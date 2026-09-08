import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync,readFileSync,mkdirSync,symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture,response } from './helpers.mjs';
import { Store,Room } from '../src/room.mjs';
import { restoreBackup } from '../src/store.mjs';
import { validateResponse } from '../src/contracts.mjs';

test('messages are immutable, ordered and idempotent; restart retains their identity',t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  const a=f.room.post(p,th,{body:'Preserve the original question.',key:'a'});
  assert.equal(f.room.post(p,th,{body:'Preserve the original question.',key:'a'}).id,a.id);
  assert.throws(()=>f.room.post(p,th,{body:'Changed payload',key:'a'}),{code:'conflict'});
  assert.throws(()=>f.store.run('UPDATE messages SET body=? WHERE id=?','rewritten',a.id),/immutable/);
  assert.throws(()=>f.store.run('DELETE FROM messages WHERE id=?',a.id),/immutable/);
  const second=new Store(f.state),room=new Room(second,f.token);
  assert.equal(room.read(p,th)[0].body,a.body); second.close();
});

test('twenty simultaneous writers with duplicate delivery produce twenty messages',async t=>{
  const f=fixture(t),module=fileURLToPath(new URL('../src/room.mjs',import.meta.url));
  const code=`import{Store,Room}from${JSON.stringify(module)};import{readFileSync}from'node:fs';const s=new Store(process.argv[1]);const r=new Room(s,readFileSync(process.argv[2],'utf8').trim());const o={body:'Writer '+process.argv[5],key:process.argv[5]};r.post(process.argv[3],process.argv[4],o);r.post(process.argv[3],process.argv[4],o);s.close();`;
  await Promise.all(Array.from({length:20},(_,i)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',code,f.state,join(f.state,'operator.token'),f.project.id,f.thread.id,String(i)],{stdio:['ignore','ignore','pipe']});
    let stderr='';child.stderr.on('data',c=>stderr+=c);child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(stderr)));
  })));
  const messages=f.room.read(f.project.id,f.thread.id);
  assert.equal(messages.length,20);assert.equal(new Set(messages.map(m=>m.id)).size,20);
  assert.deepEqual(messages.map(m=>m.seq),[...messages.map(m=>m.seq)].sort((a,b)=>a-b));
});

test('agent capability cannot cross projects, impersonate operator or accept decisions',t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  const agent=f.room.attachActor(p,{name:'claude:developer',run_id:'one'}),r=new Room(f.store,readFileSync(agent.token_file,'utf8').trim());
  mkdirSync(join(f.root,'other'));const other=f.room.register({path:join(f.root,'other'),label:'Other'});
  assert.throws(()=>r.project(other.id),{code:'forbidden'});
  assert.throws(()=>r.search(other.id,'private'),{code:'forbidden'});
  assert.throws(()=>r.post(p,th,{body:'I am human',author_role:'operator',key:'bad'}),{code:'invalid_input'});
  assert.throws(()=>r.setPolicy({execution_enabled:true}),{code:'forbidden'});
  assert.throws(()=>r.decide(p,th,{statement:'Accept',rationale:'because',status:'accepted',key:'bad'}),{code:'forbidden'});
  const message=r.post(p,th,{body:'Agent proposal',key:'ok'});assert.equal(message.author_role,'agent');
  const proposal=r.decide(p,th,{statement:'Use a typed error',rationale:'Preserve failure',key:'proposal'});assert.equal(proposal.status,'proposed');
  assert.throws(()=>f.room.post(other.id,f.room.openThread(other.id,{title:'Other',key:'other'}).id,{body:'Bad cross reference',source_ids:[message.id],key:'cross'}),{code:'not_found'});
});

test('human constraints and decision versions retain exact text and old rationale',t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  const a=f.room.constrain(p,th,{body:'Keep public access disabled.',key:'a'});
  const b=f.room.constrain(p,th,{body:'Enable public access only for the sample route.',stable_id:a.stable_id,key:'b'});
  assert.equal(b.version,2);assert.equal(f.room.constraints(p,th).length,1);
  assert.equal(f.room.message(p,a.source_message_id).body,'Keep public access disabled.');
  const d=f.room.decide(p,th,{statement:'Return errors',rationale:'Do not hide outages',key:'d'});
  const accepted=f.room.decide(p,th,{statement:d.statement,rationale:d.rationale,stable_id:d.stable_id,status:'accepted',key:'accept'});
  assert.equal(accepted.version,2);assert.equal(f.room.decisions(p,th,{history:true}).length,2);
});

