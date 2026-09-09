import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync,mkdirSync,readFileSync,readlinkSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture } from './helpers.mjs';

function setup(t){
  const f=fixture(t),source=fileURLToPath(new URL('..',import.meta.url)),copy=join(f.root,'package'),installRoot=join(f.root,'shared install'),binDir=join(f.root,'local bin');
  const env={...process.env,WAPENTAKE_INSTALL_ROOT:installRoot};delete env.WAPENTAKE_CLI;delete env.WAPENTAKE_TOKEN;delete env.WAPENTAKE_STATE_DIR;
  const run=(cmd,args,cwd=f.repo)=>spawnSync(cmd,args,{cwd,env,encoding:'utf8',timeout:60000});
  const success=(cmd,args,cwd)=>{const r=run(cmd,args,cwd);assert.equal(r.status,0,r.stderr+'\n'+r.stdout);return JSON.parse(r.stdout);};
  mkdirSync(copy);const manifest=JSON.parse(readFileSync(join(source,'package.json'),'utf8'));
  cpSync(join(source,'package.json'),join(copy,'package.json'));for(const path of manifest.files)cpSync(join(source,path),join(copy,path),{recursive:true});
  function pack(version){manifest.version=version;writeFileSync(join(copy,'package.json'),JSON.stringify(manifest));const result=success('npm',['pack','--offline','--ignore-scripts','--json','--pack-destination',f.root,'--cache',join(f.root,'pack-cache')],copy)[0];return join(f.root,result.filename);}
  const install=(archive,extra=[])=>run(process.execPath,[join(source,'scripts','install-local.mjs'),'--from',archive,'--install-root',installRoot,...(extra.includes('--bin-dir')?[]:['--bin-dir',binDir]),...extra]);
  return {...f,source,installRoot,binDir,run,success,pack,install};
}

test('one shared installation updates two unchanged toolkit adapters while retaining project history',t=>{
  const f=setup(t),archive=f.pack('0.1.0');let result=f.install(archive);assert.equal(result.status,0,result.stderr);
  const first=JSON.parse(result.stdout),firstTarget=readlinkSync(join(f.installRoot,'current'));
  const post=f.room.post(f.project.id,f.thread.id,{body:'Keep the rationale during independent updates.',key:'history'});
  const second=join(f.root,'second-toolkit');mkdirSync(second);f.room.register({path:second});
  const wrappers=[];
  for(const project of [f.repo,second]){
    const path=join(project,'.claude','scripts','wapentake.sh');mkdirSync(join(project,'.claude','scripts'),{recursive:true});cpSync(join(f.source,'integrations','wapentake.sh'),path);wrappers.push({path,body:readFileSync(path,'utf8')});
    assert.equal(f.success('bash',[path,'--version']).version,'0.1.0');
  }
  result=f.install(archive);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,'already_current');
  result=f.install(f.pack('0.1.1'));assert.equal(result.status,0,result.stderr);assert.notEqual(readlinkSync(join(f.installRoot,'current')),firstTarget);
  for(const wrapper of wrappers){assert.equal(readFileSync(wrapper.path,'utf8'),wrapper.body);assert.equal(f.success('bash',[wrapper.path,'--version']).version,'0.1.1');}
  assert.equal(f.success(process.execPath,[join(f.binDir,'wapentake'),'--version']).name,'@productengineered/wapentake');
  const args=['read','--operator','--state-dir',f.state,'--thread',f.thread.id];
  assert.equal(f.success('bash',[wrappers[0].path,...args])[0].id,post.id);
  assert.notEqual(f.run('bash',[wrappers[1].path,...args]).status,0);
  assert.equal(f.room.usage(f.project.id).started,0);assert.equal(f.room.policy().execution_enabled,false);
  result=f.install(archive);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).release,first.release);
});

test('a bad update or unrelated command cannot replace the working shared installation',t=>{
  const f=setup(t),archive=f.pack('0.1.0');let result=f.install(archive);assert.equal(result.status,0,result.stderr);
  const before=readlinkSync(join(f.installRoot,'current')),hash=createHash('sha256').update(readFileSync(archive)).digest('hex');
  result=f.install(archive,['--sha256','0'.repeat(64)]);assert.notEqual(result.status,0);assert.match(result.stderr,/SHA-256/);
  assert.equal(readlinkSync(join(f.installRoot,'current')),before);
  const unrelated=join(f.root,'unrelated');mkdirSync(unrelated);writeFileSync(join(unrelated,'wapentake'),'preserve this unrelated command');
  result=f.install(archive,['--bin-dir',unrelated]);assert.notEqual(result.status,0);assert.match(result.stderr,/unrelated command/);assert.equal(readFileSync(join(unrelated,'wapentake'),'utf8'),'preserve this unrelated command');
  const invalid=join(f.root,'invalid.tgz');writeFileSync(invalid,'not an archive');result=f.install(invalid);assert.notEqual(result.status,0);assert.equal(readlinkSync(join(f.installRoot,'current')),before);
  result=f.install(archive,['--sha256',hash]);assert.equal(result.status,0,result.stderr);
});
