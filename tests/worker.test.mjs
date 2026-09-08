import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture,response } from './helpers.mjs';
import { Worker } from '../src/worker.mjs';
import { Store,Room } from '../src/room.mjs';
import { RoomError } from '../src/contracts.mjs';
import { processIdentity } from '../src/adapters/process.mjs';

function fakeAdapters(run){
  const calls=[];
  const adapter={async prepare({participant}){return {participant,capabilities:{fixture:true}};},async run(prepared,options){calls.push({prepared,...options});const value=await run(prepared,options);return {value,usage:null,observed_model:prepared.participant.model,terminal_state:'fixture-terminal'};}};
  return {calls,adapters:new Map([['codex-chatgpt-astra',adapter],['opencode-glm-plan',adapter]])};
}

test('worker is disabled by default and one active claim blocks a second worker',async t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  f.room.ask(p,th,{body:'Compare the contract.',to:['glm','astra'],key:'ask'});
  let release,entered;const ready=new Promise(r=>entered=r);
  const fake=fakeAdapters(async()=>{entered();await new Promise(r=>release=r);return response();});
  const worker=new Worker(f.room,{adapters:fake.adapters});
  assert.equal((await worker.runOnce()).status,'disabled');assert.equal(fake.calls.length,0);
  f.room.setPolicy({execution_enabled:true});const run=worker.runOnce();await ready;
  const otherStore=new Store(f.state),other=new Worker(new Room(otherStore,f.token),{adapters:fake.adapters});
  assert.equal((await other.runOnce()).status,'busy');assert.equal(fake.calls.length,1);
  release();assert.equal((await run).status,'succeeded');assert.equal(f.room.usage(p).started,1);otherStore.close();
});

test('independent first replies do not consume the earlier answer or its proposal',async t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  const question=f.room.ask(p,th,{body:'Which contract is defensible?',to:['glm','astra'],key:'ask'});
  f.room.setPolicy({execution_enabled:true});
  const fake=fakeAdapters(async(prepared,options)=>({...response(`SECRET_FIRST_ANSWER_${prepared.participant.alias}`),proposed_decision:{statement:`PROPOSAL_${prepared.participant.alias}`,rationale:'A bounded design suggestion.',citations:[]}}));
  const worker=new Worker(f.room,{adapters:fake.adapters});
  assert.equal((await worker.runOnce()).status,'succeeded');assert.equal((await worker.runOnce()).status,'succeeded');
  assert.equal(fake.calls.length,2);assert.ok(!fake.calls[1].prompt.includes('SECRET_FIRST_ANSWER_glm'));assert.ok(!fake.calls[1].prompt.includes('PROPOSAL_glm'));
  const jobs=question.job_ids.map(id=>f.room.job(p,id));assert.equal(jobs[0].boundary_seq,jobs[1].boundary_seq);assert.ok(jobs.every(j=>j.reply_id));
  assert.equal(f.room.decisions(p,th).length,2);assert.ok(f.room.decisions(p,th).every(d=>d.status==='proposed'));
});

test('operator change during inference keeps stale reply but does not promote its proposal',async t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  f.room.ask(p,th,{body:'Recommend the behavior.',to:['astra'],key:'ask'});f.room.setPolicy({execution_enabled:true});
  const fake=fakeAdapters(async()=>{
    f.room.post(p,th,{body:'Correction: use the new constraint.',key:'correction'});
    return {...response(),proposed_decision:{statement:'Old proposal',rationale:'Old basis',citations:[]}};
  });
  const out=await new Worker(f.room,{adapters:fake.adapters}).runOnce();
  assert.equal(out.status,'succeeded');assert.equal(out.job.stale_context,1);assert.equal(f.room.decisions(p,th).length,0);
});

