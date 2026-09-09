#!/usr/bin/env node
import { readFileSync,realpathSync,existsSync,mkdirSync } from 'node:fs';
import { resolve,join,sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store,Room } from '../src/room.mjs';
import { DATABASE_VERSION,stateRoot,privateWrite,restoreBackup } from '../src/store.mjs';
import { execute } from '../src/commands.mjs';
import { doctor,runtimeReport } from '../src/doctor.mjs';
import { fail,EXIT,parseJSON,object,RoomError } from '../src/contracts.mjs';
import { modelsPath,readModelConfig,resolveModels } from '../src/models.mjs';
import { PACKAGE_NAME } from '../src/identity.mjs';

const packageVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const help=`Wapentake ${packageVersion} -- durable conversations for humans and coding agents

  wapentake --version
  wapentake models init --operator [--models-file <path>]
  wapentake models validate|resolve [--model-profile <name>] [--for glm,astra,adjudicator]
  wapentake init --project <path> --operator [--name <name>]
  wapentake migrate --operator --backup-out <new-directory>
  wapentake doctor --offline [--runtime-only]
  wapentake serve --operator [--port 0] [--worker]
  wapentake project list | register --path <path> | move --path <path>
  wapentake actor attach --name <name> --run-id <id> --operator [--role agent|runner]
  wapentake actor revoke --id <actor-id> --operator
  wapentake thread open --title <text> [--mode independent] [--task <id>]
  wapentake thread list | status --thread <id> --status resolved
  wapentake post --thread <id> --body-file <path> [--kind question]
  wapentake ask --thread <id> --to glm,astra --body-file <path> [--model-profile <name>]
  wapentake source add --thread <id> --path <relative> --working-tree
  wapentake source read --id <source-id> [--offset 0] [--max-bytes 8192]
  wapentake read --thread <id> [--after 0] [--limit 50]
  wapentake inbox | ack --thread <id> --through <sequence>
  wapentake search --query <text>
  wapentake context preview --thread <id> [--for astra]
  wapentake constraint set --thread <id> --body-file <path> [--stable-id <id>]
  wapentake decision propose|accept|reject|supersede --thread <id>
             --statement <text> --rationale <text> [--stable-id <id>]
  wapentake policy show | enable --max-calls 6 --operator | pause --operator
  wapentake work --once --operator
  wapentake work --job <id> [--project <id-or-path>]
  wapentake jobs | cancel --job <id> | retry --job <id> --operator
  wapentake recover --job <id> --inspect | --confirm-stopped --operator
  wapentake export --thread <id> --out <new-directory>
  wapentake backup --out <new-directory> --operator
  wapentake restore --from <backup> --out <new-state-directory> --operator
  wapentake event --input-file <event.json>
  wapentake call --action <action> --input-file <data.json>

Common: --project <id-or-path>, --state-dir <path>, --json, --key <request-id>.
Identity: --operator reads the local operator capability; agents use
WAPENTAKE_TOKEN or --token-file <registered-agent-token-file>.
--body-stdin and --body <text> are alternatives to --body-file.
Opening, reading, searching and serving do not enable model execution.
`;
const booleanFlags=new Set(['operator','json','offline','runtime-only','working-tree','optional','body-stdin','once','inspect','confirm-stopped','worker','help','history','version']);
const valuedFlags=new Set(['state-dir','project','name','path','label','run-id','role','lifetime-days','models-file','model-profile','backup-out','title','mode','task','thread','body','body-file','kind','reply-to','sources','to','key','token-file','id','offset','max-bytes','revision','after','limit','through','query','for','stable-id','status','statement','rationale','citations','expected-context-version','max-calls','automatic-follow-up-rounds','job','out','from','action','input-file','port']);
function parse(argv){
  const flags={},positionals=[];
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];if(arg==='-h'){flags.help=true;continue;}
    if(!arg.startsWith('--')){positionals.push(arg);continue;}
    const equal=arg.indexOf('='),name=arg.slice(2,equal<0?undefined:equal);
    if(name in flags)fail('invalid_input',`Duplicate --${name}`);
    if(booleanFlags.has(name)){if(equal>=0)fail('invalid_input',`--${name} does not take a value`);flags[name]=true;}
    else if(valuedFlags.has(name)){
      const value=equal>=0?arg.slice(equal+1):argv[++i];if(value===undefined||value.startsWith('--'))fail('invalid_input',`--${name} needs a value`);flags[name]=value;
    }else fail('invalid_input',`Unknown option --${name}`);
  }
  return {flags,positionals};
}
const common=['operator','json','project','state-dir','token-file','key','help'];
function allow(flags,names){for(const name of Object.keys(flags))if(!common.includes(name)&&!names.includes(name))fail('invalid_input',`--${name} is not supported for this command`);}
function readInput(path, label, code = 'invalid_input') {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    fail(code, `Cannot read ${label}`, { cause: error.code ?? error.name, path: path === 0 ? 'stdin' : path });
  }
}
function body(f){
  const sources=['body','body-file','body-stdin'].filter(k=>k in f);if(sources.length!==1)fail('invalid_input','Select exactly one body input');
  const value=f.body??readInput(f['body-stdin']?0:f['body-file'],f['body-stdin']?'--body-stdin':'--body-file');
  if(Buffer.byteLength(value)>65536)fail('invalid_input','Message input exceeds 64 KiB');return value;
}
const csv=value=>value?value.split(',').map(s=>s.trim()).filter(Boolean):[];
const number=(value,defaultValue)=>value===undefined?defaultValue:Number(value);
function locate(room,arg){
  if (arg) {
    try { return room.project(arg).id; } catch (error) { if (error.code !== 'not_found') throw error; }
    let path;
    try { path = realpathSync(arg); }
    catch (error) { fail('not_found', `No registered project matches ${arg}`, { cause: error.code ?? error.name }); }
    return room.project(path).id;
  }
  if(room.actor.project_id)return room.actor.project_id;
  const cwd=realpathSync(process.cwd()),matches=room.projects().filter(p=>cwd===p.path||cwd.startsWith(p.path+sep)).sort((a,b)=>b.path.length-a.path.length);
  if(!matches.length)fail('invalid_input','No registered project matches this directory; supply --project');return matches[0].id;
}
function jsonFile(path){if(!path)fail('invalid_input','--input-file is required');const raw=readInput(path,'--input-file');if(Buffer.byteLength(raw)>131072)fail('invalid_input','JSON input exceeds 128 KiB');return parseJSON(raw,'input file');}
async function main(){
  const {flags:f,positionals}=parse(process.argv.slice(2));
  if(f.version){if(positionals.length||Object.keys(f).length!==1)fail('invalid_input','Use --version by itself');emit({name:PACKAGE_NAME,version:packageVersion,database_schema:DATABASE_VERSION,model_config_schema:1,export_schema:2});return;}
  if(f.help||!positionals.length){process.stdout.write(help);return;}
  const [command,sub]=positionals;if(positionals.length>2)fail('invalid_input','Unexpected positional arguments');
  if(sub&&!['project','actor','thread','source','context','constraint','decision','policy','models'].includes(command))fail('invalid_input','Unexpected positional argument');
  if(f.operator&&(f['token-file']||process.env.WAPENTAKE_TOKEN))fail('invalid_input','Choose operator or agent capability explicitly, not both');
  const root=resolve(f['state-dir']??stateRoot()),requestKey=f.key??randomUUID();let store;
  try{
    if(command==='models') {
      allow(f,['models-file','model-profile','for']);
      if(sub==='init') {
        if(!f.operator)fail('forbidden','Initialize the user model file explicitly with --operator');
        if(f.for||f['model-profile'])fail('invalid_input','models init creates the example file; edit it to choose profiles');
        const path=f['models-file']?resolve(f['models-file']):modelsPath();
        if(existsSync(path))fail('conflict','The model file already exists; edit it explicitly instead of replacing it',{path});
        privateWrite(path,readFileSync(new URL('../examples/models.json',import.meta.url)),{exclusive:true});
        emit({status:'created',path,inference_performed:false});return;
      }
      if(!['validate','resolve'].includes(sub))fail('invalid_input','Use models init, validate or resolve');
      const document=readModelConfig({file:f['models-file']});
      const roles=f.for?csv(f.for):sub==='validate'?Object.keys(document.config.defaults):['glm','astra'];
      if(!roles.length)fail('invalid_input','Name at least one model role');
      if(sub==='validate') for(const profile of Object.keys(document.config.profiles??{}))resolveModels({roles:[...new Set([...roles,...Object.keys(document.config.profiles[profile])])],profile,document});
      emit(resolveModels({roles,profile:f['model-profile'],document}));return;
    }
    if(command==='doctor'){allow(f,['offline','runtime-only','models-file','model-profile']);const out=await doctor({runtimeOnly:Boolean(f['runtime-only']),modelsFile:f['models-file'],modelProfile:f['model-profile']});emit(out);if(!out.ready_offline)process.exitCode=3;return;}
    if(command==='restore'){allow(f,['from','out']);if(!f.operator)fail('forbidden','Restore requires explicit --operator');if(!f.from||!f.out)fail('invalid_input','Restore requires --from and --out');emit(restoreBackup(f.from,f.out));return;}
    const runtime=runtimeReport();if(!runtime.supported_runtime||!runtime.fts5)fail('client_unsupported','A supported Node runtime with SQLite FTS5 is required');
    if(command==='init'){
      allow(f,['name']);if(!f.operator||!f.project)fail('invalid_input','Initialize explicitly with --operator and --project <path>');
      store=new Store(root,{initialize:true});const operator=store.ensureOperator(f.name??'Operator'),room=new Room(store,readFileSync(operator.tokenPath,'utf8').trim());
      emit({project:room.register({path:f.project}),state_dir:root,operator_token_file:operator.tokenPath,execution_enabled:room.policy().execution_enabled});return;
    }
    store=new Store(root,{allowLegacy:command==='migrate'||command==='backup'||(command==='policy'&&['pause','show'].includes(sub))});
    if(f.operator&&(f['token-file']||process.env.WAPENTAKE_TOKEN))fail('invalid_input','Choose operator or agent capability explicitly, not both');
    const token=f.operator?readInput(join(root,'operator.token'),'the operator capability; run init --operator if it is missing','auth_required').trim():f['token-file']?readInput(f['token-file'],'--token-file','auth_required').trim():process.env.WAPENTAKE_TOKEN;
    const room=new Room(store,token,{modelsFile:f['models-file'],modelProfile:f['model-profile']});
    if(command==='migrate'){
      allow(f,['backup-out']);room.operator();if(!f['backup-out'])fail('invalid_input','Supply --backup-out <new-directory> for the migration backup');
      emit(await store.migrate(f['backup-out']));return;
    }
    if(command==='serve'){
      allow(f,['port','worker','models-file','model-profile']);room.operator();
      const {serve}=await import('../web/server.mjs');
      let server;
      try { server = await serve({store,token,port:number(f.port,0),runWorker:Boolean(f.worker),modelsFile:f['models-file'],modelProfile:f['model-profile']}); }
      catch (error) {
        if (['EADDRINUSE', 'EACCES'].includes(error.code)) fail('invalid_input', `Cannot listen on 127.0.0.1:${f.port ?? 0}`, { cause: error.code });
        throw error;
      }
      emit({status:'listening',url:server.url,session_url:server.sessionURL,execution_enabled:room.policy().execution_enabled});
      const stop=()=>server.close().finally(()=>process.exit(0));process.once('SIGINT',stop);process.once('SIGTERM',stop);store=null;return;
    }
    let action,data={},project,thread=f.thread;
    const needsProject=!(command==='policy'||(command==='work'&&!f.job)||command==='backup'||(command==='project'&&['list','register'].includes(sub))||(command==='call'&&['snapshot','projects.list','projects.register','policy.show','policy.update','worker.once','backup'].includes(f.action)));
    if(needsProject)project=locate(room,f.project);
    const bodies=['body','body-file','body-stdin'];
    switch(command){
      case 'project':
        allow(f,['path','label']);action={list:'projects.list',register:'projects.register',move:'projects.move'}[sub];data=sub==='register'?{path:f.path,...(f.label?{label:f.label}:{})}:sub==='move'?{path:f.path}:{};break;
      case 'actor':
        allow(f,sub==='revoke'?['id']:['name','run-id','role','lifetime-days']);
        if(!['attach','revoke'].includes(sub))fail('invalid_input','Use actor attach or revoke');
        action=sub==='revoke'?'actors.revoke':'actors.attach';
        data=sub==='revoke'?{id:f.id}:{name:f.name,run_id:f['run-id'],role:f.role??'agent',lifetime_days:number(f['lifetime-days'],7)};break;
      case 'thread':
        allow(f,['thread','title','task','mode','status']);action={open:'threads.open',list:'threads.list',status:'threads.status'}[sub];
        data=sub==='open'?{title:f.title,task_ids:csv(f.task),mode:f.mode??'brainstorm',key:requestKey}:sub==='status'?{status:f.status}:{};break;
      case 'post':allow(f,['thread',...bodies,'kind','reply-to','sources']);action='messages.post';data={body:body(f),kind:f.kind??'message',reply_to:f['reply-to']??null,source_ids:csv(f.sources),key:requestKey};break;
      case 'ask':allow(f,['thread',...bodies,'to','reply-to','sources','models-file','model-profile']);action='ask';data={body:body(f),to:csv(f.to),reply_to:f['reply-to']??null,source_ids:csv(f.sources),key:requestKey,...(f['model-profile']===undefined?{}:{model_profile:f['model-profile']})};break;
      case 'read':allow(f,['thread','after','limit']);action='messages.read';data={after:number(f.after,0),limit:number(f.limit,50)};break;
      case 'inbox':allow(f,[]);action='inbox';break;
      case 'ack':allow(f,['thread','through']);action='ack';data={through:number(f.through)};break;
      case 'search':allow(f,['query','limit']);action='search';data={query:f.query,limit:number(f.limit,5)};break;
      case 'source':
        allow(f,['thread','path','revision','working-tree','optional','id','offset','max-bytes']);action={add:'sources.add',list:'sources.list',read:'sources.read'}[sub];
        data=sub==='add'?{path:f.path,working_tree:Boolean(f['working-tree']),required:!f.optional,key:requestKey,...(f.revision?{revision:f.revision}:{})}:sub==='read'?{id:f.id,offset:number(f.offset,0),max_bytes:number(f['max-bytes'],8192)}:{};break;
      case 'context':allow(f,['thread','for','models-file','model-profile']);if(sub!=='preview')fail('invalid_input','Use context preview');action='context.preview';data={participant:f.for??'astra',...(f['model-profile']===undefined?{}:{model_profile:f['model-profile']})};break;
      case 'constraint':allow(f,['thread',...bodies,'stable-id','status']);action=sub==='set'?'constraints.set':sub==='list'?'constraints.list':null;data=sub==='set'?{body:body(f),key:requestKey,...(f['stable-id']?{stable_id:f['stable-id']}:{}),...(f.status?{status:f.status}:{})}:{};break;
      case 'decision':
        allow(f,['thread','statement','rationale','citations','stable-id','history','expected-context-version']);action=sub==='list'?'decisions.list':'decisions.set';
        if(sub==='list')data={history:Boolean(f.history)};
        else{const status={propose:'proposed',accept:'accepted',reject:'rejected',supersede:'superseded'}[sub];if(!status)fail('invalid_input','Unknown decision action');data={statement:f.statement,rationale:f.rationale,citations:csv(f.citations),status,key:requestKey,...(f['stable-id']?{stable_id:f['stable-id']}:{}),...(f['expected-context-version']?{expected_context_version:number(f['expected-context-version'])}:{})};}break;
      case 'policy':
        allow(f,['max-calls','automatic-follow-up-rounds']);action=sub==='show'?'policy.show':'policy.update';
        if(sub==='enable'){if(f['max-calls']===undefined)fail('invalid_input','Specify a bounded --max-calls allowance');data={execution_enabled:true,max_calls_per_day:number(f['max-calls']),...(f['automatic-follow-up-rounds']!==undefined?{automatic_follow_up_rounds:number(f['automatic-follow-up-rounds'])}:{})};}
        else if(sub==='pause')data={execution_enabled:false};else if(sub!=='show')fail('invalid_input','Use policy show, enable or pause');break;
      case 'work':
        allow(f,['once','job']);
        if(Boolean(f.once)===Boolean(f.job))fail('invalid_input','Choose work --once or work --job <id>');
        action=f.job?'worker.job':'worker.once';data=f.job?{id:f.job}:{};break;
      case 'jobs':allow(f,['limit']);action='jobs.list';data={limit:number(f.limit,100)};break;
      case 'cancel':allow(f,['job']);action='jobs.cancel';data={id:f.job};break;
      case 'retry':allow(f,['job']);action='jobs.retry';data={id:f.job,key:requestKey};break;
      case 'recover':allow(f,['job','inspect','confirm-stopped']);if(Boolean(f.inspect)===Boolean(f['confirm-stopped']))fail('invalid_input','Choose --inspect or --confirm-stopped');action=f.inspect?'jobs.inspect':'jobs.recover';data={id:f.job,...(f['confirm-stopped']?{confirm_stopped:true}:{})};break;
      case 'export':allow(f,['thread','out']);action='export';break;
      case 'backup':allow(f,['out']);action='backup';data={out:f.out};break;
      case 'event':allow(f,['input-file','models-file','model-profile']);action='event';data=object(jsonFile(f['input-file']),'event');if(!data.key)data.key=requestKey;if(f['model-profile']!==undefined)data.model_profile=f['model-profile'];break;
      case 'call':allow(f,['thread','action','input-file','models-file','model-profile']);action=f.action;data=jsonFile(f['input-file']);break;
      default:fail('invalid_input',`Unknown command: ${command}`);
    }
    if(!action)fail('invalid_input','Unknown subcommand');
    const result=await execute(room,action,{project,thread,data});
    if(command==='export'&&f.out){
      const dir=resolve(f.out);if(existsSync(dir))fail('invalid_input','Export destination must not already exist');mkdirSync(dir,{recursive:true,mode:0o700});
      privateWrite(join(dir,'thread.md'),result.markdown);privateWrite(join(dir,'records.json'),JSON.stringify(result.records,null,2));
      for(const source of result.records.sources)privateWrite(join(dir,'sources',source.blob_hash),store.readBlob(project,source.blob_hash));
      emit({path:dir,messages:result.records.messages.length,sources:result.records.sources.length});
    }else emit(result);
    if(action==='worker.job'&&result.status!=='succeeded')process.exitCode=EXIT[result.error?.code??result.status]??6;
    else if(command==='work'&&['failed','cancelled','auth_required','quota_wait','needs_scoping','disabled'].includes(result.status))process.exitCode=EXIT[result.error?.code??result.status]??6;
  }finally{store?.close();}
}
function emit(value){process.stdout.write(JSON.stringify(value)+'\n');}
main().catch(error => {
  const code = error instanceof RoomError ? error.code : 'storage_error';
  const details = error instanceof RoomError ? error.details : { cause: error.code ?? error.name };
  emit({ error: { code, message: error.message, details } });
  process.exitCode = EXIT[code] ?? 5;
});
