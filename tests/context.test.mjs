import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { buildPacket } from '../src/context.mjs';

test('bounded context retrieves old decisions amid ten thousand irrelevant peer messages',t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  const original=f.room.post(p,th,{body:'The original contract forbids converting an outage into an empty list.',key:'old'});
  f.room.decide(p,th,{statement:'Errors remain errors',rationale:'Otherwise outages look like successful empty results.',citations:[original.id],status:'accepted',key:'decision'});
  f.store.tx(()=>{for(let i=0;i<10000;i++)f.room._post(p,th,{body:`Unrelated peer observation ${i}.`,kind:'message'},{id:'test-peer',name:'Peer',role:'agent'});});
  f.room.ask(p,th,{body:'What was our error contract and why?',to:['astra'],key:'q'});
  const packet=buildPacket(f.room,p,th,'astra');
  assert.ok(packet.bytes<=32768);assert.ok(packet.prompt.includes(original.body));assert.ok(packet.prompt.includes('Otherwise outages'));
  assert.ok(packet.packet.coverage.history_omitted_count>=9990);assert.ok(packet.packet.messages.length<20);
  assert.equal(buildPacket(f.room,p,th,'astra').hash,packet.hash);
});

test('late operator corrections and both unresolved claims survive an independent boundary',t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  f.room.constrain(p,th,{body:'Use the current contract exactly.',key:'pin'});
  f.room.post(p,th,{body:'One reviewer thinks empty lists are safe.',kind:'objection',key:'one'});
  f.room.post(p,th,{body:'Another reviewer says this hides outages.',kind:'objection',key:'two'});
  const ask=f.room.ask(p,th,{body:'Resolve the contract disagreement.',to:['glm','astra'],key:'ask'});
  f.room.post(p,th,{body:'Correction: a missing upstream response must be an error.',kind:'correction',key:'late'});
  const job=f.room.job(p,ask.job_ids[0]),packet=buildPacket(f.room,p,th,job.participant_id,{job});
  for(const text of ['current contract exactly','empty lists are safe','hides outages','Correction: a missing'])assert.ok(packet.prompt.includes(text));
});

test('citing an earlier thread does not count its messages against this thread history',t=>{
  const f=fixture(t),p=f.project.id;
  const approval=f.room.post(p,f.thread.id,{body:'Approve a bounded pilot.',key:'approval'});
  const focused=f.room.openThread(p,{title:'Read the prior approval',mode:'independent',key:'focused'});
  f.room.ask(p,focused.id,{body:'What was approved?',source_ids:[approval.id],to:['glm'],key:'read-approval'});
  const packet=buildPacket(f.room,p,focused.id,'glm');
  assert.equal(packet.packet.messages.length,2);assert.equal(packet.packet.coverage.history_omitted_count,0);
  assert.ok(packet.packet.messages.some(m=>m.id===approval.id));
});

test('required oversized evidence refuses before launch and changed sources are visible',t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  writeFileSync(join(f.repo,'large.txt'),'a'.repeat(40000));
  const s=f.room.addSource(p,th,{path:'large.txt',working_tree:true,key:'large'});
  f.room.ask(p,th,{body:'Inspect every byte.',to:['astra'],key:'q'});
  assert.throws(()=>buildPacket(f.room,p,th,'astra'),{code:'needs_scoping'});
  writeFileSync(join(f.repo,'large.txt'),'changed');
  assert.throws(()=>buildPacket(f.room,p,th,'astra'),{code:'needs_scoping'});
  assert.equal(f.room.readSource(p,s.id).total_bytes,40000);
});
