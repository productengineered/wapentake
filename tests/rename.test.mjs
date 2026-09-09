import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture } from './helpers.mjs';
import { resolveModels, modelsPath } from '../src/models.mjs';
import { stateRoot } from '../src/store.mjs';

test('the Wapentake CLI reads existing conversation data through its named environment settings', t => {
  const f=fixture(t),env={...process.env,WAPENTAKE_STATE_DIR:f.state,WAPENTAKE_TOKEN:f.token};
  const run=args=>spawnSync(process.execPath,[fileURLToPath(new URL('../bin/wapentake.mjs',import.meta.url)),...args],{encoding:'utf8',env});
  const version=run(['--version']);assert.equal(version.status,0,version.stdout);
  assert.equal(JSON.parse(version.stdout).name,'@productengineered/wapentake');
  f.room.post(f.project.id,f.thread.id,{body:'Preserve this history.',key:'rename'});
  const result=run(['read','--project',f.project.id,'--thread',f.thread.id]);
  assert.equal(result.status,0,result.stdout);assert.equal(JSON.parse(result.stdout)[0].body,'Preserve this history.');
  const mixed=run(['policy','show','--operator']);assert.equal(mixed.status,2);assert.equal(JSON.parse(mixed.stdout).error.code,'invalid_input');
});

test('model and state defaults use Wapentake paths with explicit environment overrides', t => {
  const f=fixture(t),config=join(f.root,'config'),state=join(f.root,'state-home');
  const env={XDG_CONFIG_HOME:config,XDG_STATE_HOME:state};
  assert.equal(modelsPath(env),join(config,'wapentake','models.json'));
  assert.equal(stateRoot(env),join(state,'wapentake'));
  const file=join(f.root,'models.json');writeFileSync(file,readFileSync(new URL('../examples/models.json',import.meta.url)));
  const explicit={...env,WAPENTAKE_MODELS_FILE:file,WAPENTAKE_STATE_DIR:f.state,WAPENTAKE_MODEL_PROFILE:'toolkit'};
  assert.equal(modelsPath(explicit),file);assert.equal(stateRoot(explicit),f.state);
  assert.equal(resolveModels({env:explicit}).model_profile,'toolkit');
});

test('a broken model configuration link refuses rather than selecting implicit models', t => {
  const f=fixture(t),config=join(f.root,'config');mkdirSync(join(config,'wapentake'),{recursive:true});
  symlinkSync(join(config,'missing.json'),join(config,'wapentake','models.json'));
  assert.throws(()=>resolveModels({env:{XDG_CONFIG_HOME:config}}),{code:'invalid_input'});
});
