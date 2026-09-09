import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { enumeration, fail, fingerprint, keys, object, sha256, text } from './contracts.mjs';
import { setting, userPath, present } from './identity.mjs';

export const MODEL_ROLES = Object.freeze({
  glm: { adapter: 'opencode-glm-plan', pattern: /^zai-coding-plan\/glm-[a-zA-Z0-9][a-zA-Z0-9._-]*$/ },
  astra: { adapter: 'codex-chatgpt-astra', pattern: /^gpt-[a-zA-Z0-9][a-zA-Z0-9._-]*$/ },
  adjudicator: { adapter: 'opencode-openai', pattern: /^openai\/gpt-[a-zA-Z0-9][a-zA-Z0-9._-]*$/ },
});

// Compatibility values are used only when no user file or named profile was selected.
// A user configuration replaces these defaults; missing roles in that file are errors.
export const LEGACY_MODELS = Object.freeze({
  glm: { model: 'zai-coding-plan/glm-5.3' },
  astra: { model: 'gpt-6-astra', reasoning_effort: 'low' },
  adjudicator: { model: 'openai/gpt-5.5' },
});

export function modelsPath(env = process.env) {
  return resolve(setting('MODELS_FILE', env) || userPath('models', env));
}

export function validateModel(role, value, { partial = false } = {}) {
  const definition = Object.hasOwn(MODEL_ROLES, role) ? MODEL_ROLES[role] : null;
  if (!definition) fail('invalid_input', 'Unknown model role');
  keys(value, role === 'astra' ? ['model', 'reasoning_effort'] : ['model'], `${role} model`);
  if (!partial || Object.hasOwn(value, 'model')) {
    if (typeof value.model !== 'string' || value.model.length > 200 || !definition.pattern.test(value.model) || /(?:^|[-/])latest(?:$|[-/])/i.test(value.model)) {
      fail('model_unavailable', `Select an explicit ${role} model on its existing authentication route; no provider or latest-alias fallback is allowed`);
    }
  }
  if (Object.hasOwn(value, 'reasoning_effort')) enumeration(value.reasoning_effort, ['low', 'medium', 'high', 'xhigh'], 'reasoning effort');
  return { ...value };
}

function validateRoles(roles, partial) {
  keys(roles, Object.keys(MODEL_ROLES), 'model roles');
  for (const [role, value] of Object.entries(roles)) validateModel(role, value, { partial });
}

export function readModelConfig({ file, env = process.env } = {}) {
  const path = file === undefined ? modelsPath(env) : resolve(text(file, 'models file', 2000));
  if (!present(path)) {
    if (file !== undefined || setting('MODELS_FILE', env)) fail('invalid_input', 'The selected model configuration file does not exist', { path });
    const config = { schema_version: 1, defaults: LEGACY_MODELS, profiles: {} };
    return { config, path: null, configuration_hash: fingerprint(config), source: 'legacy_compatibility_defaults' };
  }
  let bytes, canonical;
  try {
    canonical = realpathSync(path);
    const stat = statSync(canonical);
    if (!stat.isFile() || stat.size > 65536) fail('invalid_input', 'Model configuration must be a regular JSON file of at most 64 KiB');
    bytes = readFileSync(canonical);
    if (bytes.length > 65536) fail('invalid_input', 'Model configuration exceeds 64 KiB');
  } catch (error) {
    if (error.code === 'invalid_input') throw error;
    fail('invalid_input', 'Cannot read the model configuration', { path, cause: error.code ?? error.name });
  }
  let config;
  try { config = JSON.parse(bytes); } catch { fail('invalid_input', 'Model configuration is not valid JSON'); }
  keys(config, ['schema_version', 'defaults', 'profiles'], 'model configuration');
  if (config.schema_version !== 1) fail('invalid_input', 'Unsupported model configuration schema');
  validateRoles(config.defaults, false);
  object(config.profiles ?? {}, 'model profiles');
  if (Object.keys(config.profiles ?? {}).length > 100) fail('invalid_input', 'At most 100 model profiles are supported');
  for (const [name, roles] of Object.entries(config.profiles ?? {})) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name) || ['default', '__proto__', 'constructor', 'prototype'].includes(name)) fail('invalid_input', 'Invalid or reserved model profile name');
    validateRoles(roles, true);
  }
  return { config, path: canonical, configuration_hash: sha256(bytes), source: 'user_file' };
}

export function resolveModels({ roles = ['glm', 'astra'], profile, file, env = process.env, document } = {}) {
  const loaded = document ?? readModelConfig({ file, env });
  const selected = profile ?? setting('MODEL_PROFILE', env) ?? 'default';
  text(selected, 'model profile', 100);
  const overrides = selected === 'default' ? {} : loaded.config.profiles?.[selected];
  if (!overrides || !Object.hasOwn(loaded.config.profiles ?? {}, selected) && selected !== 'default') fail('invalid_input', 'Unknown model profile', { profile: selected });
  const models = {};
  for (const role of roles) {
    if (!Object.hasOwn(MODEL_ROLES, role)) fail('invalid_input', 'Unknown model role');
    const value = validateModel(role, { ...loaded.config.defaults[role], ...overrides[role] });
    const reasoning = role === 'astra' ? value.reasoning_effort ?? 'low' : null;
    models[role] = {
      schema_version: 1, role, adapter: MODEL_ROLES[role].adapter,
      model: value.model, reasoning_effort: reasoning,
      model_profile: selected, configuration_source: loaded.source,
      configuration_file: loaded.path, configuration_hash: loaded.configuration_hash,
    };
  }
  return { schema_version: 1, model_profile: selected, configuration_file: loaded.path, configuration_hash: loaded.configuration_hash, models, inference_performed: false };
}

export function legacySelection(participant, model = participant.model) {
  const value = { model, ...(participant.alias === 'astra' ? { reasoning_effort: 'low' } : {}) };
  validateModel(participant.alias, value);
  return {
    schema_version: 1, role: participant.alias, adapter: participant.adapter, model,
    reasoning_effort: participant.alias === 'astra' ? 'low' : null,
    model_profile: null, configuration_source: 'legacy_job_snapshot', configuration_file: null,
    configuration_hash: fingerprint({ adapter: participant.adapter, ...value }),
  };
}

export function validateSelection(selection) {
  keys(selection, ['schema_version', 'role', 'adapter', 'model', 'reasoning_effort', 'model_profile', 'configuration_source', 'configuration_file', 'configuration_hash'], 'job model selection');
  if (selection.schema_version !== 1 || !Object.hasOwn(MODEL_ROLES, selection.role) || MODEL_ROLES[selection.role].adapter !== selection.adapter) fail('storage_error', 'Invalid job model selection');
  validateModel(selection.role, { model: selection.model, ...(selection.role === 'astra' ? { reasoning_effort: selection.reasoning_effort } : {}) });
  if (!/^[a-f0-9]{64}$/.test(selection.configuration_hash)) fail('storage_error', 'Invalid job model configuration hash');
  return selection;
}
