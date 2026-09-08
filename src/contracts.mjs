import { createHash, randomUUID } from 'node:crypto';

export class RoomError extends Error {
  constructor(code, message, details = null) {
    super(message); this.name = 'RoomError'; this.code = code; this.details = details;
  }
}
export const EXIT = { invalid_input: 2, forbidden: 3, auth_required: 3, disabled: 3, budget_exhausted: 3, quota_wait: 3, client_unsupported: 3, wrong_auth_mode: 3, model_unavailable: 3, permission_config_error: 3, conflict: 4, not_found: 2, storage_error: 5, invalid_output: 6, provider_error: 6, cancelled: 6, timeout: 6, needs_scoping: 7 };
export const fail = (code, message, details) => { throw new RoomError(code, message, details); };
export const uuid = () => randomUUID();
export const now = () => new Date().toISOString();
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const fingerprint = value => sha256(stable(value));
export function object(value, name = 'input') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_input', `${name} must be an object`);
  return value;
}
export function keys(value, allowed, name = 'input') {
  object(value, name);
  for (const k of Object.keys(value)) if (!allowed.includes(k)) fail('invalid_input', `Unknown ${name} field: ${k}`);
  return value;
}
export function text(value, name, max = 8000, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || [...value].length > max || value.includes('\0')) fail('invalid_input', `${name} must be ${empty ? '' : 'nonempty '}text of at most ${max} characters`);
  return value;
}
export function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('invalid_input', `${name} must be an integer from ${min} to ${max}`);
  return value;
}
export function enumeration(value, allowed, name) {
  if (!allowed.includes(value)) fail('invalid_input', `Invalid ${name}: ${String(value)}`);
  return value;
}
export function strings(value = [], name = 'ids', max = 30) {
  if (!Array.isArray(value) || value.length > max) fail('invalid_input', `${name} must contain at most ${max} strings`);
  value.forEach(v => text(v, name, 300));
  return [...new Set(value)];
}
export function parseJSON(value, name = 'JSON') {
  try { return JSON.parse(value); } catch { fail('invalid_input', `${name} is malformed`); }
}
export const DEFAULT_POLICY = Object.freeze({
  schema_version: 1, execution_enabled: false,
  allowed_adapters: ['opencode-glm-plan', 'codex-chatgpt-astra'],
  allow_general_api_fallback: false, max_global_concurrency: 1,
  max_calls_per_thread: 6, max_calls_per_day: 20, reset_timezone: 'UTC',
  automatic_follow_up_rounds: 0, max_packet_bytes: 32768,
  max_source_bytes: 1048576, max_retrieval_bytes: 8192,
  max_output_bytes: 2097152, timeout_seconds: 600,
  enabled_triggers: ['manual'],
});
export function validatePolicy(value) {
  keys(value, Object.keys(DEFAULT_POLICY), 'policy');
  const p = { ...DEFAULT_POLICY, ...value };
  if (p.schema_version !== 1 || p.allow_general_api_fallback !== false || p.max_global_concurrency !== 1 || p.reset_timezone !== 'UTC' || typeof p.execution_enabled !== 'boolean') fail('invalid_input', 'Policy requires schema 1, UTC resets, one worker and no general API fallback');
  p.allowed_adapters = strings(p.allowed_adapters, 'allowed_adapters', 2);
  p.allowed_adapters.forEach(a => enumeration(a, DEFAULT_POLICY.allowed_adapters, 'adapter'));
  p.enabled_triggers = strings(p.enabled_triggers, 'enabled_triggers', 3);
  p.enabled_triggers.forEach(t => enumeration(t, ['manual', 'disagreement', 'stuck'], 'trigger'));
  for (const [key, min, max] of [
    ['max_calls_per_thread',1,100], ['max_calls_per_day',1,1000], ['automatic_follow_up_rounds',0,1],
    ['max_packet_bytes',1024,131072], ['max_source_bytes',1024,1048576], ['max_retrieval_bytes',256,8192],
    ['max_output_bytes',1024,2097152], ['timeout_seconds',1,600],
  ]) integer(p[key], key, min, max);
  return p;
}
export const PARTICIPANTS = Object.freeze([
  { alias: 'glm', role: 'consultant', adapter: 'opencode-glm-plan', model: 'zai-coding-plan/glm-5.3' },
  { alias: 'astra', role: 'consultant', adapter: 'codex-chatgpt-astra', model: 'gpt-6-astra' },
]);

export function validateResponse(value, { citations = [], participants = [] } = {}) {
  try {
    keys(value, ['schema_version', 'kind', 'body', 'citations', 'context_requests', 'proposed_decision', 'follow_up'], 'response');
    const required = ['schema_version', 'kind', 'body', 'citations', 'context_requests', 'proposed_decision', 'follow_up'];
    if (required.some(k => !(k in value)) || value.schema_version !== 1) fail('invalid_input', 'Response must contain every schema 1 field');
    enumeration(value.kind, ['answer', 'needs_context', 'abstain'], 'response kind');
    text(value.body, 'body', 4000);
    const checkCitations = refs => {
      const out = strings(refs, 'citations', 30);
      if (out.some(id => !citations.includes(id))) fail('invalid_input', 'Response cites material outside the delivered packet');
      return out;
    };
    checkCitations(value.citations);
    if (!Array.isArray(value.context_requests) || value.context_requests.length > 3) fail('invalid_input', 'At most three context requests are allowed');
    for (const r of value.context_requests) {
      if (r.kind === 'read') {
        keys(r, ['kind','source_id','offset_bytes','max_bytes'], 'read request');
        text(r.source_id, 'source_id', 100); integer(r.offset_bytes, 'offset_bytes', 0, 1048576); integer(r.max_bytes, 'max_bytes', 1, 8192);
      } else if (r.kind === 'search') {
        keys(r, ['kind','query','limit'], 'search request');
        text(r.query, 'query', 300); integer(r.limit, 'limit', 1, 5);
      } else fail('invalid_input', 'Unsupported context request');
    }
    if ((value.kind === 'needs_context') !== (value.context_requests.length > 0)) fail('invalid_input', 'Context requests require needs_context and vice versa');
    if (value.proposed_decision !== null) {
      if (value.kind !== 'answer') fail('invalid_input', 'Only an answer may propose a decision');
      keys(value.proposed_decision, ['statement','rationale','citations'], 'proposed decision');
      text(value.proposed_decision.statement, 'statement', 2000); text(value.proposed_decision.rationale, 'rationale', 4000); checkCitations(value.proposed_decision.citations);
    }
    if (value.follow_up !== null) {
      if (value.kind !== 'answer') fail('invalid_input', 'Only an answer may propose a follow-up');
      keys(value.follow_up, ['participant_id','question','citations'], 'follow_up');
      if (!participants.includes(value.follow_up.participant_id)) fail('invalid_input', 'Follow-up participant is not in the discussion');
      text(value.follow_up.question, 'follow-up question', 2000); checkCitations(value.follow_up.citations);
    }
    return value;
  } catch (error) {
    if (error instanceof RoomError) fail('invalid_output', error.message);
    throw error;
  }
}
