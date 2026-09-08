import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCodex,codexArguments } from '../src/adapters/codex.mjs';
import { normalizeOpenCode,openCodeProfile } from '../src/adapters/opencode.mjs';
import { safeEnvironment,runProcess,processAlive,processIdentity } from '../src/adapters/process.mjs';
import { response } from './helpers.mjs';

const codex=value=>[{type:'thread.started',thread_id:'diagnostic-session'},{type:'turn.started'},{type:'item.completed',item:{id:'reply',type:'agent_message',text:JSON.stringify(value)}},{type:'turn.completed',usage:{input_tokens:200,output_tokens:50}}].map(JSON.stringify).join('\n');
const opencode=value=>[{type:'step_start',sessionID:'session'},{type:'text',part:{type:'text',text:JSON.stringify(value)}},{type:'step_finish',part:{reason:'stop',tokens:{input:200,output:50}}}].map(JSON.stringify).join('\n');

test('native parsers accept only final assistant output with a successful terminal event',()=>{
  assert.equal(normalizeCodex(codex(response())).value.kind,'answer');assert.equal(normalizeOpenCode(opencode(response())).value.kind,'answer');
  assert.throws(()=>normalizeCodex(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(response())}})),{code:'invalid_output'});
  assert.throws(()=>normalizeOpenCode(JSON.stringify({type:'text',part:{text:JSON.stringify(response())}})),{code:'invalid_output'});
  assert.throws(()=>normalizeCodex(codex(response()),{code:1}),{code:'provider_error'});
});

test('tool JSON, unknown events and malformed terminal data do not become room answers',()=>{
  const tool=JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:JSON.stringify(response())}});
  assert.throws(()=>normalizeCodex(tool+'\n'+codex(response())),{code:'permission_config_error'});
  assert.throws(()=>normalizeOpenCode(JSON.stringify({type:'tool_use',part:{output:JSON.stringify(response())}})),{code:'permission_config_error'});
  assert.throws(()=>normalizeCodex(JSON.stringify({type:'new.terminal.schema'})),{code:'client_unsupported'});
  assert.throws(()=>normalizeOpenCode(opencode(response()).replace('"stop"','"length"')),{code:'invalid_output'});
});

test('commentary-only output and extra turns cannot masquerade as a final answer',()=>{
  const commentary=codex(response()).replace('"type":"agent_message"','"type":"agent_message","phase":"commentary"');
  assert.throws(()=>normalizeCodex(commentary),{code:'invalid_output'});
  assert.throws(()=>normalizeCodex(codex(response())+'\n'+JSON.stringify({type:'turn.started'})),{code:'client_unsupported'});
  assert.throws(()=>normalizeOpenCode(opencode(response())+'\n'+JSON.stringify({type:'step_start'})),{code:'client_unsupported'});
  assert.throws(()=>normalizeOpenCode(JSON.stringify({type:'reasoning',part:{type:'tool'}})),{code:'permission_config_error'});
  assert.equal(normalizeCodex(codex(response()).replace('"type":"agent_message"','"type":"agent_message","phase":"final"')).value.kind,'answer');
});

test('unavailable process inspection does not turn a live owner into a recoverable stopped process',()=>{
  const identity=processIdentity();assert.ok(identity);
  assert.equal(processAlive(process.pid,identity,()=>null),true);
  assert.equal(processAlive(process.pid,identity,()=>identity),true);
  assert.equal(processAlive(process.pid,identity,()=>identity+' different process'),false);
});

test('adapter profiles preserve explicit models, remove API overrides and always start fresh',()=>{
  const args=codexArguments('gpt-6-astra');assert.ok(args.includes('--ignore-user-config'));assert.ok(args.includes('--ephemeral'));
  for(const flag of ['--continue','--session','--last','resume'])assert.ok(!args.includes(flag));
  assert.throws(()=>codexArguments('another-model'),{code:'model_unavailable'});
  const profile=openCodeProfile('zai-coding-plan/glm-5.3');assert.equal(profile.permission,'deny');assert.deepEqual(profile.enabled_providers,['zai-coding-plan']);
  const env=safeEnvironment({HOME:'/unchanged',PATH:'/bin',OPENAI_API_KEY:'synthetic',CODEX_API_KEY:'synthetic',OPENAI_BASE_URL:'https://not-used.invalid',AGENT_ROOM_TOKEN:'never-forward',OPENCODE_CONFIG_CONTENT:'untrusted'});
  assert.equal(env.HOME,'/unchanged');for(const name of ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','AGENT_ROOM_TOKEN','OPENCODE_CONFIG_CONTENT'])assert.equal(env[name],undefined);
});

test('process boundary handles timeout, output limits and split Unicode without a shell',async()=>{
  const split=await runProcess(process.execPath,['-e',"const b=Buffer.from('🌎');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),10)"],{timeoutMs:1000});
  assert.equal(split.stdout,'🌎');
  await assert.rejects(runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:50}),{code:'timeout'});
  await assert.rejects(runProcess(process.execPath,['-e',"process.stdout.write('x'.repeat(10000))"],{timeoutMs:1000,maxBytes:1000}),{code:'invalid_output'});
});
