import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseDocument } from 'yaml';

function run(command,args){
  const result=spawnSync(command,args,{encoding:'utf8'});
  assert.equal(result.status,0,result.error?.message??result.stderr+result.stdout);
  return result.stdout;
}
const files=run('git',['ls-files','-z']).split('\0').filter(Boolean);
for(const file of files){
  const source=readFileSync(file,'utf8');
  if(file.endsWith('.json'))JSON.parse(source);
  if(/\.ya?ml$/.test(file))assert.deepEqual(parseDocument(source,{uniqueKeys:true}).errors,[],file);
  if(/\.(?:mjs|js)$/.test(file))run(process.execPath,['--check',file]);
  if(file.endsWith('.py'))run('python3',['-c','import ast,sys; ast.parse(open(sys.argv[1]).read())',file]);
  if(file.endsWith('.md')){
    const prose=source.replace(/```[^]*?```/g,'');
    for(const match of prose.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)){
      const target=match[1].split('#')[0];
      if(!target||/^[a-z]+:|^\//i.test(target))continue;
      assert.ok(existsSync(resolve(dirname(file),decodeURIComponent(target))),`${file}: broken link ${target}`);
    }
  }
}
const manifest=JSON.parse(readFileSync('package.json','utf8'));
const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
assert.equal(lock.version,manifest.version);
assert.equal(lock.packages[''].version,manifest.version);
assert.ok(readFileSync('CHANGELOG.md','utf8').includes(`## ${manifest.version}`),'Changelog must describe the package version');
assert.deepEqual(manifest.dependencies??{},{});
const directory=run('git',['rev-parse','--git-path','wapentake-tools']).trim();
run(join(directory,'shellcheck'),files.filter(file=>file.endsWith('.sh')||file.startsWith('.githooks/')));
run(join(directory,'actionlint'),['-shellcheck',join(directory,'shellcheck')]);
console.log(`Quality checks passed for ${files.length} tracked files`);