test('changed selected working-tree evidence is recaptured before launch',async t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  writeFileSync(join(f.repo,'contract.txt'),'old contract');const source=f.room.addSource(p,th,{path:'contract.txt',working_tree:true,key:'source'});
  f.room.ask(p,th,{body:'Inspect the current selected contract.',source_ids:[source.id],to:['astra'],key:'ask'});
  writeFileSync(join(f.repo,'contract.txt'),'new contract');f.room.setPolicy({execution_enabled:true});
  const fake=fakeAdapters(async(_p,o)=>{assert.ok(o.prompt.includes('new contract'));assert.ok(!o.prompt.includes('old contract'));return response();});
  const out=await new Worker(f.room,{adapters:fake.adapters}).runOnce();
  assert.equal(out.status,'succeeded');assert.equal(f.room.sources(p,th,{history:true}).length,2);assert.equal(f.room.readSource(p,source.id).text,'old contract');
});

test('pre-spawn auth failures release reservation; launched invalid output still consumes allowance',async t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  f.room.ask(p,th,{body:'Question.',to:['astra'],key:'ask'});f.room.setPolicy({execution_enabled:true});
  const rejected={async prepare(){throw new RoomError('wrong_auth_mode','API-key login is not permitted');}};
  const out=await new Worker(f.room,{adapters:new Map([['codex-chatgpt-astra',rejected]])}).runOnce();
  assert.equal(out.status,'failed');assert.equal(f.room.usage(p).started,0);assert.equal(f.room.usage(p).reserved,0);
  f.room.retry(p,out.job.id,'retry');const bad=fakeAdapters(async()=>({kind:'answer'}));
  assert.equal((await new Worker(f.room,{adapters:bad.adapters}).runOnce()).error.code,'invalid_output');assert.equal(f.room.usage(p).started,1);
});

test('live owner cannot be stolen; confirmed stopped recovery retains uncertain usage and never retries',async t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  const id=f.room.ask(p,th,{body:'Question.',to:['astra'],key:'ask'}).job_ids[0];
  f.store.run("UPDATE jobs SET status='running' WHERE id=?",id);f.store.run("UPDATE budget_ledger SET state='started' WHERE job_id=?",id);
  f.store.run('INSERT INTO worker_claim(singleton,job_id,owner_pid,owner_identity,heartbeat) VALUES(1,?,?,?,?)',id,process.pid,processIdentity(),'2000-01-01T00:00:00Z');
  const worker=new Worker(f.room);
  assert.throws(()=>worker.recover(p,id,{confirmStopped:true}),{code:'conflict'});
  f.store.run('UPDATE worker_claim SET owner_pid=99999999,owner_identity=? WHERE job_id=?','stopped-process',id);
  assert.equal(worker.recover(p,id,{confirmStopped:true}).job.status,'interrupted_unknown');
  assert.equal(f.room.jobs(p).length,1);assert.equal(f.room.usage(p).started,1);
});

test('cancellation during a running consultant preserves conversation and refuses its output',async t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  const id=f.room.ask(p,th,{body:'Question.',to:['astra'],key:'ask'}).job_ids[0];f.room.setPolicy({execution_enabled:true});
  const fake=fakeAdapters(async()=>{f.room.cancel(p,id);return response('Too late to promote.');});
  const out=await new Worker(f.room,{adapters:fake.adapters}).runOnce();assert.equal(out.status,'cancelled');assert.equal(f.room.read(p,th).length,1);
});

test('bounded follow-up waits for both independent answers and cannot start a third round',async t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  const participants=f.room.participants(p),astra=participants.find(p=>p.alias==='astra');
  f.room.ask(p,th,{body:'Discuss the error contract.',to:['glm','astra'],key:'ask'});f.room.setPolicy({execution_enabled:true,automatic_follow_up_rounds:1});
  const fake=fakeAdapters(async(prepared)=>({...response(),follow_up:{participant_id:astra.id,question:'What test distinguishes these cases?',citations:[]}}));
  const worker=new Worker(f.room,{adapters:fake.adapters});
  await worker.runOnce();assert.equal(f.room.jobs(p).length,2);
  await worker.runOnce();assert.equal(f.room.jobs(p).length,3);
  await worker.runOnce();assert.equal(f.room.jobs(p).length,3);assert.equal((await worker.runOnce()).status,'idle');
  const job=f.room.jobs(p).find(j=>j.round===1),packet=JSON.parse(readFileSync(join(f.store.jobDir(p,job.id),'packet.json'),'utf8'));
  assert.equal(packet.packet.messages.filter(m=>m.role==='consultant'&&m.kind==='answer').length,2);
});
