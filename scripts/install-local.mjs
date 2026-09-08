#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readlinkSync,realpathSync,renameSync,rmSync,statSync,symlinkSync,writeFileSync } from 'node:fs';
import { homedir,tmpdir } from 'node:os';
import { dirname,join,resolve,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeReport } from '../src/doctor.mjs';

const name='@productengineered/agent-room';
const help=`Install or update the shared Mac Agent Room command.

  npm run install:local
  npm run install:local -- --from /path/agent-room.tgz --sha256 HASH

Options: --from ARCHIVE, --sha256 HASH, --install-root PATH, --bin-dir PATH.
Defaults: ~/.local/share/agent-room and ~/.local/bin.
No model calls, toolkit changes or room-data migrations are performed.
`;
function options(argv){
  const out={};
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--help'){out.help=true;continue;}
    const key=argv[i].replace(/^--/,'');
    if(!argv[i].startsWith('--')||!['from','sha256','install-root','bin-dir'].includes(key)||key in out||!argv[i+1]||argv[i+1].startsWith('--'))throw Error(`Invalid option: ${argv[i]}`);
    out[key]=argv[++i];
  }
  if(out.sha256&&!/^[a-f0-9]{64}$/i.test(out.sha256))throw Error('--sha256 must be a SHA-256 hex digest');
  return out;
}
function run(command,args,cwd){
  const result=spawnSync(command,args,{cwd,encoding:'utf8',timeout:60000,maxBuffer:1048576});
  if(result.error||result.status!==0)throw Error(`${command} failed: ${result.error?.message??result.stderr.trim().slice(-1000)}`);
  return result.stdout;
}
function entry(path){try{return lstatSync(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function currentRelease(root){
  const path=join(root,'current'),info=entry(path);if(!info)return null;
  if(!info.isSymbolicLink())throw Error('The current installation path is not an Agent Room release link');
  const target=resolve(root,readlinkSync(path));
  if(!target.startsWith(join(root,'releases')+sep))throw Error('The current link points outside Agent Room releases');
  return target;
}
function checkBin(path,target){
  const info=entry(path);
  if(info&&(!info.isSymbolicLink()||resolve(dirname(path),readlinkSync(path))!==target))throw Error(`Refusing to replace an unrelated command at ${path}`);
  return Boolean(info);
}
function inspectRelease(path){
  const pkg=join(path,'node_modules','@productengineered','agent-room'),manifest=JSON.parse(readFileSync(join(pkg,'package.json'),'utf8'));
  if(manifest.name!==name||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version))throw Error('Archive is not a versioned Agent Room package');
  if(realpathSync(join(path,'node_modules','.bin','agent-room'))!==realpathSync(join(pkg,'bin','agent-room.mjs')))throw Error('Installed command does not resolve to the verified Agent Room entry point');
  const report=JSON.parse(run(process.execPath,[join(pkg,'bin','agent-room.mjs'),'doctor','--offline','--runtime-only'],pkg));
  if(!report.ready_offline||report.inference_performed!==false)throw Error('Installed package failed its offline runtime check');
  return manifest;
}
async function main(){
  const args=options(process.argv.slice(2));if(args.help){process.stdout.write(help);return;}
  if(!runtimeReport().supported_runtime)throw Error('Install with supported Node 24.20+ or 26 on macOS');
  const root=resolve(args['install-root']??join(homedir(),'.local','share','agent-room'));
  const binDir=resolve(args['bin-dir']??join(homedir(),'.local','bin')),bin=join(binDir,'agent-room');
  const target=join(root,'current','node_modules','.bin','agent-room');
  checkBin(bin,target);currentRelease(root);
  mkdirSync(root,{recursive:true,mode:0o700});const lock=join(root,'.install-lock');
  try{mkdirSync(lock,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw Error('Another installation holds .install-lock; inspect it before removing a stopped installation lock');throw error;}
  let temporary,stage,switchLink;
  try{
    writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:process.pid,started_at:new Date().toISOString()}),{mode:0o600});
    temporary=mkdtempSync(join(tmpdir(),'agent-room-install-'));
    const cache=join(root,'cache'),releases=join(root,'releases');mkdirSync(releases,{recursive:true,mode:0o700});
    let archive;
    if(args.from){archive=realpathSync(resolve(args.from));if(!statSync(archive).isFile())throw Error('--from must name a package archive file');}
    else{
      const source=fileURLToPath(new URL('..',import.meta.url));
      const packed=JSON.parse(run('npm',['pack','--offline','--ignore-scripts','--json','--pack-destination',temporary,'--cache',cache],source))[0];
      archive=join(temporary,packed.filename);
    }
    const hash=createHash('sha256').update(readFileSync(archive)).digest('hex');
    if(args.sha256&&args.sha256.toLowerCase()!==hash)throw Error('Archive SHA-256 does not match; current installation was not changed');
    stage=mkdtempSync(join(releases,'.staging-'));
    run('npm',['install','--prefix',stage,'--offline','--ignore-scripts','--no-audit','--no-fund','--no-save','--package-lock=false','--cache',cache,archive],temporary);
    const manifest=inspectRelease(stage),release=join(releases,`${manifest.version}-${hash.slice(0,16)}`);
    if(existsSync(release)){
      if(JSON.parse(readFileSync(join(release,'release.json'),'utf8')).archive_sha256!==hash)throw Error('Existing release has a different archive hash');
      inspectRelease(release);rmSync(stage,{recursive:true,force:true});stage=null;
    }else{
      writeFileSync(join(stage,'release.json'),JSON.stringify({schema_version:1,name,version:manifest.version,archive_sha256:hash,installed_at:new Date().toISOString()},null,2)+'\n',{mode:0o600});
      renameSync(stage,release);stage=null;
    }
    const previous=currentRelease(root);mkdirSync(binDir,{recursive:true,mode:0o700});
    if(!checkBin(bin,target))symlinkSync(target,bin);
    switchLink=join(root,`.current-${randomUUID()}`);symlinkSync(release,switchLink);renameSync(switchLink,join(root,'current'));switchLink=null;
    process.stdout.write(JSON.stringify({status:previous===release?'already_current':'installed',version:manifest.version,archive_sha256:hash,command:bin,release,previous_release:previous,running_processes_restarted:false,room_data_changed:false,inference_performed:false})+'\n');
  }finally{
    if(switchLink)rmSync(switchLink,{force:true});
    if(stage)rmSync(stage,{recursive:true,force:true});
    if(temporary)rmSync(temporary,{recursive:true,force:true});
    rmSync(lock,{recursive:true,force:true});
  }
}
main().catch(error=>{process.stderr.write(`Agent Room installation failed: ${error.message}\n`);process.exitCode=1;});
