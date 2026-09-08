import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,cpSync,rmSync,existsSync,statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('packed module installs offline in a clean consumer and keeps state and projects separate',t=>{
  const root=mkdtempSync(join(tmpdir(),'agent-room-portability-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=fileURLToPath(new URL('..',import.meta.url)),copy=join(root,'package'),consumer=join(root,'consumer'),other=join(root,'other'),cache=join(root,'npm-cache');mkdirSync(copy);mkdirSync(consumer);mkdirSync(other);
  const manifest=JSON.parse(readFileSync(join(source,'package.json'),'utf8'));
  cpSync(join(source,'package.json'),join(copy,'package.json'));
  for(const name of manifest.files)if(existsSync(join(source,name)))cpSync(join(source,name),join(copy,name),{recursive:true});
  mkdirSync(join(copy,'runtime-state'));writeFileSync(join(copy,'runtime-state','room.sqlite'),'synthetic local history');writeFileSync(join(copy,'operator.token'),'synthetic operator credential');writeFileSync(join(copy,'.env.local'),'SYNTHETIC_ONLY=private');
  const env={...process.env};delete env.AGENT_ROOM_TOKEN;delete env.AGENT_ROOM_STATE_DIR;
  function run(command,args,cwd=consumer){const out=spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:30000});assert.equal(out.status,0,`${command} failed: ${out.stderr}\n${out.stdout}`);return out.stdout;}
  run('git',['init','--quiet']);
  const packed=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',root,'--cache',cache],copy))[0];
  const names=packed.files.map(f=>f.path);assert.ok(names.includes('web/index.html'));assert.ok(names.includes('migrations/001-initial.sql'));
  assert.ok(!names.some(n=>/room\.sqlite|operator\.token|runtime-state|\.env|node_modules|\.test-output/.test(n)));
  const archive=join(root,packed.filename),prefix=join(consumer,'.tools','agent-room');
  run('npm',['install','--prefix',prefix,'--offline','--ignore-scripts','--no-audit','--no-fund','--cache',cache,archive]);
  assert.equal(existsSync(join(consumer,'.claude')),false);
  const bin=join(prefix,'node_modules','@productengineered','agent-room','bin','agent-room.mjs'),state=join(root,'state');assert.ok(statSync(bin).mode&0o111);
  function cli(args,project=consumer){return JSON.parse(run(process.execPath,[bin,...args,'--operator','--state-dir',state,'--project',project]));}
  const p=cli(['init']).project;const thread=cli(['thread','open','--title','Portable reasoning','--mode','independent']).id;
  const post=cli(['post','--thread',thread,'--body','Needle: retain explicit original failures.','--key','one']);
  assert.equal(cli(['post','--thread',thread,'--body','Needle: retain explicit original failures.','--key','one']).id,post.id);
  cli(['decision','accept','--thread',thread,'--statement','Preserve the failure reason','--rationale','Future callers need the original contract','--citations',post.id]);
  cli(['ask','--thread',thread,'--body','Review this choice','--to','glm']);
  assert.equal(cli(['read','--thread',thread])[0].id,post.id);assert.equal(cli(['decision','list','--thread',thread])[0].status,'accepted');assert.equal(cli(['jobs'])[0].status,'queued');
  const registered=cli(['project','register','--path',other]);assert.notEqual(registered.id,p.id);assert.deepEqual(cli(['search','--query','Needle'],other),[]);
  const exportPath=join(root,'export');cli(['export','--thread',thread,'--out',exportPath]);assert.match(readFileSync(join(exportPath,'thread.md'),'utf8'),/retain explicit original failures/);
  mkdirSync(join(consumer,'.claude','scripts'),{recursive:true});cpSync(join(source,'integrations','room.sh'),join(consumer,'.claude','scripts','room.sh'));
  env.AGENT_ROOM_CLI=bin;
  const forwarded=JSON.parse(run('bash',[join(consumer,'.claude','scripts','room.sh'),'read','--thread',thread,'--operator','--state-dir',state]));assert.equal(forwarded[0].id,post.id);
  assert.equal(cli(['policy','show']).execution_enabled,false);
});
