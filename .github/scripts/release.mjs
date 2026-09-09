import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repository=process.env.GITHUB_REPOSITORY,head=process.env.GITHUB_SHA;
assert.match(repository??'',/^[\w.-]+\/[\w.-]+$/);
assert.match(head??'',/^[a-f0-9]{40}$/);
assert.equal(process.env.GITHUB_REF,'refs/heads/main');
function gh(args){
  const result=spawnSync('gh',args,{encoding:'utf8',timeout:120000});
  assert.equal(result.status,0,result.error?.message??result.stderr);
  return result.stdout;
}
const get=path=>JSON.parse(gh(['api',`repos/${repository}/${path}`]));
assert.equal(get('commits/main').sha,head,'Main moved; start a new release run');
const runs=get(`actions/workflows/ci.yml/runs?head_sha=${head}&event=push&per_page=100`).workflow_runs;
assert.equal(runs[0]?.conclusion,'success','Latest main CI must succeed for this exact commit');
const manifest=JSON.parse(readFileSync('package.json','utf8'));
assert.match(manifest.version,/^\d+\.\d+\.\d+$/);
const changelog=readFileSync('CHANGELOG.md','utf8');
assert.ok(changelog.includes(`## ${manifest.version}`),'Version must have a changelog entry');
const directory=process.env.WAPENTAKE_PACKAGE_DIR;
assert.ok(directory);
const sums=readFileSync(join(directory,'SHA256SUMS'),'utf8');
const match=sums.match(/^([a-f0-9]{64})  ([\w.-]+\.tgz)\n$/);
assert.ok(match,'Expected exactly one archive checksum');
assert.equal(createHash('sha256').update(readFileSync(join(directory,match[2]))).digest('hex'),match[1]);
assert.equal(get('immutable-releases').enabled,true,'Enable immutable releases before drafting');
gh(['release','create',`v${manifest.version}`,join(directory,match[2]),join(directory,'SHA256SUMS'),'--repo',repository,'--target',head,'--draft','--title',`Wapentake ${manifest.version}`,'--notes',`Built from reviewed main commit ${head}. Archive contents, SHA-256 and a fresh offline installation passed verification. See CHANGELOG.md at this commit. Inspect this draft before manually publishing.`]);
console.log(`Created draft v${manifest.version} from ${head}; publication remains manual.`);
