import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture, response } from './helpers.mjs';
import { Room } from '../src/room.mjs';
import { Worker } from '../src/worker.mjs';
import { execute } from '../src/commands.mjs';
import { serve } from '../web/server.mjs';

function attached(f, role = 'runner', run = 'epic') {
  const actor = f.room.attachActor(f.project.id, { name: 'coordinator', run_id: run, role });
  const token = readFileSync(actor.token_file, 'utf8').trim();
  return { actor, token, room: new Room(f.store, token) };
}
function fakeAdapters(overrides = {}) {
  let calls = 0;
  const adapter = {
    async prepare({ participant }) { return { participant, capabilities: {} }; },
    async run({ participant }) { calls++; return { value: response(), observed_model: participant.model, terminal_state: 'fixture' }; },
    ...overrides,
  };
  return { calls: () => calls, adapters: new Map([['opencode-glm-plan', adapter], ['codex-chatgpt-astra', adapter]]) };
}

test('a named job bypasses older unrelated queue entries and runs exactly once under the shared allowance', async t => {
  const f = fixture(t), p = f.project.id, thread = f.thread.id;
  const older = f.room.ask(p, thread, { body: 'Older operator job.', to: ['glm'], key: 'older' }).job_ids[0];
  const runner = attached(f);
  const own = runner.room.ask(p, thread, { body: 'Named coordinator job.', to: ['astra'], key: 'own' }).job_ids[0];
  f.room.setPolicy({ execution_enabled: true });
  const fake = fakeAdapters(), worker = new Worker(runner.room, fake);
  const result = await worker.runJob(p, own);
  assert.equal(result.job_id, own); assert.equal(result.status, 'succeeded');
  assert.equal(f.room.job(p, older).status, 'queued'); assert.equal(fake.calls(), 1);
  await assert.rejects(worker.runJob(p, own), { code: 'conflict' });
  assert.equal(fake.calls(), 1); assert.equal(f.room.usage(p).started, 1);
  assert.equal(f.room.usage(p).reserved, 1);
  await assert.rejects(worker.runOnce(), { code: 'forbidden' });
});

test('runner permission does not extend to other invitations, projects, operator actions or expired capabilities', async t => {
  const f = fixture(t), p = f.project.id, thread = f.thread.id, runner = attached(f), other = attached(f, 'runner', 'other'), agent = attached(f, 'agent', 'plain');
  const own = runner.room.ask(p, thread, { body: 'Own.', to: ['astra'], key: 'own' }).job_ids[0];
  const theirs = other.room.ask(p, thread, { body: 'Other.', to: ['astra'], key: 'other' }).job_ids[0];
  const path = join(f.root, 'another-project'); mkdirSync(path);
  const foreign = f.room.register({ path });
  const foreignThread = f.room.openThread(foreign.id, { title: 'Other project', key: 'other-thread' });
  const foreignJob = f.room.ask(foreign.id, foreignThread.id, { body: 'Other project.', to: ['glm'], key: 'foreign' }).job_ids[0];
  assert.throws(() => new Worker(agent.room, fakeAdapters()), { code: 'forbidden' });
  const worker = new Worker(runner.room, fakeAdapters());
  await assert.rejects(worker.runJob(p, theirs), { code: 'forbidden' });
  await assert.rejects(worker.runJob(foreign.id, foreignJob), { code: 'forbidden' });
  await assert.rejects(worker.runJob(p, foreignJob), { code: 'not_found' });
  for (const [action, data] of [
    ['policy.update', { execution_enabled: true }],
    ['decisions.set', { statement: 'Accept.', rationale: 'Not authorized.', status: 'accepted', key: 'accept' }],
    ['projects.register', { path: f.repo }],
    ['actors.attach', { name: 'other', run_id: 'run' }],
    ['actors.revoke', { id: other.actor.id }],
    ['worker.once', {}],
  ]) await assert.rejects(execute(runner.room, action, { project: p, thread, data }), { code: 'forbidden' });
  f.store.run('UPDATE actor_sessions SET expires_at=? WHERE id=?', '2000-01-01T00:00:00.000Z', runner.actor.id);
  await assert.rejects(worker.runJob(p, own), { code: 'auth_required' });
  assert.equal(f.room.job(p, own).status, 'queued');
});

test('an occupied claim refuses a named job and identifies the blocking job without launching anything else', async t => {
  const f = fixture(t), p = f.project.id, thread = f.thread.id, runner = attached(f);
  const first = f.room.ask(p, thread, { body: 'Claimed first.', to: ['glm'], key: 'first' }).job_ids[0];
  const own = runner.room.ask(p, thread, { body: 'Wait.', to: ['astra'], key: 'own' }).job_ids[0];
  f.room.setPolicy({ execution_enabled: true });
  const fake = fakeAdapters();
  const claim = new Worker(f.room, fake).claim(); assert.equal(claim.job.id, first);
  await assert.rejects(new Worker(runner.room, fake).runJob(p, own), error => error.code === 'conflict' && error.details.blocking_job_id === first && error.details.job_id === own);
  assert.equal(fake.calls(), 0); assert.equal(f.room.job(p, own).status, 'queued');
  assert.equal(f.room.usage(p).started, 0);
});

