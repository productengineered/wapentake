import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture, response } from './helpers.mjs';
import { Store, Room } from '../src/room.mjs';
import { restoreBackup } from '../src/store.mjs';
import { Worker } from '../src/worker.mjs';

// Schema 2 adds only these tables/triggers; removing them yields the real v1 layout.
function legacy(f) {
  f.store.db.exec('DROP TRIGGER job_models_immutable_update; DROP TRIGGER job_models_immutable_delete; DROP TABLE job_models; DROP TABLE actor_grants; PRAGMA user_version=1;');
  f.store.close();
  return new Store(f.state, { allowLegacy: true });
}

test('v1 migration backs up first, preserves queued jobs and history, and freezes the original model settings', async t => {
  const f = fixture(t), attached = f.room.attachActor(f.project.id, { name: 'old coordinator', run_id: 'old' });
  const token = readFileSync(attached.token_file, 'utf8').trim(), agent = new Room(f.store, token);
  const asked = agent.ask(f.project.id, f.thread.id, { body: 'Original question.', to: ['astra', 'glm'], key: 'original' });
  const store = legacy(f); t.after(() => store.close());
  assert.throws(() => new Store(f.state), /backup-first/);
  const result = await store.migrate(join(f.root, 'before-v2'));
  assert.equal(result.schema_version, 2); assert.equal(result.execution_enabled, false);
  const snapshot = new DatabaseSync(join(result.backup, 'room.sqlite'), { readOnly: true });
  assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(snapshot.prepare('SELECT count(*) n FROM jobs').get().n, 2); snapshot.close();
  const room = new Room(store, token);
  assert.equal(room.read(f.project.id, f.thread.id)[0].body, 'Original question.');
  for (const id of asked.job_ids) {
    const model = store.jobModel(id);
    assert.equal(model.owner_actor_id, attached.id);
    assert.equal(model.selection.configuration_source, 'legacy_job_snapshot');
    assert.equal(model.selection.model, room.job(f.project.id, id).requested_model);
    assert.equal(room.job(f.project.id, id).status, 'queued');
  }
  assert.equal(store.jobModel(asked.job_ids[0]).selection.reasoning_effort, 'low');
  assert.equal(store.authenticate(token).execution_scope, null);
  assert.equal(room.exportThread(f.project.id, f.thread.id).records.jobs[0].provenance.metadata_status, 'not_prepared');
  const restored = restoreBackup(result.backup, join(f.root, 'restored-v1'));
  assert.equal(restored.migration_required, true);
  const oldCopy = new Store(restored.state_dir, { allowLegacy: true }); t.after(() => oldCopy.close());
  assert.throws(() => oldCopy.authenticate(token), { code: 'auth_required' });
  await oldCopy.migrate(join(f.root, 'restored-before-v2'));
  assert.equal(oldCopy.jobModel(asked.job_ids[0]).owner_actor_id, attached.id);
  assert.equal(oldCopy.policy().execution_enabled, false);
});

test('migration refuses enabled execution or claims, and rolls back unsupported legacy model data', async t => {
  const f = fixture(t), id = f.room.ask(f.project.id, f.thread.id, { body: 'Preserve.', to: ['astra'], key: 'q' }).job_ids[0];
  const store = legacy(f); t.after(() => store.close());
  store.setPolicy({ ...store.policy(), execution_enabled: true });
  await assert.rejects(store.migrate(join(f.root, 'enabled')), { code: 'conflict' });
  store.setPolicy({ ...store.policy(), execution_enabled: false });
  store.run("UPDATE jobs SET status='preparing' WHERE id=?", id);
  await assert.rejects(store.migrate(join(f.root, 'active')), { code: 'conflict' });
  store.run("UPDATE jobs SET status='queued',requested_model='unknown-provider/model' WHERE id=?", id);
  await assert.rejects(store.migrate(join(f.root, 'rollback')), { code: 'model_unavailable' });
  assert.equal(store.get('PRAGMA user_version').user_version, 1);
  assert.equal(store.get("SELECT name FROM sqlite_master WHERE name='job_models'"), undefined);
  assert.equal(store.get('SELECT requested_model FROM jobs WHERE id=?', id).requested_model, 'unknown-provider/model');
  assert.ok(readFileSync(join(f.root, 'rollback', 'manifest.json')));
});

test('migration refuses a changed store during backup and leaves the saved prefix readable', async t => {
  const f = fixture(t), store = legacy(f); t.after(() => store.close());
  const originalBackup = store.backup.bind(store);
  store.backup = async out => {
    const result = await originalBackup(out), other = new Store(f.state, { allowLegacy: true });
    other.run("UPDATE projects SET label='Concurrent writer' WHERE id=?", f.project.id); other.close();
    return result;
  };
  await assert.rejects(store.migrate(join(f.root, 'changed')), { code: 'conflict' });
  assert.equal(store.get('PRAGMA user_version').user_version, 1);
  const snapshot = new DatabaseSync(join(f.root, 'changed', 'room.sqlite'), { readOnly: true });
  assert.equal(snapshot.prepare('SELECT label FROM projects').get().label, 'Test project'); snapshot.close();
});

