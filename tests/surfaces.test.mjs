import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import { serve } from '../web/server.mjs';
import { execute,workflowEvent } from '../src/commands.mjs';
import { Store,Room } from '../src/room.mjs';

test('CLI preserves restart/read/export and refuses invalid options before a write',t=>{
  const f=fixture(t),bin=fileURLToPath(new URL('../bin/agent-room.mjs',import.meta.url));
  function run(args){const env={...process.env};delete env.AGENT_ROOM_TOKEN;const result=spawnSync(process.execPath,[bin,...args,'--state-dir',f.state,'--project',f.project.id,'--operator'],{encoding:'utf8',env});return {...result,value:JSON.parse(result.stdout)};}
  const a=run(['post','--thread',f.thread.id,'--body','Quoted @astra stays text.','--key','cli-post']);assert.equal(a.status,0);
  assert.equal(run(['post','--thread',f.thread.id,'--body','Quoted @astra stays text.','--key','cli-post']).value.id,a.value.id);
  for(const bad of [['post','ignored','--thread',f.thread.id,'--body','bad'],['post','--thread',f.thread.id,'--body','bad','--author','human'],['post','--thread',f.thread.id,'--body','bad','--to','astra']])assert.equal(run(bad).status,2);
  const read=run(['read','--thread',f.thread.id]);assert.equal(read.value.length,1);assert.equal(read.value[0].id,a.value.id);
  const exportPath=join(f.root,'export');assert.equal(run(['export','--thread',f.thread.id,'--out',exportPath]).status,0);assert.match(readFileSync(join(exportPath,'thread.md'),'utf8'),/Quoted @astra stays text/);
  assert.equal(run(['work','--once']).status,3);assert.equal(f.room.jobs(f.project.id).length,0);
  assert.equal(run(['doctor','--offline','--runtime-only']).value.inference_performed,false);
});

test('workflow triggers are opt-in, causally idempotent and advisory',t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  const a=f.room.post(p,th,{body:'Reviewer one: preserve explicit failures.',key:'a'}),b=f.room.post(p,th,{body:'Reviewer two: return a sentinel.',key:'b'});
  const event={kind:'disagreement',task_id:'TASK-42',body:'Resolve the contradictory contracts.',source_ids:[a.id,b.id],key:'review-disagreement'};
  assert.equal(workflowEvent(f.room,p,event).status,'disabled');assert.equal(f.room.jobs(p).length,0);
  f.room.setPolicy({enabled_triggers:['manual','disagreement','stuck']});
  const first=workflowEvent(f.room,p,event),second=workflowEvent(f.room,p,event);assert.deepEqual(first,second);assert.equal(first.task_changed,false);assert.equal(first.advisory,true);assert.equal(f.room.jobs(p).length,2);
  assert.throws(()=>workflowEvent(f.room,p,{kind:'stuck',task_id:'TASK-43',body:'Help',source_ids:[],attempts:['same','same'],failure_signature:'failure',key:'stuck'}),{code:'invalid_input'});
  assert.equal(f.room.policy().execution_enabled,false);
});

test('shared snapshot returns recent messages without acknowledging another actor or invoking a consultant',async t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  for(let i=0;i<205;i++)f.room.post(p,th,{body:`Message ${i}`,key:`m-${i}`});
  const actor=f.room.attachActor(p,{name:'claude',run_id:'waiting'}),agent=new Room(f.store,readFileSync(actor.token_file,'utf8').trim());
  const snapshot=await execute(f.room,'snapshot',{project:p,thread:th});assert.equal(snapshot.messages.length,200);assert.equal(snapshot.messages[0].body,'Message 5');
  f.room.ack(p,th,snapshot.messages.at(-1).seq);assert.equal(agent.inbox(p)[0].unread,205);assert.equal(f.room.jobs(p).length,0);
  await assert.rejects(execute(f.room,'snapshot',{data:null}),{code:'invalid_input'});
});

test('loopback HTTP enforces capability, origin, host, role and JSON boundaries',async t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  let launches=0;
  const mockWorker={active:false,runOnce:async()=>{launches++;return {status:'idle'};}};
  const app=await serve({store:f.store,token:f.token,worker:mockWorker});t.after(()=>app.close());
  const command=async(action,data={},options={})=>{
    const r=await fetch(`${app.url}/api/command`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${f.token}`,...options.headers},body:JSON.stringify({action,project:p,thread:th,data})});return {status:r.status,...await r.json()};
  };
  const home=await fetch(app.url);assert.equal(home.status,200);assert.match(home.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.doesNotMatch(await home.text(),new RegExp(f.token));
  for(const headers of [{authorization:''},{origin:'https://untrusted.example'}])assert.ok([401,403].includes((await command('snapshot',{}, {headers})).status));
  const hostileHost=await new Promise((resolve,reject)=>{const req=request(app.url,{headers:{Host:'room.attacker.invalid'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});assert.equal(hostileHost,403);
  assert.equal((await command('snapshot',null)).status,400);
  assert.equal((await command('snapshot',{oversize:'a'.repeat(140000)})).status,400);
  const agent=f.room.attachActor(p,{name:'claude',run_id:'ui'}),agentToken=readFileSync(agent.token_file,'utf8').trim();
  assert.equal((await command('policy.update',{execution_enabled:true},{headers:{authorization:`Bearer ${agentToken}`}})).status,403);
  assert.equal((await command('worker.start',{}, {headers:{authorization:`Bearer ${agentToken}`}})).status,403);
  const dangerous='<script>throw new Error("not executed")</script>';
  assert.equal((await command('messages.post',{body:dangerous,key:'html'})).status,200);
  for(let i=0;i<3;i++)assert.equal((await command('snapshot')).result.messages[0].body,dangerous);
  assert.equal((await command('export')).status,200);assert.equal(launches,0);
  assert.equal((await fetch(`${app.url}/../src/store.mjs`)).status,404);
  await command('worker.start');await new Promise(resolve=>setTimeout(resolve,20));await command('worker.stop');assert.equal(launches,1);
});
