import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,writeFileSync,mkdirSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';
import { Store,Room } from '../src/room.mjs';
import { restoreBackup } from '../src/store.mjs';
import { sha256 } from '../src/contracts.mjs';

test('future, malformed and nonempty unversioned stores refuse without replacing data',t=>{
  const f=fixture(t);
  for(const [name,prepare] of [
    ['future',db=>db.exec('CREATE TABLE sentinel(body TEXT); INSERT INTO sentinel VALUES(\'keep\'); PRAGMA user_version=99;')],
    ['unversioned',db=>db.exec('CREATE TABLE sentinel(body TEXT); INSERT INTO sentinel VALUES(\'keep\');')],
  ]){
    const dir=join(f.root,name);mkdirSync(dir);const file=join(dir,'room.sqlite'),db=new DatabaseSync(file);prepare(db);db.close();const before=sha256(readFileSync(file));
    assert.throws(()=>new Store(dir,{initialize:true}),{code:'storage_error'});assert.equal(sha256(readFileSync(file)),before);
  }
  const malformed=join(f.root,'malformed');mkdirSync(malformed);writeFileSync(join(malformed,'room.sqlite'),'not a database');assert.throws(()=>new Store(malformed),{code:'storage_error'});assert.equal(readFileSync(join(malformed,'room.sqlite'),'utf8'),'not a database');
  const post=f.room.post(f.project.id,f.thread.id,{body:'Prior message survives invalid policy.',key:'prior'});
  f.store.run("UPDATE meta SET value='not-json' WHERE key='policy'");assert.throws(()=>new Store(f.state),{code:'storage_error'});assert.equal(f.room.message(f.project.id,post.id).body,post.body);
});

test('consistent backup during writes restores a prefix and verifies captured evidence hashes',async t=>{
  const f=fixture(t),p=f.project.id,th=f.thread.id;
  writeFileSync(join(f.repo,'proof.txt'),'Retain this evidence.');const source=f.room.addSource(p,th,{path:'proof.txt',working_tree:true,key:'source'});
  for(let i=0;i<10;i++)f.room.post(p,th,{body:`Before ${i}`,source_ids:[source.id],key:`before-${i}`});
  const backup=join(f.root,'backup'),pending=f.store.backup(backup);
  const other=new Store(f.state),writer=new Room(other,f.token);
  for(let i=0;i<10;i++)writer.post(p,th,{body:`During ${i}`,source_ids:[source.id],key:`during-${i}`});other.close();await pending;
  const out=restoreBackup(backup,join(f.root,'restored')),restored=new Store(out.state_dir),room=new Room(restored,readFileSync(out.operator_token_file,'utf8').trim());
  const records=room.read(p,th);assert.ok(records.length>=10&&records.length<=20);assert.deepEqual(records.map(m=>m.seq),Array.from({length:records.length},(_,i)=>i+1));assert.equal(room.readSource(p,source.id).text,'Retain this evidence.');assert.equal(restored.get('PRAGMA integrity_check').integrity_check,'ok');restored.close();
  writeFileSync(join(backup,'projects',p,'blobs',source.blob_hash),'tampered');const bad=join(f.root,'bad-restore');assert.throws(()=>restoreBackup(backup,bad),{code:'storage_error'});assert.equal(existsSync(bad),false);
});