test('schema-2 export joins each message to complete normalized provenance without copying private client output', async t => {
  const f = fixture(t), p = f.project.id, th = f.thread.id;
  for (let i = 0; i < 25; i++) f.room._post(p, th, { body: `Optional peer context ${i}.`, kind: 'message' }, { id: 'peer', name: 'Peer', role: 'agent' });
  writeFileSync(join(f.repo, 'contract.txt'), 'Captured evidence.');
  const source = f.room.addSource(p, th, { path: 'contract.txt', working_tree: true, key: 'source' });
  const ids = f.room.ask(p, th, { body: 'Review.', to: ['glm', 'astra'], source_ids: [source.id], key: 'q' }).job_ids;
  f.room.setPolicy({ execution_enabled: true });
  const adapter = {
    async prepare({ participant }) { return { participant, capabilities: { client_version: 'fixture-1', private_diagnostic: 'PRIVATE_CAPABILITY_DETAIL' } }; },
    async run({ participant }) { return { value: response(`Answer from ${participant.alias}.`, [source.id]), observed_model: participant.alias === 'glm' ? participant.model : null, model_identity_source: participant.alias === 'glm' ? 'fixture_session' : null, session_id: `session-${participant.alias}`, native: 'PRIVATE_NATIVE_OUTPUT', terminal_state: 'fixture' }; },
  };
  const worker = new Worker(f.room, { adapters: new Map([['opencode-glm-plan', adapter], ['codex-chatgpt-astra', adapter]]) });
  for (const id of ids) assert.equal((await worker.runJob(p, id)).status, 'succeeded');
  const records = f.room.exportThread(p, th).records;
  assert.equal(records.schema_version, 2);
  for (const job of records.jobs) {
    const provenance = job.provenance;
    assert.equal(provenance.metadata_status, 'captured');
    assert.ok(provenance.omissions.length > 10);
    assert.equal(provenance.coverage.optional_omissions.length, 10);
    assert.equal(provenance.client_version, 'fixture-1');
    assert.equal(provenance.source_manifest[0].sha256, source.blob_hash);
    assert.match(provenance.packet_hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(records.messages.find(m => m.id === job.reply_id).provenance, provenance);
  }
  const glm = records.jobs[0].provenance, astra = records.jobs[1].provenance;
  assert.equal(glm.observed_model, 'zai-coding-plan/glm-5.3'); assert.equal(glm.model_identity_source, 'fixture_session');
  assert.equal(astra.observed_model, null); assert.equal(astra.model_identity_verified, false);
  assert.equal(astra.session_id, 'session-astra');
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_CAPABILITY_DETAIL|PRIVATE_NATIVE_OUTPUT/);
  const dir = f.store.jobDir(p, ids[0]), path = join(dir, 'output.json'), original = readFileSync(path, 'utf8');
  const altered = JSON.parse(original); altered.observed_model = 'a-different-model';
  writeFileSync(path, JSON.stringify(altered));
  assert.throws(() => f.room.exportThread(p, th), { code: 'storage_error' });
  writeFileSync(path, original); rmSync(join(dir, 'invocation.json'));
  assert.deepEqual(f.room.exportThread(p, th).records.jobs[0].provenance.missing_captures, ['invocation.json']);
});

test('export includes an old thread job after more than 500 newer project jobs', t => {
  const f = fixture(t), p = f.project.id;
  const first = f.room.ask(p, f.thread.id, { body: 'Old retained job.', to: ['astra'], key: 'old' }).job_ids[0];
  f.room.cancel(p, first);
  const later = f.room.openThread(p, { title: 'New activity', key: 'later' });
  f.store.tx(() => {
    for (let i = 0; i < 501; i++) {
      const id = f.room.ask(p, later.id, { body: 'Newer activity.', to: ['astra'], key: `new-${i}` }).job_ids[0];
      f.room.cancel(p, id);
    }
  });
  assert.equal(f.room.jobs(p).some(j => j.id === first), false);
  const exported = f.room.exportThread(p, f.thread.id).records.jobs;
  assert.deepEqual(exported.map(j => j.id), [first]);
});

test('legacy GLM identity can come from separately captured session verification only when it matches the job', async t => {
  const f = fixture(t), p = f.project.id, th = f.thread.id;
  const id = f.room.ask(p, th, { body: 'Legacy capture.', to: ['glm'], key: 'old-capture' }).job_ids[0];
  f.room.setPolicy({ execution_enabled: true });
  const adapter = { async prepare() { return { capabilities: {} }; }, async run() { return { value: response(), observed_model: null, session_id: 'legacy-glm-session', terminal_state: 'fixture' }; } };
  assert.equal((await new Worker(f.room, { adapters: new Map([['opencode-glm-plan', adapter]]) }).runJob(p, id)).status, 'succeeded');
  const path = join(f.store.jobDir(p, id), 'client-session-verification.json');
  const evidence = { observed_model: 'zai-coding-plan/glm-5.3', model_identity_source: 'client_session_metadata', provider: 'zai-coding-plan', session_id: 'legacy-glm-session', finish: 'stop', tool_activity: 0 };
  writeFileSync(path, JSON.stringify(evidence));
  const result = f.room.exportThread(p, th).records.jobs[0].provenance;
  assert.equal(result.model_identity_verified, true);
  assert.equal(result.observed_model, evidence.observed_model);
  assert.equal(result.model_identity_source, 'client_session_metadata');
  assert.match(result.session_verification_metadata_hash, /^[a-f0-9]{64}$/);
  writeFileSync(path, JSON.stringify({ ...evidence, session_id: 'another-session' }));
  assert.throws(() => f.room.exportThread(p, th), { code: 'storage_error' });
});
