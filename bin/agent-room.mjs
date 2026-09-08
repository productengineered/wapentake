#!/usr/bin/env node
import { readFileSync,realpathSync,existsSync,mkdirSync } from 'node:fs';
import { resolve,join,sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store,Room } from '../src/room.mjs';
import { stateRoot,privateWrite,restoreBackup } from '../src/store.mjs';
import { execute } from '../src/commands.mjs';
import { doctor,runtimeReport } from '../src/doctor.mjs';
import { fail,EXIT,parseJSON } from '../src/contracts.mjs';

const packageVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const help=`Agent Room ${packageVersion} -- durable conversations for humans and coding agents

  agent-room --version
  agent-room init --project <path> --operator [--name <name>]
  agent-room doctor --offline [--runtime-only]
  agent-room serve --operator [--port 0] [--worker]
  agent-room project list | register --path <path> | move --path <path>
  agent-room actor attach --name <role> --run-id <id> --operator
  agent-room thread open --title <text> [--mode independent] [--task <id>]
  agent-room thread list | status --thread <id> --status resolved
  agent-room post --thread <id> --body-file <path> [--kind question]
  agent-room ask --thread <id> --to glm,astra --body-file <path>
  agent-room source add --thread <id> --path <relative> --working-tree
  agent-room source read --id <source-id> [--offset 0] [--max-bytes 8192]
  agent-room read --thread <id> [--after 0] [--limit 50]
  agent-room inbox | ack --thread <id> --through <sequence>
  agent-room search --query <text>
  agent-room context preview --thread <id> [--for astra]
  agent-room constraint set --thread <id> --body-file <path> [--stable-id <id>]
  agent-room decision propose|accept|reject|supersede --thread <id>
             --statement <text> --rationale <text> [--stable-id <id>]
  agent-room policy show | enable --max-calls 6 --operator | pause --operator
  agent-room work --once --operator
  agent-room jobs | cancel --job <id> | retry --job <id> --operator
  agent-room recover --job <id> --inspect | --confirm-stopped --operator
  agent-room export --thread <id> --out <new-directory>
  agent-room backup --out <new-directory> --operator
  agent-room restore --from <backup> --out <new-state-directory> --operator
  agent-room event --input-file <event.json>
  agent-room call --action <action> --input-file <data.json>

Common: --project <id-or-path>, --state-dir <path>, --json, --key <request-id>.
Identity: --operator reads the local operator capability; agents use
AGENT_ROOM_TOKEN or --token-file <registered-agent-token-file>.
--body-stdin and --body <text> are alternatives to --body-file.
Opening, reading, searching and serving do not enable model execution.
`;
const booleanFlags=new Set(['operator','json','offline','runtime-only','working-tree','optional','body-stdin','once','inspect','confirm-stopped','worker','help','history','version']);
const valuedFlags=new Set(['state-dir','project','name','path','label','run-id','title','mode','task','thread','body','body-file','kind','reply-to','sources','to','key','token-file','id','offset','max-bytes','revision','after','limit','through','query','for','stable-id','status','statement','rationale','citations','expected-context-version','max-calls','automatic-follow-up-rounds','job','out','from','action','input-file','port']);
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
function body(f){
  const sources=['body','body-file','body-stdin'].filter(k=>k in f);if(sources.length!==1)fail('invalid_input','Select exactly one body input');
  const value=f.body??readFileSync(f['body-stdin']?0:f['body-file'],'utf8');
  if(Buffer.byteLength(value)>65536)fail('invalid_input','Message input exceeds 64 KiB');return value;
}
const csv=value=>value?value.split(',').map(s=>s.trim()).filter(Boolean):[];
const number=(value,defaultValue)=>value===undefined?defaultValue:Number(value);
function locate(room,arg){
  if(arg){try{return room.project(arg).id;}catch(error){if(error.code!=='not_found')throw error;}return room.project(realpathSync(arg)).id;}
  if(room.actor.project_id)return room.actor.project_id;
  const cwd=realpathSync(process.cwd()),matches=room.projects().filter(p=>cwd===p.path||cwd.startsWith(p.path+sep)).sort((a,b)=>b.path.length-a.path.length);
  if(!matches.length)fail('invalid_input','No registered project matches this directory; supply --project');return matches[0].id;
}
function jsonFile(path){if(!path)fail('invalid_input','--input-file is required');const raw=readFileSync(path,'utf8');if(Buffer.byteLength(raw)>131072)fail('invalid_input','JSON input exceeds 128 KiB');return parseJSON(raw,'input file');}
async function main(){
  const {flags:f,positionals}=parse(process.argv.slice(2));
  if(f.version){if(positionals.length||Object.keys(f).length!==1)fail('invalid_input','Use --version by itself');emit({version:packageVersion});return;}
  if(f.help||!positionals.length){process.stdout.write(help);return;}
  const [command,sub]=positionals;if(positionals.length>2)fail('invalid_input','Unexpected positional arguments');
  if(sub&&!['project','actor','thread','source','context','constraint','decision','policy'].includes(command))fail('invalid_input','Unexpected positional argument');
  const root=resolve(f['state-dir']??stateRoot()),requestKey=f.key??randomUUID();let store;
  try{
    if(command==='doctor'){allow(f,['offline','runtime-only']);const out=await doctor({runtimeOnly:Boolean(f['runtime-only'])});emit(out);if(!out.ready_offline)process.exitCode=3;return;}
    if(command==='restore'){allow(f,['from','out']);if(!f.operator)fail('forbidden','Restore requires explicit --operator');if(!f.from||!f.out)fail('invalid_input','Restore requires --from and --out');emit(restoreBackup(f.from,f.out));return;}
    const runtime=runtimeReport();if(!runtime.supported_runtime||!runtime.fts5)fail('client_unsupported','A supported Node runtime with SQLite FTS5 is required');
    if(command==='init'){
      allow(f,['name']);if(!f.operator||!f.project)fail('invalid_input','Initialize explicitly with --operator and --project <path>');
      store=new Store(root,{initialize:true});const operator=store.ensureOperator(f.name??'Operator'),room=new Room(store,readFileSync(operator.tokenPath,'utf8').trim());
      emit({project:room.register({path:f.project}),state_dir:root,operator_token_file:operator.tokenPath,execution_enabled:room.policy().execution_enabled});return;
    }
    store=new Store(root);
    if(f.operator&&(f['token-file']||process.env.AGENT_ROOM_TOKEN))fail('invalid_input','Choose operator or agent capability explicitly, not both');
    const token=f.operator?readFileSync(join(root,'operator.token'),'utf8').trim():f['token-file']?readFileSync(f['token-file'],'utf8').trim():process.env.AGENT_ROOM_TOKEN;
    const room=new Room(store,token);
    if(command==='serve'){
      allow(f,['port','worker']);room.operator();
      const {serve}=await import('../web/server.mjs');const server=await serve({store,token,port:number(f.port,0),runWorker:Boolean(f.worker)});
      emit({status:'listening',url:server.url,session_url:server.sessionURL,execution_enabled:room.policy().execution_enabled});
      const stop=()=>server.close().finally(()=>process.exit(0));process.once('SIGINT',stop);process.once('SIGTERM',stop);store=null;return;
    }
    let action,data={},project,thread=f.thread;
    const needsProject=!(command==='policy'||command==='work'||command==='backup'||(command==='project'&&['list','register'].includes(sub))||(command==='call'&&['snapshot','projects.list','projects.register','policy.show','policy.update','worker.once','backup'].includes(f.action)));
    if(needsProject)project=locate(room,f.project);
    const bodies=['body','body-file','body-stdin'];
    switch(command){
      case 'project':
        allow(f,['path','label']);action={list:'projects.list',register:'projects.register',move:'projects.move'}[sub];data=sub==='register'?{path:f.path,...(f.label?{label:f.label}:{})}:sub==='move'?{path:f.path}:{};break;
      case 'actor':allow(f,['name','run-id']);if(sub!=='attach')fail('invalid_input','Use actor attach');action='actors.attach';data={name:f.name,run_id:f['run-id']};break;
      case 'thread':
        allow(f,['thread','title','task','mode','status']);action={open:'threads.open',list:'threads.list',status:'threads.status'}[sub];
        data=sub==='open'?{title:f.title,task_ids:csv(f.task),mode:f.mode??'brainstorm',key:requestKey}:sub==='status'?{status:f.status}:{};break;
      case 'post':allow(f,['thread',...bodies,'kind','reply-to','sources']);action='messages.post';data={body:body(f),kind:f.kind??'message',reply_to:f['reply-to']??null,source_ids:csv(f.sources),key:requestKey};break;
      case 'ask':allow(f,['thread',...bodies,'to','reply-to','sources']);action='ask';data={body:body(f),to:csv(f.to),reply_to:f['reply-to']??null,source_ids:csv(f.sources),key:requestKey};break;
      case 'read':allow(f,['thread','after','limit']);action='messages.read';data={after:number(f.after,0),limit:number(f.limit,50)};break;
      case 'inbox':allow(f,[]);action='inbox';break;
      case 'ack':allow(f,['thread','through']);action='ack';data={through:number(f.through)};break;
      case 'search':allow(f,['query','limit']);action='search';data={query:f.query,limit:number(f.limit,5)};break;
      case 'source':
        allow(f,['thread','path','revision','working-tree','optional','id','offset','max-bytes']);action={add:'sources.add',list:'sources.list',read:'sources.read'}[sub];
        data=sub==='add'?{path:f.path,working_tree:Boolean(f['working-tree']),required:!f.optional,key:requestKey,...(f.revision?{revision:f.revision}:{})}:sub==='read'?{id:f.id,offset:number(f.offset,0),max_bytes:number(f['max-bytes'],8192)}:{};break;
      case 'context':allow(f,['thread','for']);if(sub!=='preview')fail('invalid_input','Use context preview');action='context.preview';data={participant:f.for??'astra'};break;
      case 'constraint':allow(f,['thread',...bodies,'stable-id','status']);action=sub==='set'?'constraints.set':sub==='list'?'constraints.list':null;data=sub==='set'?{body:body(f),key:requestKey,...(f['stable-id']?{stable_id:f['stable-id']}:{}),...(f.status?{status:f.status}:{})}:{};break;
      case 'decision':
        allow(f,['thread','statement','rationale','citations','stable-id','history','expected-context-version']);action=sub==='list'?'decisions.list':'decisions.set';
        if(sub==='list')data={history:Boolean(f.history)};
        else{const status={propose:'proposed',accept:'accepted',reject:'rejected',supersede:'superseded'}[sub];if(!status)fail('invalid_input','Unknown decision action');data={statement:f.statement,rationale:f.rationale,citations:csv(f.citations),status,key:requestKey,...(f['stable-id']?{stable_id:f['stable-id']}:{}),...(f['expected-context-version']?{expected_context_version:number(f['expected-context-version'])}:{})};}break;
      case 'policy':
        allow(f,['max-calls','automatic-follow-up-rounds']);action=sub==='show'?'policy.show':'policy.update';
        if(sub==='enable'){if(f['max-calls']===undefined)fail('invalid_input','Specify a bounded --max-calls allowance');data={execution_enabled:true,max_calls_per_day:number(f['max-calls']),...(f['automatic-follow-up-rounds']!==undefined?{automatic_follow_up_rounds:number(f['automatic-follow-up-rounds'])}:{})};}
        else if(sub==='pause')data={execution_enabled:false};else if(sub!=='show')fail('invalid_input','Use policy show, enable or pause');break;
      case 'work':allow(f,['once']);if(!f.once)fail('invalid_input','Use work --once for the foreground worker');action='worker.once';break;
      case 'jobs':allow(f,['limit']);action='jobs.list';data={limit:number(f.limit,100)};break;
      case 'cancel':allow(f,['job']);action='jobs.cancel';data={id:f.job};break;
      case 'retry':allow(f,['job']);action='jobs.retry';data={id:f.job,key:requestKey};break;
      case 'recover':allow(f,['job','inspect','confirm-stopped']);if(Boolean(f.inspect)===Boolean(f['confirm-stopped']))fail('invalid_input','Choose --inspect or --confirm-stopped');action=f.inspect?'jobs.inspect':'jobs.recover';data={id:f.job,...(f['confirm-stopped']?{confirm_stopped:true}:{})};break;
      case 'export':allow(f,['thread','out']);action='export';break;
      case 'backup':allow(f,['out']);action='backup';data={out:f.out};break;
      case 'event':allow(f,['input-file']);action='event';data=jsonFile(f['input-file']);if(!data.key)data.key=requestKey;break;
      case 'call':allow(f,['thread','action','input-file']);action=f.action;data=jsonFile(f['input-file']);break;
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
    if(command==='work'&&['failed','cancelled','auth_required','quota_wait','needs_scoping','disabled'].includes(result.status))process.exitCode=EXIT[result.error?.code??result.status]??6;
  }finally{store?.close();}
}
function emit(value){process.stdout.write(JSON.stringify(value)+'\n');}
main().catch(error=>{emit({error:{code:error.code??'storage_error',message:error.message,details:error.details??null}});process.exitCode=EXIT[error.code]??5;});
