import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { privateDir,privateWrite } from '../store.mjs';
import { fail, RoomError } from '../contracts.mjs';
import { validateModel } from '../models.mjs';
import { inspectCommand,runProcess,eventsFromJSONL,safeEnvironment,classifyFailure } from './process.mjs';

export function openCodeProfile(model){
  validateModel('glm', { model });
  return {model,enabled_providers:['zai-coding-plan'],autoupdate:false,share:'disabled',permission:'deny',mcp:{},plugin:[],instructions:[],agent:{'room-consultant':{description:'Packet-only engineering consultant',mode:'primary',permission:{'*':'deny'},prompt:'Use the supplied room packet only. Do not use tools. Return the requested JSON response or a bounded context request.'}}};
}
export function openCodeEnvironment(dir,model){
  const env=safeEnvironment(),config=join(dir,'config-root');privateDir(join(config,'opencode'));
  env.XDG_CONFIG_HOME=config;env.OPENCODE_CONFIG_DIR=join(config,'opencode');env.OPENCODE_CONFIG_CONTENT=JSON.stringify(openCodeProfile(model));
  return env;
}
export function normalizeOpenCode(output,{code=0}={}){
  const events=eventsFromJSONL(output);let texts=[],terminal=false,stepStarted=false,usage=null,session=null,observedModel=null;
  for(const event of events){
    if(event.type==='tool_use'||event.part?.type==='tool')fail('permission_config_error','Consultant emitted tool activity despite the packet-only profile');
    session=event.sessionID??session;
    if(event.type==='step_start'){if(stepStarted)fail('client_unsupported','Packet-only consultation emitted multiple steps');stepStarted=true;}
    else if(event.type==='text'){
      if(typeof event.part?.text!=='string')fail('invalid_output','OpenCode text event has no assistant text');
      texts.push(event.part.text);
    }else if(event.type==='reasoning'){}
    else if(event.type==='step_finish'){
      if(event.part?.reason!=='stop'&&event.part?.reason!=='end_turn')fail('invalid_output',`OpenCode did not finish normally: ${event.part?.reason??'unknown'}`);
      terminal=true;const tokens=event.part?.tokens;
      if(tokens&&Number.isFinite(tokens.input)&&Number.isFinite(tokens.output))usage={input_tokens:tokens.input,output_tokens:tokens.output,cached_input_tokens:tokens.cache?.read??null,reasoning_output_tokens:tokens.reasoning??null,reported_cost:event.part.cost??null};
      observedModel=event.part?.modelID??null;
    }else if(event.type==='error')fail(classifyFailure(JSON.stringify(event)),'OpenCode reported a failed turn');
    else fail('client_unsupported',`Unsupported OpenCode event type: ${event.type}`);
  }
  if(code!==0)fail(classifyFailure(output),'OpenCode exited unsuccessfully');
  if(!stepStarted||!terminal||!texts.length)fail('invalid_output','OpenCode exited without terminal assistant output');
  let value;try{value=JSON.parse(texts.join(''));}catch{fail('invalid_output','Final OpenCode assistant text is not a single JSON object');}
  return {value,usage,usage_unknown_reason:usage?null:'Native usage was not reported',session_id:session,observed_model:observedModel,tool_activity:0,terminal_state:'step_finish'};
}
export function verifyOpenCodeSession(exported,sessionId,model){
  if(exported?.info?.id!==sessionId||!Array.isArray(exported.messages))fail('client_unsupported','OpenCode session export does not match the completed session');
  const assistant=exported.messages.filter(m=>m.info?.role==='assistant');
  if(assistant.length!==1)fail('client_unsupported','Fresh OpenCode consultation did not produce exactly one assistant message');
  const message=assistant[0],observed=`${message.info.providerID}/${message.info.modelID}`;
  if(observed!==model)fail('model_unavailable','OpenCode session recorded a different provider or model');
  if(!['stop','end_turn'].includes(message.info.finish))fail('invalid_output','OpenCode session did not record a normal assistant completion');
  if(!Array.isArray(message.parts)||message.parts.some(p=>!['step-start','step-finish','text','reasoning'].includes(p.type)))fail('permission_config_error','OpenCode session contains tool activity or unsupported message parts');
  return {observed_model:observed,model_identity_source:'client_session_metadata',provider:message.info.providerID,session_id:sessionId,assistant_message_id:message.info.id,finish:message.info.finish,tool_activity:0};
}
export class OpenCodeAdapter {
  constructor({executable='opencode'}={}){this.executable=executable;this.kind='opencode-glm-plan';}
  async inspect({cwd,model='zai-coding-plan/glm-5.3',env=safeEnvironment(),checkProfile=false}={}){
    openCodeProfile(model);
    const version=await inspectCommand(this.executable,['--version'],{cwd,env});
    const number=version.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
    if(number!=='1.18.18')fail('client_unsupported',`OpenCode ${number??'unknown'} has no verified event/profile contract in this release`);
    const help=await inspectCommand(this.executable,['run','--help'],{cwd,env});
    for(const flag of ['--pure','--agent','--format','--model'])if(!help.includes(flag))fail('client_unsupported',`OpenCode is missing required ${flag}`);
    const auth=await inspectCommand(this.executable,['auth','list'],{cwd,env});
    if(!/Z\.AI Coding Plan/i.test(auth))fail('auth_required','OpenCode has no configured Z.AI Coding Plan provider');
    let profileChecked=false;
    if(checkProfile){
      // Resolved configuration may contain sensitive options: inspect only in memory and never log it.
      const result=await runProcess(this.executable,['debug','config','--pure'],{cwd,env,timeoutMs:15000,maxBytes:1048576});
      if(result.code!==0)fail('permission_config_error','Cannot inspect the isolated OpenCode configuration');
      let config;try{config=JSON.parse(result.stdout);}catch{fail('client_unsupported','OpenCode debug config did not return JSON');}
      const agent=config.agent?.['room-consultant'];
      const denied=config.permission==='deny'||config.permission?.['*']==='deny';
      if(!denied||agent?.permission?.['*']!=='deny'||config.model!==model||Object.values(config.mcp??{}).some(m=>m.enabled!==false)||(config.instructions??[]).length||(config.plugin??[]).length)fail('permission_config_error','Effective OpenCode profile contains unexpected tools, integrations or instructions');
      profileChecked=true;
    }
    return {adapter:this.kind,client_version:number,auth_mode:'zai-coding-plan-client-credential',requested_model:model,model_availability:'requires_live_validation',profile:'isolated-config-deny-tools-v1',effective_config_checked:profileChecked,unverified:['actual account model access','effective tool behavior until live trace'],no_general_api_fallback:true};
  }
  async prepare({dir,participant}){
    const env=openCodeEnvironment(dir,participant.model);
    const capabilities=await this.inspect({cwd:dir,model:participant.model,env,checkProfile:true});
    privateWrite(join(dir,'profile.json'),JSON.stringify(openCodeProfile(participant.model),null,2));
    return {command:this.executable,args:['run','--pure','--model',participant.model,'--agent','room-consultant','--format','json'],cwd:dir,env,capabilities};
  }
  async run(prepared,{prompt,policy,signal,onSpawn,onCapture}){
    const result=await runProcess(prepared.command,prepared.args,{cwd:prepared.cwd,env:prepared.env,input:prompt,timeoutMs:policy.timeout_seconds*1000,maxBytes:policy.max_output_bytes,signal,onSpawn,onCapture});
    try { return await this.normalizeCapture(prepared,result,{signal}); }
    catch (error) {
      // Inference has already run. An export subprocess reporting spawned:false
      // describes only metadata capture and must never refund that inference.
      if (error instanceof RoomError) error.details = { ...error.details, spawned: true, stage: 'capture' };
      throw error;
    }
  }
  async normalizeCapture(prepared,result,{signal}={}){
    const normalized=normalizeOpenCode(result.stdout,result);
    if (typeof normalized.session_id !== 'string' || !normalized.session_id.trim()) {
      fail('invalid_output', 'OpenCode did not report a session ID; session metadata cannot be verified');
    }
    const stdoutFile=join(prepared.cwd,`session-export-${randomUUID()}.json`);
    let exported;
    try{exported=await runProcess(prepared.command,['export',normalized.session_id,'--pure'],{cwd:prepared.cwd,env:prepared.env,timeoutMs:15000,maxBytes:2097152,signal,stdoutFile});}
    finally{rmSync(stdoutFile,{force:true});}
    if(exported.code!==0)fail('client_unsupported','Could not inspect the completed OpenCode session metadata');
    let session;try{session=JSON.parse(exported.stdout);}catch{fail('client_unsupported','OpenCode session export was not JSON');}
    const verification=verifyOpenCodeSession(session,normalized.session_id,prepared.capabilities.requested_model);
    privateWrite(join(prepared.cwd,'client-session-verification.json'),JSON.stringify(verification,null,2));
    return {...normalized,...verification,capabilities:prepared.capabilities};
  }
}
