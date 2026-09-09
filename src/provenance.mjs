import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fail, fingerprint, sha256, validateResponse } from './contracts.mjs';

function capture(store, project, job, name) {
  const path = join(store.jobDir(project, job), name);
  if (!existsSync(path)) return null;
  try {
    if (!statSync(path).isFile() || statSync(path).size > 4 * 1024 * 1024) fail('storage_error', 'Invalid provenance capture file');
    const bytes = readFileSync(path);
    if (bytes.length > 4 * 1024 * 1024) fail('storage_error', 'Provenance capture exceeds its size limit');
    return { value: JSON.parse(bytes), hash: sha256(bytes) };
  } catch (error) {
    if (error.code === 'storage_error') throw error;
    fail('storage_error', 'Cannot validate saved consultation provenance', { job_id: job, capture: name });
  }
}

export function jobProvenance(room, project, job) {
  const stored = room.store.jobModel(job.id);
  const packetFile = capture(room.store, project, job.id, 'packet.json');
  const outputFile = capture(room.store, project, job.id, 'output.json');
  const invocationFile = capture(room.store, project, job.id, 'invocation.json');
  const verificationFile = capture(room.store, project, job.id, 'client-session-verification.json');
  const missing = [];
  let packet = null, omissions = null;
  if (packetFile && job.packet_hash) {
    const saved = packetFile.value, marker = '\n\nROOM PACKET\n';
    if (typeof saved.prompt !== 'string' || !saved.prompt.includes(marker) || sha256(saved.prompt) !== job.packet_hash || saved.hash !== job.packet_hash || saved.config_hash !== job.config_hash) {
      fail('storage_error', 'Saved packet does not match the job receipt', { job_id: job.id });
    }
    try { packet = JSON.parse(saved.prompt.slice(saved.prompt.lastIndexOf(marker) + marker.length)); }
    catch { fail('storage_error', 'Saved packet has invalid structured content', { job_id: job.id }); }
    if (packet.participant?.requested_model !== job.requested_model || !Array.isArray(saved.omissions) || saved.omissions.some(o => typeof o?.id !== 'string' || typeof o?.reason !== 'string') || fingerprint(saved.omissions.slice(0, 10)) !== fingerprint(packet.coverage?.optional_omissions)) {
      fail('storage_error', 'Saved packet provenance is inconsistent', { job_id: job.id });
    }
    omissions = saved.omissions;
  } else if (job.packet_hash) missing.push('packet.json');
  else if (packetFile) missing.push('packet_not_bound_before_launch');
  const output = outputFile?.value;
  if (output) {
    const observed = output.observed_model;
    if (output.requested_model !== job.requested_model || (observed !== null && (typeof observed !== 'string' || !observed.trim())) || output.model_identity_verified !== (observed !== null)) fail('storage_error', 'Saved model identity is inconsistent', { job_id: job.id });
    if (observed !== null && observed !== job.requested_model && observed !== job.requested_model.split('/').at(-1)) fail('storage_error', 'Saved observed model differs from the requested model', { job_id: job.id });
    if (packet) {
      try { validateResponse(output.response, { citations: packet.allowed_citations, participants: packet.discussion_participants.map(p => p.id) }); }
      catch { fail('storage_error', 'Saved consultant response failed provenance validation', { job_id: job.id }); }
    }
    if (job.reply_id) {
      const reply = room.message(project, job.reply_id);
      if (reply.job_id !== job.id || reply.body !== output.response?.body || reply.kind !== output.response?.kind) fail('storage_error', 'Saved output does not match its immutable consultant message', { job_id: job.id });
    }
  } else if (job.status === 'succeeded') missing.push('output.json');
  // Early GLM captures saved session verification separately after the reply.
  // Bind that evidence to the same session/model before filling an unknown identity.
  let sessionEvidence = null;
  if (verificationFile && output) {
    const evidence = verificationFile.value;
    if (stored.selection.adapter !== 'opencode-glm-plan' || evidence.model_identity_source !== 'client_session_metadata' || evidence.provider !== 'zai-coding-plan' || evidence.observed_model !== job.requested_model || !output.session_id || evidence.session_id !== output.session_id || evidence.tool_activity !== 0 || !['stop', 'end_turn'].includes(evidence.finish)) {
      fail('storage_error', 'Saved session identity is not bound to this consultation', { job_id: job.id });
    }
    sessionEvidence = evidence;
  }
  if (invocationFile && job.packet_hash) {
    const invocation = invocationFile.value;
    if (invocation.packet_hash !== job.packet_hash || invocation.requested_model !== job.requested_model || invocation.configuration_hash !== job.config_hash) fail('storage_error', 'Saved invocation does not match its job', { job_id: job.id });
  } else if (job.packet_hash) missing.push('invocation.json');
  return {
    schema_version: 1, job_id: job.id, message_id: job.reply_id,
    owner_actor_id: stored.owner_actor_id,
    requested_model: job.requested_model,
    observed_model: output?.observed_model ?? sessionEvidence?.observed_model ?? null,
    model_identity_verified: output?.model_identity_verified === true || sessionEvidence !== null,
    model_identity_source: output?.model_identity_source ?? sessionEvidence?.model_identity_source ?? null,
    session_id: output?.session_id ?? null,
    reasoning_effort: stored.selection.reasoning_effort,
    model_selection: stored.selection, model_selection_hash: stored.selection_hash,
    packet_hash: job.packet_hash, configuration_hash: job.config_hash,
    packet_metadata_hash: packetFile?.hash ?? null, output_metadata_hash: outputFile?.hash ?? null,
    session_verification_metadata_hash: verificationFile?.hash ?? null,
    client_version: invocationFile?.value.capabilities?.client_version ?? null,
    adapter: stored.selection.adapter,
    omissions,
    coverage: packet?.coverage ?? null,
    source_manifest: packet ? [...packet.sources.map(s => ({ id: s.id, path: s.path, sha256: s.sha256, revision: s.revision, offset_bytes: s.offset_bytes, end_bytes: s.end_bytes, total_bytes: s.total_bytes })), ...packet.retrieval.filter(r => r.kind === 'read').map(r => ({ id: r.source_id, sha256: r.sha256, offset_bytes: r.offset_bytes, end_bytes: r.end_bytes, total_bytes: r.total_bytes }))] : null,
    metadata_status: missing.length ? 'incomplete' : packetFile ? 'captured' : 'not_prepared',
    missing_captures: missing,
    consultation_status: job.status,
    response_kind: output?.response?.kind ?? null,
    stale_context: Boolean(job.stale_context),
  };
}
