import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const scratch=mkdtempSync(join(tmpdir(),'wapentake-package-check-'));
const destination=resolve(process.env.WAPENTAKE_PACKAGE_DIR??join(scratch,'archives'));
mkdirSync(destination,{recursive:true});
function run(command,args){
  const result=spawnSync(command,args,{encoding:'utf8',timeout:120000});
  assert.equal(result.status,0,result.error?.message??result.stderr+result.stdout);
  return result.stdout;
}
try{
  const [packed]=JSON.parse(run('npm',['pack','--offline','--ignore-scripts','--json','--pack-destination',destination]));
  const manifest=JSON.parse(readFileSync('package.json','utf8'));
  const allowed=new Set(['package.json',...manifest.files]);
  for(const file of packed.files){
    assert.ok(allowed.has(file.path)||allowed.has(file.path.split('/')[0]),`Unexpected package file: ${file.path}`);
    assert.ok(!/(?:^|\/)(?:\.env[^/]*|node_modules|\.github|tests|models\.json)$/.test(file.path)||file.path==='examples/models.json',`Private/development file: ${file.path}`);
  }
  const archive=join(destination,packed.filename);
  const hash=createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(join(destination,'SHA256SUMS'),`${hash}  ${packed.filename}\n`);
  const result=JSON.parse(run(process.execPath,['scripts/install-local.mjs','--from',archive,'--sha256',hash,'--install-root',join(scratch,'installation'),'--bin-dir',join(scratch,'bin')]));
  assert.equal(result.version,manifest.version);
  assert.equal(result.inference_performed,false);
  const report=JSON.parse(run(process.execPath,[join(scratch,'bin','wapentake'),'doctor','--offline','--runtime-only']));
  assert.equal(report.ready_offline,true);
  console.log(`Verified ${packed.filename}: allowlist, SHA-256, fresh offline installation and runtime`);
}finally{rmSync(scratch,{recursive:true,force:true});}
