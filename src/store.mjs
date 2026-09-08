import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, realpathSync, renameSync, lstatSync } from 'node:fs';
import { resolve, join, dirname, isAbsolute, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { fail, now, uuid, sha256, fingerprint, DEFAULT_POLICY, validatePolicy, RoomError } from './contracts.mjs';

export function stateRoot(env = process.env) {
  return resolve(env.AGENT_ROOM_STATE_DIR || join(env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'agent-room'));
}
export function privateDir(path) { mkdirSync(path, { recursive: true, mode: 0o700 }); }
export function privateWrite(path, data, { exclusive = false } = {}) {
  privateDir(dirname(path));
  if(exclusive){writeFileSync(path,data,{mode:0o600,flag:'wx'});return;}
  const temporary=`${path}.${uuid()}.tmp`;
  writeFileSync(temporary,data,{mode:0o600,flag:'wx'});renameSync(temporary,path);
}
export class Store {
  constructor(root = stateRoot(), { initialize = false } = {}) {
    this.root = resolve(root); this.depth = 0;
    const file = join(this.root, 'room.sqlite');
    if (!existsSync(file) && !initialize) fail('storage_error', 'Room store is not initialized. Run init --operator first.');
    privateDir(this.root);
    try {
      this.db = new DatabaseSync(file, { timeout: 10000 });
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;');
      const version = Number(this.db.prepare('PRAGMA user_version').get().user_version);
      if (version > 1) fail('storage_error', `Unsupported future database schema ${version}; use the matching room release`);
      if (version === 0) {
        if (!initialize) fail('storage_error', 'Unversioned database; initialization/repair must be explicit');
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        if (tables.length) fail('storage_error', 'Refusing to initialize a nonempty unversioned database');
        const migration = readFileSync(new URL('../migrations/001-initial.sql', import.meta.url), 'utf8');
        this.tx(() => {
          this.db.exec(migration);
          this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('policy', JSON.stringify(DEFAULT_POLICY));
          this.db.exec('PRAGMA user_version=1');
        });
      }
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      chmodSync(file, 0o600);
      this.policy();
    } catch (error) {
      try { this.db?.close(); } catch {}
      if (error instanceof RoomError) throw error;
      fail('storage_error', `Cannot open room database: ${error.message}`);
    }
  }
  close() { if(this.closed)return;this.db.close();this.closed=true; }
  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  tx(fn) {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const out = fn(); this.db.exec('COMMIT'); return out; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.depth--; }
  }
  policy() {
    try { return validatePolicy(JSON.parse(this.get("SELECT value FROM meta WHERE key='policy'").value)); }
    catch (error) { fail('storage_error', `Invalid stored policy: ${error.message}`); }
  }
  setPolicy(value) {
    const policy = validatePolicy(value);
    this.run("UPDATE meta SET value=? WHERE key='policy'", JSON.stringify(policy)); return policy;
  }
  idempotent(project, actor, operation, key, payload, fn) {
    if (!key || typeof key !== 'string' || key.length > 300) fail('invalid_input', 'An idempotency key of 1-300 characters is required');
    return this.tx(() => {
      const old = this.get('SELECT * FROM requests WHERE project_id=? AND actor_id=? AND operation=? AND request_key=?', project, actor, operation, key);
      const hash = fingerprint(payload);
      if (old) {
        if (old.payload_hash !== hash) fail('conflict', 'Idempotency key was already used with different input');
        return JSON.parse(old.result);
      }
      const result = fn();
      this.run('INSERT INTO requests VALUES(?,?,?,?,?,?)', project, actor, operation, key, hash, JSON.stringify(result));
      return result;
    });
  }
  issueActor({ project_id = null, name, role, lifetimeDays = 30 }) {
    const id = uuid(), token = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + lifetimeDays * 86400000).toISOString();
    this.run('INSERT INTO actor_sessions VALUES(?,?,?,?,?,?,?)', id, project_id, name, role, sha256(token), expires, now());
    return { actor: { id, project_id, name, role, expires_at: expires }, token };
  }
  ensureOperator(name = 'Operator') {
    const tokenPath = join(this.root, 'operator.token');
    if (existsSync(tokenPath)) {
      const token = readFileSync(tokenPath, 'utf8').trim();
      const actor = this.authenticate(token);
      if (actor.role !== 'operator') fail('storage_error', 'Operator token does not identify an operator');
      return { actor, tokenPath };
    }
    const issued = this.issueActor({ name, role: 'operator', lifetimeDays: 365 });
    privateWrite(tokenPath, `${issued.token}\n`, { exclusive: true });
    return { actor: issued.actor, tokenPath };
  }
  authenticate(token) {
    if (typeof token !== 'string' || token.length < 30 || token.length > 200) fail('auth_required', 'A registered actor capability is required');
    const actor = this.get('SELECT id,project_id,name,role,expires_at FROM actor_sessions WHERE capability_hash=?', sha256(token));
    if (!actor || actor.expires_at <= now()) fail('auth_required', 'Unknown or expired actor capability');
    return actor;
  }
  blobPath(project, hash) {
    if (!/^[a-f0-9]{64}$/.test(hash) || !this.get('SELECT id FROM projects WHERE id=?', project)) fail('storage_error', 'Invalid blob locator');
    return join(this.root, 'projects', project, 'blobs', hash);
  }
  writeBlob(project, data) {
    const hash = sha256(data), path = this.blobPath(project, hash);
    if (!existsSync(path)) privateWrite(path, data, { exclusive: true });
    else if (sha256(readFileSync(path)) !== hash) fail('storage_error', 'Existing source blob failed integrity verification');
    return hash;
  }
  readBlob(project, hash) {
    let data;
    try { data = readFileSync(this.blobPath(project, hash)); } catch { fail('storage_error', 'Captured source blob is missing'); }
    if (sha256(data) !== hash) fail('storage_error', 'Captured source blob hash mismatch');
    return data;
  }
  jobDir(project, job) {
    if (!this.get('SELECT id FROM jobs WHERE id=? AND project_id=?', job, project)) fail('not_found', 'Job not found in this project');
    return join(this.root, 'projects', project, 'jobs', job);
  }
  event(job, event, details = {}) { this.run('INSERT INTO job_events(job_id,event,details,created_at) VALUES(?,?,?,?)', job, event, JSON.stringify(details), now()); }
  async backup(out) {
    const destination = resolve(out);
    if (existsSync(destination)) fail('invalid_input', 'Backup destination must not already exist');
    if (destination === this.root || destination.startsWith(this.root + sep)) fail('invalid_input', 'Backup must be outside the active state directory');
    privateDir(destination);
    await backup(this.db, join(destination, 'room.sqlite'));
    const copy = new DatabaseSync(join(destination, 'room.sqlite'), { readOnly: true });
    const blobs = copy.prepare('SELECT DISTINCT project_id,blob_hash FROM sources').all();
    const jobs = copy.prepare('SELECT id,project_id,packet_hash FROM jobs WHERE packet_hash IS NOT NULL').all();
    copy.close();
    const files = [];
    for (const source of blobs) {
      const data = this.readBlob(source.project_id, source.blob_hash);
      const rel = `projects/${source.project_id}/blobs/${source.blob_hash}`;
      privateWrite(join(destination, rel), data); files.push({ path: rel, sha256: sha256(data) });
    }
    for (const job of jobs) {
      const dir = this.jobDir(job.project_id, job.id);
      for (const name of ['packet.json','packet.md','output.json','native-events.jsonl','invocation.json','client-result.json','client-session-verification.json']) {
        const path = join(dir, name);
        if (!existsSync(path)) continue;
        const data = readFileSync(path), rel = `projects/${job.project_id}/jobs/${job.id}/${name}`;
        privateWrite(join(destination, rel), data); files.push({ path: rel, sha256: sha256(data) });
      }
    }
    files.push({ path: 'room.sqlite', sha256: sha256(readFileSync(join(destination, 'room.sqlite'))) });
    privateWrite(join(destination, 'manifest.json'), JSON.stringify({ schema_version: 1, created_at: now(), files }, null, 2));
    return { path: destination, files: files.length, credentials_included: false };
  }
}

