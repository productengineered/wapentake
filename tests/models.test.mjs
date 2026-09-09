import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture, response } from './helpers.mjs';
import { Room } from '../src/room.mjs';
import { Worker } from '../src/worker.mjs';
import { modelsPath, readModelConfig, resolveModels } from '../src/models.mjs';
import { codexArguments } from '../src/adapters/codex.mjs';
import { openCodeProfile } from '../src/adapters/opencode.mjs';

const example = () => JSON.parse(readFileSync(new URL('../examples/models.json', import.meta.url)));

test('user defaults and consumer profiles resolve without a store or inference, and explicit profile wins over the environment', t => {
  const f = fixture(t), file = join(f.root, 'models.json'), config = example();
  config.profiles.toolkit.astra = { reasoning_effort: 'medium' };
  config.profiles['5wth-ops'].glm = { model: 'zai-coding-plan/glm-5.2' };
  writeFileSync(file, JSON.stringify(config));
  const env = { XDG_CONFIG_HOME: join(f.root, 'xdg'), WAPENTAKE_MODELS_FILE: file, WAPENTAKE_MODEL_PROFILE: '5wth-ops' };
  assert.equal(modelsPath(env), file);
  assert.equal(resolveModels({ env }).models.glm.model, 'zai-coding-plan/glm-5.2');
  const selected = resolveModels({ env, profile: 'toolkit', roles: ['astra', 'adjudicator'] });
  assert.equal(selected.models.astra.reasoning_effort, 'medium');
  assert.equal(selected.models.adjudicator.model, 'openai/gpt-5.6-sol');
  assert.equal(selected.models.adjudicator.adapter, 'opencode-openai');
  assert.equal(selected.inference_performed, false);
  assert.throws(() => resolveModels({ env, profile: 'unknown' }), { code: 'invalid_input' });
  assert.throws(() => readModelConfig({ file: join(f.root, 'missing') }), { code: 'invalid_input' });
});

test('configuration rejects malformed files, provider changes, latest aliases and executable options before reserving a call', t => {
  const f = fixture(t), file = join(f.root, 'models.json');
  const room = new Room(f.store, f.token, { modelsFile: file });
  const cases = [
    'not JSON', JSON.stringify({ ...example(), schema_version: 2 }),
    JSON.stringify({ ...example(), api_key: 'synthetic-not-a-real-key' }),
    JSON.stringify({ defaults: example().defaults, schema_version: 1, profiles: { default: {} } }),
    JSON.stringify({ schema_version: 1, defaults: { glm: { model: 'zai/general-api' } } }),
    JSON.stringify({ schema_version: 1, defaults: { glm: { model: 'zai-coding-plan/glm-latest' } } }),
    JSON.stringify({ schema_version: 1, defaults: { astra: { model: 'gpt-6-astra', reasoning_effort: 'none' } } }),
    JSON.stringify({ schema_version: 1, defaults: { astra: { model: 'gpt-6-astra', args: ['--yolo'] } } }),
    JSON.stringify({ schema_version: 1, defaults: { astra: { model: 'gpt-6-astra --yolo' } } }),
  ];
  for (const value of cases) {
    writeFileSync(file, value);
    assert.throws(() => room.ask(f.project.id, f.thread.id, { body: 'Review.', to: ['glm', 'astra'], key: 'bad-config' }));
  }
  assert.equal(f.room.jobs(f.project.id).length, 0);
  assert.equal(f.room.usage(f.project.id).reserved, 0);
  writeFileSync(file, JSON.stringify(example()));
  const inside = join(f.repo, 'models.json'); writeFileSync(inside, JSON.stringify(example()));
  assert.throws(() => new Room(f.store, f.token, { modelsFile: inside }).ask(f.project.id, f.thread.id, { body: 'Review.', to: ['glm'], key: 'inside' }), { code: 'invalid_input' });
});

