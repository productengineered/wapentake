import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fail, sha256, text, integer } from './contracts.mjs';
import { redact } from './adapters/process.mjs';

const forbidden = /(^|\/)(?:\.git|\.env[^/]*|secrets?|credentials?|agent-memory|memory|\.ssh|\.aws|\.gnupg)(\/|$)|(?:^|\/)(?:auth\.json|operator\.token|[^/]*\.pem|[^/]*\.key|id_rsa[^/]*|id_ed25519[^/]*|[^/]*credentials[^/]*|[^/]*sensitive[^/]*)$/i;
export function safeSource(projectRoot, requested) {
  text(requested, 'source path', 1000);
  if (isAbsolute(requested) || requested.split(/[\\/]/).some(p => p === '..') || forbidden.test(requested.replaceAll('\\', '/'))) fail('forbidden', 'Source path is outside the explicit capture policy');
  const root = realpathSync(projectRoot);
  let path;
  try { path = realpathSync(resolve(root, requested)); } catch { fail('not_found', 'Selected source file does not exist'); }
  const rel = relative(root, path).split(sep).join('/');
  if (!path.startsWith(root + sep) || forbidden.test(rel) || !statSync(path).isFile()) fail('forbidden', 'Source must be an allowed regular file inside the registered project');
  return { root, path, relative: rel };
}
function git(root, args, maxBuffer = 2 * 1048576) {
  try { return execFileSync('git', ['-C', root, ...args], { timeout: 10000, maxBuffer, stdio: ['ignore','pipe','pipe'] }); }
  catch (error) {
    const diagnostic = redact(error.stderr ?? '').trim().slice(0, 500);
    const message = /not a git repository/i.test(diagnostic)
      ? 'Project is not a Git repository; capture with --working-tree'
      : 'The selected Git revision or path could not be read';
    fail('invalid_input', message, { cause: error.code ?? null, git: diagnostic });
  }
}
export function captureSource(store, project, options) {
  const selected = safeSource(project.path, options.path);
  let revision = null, data;
  if (options.working_tree === true) {
    try { revision = execFileSync('git', ['-C', selected.root, 'rev-parse', '--verify', 'HEAD'], { timeout: 3000, stdio: ['ignore','pipe','ignore'] }).toString().trim(); } catch {}
    if (statSync(selected.path).size > store.policy().max_source_bytes) fail('needs_scoping', 'Selected source exceeds the source capture limit');
    data = readFileSync(selected.path);
  } else {
    const requested = options.revision ?? 'HEAD';
    if (requested !== 'HEAD' && !/^[a-f0-9]{7,40}$/i.test(requested)) fail('invalid_input', 'Revision must be HEAD or an explicit commit hash');
    revision = git(selected.root, ['rev-parse','--verify',`${requested}^{commit}`]).toString().trim();
    const object = `${revision}:${selected.relative}`, limit = store.policy().max_source_bytes;
    // Check the immutable blob before buffering it. A subprocess buffer error
    // could also come from stderr and cannot establish the source's size.
    const size = Number(git(selected.root, ['cat-file', '-s', object]).toString().trim());
    if (!Number.isSafeInteger(size) || size < 0) fail('invalid_input', 'Git did not report a valid source size');
    if (size > limit) fail('needs_scoping', 'Selected source exceeds the source capture limit');
    data = git(selected.root, ['show', object], limit + 1);
  }
  if (data.length > store.policy().max_source_bytes) fail('needs_scoping', 'Selected source exceeds the source capture limit');
  try { new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { fail('invalid_input', 'Only UTF-8 text sources are supported'); }
  if (data.includes(0)) fail('invalid_input', 'Binary sources are not supported');
  return { path: selected.relative, revision, working_tree: options.working_tree === true ? 1 : 0, blob_hash: store.writeBlob(project.id, data), size: data.length, required: options.required === false ? 0 : 1 };
}
export function sourceFreshness(store, sources) {
  const changes = [];
  for (const source of sources) {
    if (!source.working_tree) continue;
    const project = store.get('SELECT * FROM projects WHERE id=?', source.project_id);
    try {
      const path = safeSource(project.path, source.path);
      if (statSync(path.path).size > store.policy().max_source_bytes || sha256(readFileSync(path.path)) !== source.blob_hash) changes.push({ source_id: source.id, reason: 'working_tree_changed' });
    } catch { changes.push({ source_id: source.id, reason: 'source_unavailable_or_forbidden' }); }
  }
  return changes;
}
export function excerpt(buffer, offset = 0, maxBytes = 8192) {
  integer(offset, 'offset_bytes', 0, buffer.length); integer(maxBytes, 'max_bytes', 1, 8192);
  if (offset < buffer.length && (buffer[offset] & 0xc0) === 0x80) fail('invalid_input', 'Excerpt offset must begin at a UTF-8 character boundary');
  let end = Math.min(buffer.length, offset + maxBytes);
  while (end < buffer.length && end > offset && (buffer[end] & 0xc0) === 0x80) end--;
  return { text: buffer.subarray(offset, end).toString('utf8'), offset_bytes: offset, end_bytes: end, total_bytes: buffer.length, continuation_offset: end < buffer.length ? end : null };
}