test('revocation during preparation prevents launch and releases only that confirmed unlaunched reservation', async t => {
  const f = fixture(t), runner = attached(f), p = f.project.id;
  const id = runner.room.ask(p, f.thread.id, { body: 'Prepare then revoke.', to: ['astra'], key: 'revoke' }).job_ids[0];
  f.room.setPolicy({ execution_enabled: true });
  const fake = fakeAdapters({ async prepare({ participant }) { f.room.revokeActor(p, runner.actor.id); return { participant, capabilities: {} }; } });
  const result = await new Worker(runner.room, fake).runJob(p, id);
  assert.equal(result.status, 'auth_required'); assert.equal(fake.calls(), 0);
  assert.equal(f.room.usage(p).started, 0); assert.equal(f.room.usage(p).reserved, 0);
  assert.equal(f.room.exportThread(p, f.thread.id).records.jobs[0].provenance.metadata_status, 'incomplete');
  const replacement = attached(f, 'runner', 'replacement');
  await assert.rejects(new Worker(replacement.room, fakeAdapters()).runJob(p, id), { code: 'forbidden' });
});

test('revocation after launch refuses promotion and preserves the launched charge', async t => {
  const f = fixture(t), runner = attached(f), p = f.project.id;
  const id = runner.room.ask(p, f.thread.id, { body: 'Already launched.', to: ['astra'], key: 'in-flight' }).job_ids[0];
  f.room.setPolicy({ execution_enabled: true });
  const fake = fakeAdapters({ async run() { f.room.revokeActor(p, runner.actor.id); return { value: response(), observed_model: null, terminal_state: 'fixture' }; } });
  const result = await new Worker(runner.room, fake).runJob(p, id);
  assert.equal(result.status, 'auth_required');
  assert.equal(f.room.usage(p).started, 1);
  assert.equal(f.room.job(p, id).reply_id, null);
});

test('HTTP named execution retains the requesting runner authority and cannot borrow the server operator', async t => {
  const f = fixture(t), runner = attached(f), other = attached(f, 'runner', 'other'), p = f.project.id;
  const own = runner.room.ask(p, f.thread.id, { body: 'Own request.', to: ['astra'], key: 'own' }).job_ids[0];
  const theirs = other.room.ask(p, f.thread.id, { body: 'Other request.', to: ['astra'], key: 'other' }).job_ids[0];
  f.room.setPolicy({ execution_enabled: true });
  const fake = fakeAdapters(), server = await serve({ store: f.store, token: f.token, worker: new Worker(f.room, fake) });
  try {
    const call = async (action, data = {}) => {
      const result = await fetch(`${server.url}/api/command`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${runner.token}` }, body: JSON.stringify({ action, project: p, data }) });
      return { status: result.status, value: await result.json() };
    };
    assert.equal((await call('worker.start')).status, 403);
    assert.equal((await call('worker.once')).status, 403);
    assert.equal((await call('jobs.recover', { id: own, confirm_stopped: true })).status, 403);
    assert.equal((await call('jobs.inspect', { id: own })).status, 403);
    assert.equal((await call('worker.job', { id: theirs })).status, 403);
    const result = await call('worker.job', { id: own });
    assert.equal(result.status, 200); assert.equal(result.value.result.job_id, own);
    assert.equal(result.value.result.status, 'succeeded'); assert.equal(fake.calls(), 1);
  } finally { await server.close(); }
});

test('CLI work --job returns only its own successful result, preserves once, and refuses invalid combinations', t => {
  const f = fixture(t), runner = attached(f), p = f.project.id, fakeBin = join(f.root, 'bin'); mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'codex'), `#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='--version')console.log('codex-cli 0.153.4');
else if(args.join(' ')==='exec --help')console.log('--ignore-user-config --output-schema --ephemeral --json');
else if(args.join(' ')==='login status')console.log('Logged in using ChatGPT');
else if(args[0]==='exec'){
  process.stdin.resume();process.stdin.on('end',()=>{
    const value={schema_version:1,kind:'answer',body:'Fake provider response.',citations:[],context_requests:[],proposed_decision:null,follow_up:null};
    for(const event of [{type:'thread.started',thread_id:'fake-session'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}},{type:'turn.completed'}])console.log(JSON.stringify(event));
  });
} else process.exitCode=99;
`, { mode: 0o700 });
  const own = runner.room.ask(p, f.thread.id, { body: 'CLI.', to: ['astra'], key: 'cli' }).job_ids[0];
  const bin = fileURLToPath(new URL('../bin/wapentake.mjs', import.meta.url));
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }; delete env.WAPENTAKE_TOKEN;
  const run = (args, token = runner.actor.token_file) => spawnSync(process.execPath, [bin, ...args, '--state-dir', f.state, '--project', p, ...(token ? ['--token-file', token] : ['--operator'])], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(run(['work', '--job', own]).status, 3);
  assert.equal(run(['work', '--once', '--job', own]).status, 2);
  assert.equal(run(['work', '--once']).status, 3);
  f.room.setPolicy({ execution_enabled: true });
  const result = run(['work', '--job', own]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).job_id, own); assert.equal(JSON.parse(result.stdout).status, 'succeeded');
  assert.equal(run(['work', '--job', own]).status, 4);
  assert.equal(run(['work', '--job', 'missing']).status, 2);
  assert.equal(JSON.parse(run(['work', '--once'], null).stdout).status, 'idle');
});
