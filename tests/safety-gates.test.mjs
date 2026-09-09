import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import { Store } from '../src/store.mjs';
import { validatePolicy } from '../src/contracts.mjs';
import { CodexAdapter } from '../src/adapters/codex.mjs';
import { OpenCodeAdapter, openCodeProfile } from '../src/adapters/opencode.mjs';

function fakeClient(f, name, replies) {
  const executable = join(f.root, name), log = join(f.root, `${name}.calls`);
  writeFileSync(log, '');
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const command = process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(log)}, command + '\\n');
const replies = ${JSON.stringify(replies)};
if (!Object.hasOwn(replies, command)) {
  console.error('Unexpected fake-client command'); process.exitCode = 99;
} else console.log(replies[command]);
`, { mode: 0o700 });
  return { executable, calls: () => readFileSync(log, 'utf8').trim().split('\n') };
}

test('Codex inspection enforces the pinned version, every required flag and ChatGPT authentication', async t => {
  const f = fixture(t), flags = ['--ignore-user-config', '--output-schema', '--ephemeral', '--json'];
  const good = { '--version': 'codex-cli 0.153.4', 'exec --help': flags.join(' '), 'login status': 'Logged in using ChatGPT' };
  const cases = [
    [{}, null], [{ '--version': 'codex-cli 0.153.5' }, 'client_unsupported'],
    [{ '--version': 'unrecognized client' }, 'client_unsupported'],
    [{ 'login status': 'Logged in using API key' }, 'wrong_auth_mode'],
    [{ 'login status': 'Not logged in' }, 'auth_required'],
    ...flags.map(flag => [{ 'exec --help': flags.filter(value => value !== flag).join(' ') }, 'client_unsupported']),
  ];
  for (const [patch, code] of cases) {
    const fake = fakeClient(f, 'fake-codex', { ...good, ...patch });
    const pending = new CodexAdapter({ executable: fake.executable }).inspect({ cwd: f.root });
    if (code) await assert.rejects(pending, { code });
    else {
      const result = await pending;
      assert.equal(result.client_version, '0.153.4'); assert.equal(result.auth_mode, 'chatgpt');
      assert.equal(result.no_general_api_fallback, true);
    }
    assert.ok(fake.calls().every(command => Object.hasOwn(good, command)));
  }
});

test('OpenCode inspection enforces version, flags, plan authentication and the effective deny-tools profile', async t => {
  const f = fixture(t), flags = ['--pure', '--agent', '--format', '--model'];
  const profile = openCodeProfile('zai-coding-plan/glm-5.3');
  const good = {
    '--version': '1.18.18', 'run --help': flags.join(' '), 'auth list': 'Z.AI Coding Plan',
    'debug config --pure': JSON.stringify(profile),
  };
  const cases = [
    [{}, null], [{ '--version': '1.18.19' }, 'client_unsupported'],
    [{ 'auth list': 'Z.AI general API credential' }, 'auth_required'],
    [{ 'debug config --pure': 'not JSON' }, 'client_unsupported'],
    ...flags.map(flag => [{ 'run --help': flags.filter(value => value !== flag).join(' ') }, 'client_unsupported']),
    ...[
      { permission: 'allow' }, { model: 'general-api/another-model' },
      { agent: { 'room-consultant': { permission: { '*': 'allow' } } } },
      { mcp: { external: { enabled: true } } }, { instructions: ['unexpected.md'] }, { plugin: ['unexpected'] },
    ].map(patch => [{ 'debug config --pure': JSON.stringify({ ...profile, ...patch }) }, 'permission_config_error']),
  ];
  for (const [patch, code] of cases) {
    const fake = fakeClient(f, 'fake-opencode', { ...good, ...patch });
    const pending = new OpenCodeAdapter({ executable: fake.executable }).inspect({ cwd: f.root, checkProfile: true });
    if (code) await assert.rejects(pending, { code });
    else {
      const result = await pending;
      assert.equal(result.client_version, '1.18.18'); assert.equal(result.effective_config_checked, true);
      assert.equal(result.auth_mode, 'zai-coding-plan-client-credential');
    }
    assert.ok(fake.calls().every(command => Object.hasOwn(good, command)));
  }
});

test('policy invariants and numeric bounds reject unsafe changes and valid limits survive restart', t => {
  const f = fixture(t), before = f.room.policy();
  for (const patch of [
    { schema_version: 2 }, { allow_general_api_fallback: true }, { max_global_concurrency: 2 },
    { reset_timezone: 'America/Chicago' }, { execution_enabled: 'yes' },
    { allowed_adapters: ['general-api'] }, { enabled_triggers: ['automatic'] }, { unknown: true },
  ]) assert.throws(() => f.room.setPolicy(patch), { code: 'invalid_input' });
  for (const [field, min, max] of [
    ['max_calls_per_thread', 1, 100], ['max_calls_per_day', 1, 1000], ['automatic_follow_up_rounds', 0, 1],
    ['max_packet_bytes', 1024, 131072], ['max_source_bytes', 1024, 1048576],
    ['max_retrieval_bytes', 256, 8192], ['max_output_bytes', 1024, 2097152], ['timeout_seconds', 1, 600],
  ]) {
    for (const value of [min - 1, max + 1, min + 0.5]) assert.throws(() => f.room.setPolicy({ [field]: value }), { code: 'invalid_input' });
    for (const value of [min, max]) assert.equal(validatePolicy({ [field]: value })[field], value);
  }
  assert.deepEqual(f.room.policy(), before);
  const expected = f.room.setPolicy({ max_calls_per_day: 3, max_calls_per_thread: 2 });
  const reopened = new Store(f.state);
  try { assert.deepEqual(reopened.policy(), expected); } finally { reopened.close(); }
});

test('eight concurrent CLI invitations cannot overbook a three-call allowance', async t => {
  const f = fixture(t); f.room.setPolicy({ max_calls_per_day: 3 });
  const env = { ...process.env }; delete env.WAPENTAKE_TOKEN;
  const bin = fileURLToPath(new URL('../bin/wapentake.mjs', import.meta.url));
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      bin, 'ask', '--operator', '--state-dir', f.state, '--project', f.project.id, '--thread', f.thread.id,
      '--to', 'astra', '--body', `Concurrent invitation ${index}`, '--key', `concurrent-${index}`,
    ], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', exit => {
      try { resolve({ exit, value: JSON.parse(stdout) }); } catch { reject(new Error(stderr || stdout)); }
    });
  })));
  const queued = results.filter(result => result.exit === 0), refused = results.filter(result => result.exit !== 0);
  assert.equal(queued.length, 3); assert.equal(refused.length, 5);
  assert.ok(queued.every(result => result.value.status === 'queued'));
  assert.ok(refused.every(result => result.exit === 3 && result.value.error.code === 'budget_exhausted'));
  assert.equal(f.room.usage(f.project.id).reserved, 3); assert.equal(f.room.usage(f.project.id).started, 0);
  assert.equal(f.room.jobs(f.project.id).length, 3); assert.equal(f.room.read(f.project.id, f.thread.id).length, 3);
});
