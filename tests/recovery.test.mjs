import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { fixture } from './helpers.mjs';
import { Store, Room } from '../src/room.mjs';
import { restoreBackup } from '../src/store.mjs';
import { Worker } from '../src/worker.mjs';

function blockedWorker(t, state, phase) {
  const child = fork(new URL('./fixtures/blocked-worker.mjs', import.meta.url), [state, phase], {
    execPath: process.execPath, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = once(child, 'close');
  const kill = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  };
  t.after(kill);
  const message = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Fake worker timed out: ${stderr}`)), 10000);
    const onMessage = value => finish(null, value);
    const onClose = () => finish(new Error(`Fake worker exited early: ${stderr}`));
    function finish(error, value) {
      clearTimeout(timer);
      child.off('message', onMessage); child.off('close', onClose); child.off('error', finish);
      if (error) reject(error); else resolve(value);
    }
    child.once('message', onMessage); child.once('close', onClose); child.once('error', finish);
  });
  return { child, kill, message };
}

function invite(f) {
  f.room.setPolicy({ execution_enabled: true, max_calls_per_thread: 1 });
  return f.room.ask(f.project.id, f.thread.id, {
    body: 'Exercise process loss with a fake adapter.', to: ['astra'], key: 'crash',
  }).job_ids[0];
}
const ledger = (store, id) => store.get('SELECT state FROM budget_ledger WHERE job_id=?', id).state;

test('a killed preparing worker releases its reservation only after confirmed-stopped recovery', async t => {
  const f = fixture(t), p = f.project.id, id = invite(f), worker = new Worker(f.room);
  const process = blockedWorker(t, f.state, 'preparing');
  assert.equal(await process.message(), 'preparing');
  assert.throws(() => worker.recover(p, id, { confirmStopped: true }), { code: 'conflict' });
  await process.kill();
  assert.equal(worker.inspectRecovery(p, id).owner_alive, false);
  assert.deepEqual(worker.claim(), { status: 'busy', job_id: id, recovery_required: true });
  assert.throws(() => worker.recover(p, id), { code: 'invalid_input' });
  assert.equal(ledger(f.store, id), 'reserved');
  assert.equal(worker.recover(p, id, { confirmStopped: true }).job.status, 'interrupted_unknown');
  assert.equal(ledger(f.store, id), 'released');
  assert.equal(f.room.usage(p).reserved, 0);
  assert.equal(f.room.jobs(p).length, 1);
  const event = f.store.get("SELECT details FROM job_events WHERE job_id=? AND event='operator_reconciled' ORDER BY rowid DESC LIMIT 1", id);
  assert.equal(JSON.parse(event.details).reservation_released, true);
  worker.recover(p, id, { confirmStopped: true });
  assert.equal(ledger(f.store, id), 'released');
  assert.equal(f.room.retry(p, id, 'explicit-retry').status, 'queued');
  assert.equal(f.room.usage(p).reserved, 1);
});

test('recovery repairs a preparing reservation already reconciled by an older release', async t => {
  const f = fixture(t), id = invite(f), process = blockedWorker(t, f.state, 'preparing');
  await process.message(); await process.kill();
  f.store.tx(() => {
    f.store.run("UPDATE jobs SET status='interrupted_unknown',error_code='interrupted_unknown' WHERE id=?", id);
    f.store.run('DELETE FROM worker_claim WHERE job_id=?', id);
    f.store.event(id, 'operator_reconciled', { automatic_retry: false });
  });
  new Worker(f.room).recover(f.project.id, id, { confirmStopped: true });
  assert.equal(ledger(f.store, id), 'released');
});

test('a killed running worker remains charged after recovery and a retry needs another slot', async t => {
  const f = fixture(t), id = invite(f), process = blockedWorker(t, f.state, 'running');
  assert.equal(await process.message(), 'running');
  await process.kill();
  new Worker(f.room).recover(f.project.id, id, { confirmStopped: true });
  assert.equal(ledger(f.store, id), 'started');
  assert.equal(f.room.usage(f.project.id).started, 1);
  assert.throws(() => f.room.retry(f.project.id, id, 'retry'), { code: 'budget_exhausted' });
});

test('a preparing backup cannot release a reservation when the original worker later launched', async t => {
  const f = fixture(t), id = invite(f), process = blockedWorker(t, f.state, 'preparing');
  await process.message();
  const backup = join(f.root, 'backup');
  await f.store.backup(backup);
  const running = process.message(); process.child.send('continue');
  assert.equal(await running, 'running');
  await process.kill();
  assert.equal(ledger(f.store, id), 'started');
  const out = restoreBackup(backup, join(f.root, 'restored'));
  const restored = new Store(out.state_dir);
  try {
    const room = new Room(restored, readFileSync(out.operator_token_file, 'utf8').trim());
    assert.equal(room.policy().execution_enabled, false);
    assert.equal(room.job(f.project.id, id).status, 'interrupted_unknown');
    assert.equal(ledger(restored, id), 'reserved');
    const worker = new Worker(room);
    worker.recover(f.project.id, id, { confirmStopped: true });
    worker.recover(f.project.id, id, { confirmStopped: true });
    assert.equal(ledger(restored, id), 'reserved');
    assert.throws(() => room.retry(f.project.id, id, 'retry'), { code: 'budget_exhausted' });
    assert.throws(() => new Room(restored, f.token), { code: 'auth_required' });
  } finally { restored.close(); }
});
