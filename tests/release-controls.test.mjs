import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function fixture(t,options={}){
  const root=mkdtempSync(join(tmpdir(),'wapentake-release-fixture-')),bin=join(root,'bin');
  t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(bin);
  const head='a'.repeat(40),archive=Buffer.from('synthetic archive bytes');
  writeFileSync(join(root,'package.json'),JSON.stringify({version:'0.3.0'}));
  writeFileSync(join(root,'CHANGELOG.md'),'## 0.3.0\nFixture release.\n');
  writeFileSync(join(root,'package.tgz'),archive);
  writeFileSync(join(root,'SHA256SUMS'),`${createHash('sha256').update(archive).digest('hex')}  package.tgz\n`);
  writeFileSync(join(root,'fixture.json'),JSON.stringify({head,...options}));
  writeFileSync(join(bin,'gh'),`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2),config=JSON.parse(fs.readFileSync('fixture.json','utf8'));
fs.appendFileSync('calls.jsonl',JSON.stringify(args)+'\\n');
let result;
if(args[0]==='release'){result={};}
else if(args[1].endsWith('/commits/main'))result={sha:config.head};
else if(args[1].includes('/actions/workflows/'))result={workflow_runs:[{head_sha:config.wrongCommit?'b'.repeat(40):config.head,conclusion:'success'}]};
else if(args[1].endsWith('/immutable-releases'))result={enabled:true};
else if(args[1].endsWith('/git/refs')){if(config.existingTag){process.stderr.write('Reference already exists');process.exit(1);}result={};}
else{process.stderr.write('Unexpected fixture command');process.exit(1);}
process.stdout.write(JSON.stringify(result));
`,{mode:0o755});
  const run=()=>spawnSync(process.execPath,[fileURLToPath(new URL('../.github/scripts/release.mjs',import.meta.url))],{cwd:root,encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,GITHUB_REPOSITORY:'fixture/project',GITHUB_SHA:head,GITHUB_REF:'refs/heads/main',WAPENTAKE_PACKAGE_DIR:root}});
  const calls=()=>readFileSync(join(root,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  return {run,calls,head};
}

test('release reserves a protected tag at the verified commit before creating its draft',t=>{
  const f=fixture(t),result=f.run();assert.equal(result.status,0,result.stderr);
  const calls=f.calls(),tag=calls.findIndex(args=>args[1]?.endsWith('/git/refs')),release=calls.findIndex(args=>args[0]==='release');
  assert.ok(tag>=0&&release>tag);
  assert.ok(calls[tag].includes(`sha=${f.head}`));
  assert.ok(calls[tag].includes('ref=refs/tags/v0.3.0'));
  assert.ok(calls[release].includes('--verify-tag'));
  assert.ok(calls[release].includes('--draft'));
});

test('release rejects CI for another commit and cannot reuse an existing version tag',t=>{
  for(const options of [{wrongCommit:true},{existingTag:true}]){
    const f=fixture(t,options),result=f.run();assert.notEqual(result.status,0);
    assert.ok(!f.calls().some(args=>args[0]==='release'));
    if(options.wrongCommit)assert.ok(!f.calls().some(args=>args[1]?.endsWith('/git/refs')));
  }
});
