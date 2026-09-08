import { spawn, execFileSync } from 'node:child_process';
import { openSync,closeSync,fstatSync,readFileSync } from 'node:fs';
import { RoomError } from '../contracts.mjs';

export const stripANSI=value=>value.replace(/\x1b\[[0-9;]*m/g,'');
export function redact(value) {
  return stripANSI(String(value)).replace(/\b(?:sk-|sk_)[a-zA-Z0-9_-]{16,}/g,'[redacted-key]').replace(/Bearer\s+[a-zA-Z0-9._~-]+/gi,'Bearer [redacted]').replace(/("?(?:api_key|access_token|refresh_token|authorization)"?\s*[:=]\s*")[^"]*(")/gi,'$1[redacted]$2');
}
export function safeEnvironment(original=process.env) {
  const allowed=['PATH','HOME','USER','LOGNAME','TMPDIR','LANG','LC_ALL','TERM','SHELL','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','CODEX_HOME','SSL_CERT_FILE','SSL_CERT_DIR'];
  const env=Object.fromEntries(allowed.filter(key=>original[key]!==undefined).map(key=>[key,original[key]]));
  env.NO_COLOR='1';env.CI='1';env.TERM='dumb';
  return env;
}
export function processIdentity(pid=process.pid) {
  try{return execFileSync('ps',['-p',String(pid),'-o','lstart='],{timeout:2000,stdio:['ignore','pipe','ignore']}).toString().trim()||null;}catch{return null;}
}
export function processAlive(pid,identity=null,inspect=processIdentity) {
  if(!Number.isSafeInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);}catch(error){return error.code==='EPERM';}
  if(identity===null)return true;
  const observed=inspect(pid);
  return observed===null||observed===identity;
}
export function runProcess(command,args,{cwd,env=safeEnvironment(),input='',timeoutMs=600000,maxBytes=2097152,signal,onSpawn,onCapture,stdoutFile}={}) {
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='',size=0,reason=null,spawned=false,settled=false,killTimer;
    // Some clients exit before flushing pipe-backed stdout. A new private regular
    // file makes their native writes synchronous; still enforce the capture cap.
    const outputFd=stdoutFile?openSync(stdoutFile,'wx',0o600):null;
    const child=spawn(command,args,{cwd,env,shell:false,detached:process.platform!=='win32',stdio:['pipe',outputFd??'pipe','pipe']});
    const kill=(code,message)=>{
      if(reason)return;reason=new RoomError(code,message,{spawned});
      try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGTERM');}catch{}
      killTimer=setTimeout(()=>{try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGKILL');}catch{}},5000);killTimer.unref();
    };
    const abort=()=>kill('cancelled','Consultation cancelled locally; provider usage may already have occurred');
    const timer=setTimeout(()=>kill('timeout','Client exceeded the configured timeout'),timeoutMs);timer.unref();
    signal?.addEventListener('abort',abort,{once:true});
    child.on('spawn',()=>{
      spawned=true;
      if(reason){reason.details={spawned:true};try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGTERM');}catch{}}
      try{onSpawn?.(child.pid);}catch(error){kill('storage_error',error.message);}
      if(signal?.aborted)abort();
    });
    child.stdout?.setEncoding('utf8');child.stderr.setEncoding('utf8');
    const fileWatch=outputFd===null?null:setInterval(()=>{
      if(fstatSync(outputFd).size+size>maxBytes)kill('invalid_output','Client output exceeded the capture limit');
    },100);fileWatch?.unref();
    const collect=(chunk,target)=>{
      size+=Buffer.byteLength(chunk);
      if(size>maxBytes){kill('invalid_output','Client output exceeded the capture limit');return;}
      if(target==='stdout')stdout+=chunk;else stderr=(stderr+chunk).slice(-16384);
    };
    child.stdout?.on('data',c=>collect(c,'stdout'));child.stderr.on('data',c=>collect(c,'stderr'));
    child.stdin.on('error',()=>{});child.stdin.end(input);
    const finish=(error,code,signalName)=>{
      if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);clearInterval(fileWatch);signal?.removeEventListener('abort',abort);
      if(reason&&spawned){try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGKILL');}catch{}}
      if(outputFd!==null){
        try{
          if(fstatSync(outputFd).size+size>maxBytes)error??=new RoomError('invalid_output','Client output exceeded the capture limit',{spawned});
          else stdout=readFileSync(stdoutFile,'utf8');
        }catch(e){error??=e;}finally{closeSync(outputFd);}
      }
      const result={stdout,stderr:redact(stderr),code,signal:signalName,spawned};
      try{onCapture?.({...result,stdout:redact(stdout)});}catch(captureError){error??=captureError;}
      if(error)reject(error);else resolve(result);
    };
    child.on('error',error=>finish(new RoomError('client_unsupported',`Cannot start ${command}: ${error.code??'spawn error'}`,{spawned:false}),null,null));
    child.on('close',(code,sig)=>finish(reason,code,sig));
  });
}
export async function inspectCommand(executable,args,options={}) {
  const result=await runProcess(executable,args,{timeoutMs:15000,maxBytes:1048576,...options});
  if(result.code!==0)throw new RoomError('client_unsupported',`${executable} capability check failed: ${result.stderr.slice(0,500)||'nonzero exit'}`);
  return stripANSI(result.stdout+'\n'+result.stderr).trim();
}
export function classifyFailure(output) {
  const s=String(output).toLowerCase();
  if(/quota|rate.?limit|too many requests|429/.test(s))return 'quota_wait';
  if(/model.*(?:not found|unavailable|not supported|not available)|unknown model/.test(s))return 'model_unavailable';
  if(/not logged|unauth|login required|authentication|401|credentials/.test(s))return 'auth_required';
  return 'provider_error';
}
export function eventsFromJSONL(output) {
  const events=[];
  for(const line of output.split(/\r?\n/)){
    if(!line.trim())continue;
    try{const event=JSON.parse(line);if(!event||typeof event!=='object'||typeof event.type!=='string')throw Error();events.push(event);}
    catch{throw new RoomError('client_unsupported','Client stdout is not the supported native JSONL event format');}
  }
  if(!events.length)throw new RoomError('invalid_output','Client returned no native events');
  return events;
}
