#!/usr/bin/env node
// Prepares inspectable local packets. Never enables execution or starts a provider.
import { existsSync,readFileSync } from 'node:fs';
import { resolve,join,relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store,Room } from '../src/room.mjs';
import { privateWrite } from '../src/store.mjs';
import { buildPacket } from '../src/context.mjs';

const [stateArgument,projectArgument,...extra]=process.argv.slice(2);
if(!stateArgument||!projectArgument||extra.length)throw Error('Usage: node examples/prepare-pilot.mjs NEW_STATE_DIRECTORY PROJECT_DIRECTORY');
const state=resolve(stateArgument),projectPath=resolve(projectArgument),packagePath=fileURLToPath(new URL('..',import.meta.url));
if(existsSync(state))throw Error('Use a new dedicated pilot state directory');
const store=new Store(state,{initialize:true});
try{
  const operator=store.ensureOperator('Local pilot operator'),room=new Room(store,readFileSync(operator.tokenPath,'utf8').trim());
  const project=room.register({path:projectPath,label:'Agent Room implementation pilot'});
  room.setPolicy({execution_enabled:false,max_calls_per_day:6,max_calls_per_thread:6,automatic_follow_up_rounds:0,timeout_seconds:300});
  const actor=room.attachActor(project.id,{name:'codex:pilot-preparation',run_id:'initial'}),agent=new Room(store,readFileSync(actor.token_file,'utf8').trim());
  const thread=agent.openThread(project.id,{title:'Retain rationale across fresh sessions',mode:'independent',key:'pilot-thread'}),sources=[];
  for(const [path,required] of [['src/context.mjs',true],['src/worker.mjs',false],['docs/live-pilot.md',true]]){
    sources.push(agent.addSource(project.id,thread.id,{path:relative(projectPath,join(packagePath,path)),working_tree:true,required,key:`pilot-source:${path}`}));
  }
  const body='Can the current packet and worker design retain decision rationale across fresh sessions without replaying all history? Use the delivered code only. Identify one behavior the implementation supports, one unverified assumption, and the smallest next validation. Address independent first responses, changed evidence, and human-only decision acceptance. Cite the supplied evidence. Request bounded context for missing implementation details rather than guessing. The design requires plan-only execution, explicit invitations, bounded context, and human acceptance of decisions; these are requirements to verify, not proof of correctness.';
  const ask=agent.ask(project.id,thread.id,{body,to:['glm','astra'],source_ids:sources.filter(s=>s.required).map(s=>s.id),key:'pilot-first-question'}),packets=[];
  for(const participant of ['glm','astra']){
    const packet=buildPacket(agent,project.id,thread.id,participant);privateWrite(join(state,`${participant}-preview.md`),packet.prompt);
    packets.push({participant,bytes:packet.bytes,hash:packet.hash,estimated_tokens:packet.estimated_tokens,omissions:packet.omissions});
  }
  const summary={status:'prepared_execution_disabled',state_dir:state,project_id:project.id,thread_id:thread.id,job_ids:ask.job_ids,packets,proposed_maximum_calls:6,model_calls_performed:0,operator_token_file:operator.tokenPath};
  privateWrite(join(state,'pilot.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
}finally{store.close();}
