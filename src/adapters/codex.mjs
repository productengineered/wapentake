import { fileURLToPath } from 'node:url';
import { RoomError,fail } from '../contracts.mjs';
import { validateModel } from '../models.mjs';
import { inspectCommand,runProcess,eventsFromJSONL,safeEnvironment,classifyFailure } from './process.mjs';

export const CODEX_DISABLE=['shell_tool','unified_exec','apps','plugins','hooks','multi_agent','multi_agent_v2','browser_use','computer_use','image_generation','view_image','skill_search','memories','goals','sleep_tool','code_mode_host','code_mode','in_app_browser','auth_elicitation','request_permissions_tool','shell_snapshot','remote_plugin','recommended_plugins'];
const disabledCodeModeNotice='Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';
function knownStartupNotice(message){
  return message===disabledCodeModeNotice||/^Under-development features enabled: skip_host_skill_discovery\. Under-development features are incomplete and may behave unpredictably\. To suppress this warning, set `suppress_unstable_features_warning = true` in [^\n]+\/config\.toml\.$/.test(message??'');
}
export function codexArguments(model,schemaPath=fileURLToPath(new URL('../../schemas/consultant-response.json',import.meta.url)),reasoningEffort='low') {
  validateModel('astra', { model, reasoning_effort: reasoningEffort });
  return ['exec','--model',model,'--sandbox','read-only','--skip-git-repo-check','--ephemeral','--ignore-user-config','--json','--color','never','--output-schema',schemaPath,'-c','web_search="disabled"','-c','approval_policy="never"','-c',`model_reasoning_effort="${reasoningEffort}"`,'-c','suppress_unstable_features_warning=true',...CODEX_DISABLE.flatMap(name=>['--disable',name]),'--enable','skip_host_skill_discovery','-'];
}
export function normalizeCodex(output,{code=0}={}) {
  const events=eventsFromJSONL(output);
  let final=null,completed=false,turnStarted=false,usage=null,session=null,observedModel=null,diagnostics=[];
  for(const event of events){
    if(event.type==='thread.started'){session=event.thread_id??null;observedModel=event.model??null;}
    else if(event.type==='turn.started'){
      if(turnStarted||completed)fail('client_unsupported','Fresh consultation emitted more than one turn');
      turnStarted=true;
    }
    else if(['item.started','item.updated','item.completed'].includes(event.type)){
      const item=event.item;
      if(completed)fail('client_unsupported','Codex emitted an item after the terminal event');
      if(item?.type==='error'){
        if(!turnStarted&&event.type==='item.completed'&&knownStartupNotice(item.message)){diagnostics.push({kind:'startup_notice',message:item.message});continue;}
        fail(classifyFailure(item.message),'Codex reported an unsupported client error item');
      }
      if(!item||!['agent_message','reasoning'].includes(item.type))fail('permission_config_error','Consultant emitted unexpected tool or unsupported item activity');
      if(event.type==='item.completed'&&item.type==='agent_message'){
        const phase=item.phase??item.channel;
        if(phase==='commentary')continue;
        if(phase!==undefined&&phase!=='final')fail('client_unsupported','Codex assistant message has an unsupported channel');
        if(typeof item.text!=='string')fail('invalid_output','Final assistant message has no text');
        final=item.text;
      }
    }else if(event.type==='turn.completed'){
      if(completed)fail('client_unsupported','Codex emitted multiple terminal events');
      completed=true;
      const raw=event.usage;
      if(raw&&['input_tokens','output_tokens'].every(k=>Number.isSafeInteger(raw[k])&&raw[k]>=0))usage={input_tokens:raw.input_tokens,output_tokens:raw.output_tokens,cached_input_tokens:raw.cached_input_tokens??null,reasoning_output_tokens:raw.reasoning_output_tokens??null};
    }else if(['error','turn.failed'].includes(event.type))fail(classifyFailure(JSON.stringify(event)),'Codex reported a failed turn');
    else fail('client_unsupported',`Unsupported Codex event type: ${event.type}`);
  }
  if(code!==0)fail(classifyFailure(output),'Codex exited unsuccessfully');
  if(!turnStarted||!completed||final===null)fail('invalid_output','Codex exited without a completed turn and final assistant response');
  let value;try{value=JSON.parse(final);}catch{fail('invalid_output','Final Codex assistant response is not a single JSON object');}
  return {value,usage,usage_unknown_reason:usage?null:'Native usage was not reported',session_id:session,observed_model:observedModel,model_identity_source:observedModel?'client_thread_event':null,tool_activity:0,diagnostics,terminal_state:'turn.completed'};
}
export class CodexAdapter {
  constructor({executable='codex'}={}){this.executable=executable;this.kind='codex-chatgpt-astra';}
  async inspect({cwd,model='gpt-6-astra',reasoningEffort='low'}={}){
    codexArguments(model,undefined,reasoningEffort);
    const env=safeEnvironment();
    const version=await inspectCommand(this.executable,['--version'],{cwd,env});
    const number=version.match(/codex-cli\s+(\d+\.\d+\.\d+)/)?.[1];
    if(number!=='0.153.4')fail('client_unsupported',`Codex ${number??'unknown'} has no verified event/profile contract in this release`);
    const help=await inspectCommand(this.executable,['exec','--help'],{cwd,env});
    for(const flag of ['--ignore-user-config','--output-schema','--ephemeral','--json'])if(!help.includes(flag))fail('client_unsupported',`Codex is missing required ${flag}`);
    const auth=await inspectCommand(this.executable,['login','status'],{cwd,env});
    if(!/logged in using chatgpt/i.test(auth))fail(/api key/i.test(auth)?'wrong_auth_mode':'auth_required','Codex must use saved ChatGPT authentication for this room');
    return {adapter:this.kind,client_version:number,auth_mode:'chatgpt',requested_model:model,reasoning_effort:reasoningEffort,model_availability:'requires_live_validation',profile:'isolated-packet-read-only-v1',unverified:['actual account model access','effective tool inventory until live trace'],no_general_api_fallback:true};
  }
  async prepare({dir,participant}){
    const reasoningEffort=participant.reasoning_effort??'low';
    const capabilities=await this.inspect({cwd:dir,model:participant.model,reasoningEffort});
    return {command:this.executable,args:codexArguments(participant.model,undefined,reasoningEffort),cwd:dir,env:safeEnvironment(),capabilities};
  }
  async run(prepared,{prompt,policy,signal,onSpawn,onCapture}){
    const result=await runProcess(prepared.command,prepared.args,{cwd:prepared.cwd,env:prepared.env,input:prompt,timeoutMs:policy.timeout_seconds*1000,maxBytes:policy.max_output_bytes,signal,onSpawn,onCapture});
    return {...normalizeCodex(result.stdout,result),capabilities:prepared.capabilities};
  }
}