export function restoreBackup(backupPath, destination) {
  const source = realpathSync(backupPath), out = resolve(destination);
  if (existsSync(out)) fail('invalid_input', 'Restore destination must not exist');
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')); } catch { fail('storage_error', 'Invalid backup manifest'); }
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.files) || !manifest.files.some(f => f.path === 'room.sqlite')) fail('storage_error', 'Unsupported backup manifest');
  const verified = [];
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || isAbsolute(file.path) || file.path.split(/[\\/]/).includes('..')) fail('storage_error', 'Unsafe backup path');
    const path = realpathSync(join(source, file.path));
    if (!path.startsWith(source + sep) || !lstatSync(path).isFile()) fail('storage_error', 'Escaping backup file');
    const data = readFileSync(path);
    if (sha256(data) !== file.sha256) fail('storage_error', 'Backup hash mismatch');
    verified.push({ path: file.path, data });
  }
  privateDir(out);
  for (const file of verified) privateWrite(join(out, file.path), file.data, { exclusive: true });
  const store = new Store(out);
  store.tx(() => {
    store.setPolicy({ ...store.policy(), execution_enabled: false });
    store.run('DELETE FROM read_cursors');
    store.run('DELETE FROM actor_sessions');
    for (const job of store.all("SELECT id FROM jobs WHERE status IN ('preparing','running')")) {
      store.run("UPDATE jobs SET status='interrupted_unknown',error_code='interrupted_unknown',error_message='Restored from backup; execution state must be reconciled' WHERE id=?", job.id);
      store.event(job.id, 'restored_uncertain');
    }
    store.run('DELETE FROM worker_claim');
  });
  const operator = store.ensureOperator(); store.close();
  return { state_dir: out, operator_token_file: operator.tokenPath, execution_enabled: false };
}
