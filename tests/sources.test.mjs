import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';

function git(f, args) {
  return execFileSync('git', ['-C', f.repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function commit(f) {
  git(f, ['add', '.']);
  git(f, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Fixture evidence']);
  return git(f, ['rev-parse', 'HEAD']);
}

test('Git capture resolves HEAD and explicit revisions and reports both size limits as needs_scoping', t => {
  const f = fixture(t), p = f.project.id, th = f.thread.id;
  git(f, ['init', '-q']);
  const limit = f.room.policy().max_source_bytes;
  writeFileSync(join(f.repo, 'exact.txt'), 'x'.repeat(limit));
  writeFileSync(join(f.repo, 'oversized.txt'), 'x'.repeat(limit + 2));
  writeFileSync(join(f.repo, 'one-over.txt'), 'x'.repeat(limit + 1));
  writeFileSync(join(f.repo, 'version.txt'), 'original');
  const original = commit(f);
  writeFileSync(join(f.repo, 'version.txt'), 'changed'); const head = commit(f);
  for (const [revision, expected, contents] of [[undefined, head, 'changed'], [original, original, 'original']]) {
    const source = f.room.addSource(p, th, { path: 'version.txt', ...(revision ? { revision } : {}), key: expected });
    assert.equal(source.revision, expected); assert.equal(source.working_tree, 0);
    assert.equal(f.room.readSource(p, source.id).text, contents);
  }
  for (const working_tree of [false, true]) {
    assert.equal(f.room.addSource(p, th, { path: 'exact.txt', working_tree, key: `exact-${working_tree}` }).size, limit);
    for (const path of ['oversized.txt', 'one-over.txt']) {
      assert.throws(() => f.room.addSource(p, th, { path, working_tree, key: `${path}-${working_tree}` }), { code: 'needs_scoping' });
    }
    const env = { ...process.env }; delete env.WAPENTAKE_TOKEN;
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('../bin/wapentake.mjs', import.meta.url)), 'source', 'add', '--operator',
      '--state-dir', f.state, '--project', p, '--thread', th, '--path', 'oversized.txt',
      ...(working_tree ? ['--working-tree'] : []),
    ], { env, encoding: 'utf8' });
    assert.equal(result.status, 7); assert.equal(JSON.parse(result.stdout).error.code, 'needs_scoping');
  }
});

test('Git failures retain bounded diagnostics and non-Git projects explain working-tree capture', t => {
  const f = fixture(t), p = f.project.id, th = f.thread.id;
  writeFileSync(join(f.repo, 'proof.txt'), 'proof');
  assert.throws(() => f.room.addSource(p, th, { path: 'proof.txt', key: 'no-git' }), error => {
    assert.equal(error.code, 'invalid_input'); assert.match(error.message, /--working-tree/);
    assert.ok(error.details.git.length > 0 && error.details.git.length <= 500); return true;
  });
  assert.equal(f.room.addSource(p, th, { path: 'proof.txt', working_tree: true, key: 'working' }).working_tree, 1);
  git(f, ['init', '-q']); commit(f);
  writeFileSync(join(f.repo, 'untracked.txt'), 'untracked');
  const diagnostics = [];
  for (const options of [{ path: 'proof.txt', revision: 'deadbeef' }, { path: 'untracked.txt' }]) {
    assert.throws(() => f.room.addSource(p, th, { ...options, key: options.path }), error => {
      assert.equal(error.code, 'invalid_input');
      assert.ok(error.details.git.length > 0 && error.details.git.length <= 500);
      diagnostics.push(error.details.git); return true;
    });
  }
  assert.notEqual(diagnostics[0], diagnostics[1]);
});