test('queued jobs, duplicate requests and retries keep their model and reasoning after the user edits or removes the configuration', async t => {
  const f = fixture(t), file = join(f.root, 'models.json'), config = example();
  writeFileSync(file, JSON.stringify(config));
  const room = new Room(f.store, f.token, { modelsFile: file, modelProfile: '5wth-ops' });
  const question = { body: 'Review this exact selection.', to: ['astra'], key: 'frozen' };
  const asked = room.ask(f.project.id, f.thread.id, question), id = asked.job_ids[0];
  const frozen = f.store.jobModel(id);
  config.profiles['5wth-ops'].astra = { model: 'gpt-5.6-sol', reasoning_effort: 'medium' };
  writeFileSync(file, JSON.stringify(config));
  assert.deepEqual(room.ask(f.project.id, f.thread.id, question).job_ids, asked.job_ids);
  const newer = room.ask(f.project.id, f.thread.id, { ...question, key: 'new-selection' }).job_ids[0];
  assert.equal(f.store.jobModel(newer).selection.model, 'gpt-5.6-sol');
  assert.notEqual(f.store.jobModel(newer).selection.configuration_hash, frozen.selection.configuration_hash);
  writeFileSync(file, 'now deliberately malformed');
  f.room.setPolicy({ execution_enabled: true });
  const seen = [];
  const adapter = {
    async prepare({ participant }) { seen.push(participant); return { participant, capabilities: { fixture: true } }; },
    async run(prepared, { prompt }) {
      assert.ok(prompt.includes('"requested_model":"gpt-6-astra"'));
      assert.ok(prompt.includes('"reasoning_effort":"high"'));
      return { value: response(), observed_model: null, terminal_state: 'fixture' };
    },
  };
  const result = await new Worker(room, { adapters: new Map([['codex-chatgpt-astra', adapter]]) }).runJob(f.project.id, id);
  assert.equal(result.status, 'succeeded');
  assert.equal(seen[0].model, 'gpt-6-astra'); assert.equal(seen[0].reasoning_effort, 'high');
  assert.equal(room.exportThread(f.project.id, f.thread.id).records.jobs[0].provenance.model_identity_verified, false);
  f.room.cancel(f.project.id, newer);
  const retry = f.room.retry(f.project.id, newer, 'retry');
  assert.deepEqual(f.store.jobModel(retry.id).selection, f.store.jobModel(newer).selection);
  assert.deepEqual(f.store.jobModel(id), frozen);
  assert.throws(() => f.store.run('UPDATE job_models SET settings=? WHERE job_id=?', '{}', id), /immutable/);
});

test('a cross-consultant follow-up inherits the target reviewer selection and original invitation owner', async t => {
  const f = fixture(t), file = join(f.root, 'models.json');
  writeFileSync(file, JSON.stringify(example()));
  const actor = f.room.attachActor(f.project.id, { name: 'coordinator', run_id: 'epic', role: 'runner' });
  const runner = new Room(f.store, readFileSync(actor.token_file, 'utf8').trim(), { modelsFile: file });
  const asked = runner.ask(f.project.id, f.thread.id, { body: 'Compare.', to: ['glm', 'astra'], key: 'pair' });
  f.room.setPolicy({ execution_enabled: true, automatic_follow_up_rounds: 1 });
  const astra = f.room.participants(f.project.id).find(p => p.alias === 'astra');
  const adapter = {
    async prepare({ participant }) { return { participant, capabilities: {} }; },
    async run({ participant }) {
      return { value: { ...response(), follow_up: participant.alias === 'glm' ? { participant_id: astra.id, question: 'What evidence changes this?', citations: [] } : null }, observed_model: participant.model, terminal_state: 'fixture' };
    },
  };
  const worker = new Worker(runner, { adapters: new Map([['codex-chatgpt-astra', adapter], ['opencode-glm-plan', adapter]]) });
  await worker.runJob(f.project.id, asked.job_ids[0]);
  writeFileSync(file, 'malformed after enqueue');
  await worker.runJob(f.project.id, asked.job_ids[1]);
  const follow = f.room.jobs(f.project.id).find(job => job.round === 1);
  assert.ok(follow);
  assert.deepEqual(f.store.jobModel(follow.id), f.store.jobModel(asked.job_ids[1]));
  assert.equal(runner.authorizeJob(f.project.id, follow.id).id, follow.id);
});

test('configured model arguments retain isolated authentication and permissions', () => {
  const args = codexArguments('gpt-5.6-sol', undefined, 'high');
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.6-sol');
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('read-only'));
  const profile = openCodeProfile('zai-coding-plan/glm-5.2');
  assert.equal(profile.model, 'zai-coding-plan/glm-5.2');
  assert.equal(profile.permission, 'deny');
  assert.deepEqual(profile.enabled_providers, ['zai-coding-plan']);
  assert.throws(() => openCodeProfile('zai/glm-5.2'), { code: 'model_unavailable' });
});

test('model CLI creates a private user file once and resolves the consumer environment without opening room state', t => {
  const f = fixture(t), configRoot = join(f.root, 'user-config'), bin = fileURLToPath(new URL('../bin/wapentake.mjs', import.meta.url));
  const env = { ...process.env, XDG_CONFIG_HOME: configRoot, WAPENTAKE_STATE_DIR: join(f.root, 'not-initialized'), WAPENTAKE_MODEL_PROFILE: '5wth-ops' };
  delete env.WAPENTAKE_TOKEN; delete env.WAPENTAKE_MODELS_FILE;
  const run = args => spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(run(['models', 'init']).status, 3);
  const created = run(['models', 'init', '--operator']); assert.equal(created.status, 0, created.stdout);
  assert.equal(JSON.parse(created.stdout).path, join(configRoot, 'wapentake', 'models.json'));
  assert.equal(run(['models', 'init', '--operator']).status, 4);
  const resolved = run(['models', 'resolve', '--for', 'adjudicator']); assert.equal(resolved.status, 0, resolved.stdout);
  assert.equal(JSON.parse(resolved.stdout).models.adjudicator.model, 'openai/gpt-5.6-sol');
  assert.equal(JSON.parse(resolved.stdout).model_profile, '5wth-ops');
  assert.equal(run(['models', 'validate']).status, 0);
  assert.equal(run(['models', 'resolve', '--model-profile', 'missing']).status, 2);
});
