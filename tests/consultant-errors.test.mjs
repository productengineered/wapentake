import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, response } from './helpers.mjs';
import { Worker } from '../src/worker.mjs';
import { OpenCodeAdapter } from '../src/adapters/opencode.mjs';

const openCodeEvents = sessionID => [
  { type: 'step_start', ...(sessionID === undefined ? {} : { sessionID }) },
  { type: 'text', part: { text: JSON.stringify(response()) } },
  { type: 'step_finish', part: { reason: 'stop' } },
].map(JSON.stringify).join('\n');

test('a consultant requesting an unknown source yields CLI exit 6 and retains the launched charge', t => {
  const f = fixture(t), p = f.project.id;
  const id = f.room.ask(p, f.thread.id, { body: 'Read the evidence.', to: ['astra'], key: 'unknown-source' }).job_ids[0];
  f.room.setPolicy({ execution_enabled: true });
  const value = { ...response(), kind: 'needs_context', context_requests: [
    { kind: 'read', source_id: 'unknown-source', offset_bytes: 0, max_bytes: 20 },
  ] };
  const native = [
    { type: 'thread.started', thread_id: 'fake-session' }, { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } },
    { type: 'turn.completed' },
  ].map(JSON.stringify).join('\n');
  const bin = join(f.root, 'fake-bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'codex'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('codex-cli 0.153.4');
else if (args[0] === 'exec' && args[1] === '--help') console.log('--ignore-user-config --output-schema --ephemeral --json');
else if (args.join(' ') === 'login status') console.log('Logged in using ChatGPT');
else if (args[0] === 'exec') console.log(${JSON.stringify(native)});
else process.exitCode = 2;
`, { mode: 0o700 });
  // Restrict executable lookup to the fake client and macOS system utilities.
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` }; delete env.WAPENTAKE_TOKEN;
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('../bin/wapentake.mjs', import.meta.url)), 'work', '--once', '--operator', '--state-dir', f.state,
  ], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 6);
  const out = JSON.parse(result.stdout);
  assert.equal(out.error.code, 'invalid_output'); assert.equal(out.job.error_code, 'invalid_output');
  assert.equal(f.store.get('SELECT state FROM budget_ledger WHERE job_id=?', id).state, 'started');
  assert.equal(f.room.read(p, f.thread.id).length, 1);
});

test('OpenCode refuses a missing or malformed session ID before trying metadata export', async t => {
  const f = fixture(t), adapter = new OpenCodeAdapter({ executable: join(f.root, 'must-not-exist') });
  for (const session of [undefined, null, '', '   ', 12, {}]) {
    await assert.rejects(adapter.normalizeCapture({
      cwd: f.root, command: adapter.executable, capabilities: { requested_model: 'zai-coding-plan/glm-5.3' },
    }, { stdout: openCodeEvents(session), code: 0 }), { code: 'invalid_output' });
  }
});

test('an OpenCode metadata subprocess that cannot spawn never refunds the completed inference', async t => {
  const f = fixture(t), p = f.project.id;
  const id = f.room.ask(p, f.thread.id, { body: 'Exercise capture failure.', to: ['glm'], key: 'capture' }).job_ids[0];
  f.room.setPolicy({ execution_enabled: true });
  const executable = join(f.root, 'fake-opencode'), marker = join(f.root, 'inference-ran');
  // Remove this disposable executable after its fake inference so export fails
  // with ENOENT. No installed provider is ever invoked by this test.
  writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)}, 'launched');
fs.unlinkSync(__filename);
console.log(${JSON.stringify(openCodeEvents('fake-session'))});
`, { mode: 0o700 });
  const native = new OpenCodeAdapter({ executable });
  const adapter = {
    async prepare({ dir, participant }) {
      return { command: executable, args: [], cwd: dir, capabilities: { requested_model: participant.model } };
    },
    run: native.run.bind(native),
  };
  const out = await new Worker(f.room, { adapters: new Map([['opencode-glm-plan', adapter]]) }).runOnce();
  assert.equal(existsSync(marker), true);
  assert.equal(out.status, 'failed'); assert.equal(out.error.code, 'client_unsupported');
  assert.equal(f.store.get('SELECT state FROM budget_ledger WHERE job_id=?', id).state, 'started');
  assert.equal(f.room.usage(p).started, 1);
});
