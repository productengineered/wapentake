import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import { execute } from '../src/commands.mjs';
import { serve } from '../web/server.mjs';

const bin = fileURLToPath(new URL('../bin/wapentake.mjs', import.meta.url));
function cli(f, args, { project = f.project.id, identity = ['--operator'] } = {}) {
  const env = { ...process.env }; delete env.WAPENTAKE_TOKEN;
  const result = spawnSync(process.execPath, [bin, ...args, '--state-dir', f.state, '--project', project, ...identity], {
    encoding: 'utf8', env, timeout: 10000,
  });
  assert.equal(result.error, undefined);
  return { exit: result.status, ...JSON.parse(result.stdout) };
}

test('CLI missing scopes, input files and malformed events use documented input/auth errors', t => {
  const f = fixture(t), missing = join(f.root, 'missing');
  const empty = join(f.root, 'empty.json'); writeFileSync(empty, '{}');
  for (const args of [
    ['read'], ['source', 'list'], ['source', 'read'], ['cancel'],
    ['call', '--action', 'messages.get', '--input-file', empty],
    ['post', '--thread', f.thread.id, '--body-file', missing],
    ['event', '--input-file', missing],
  ]) {
    const result = cli(f, args);
    assert.equal(result.error.code, 'invalid_input', args.join(' '));
    assert.equal(result.exit, 2);
  }
  const path = cli(f, ['read', '--thread', f.thread.id], { project: missing });
  assert.equal(path.error.code, 'not_found'); assert.equal(path.exit, 2);
  assert.equal(path.error.details.cause, 'ENOENT');
  const file = cli(f, ['post', '--thread', f.thread.id, '--body-file', missing]);
  assert.equal(file.error.details.cause, 'ENOENT');
  const auth = cli(f, ['read', '--thread', f.thread.id], { identity: ['--token-file', missing] });
  assert.equal(auth.error.code, 'auth_required'); assert.equal(auth.exit, 3);
  assert.equal(auth.error.details.cause, 'ENOENT');
  for (const value of [null, [], 'text']) {
    const input = join(f.root, 'event.json'); writeFileSync(input, JSON.stringify(value));
    const result = cli(f, ['event', '--input-file', input]);
    assert.equal(result.error.code, 'invalid_input'); assert.equal(result.exit, 2);
  }
  renameSync(join(f.state, 'operator.token'), join(f.state, 'saved-operator.token'));
  const operator = cli(f, ['read', '--thread', f.thread.id]);
  assert.equal(operator.error.code, 'auth_required'); assert.equal(operator.exit, 3);
  assert.equal(operator.error.details.cause, 'ENOENT');
  assert.equal(f.room.read(f.project.id, f.thread.id).length, 0);
});

test('CLI retains conflict, storage and occupied-port reasons without leaking system codes', async t => {
  const f = fixture(t), args = ['post', '--thread', f.thread.id, '--key', 'same'];
  assert.equal(cli(f, [...args, '--body', 'First']).exit, 0);
  const conflict = cli(f, [...args, '--body', 'Changed']);
  assert.equal(conflict.exit, 4); assert.equal(conflict.error.code, 'conflict');
  const blocker = join(f.root, 'file'); writeFileSync(blocker, 'a regular file');
  const storage = cli(f, ['backup', '--out', join(blocker, 'backup')]);
  assert.equal(storage.exit, 5); assert.equal(storage.error.code, 'storage_error');
  assert.equal(storage.error.details.cause, 'ENOTDIR');
  const occupied = createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  try {
    const port = cli(f, ['serve', '--port', String(occupied.address().port)]);
    assert.equal(port.exit, 2); assert.equal(port.error.code, 'invalid_input');
    assert.equal(port.error.details.cause, 'EADDRINUSE');
  } finally { await new Promise(resolve => occupied.close(resolve)); }
});

test('Room and HTTP validate missing or malformed identifiers before binding SQLite parameters', async t => {
  const f = fixture(t), p = f.project.id;
  for (const value of [undefined, null, '', 1, {}, []]) {
    for (const read of [
      () => f.room.project(value), () => f.room.thread(p, value),
      () => f.room.message(p, value), () => f.room.source(p, value), () => f.room.job(p, value),
    ]) assert.throws(read, { code: 'invalid_input' });
  }
  for (const [action, input] of [
    ['messages.read', { project: p }], ['messages.read', { thread: f.thread.id }],
    ['messages.get', { project: p }], ['sources.read', { project: p }],
    ['jobs.cancel', { project: p }],
  ]) await assert.rejects(execute(f.room, action, input), { code: 'invalid_input' });
  const app = await serve({ store: f.store, token: f.token });
  try {
    for (const input of [
      { action: 'messages.read', project: p },
      { action: 'messages.read', thread: f.thread.id },
      { action: 'messages.get', project: p, data: {} },
      { action: 'jobs.cancel', project: p, data: { id: null } },
    ]) {
      const response = await fetch(`${app.url}/api/command`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${f.token}` },
        body: JSON.stringify(input),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'invalid_input');
    }
  } finally { await app.close(); }
});