test('explicit source capture blocks escapes/secrets and returns bounded UTF-8',t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  writeFileSync(join(f.repo,'contract.txt'),'hello 🌎; errors remain errors');
  writeFileSync(join(f.repo,'.env.local'),'FAKE_SECRET=synthetic');
  writeFileSync(join(f.root,'outside.txt'),'outside');symlinkSync(join(f.root,'outside.txt'),join(f.repo,'escape.txt'));
  for(const path of ['../outside.txt','.env.local','escape.txt'])assert.throws(()=>f.room.addSource(p,th,{path,working_tree:true,key:path}),{code:'forbidden'});
  const source=f.room.addSource(p,th,{path:'contract.txt',working_tree:true,key:'source'});
  assert.equal(f.room.readSource(p,source.id,0,7).text,'hello ');
  assert.throws(()=>f.room.readSource(p,source.id,7,8),{code:'invalid_input'});
  assert.equal(f.room.readSource(p,source.id).source.working_tree,1);
});

test('search and acknowledgments are bounded reads, never consultant invitations',t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  const m=f.room.post(p,th,{body:'Quoted @astra is ordinary text. Contract errors remain visible.',key:'a'});
  assert.equal(f.room.search(p,'contract')[0].id,m.id);
  assert.equal(f.room.inbox(p)[0].unread,1);assert.equal(f.room.inbox(p)[0].unread,1);
  f.room.ack(p,th,m.seq);assert.equal(f.room.inbox(p).length,0);
  assert.equal(f.room.jobs(p).length,0);
});

test('invitations reserve local budgets atomically and preserve independent boundary',t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  f.room.setPolicy({max_calls_per_day:2});
  const a=f.room.ask(p,th,{body:'Which contract?',to:['glm','astra'],key:'ask'});
  assert.equal(a.status,'queued');assert.equal(a.execution_enabled,false);
  assert.deepEqual(f.room.ask(p,th,{body:'Which contract?',to:['glm','astra'],key:'ask'}).job_ids,a.job_ids);
  assert.equal(new Set(f.room.jobs(p).map(j=>j.boundary_seq)).size,1);
  assert.throws(()=>f.room.ask(p,th,{body:'Extra',to:['glm'],key:'extra'}),{code:'budget_exhausted'});
  assert.equal(f.room.read(p,th).length,1);assert.equal(f.room.usage(p).reserved,2);
  f.room.cancel(p,a.job_ids[0]);assert.equal(f.room.usage(p).reserved,1);
});

test('backup and restore preserve messages, source hashes, pending jobs and disable execution',async t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  writeFileSync(join(f.repo,'contract.txt'),'An explicit contract.');const src=f.room.addSource(p,th,{path:'contract.txt',working_tree:true,key:'s'});
  const q=f.room.ask(p,th,{body:'Contract?',to:['glm'],source_ids:[src.id],key:'q'});
  f.room.setPolicy({execution_enabled:true});
  const backup=join(f.root,'backup'),restored=join(f.root,'restored');await f.store.backup(backup);
  const out=restoreBackup(backup,restored),store=new Store(restored),room=new Room(store,readFileSync(out.operator_token_file,'utf8').trim());
  assert.equal(room.read(p,th)[0].id,q.question.id);assert.equal(room.policy().execution_enabled,false);
  assert.equal(room.job(p,q.job_ids[0]).status,'queued');assert.equal(room.readSource(p,src.id).text,'An explicit contract.');
  store.close();
});

test('strict final response refuses malformed/unknown citations and role fields',()=>{
  assert.equal(validateResponse(response()).kind,'answer');
  for(const input of [{kind:'answer'}, {...response(),author_role:'operator'},response('claim',['unknown']),{...response(),kind:'needs_context'}])assert.throws(()=>validateResponse(input),{code:'invalid_output'});
});
