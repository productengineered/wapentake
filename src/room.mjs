import { realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Store, privateWrite } from './store.mjs';
import { fail, uuid, now, text, integer, keys, strings, enumeration, PARTICIPANTS, fingerprint } from './contracts.mjs';
import { captureSource, excerpt } from './sources.mjs';

export { Store } from './store.mjs';
export { RoomError } from './contracts.mjs';
export class Room {
  constructor(store, token) { this.store = store; this.actor = store.authenticate(token); }
  operator() { if (this.actor.role !== 'operator') fail('forbidden', 'This action requires an explicit operator session'); }
  project(id) {
    const project = this.store.get('SELECT * FROM projects WHERE id=? OR path=?', id, id);
    if (!project) fail('not_found', 'Project not found');
    if (this.actor.project_id && this.actor.project_id !== project.id) fail('forbidden', 'Actor is registered to a different project');
    return project;
  }
  thread(project, id) {
    this.project(project);
    const thread = this.store.get('SELECT * FROM threads WHERE project_id=? AND id=?', project, id);
    if (!thread) fail('not_found', 'Thread not found in this project');
    return { ...thread, task_ids: JSON.parse(thread.task_ids) };
  }
  projects() {
    return this.actor.project_id ? [this.project(this.actor.project_id)] : this.store.all('SELECT * FROM projects ORDER BY label,id');
  }
  register(options) {
    this.operator(); keys(options, ['path','label'], 'project');
    text(options.path, 'project path', 2000);
    let path;
    try { path = realpathSync(options.path); if (!statSync(path).isDirectory()) throw Error(); } catch { fail('invalid_input', 'Project path must be an existing directory'); }
    const label = text(options.label ?? path.split('/').at(-1), 'project label', 200);
    return this.store.tx(() => {
      const old = this.store.get('SELECT * FROM projects WHERE path=?', path);
      if (old) return old;
      const id = uuid();
      this.store.run('INSERT INTO projects(id,path,label,created_at) VALUES(?,?,?,?)', id, path, label, now());
      for (const p of PARTICIPANTS) this.store.run('INSERT INTO participants(id,project_id,alias,role,adapter,model,enabled) VALUES(?,?,?,?,?,?,1)', uuid(), id, p.alias, p.role, p.adapter, p.model);
      return this.project(id);
    });
  }
  moveProject(project, path) {
    this.operator(); this.project(project);
    let real;
    try { real = realpathSync(path); if (!statSync(real).isDirectory()) throw Error(); } catch { fail('invalid_input', 'New project path must be an existing directory'); }
    this.store.run('UPDATE projects SET path=?,config_version=config_version+1 WHERE id=?', real, project); return this.project(project);
  }
  attachActor(project, options) {
    this.operator(); this.project(project); keys(options, ['name','run_id','lifetime_days'], 'actor');
    const name = text(options.name, 'actor name', 100), run = text(options.run_id, 'run_id', 100);
    const days = integer(options.lifetime_days ?? 7, 'lifetime_days', 1, 30);
    const issued = this.store.issueActor({ project_id: project, name: `${name}:${run}`, role: 'agent', lifetimeDays: days });
    const tokenFile = join(this.store.root, 'capabilities', `${issued.actor.id}.token`);
    privateWrite(tokenFile, `${issued.token}\n`, { exclusive: true });
    return { ...issued.actor, token_file: tokenFile };
  }
  participants(project) { this.project(project); return this.store.all('SELECT * FROM participants WHERE project_id=? ORDER BY alias', project); }
  openThread(project, options) {
    this.project(project); keys(options, ['title','task_ids','mode','key'], 'thread');
    const title = text(options.title, 'title', 200), tasks = strings(options.task_ids, 'task_ids');
    const mode = enumeration(options.mode ?? 'brainstorm', ['brainstorm','independent'], 'mode');
    return this.store.idempotent(project, this.actor.id, 'thread', options.key, { title, tasks, mode }, () => {
      const id = uuid(), time = now();
      this.store.run('INSERT INTO threads(id,project_id,title,task_ids,mode,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', id, project, title, JSON.stringify(tasks), mode, 'open', time, time);
      return this.thread(project, id);
    });
  }
  threads(project) {
    this.project(project);
    return this.store.all('SELECT t.*, (SELECT count(*) FROM messages m WHERE m.thread_id=t.id AND m.seq>coalesce((SELECT through_seq FROM read_cursors c WHERE c.thread_id=t.id AND c.actor_id=?),0)) AS unread FROM threads t WHERE t.project_id=? ORDER BY t.updated_at DESC,t.id', this.actor.id, project).map(t => ({ ...t, task_ids: JSON.parse(t.task_ids) }));
  }
  setThreadStatus(project, threadId, status) {
    this.operator(); this.thread(project, threadId); enumeration(status, ['open','waiting_for_input','resolved','archived'], 'thread status');
    if (status === 'resolved' && !this.decisions(project, threadId).some(d => ['accepted','proposed'].includes(d.status)) && !this.store.get("SELECT id FROM messages WHERE project_id=? AND thread_id=? AND kind IN ('conclusion','experiment')", project, threadId)) fail('invalid_input', 'Record a conclusion, experiment or decision before resolving the thread');
    this.store.run('UPDATE threads SET status=?,updated_at=? WHERE project_id=? AND id=?', status, now(), project, threadId);
    return this.thread(project, threadId);
  }
  checkRefs(project, refs) {
    for (const id of refs) {
      if (!['sources','messages','decisions','constraints'].some(table => this.store.get(`SELECT id FROM ${table} WHERE project_id=? AND id=?`, project, id))) fail('not_found', 'Citation does not resolve in this project');
    }
  }
  _post(project, threadId, options, author = this.actor) {
    const thread = this.thread(project, threadId);
    if (thread.status === 'archived') fail('conflict', 'Reopen this archived thread before posting');
    if (options.reply_to && !this.store.get('SELECT id FROM messages WHERE project_id=? AND thread_id=? AND id=?', project, threadId, options.reply_to)) fail('not_found', 'Reply target is not in this thread');
    const refs = strings(options.source_ids, 'source_ids'); this.checkRefs(project, refs);
    const id = uuid(), time = now(), isHuman = author.role === 'operator';
    if (isHuman) {
      this.store.run('UPDATE threads SET context_version=context_version+1, latest_human_id=? WHERE id=?', id, threadId);
      this.store.run("UPDATE jobs SET stale_context=1 WHERE thread_id=? AND status='succeeded'", threadId);
    }
    const version = this.store.get('SELECT context_version FROM threads WHERE id=?', threadId).context_version;
    this.store.run('INSERT INTO messages(id,project_id,thread_id,author_id,author_name,author_role,kind,body,reply_to,job_id,basis_context_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', id, project, threadId, author.id, author.name, author.role, options.kind ?? 'message', options.body, options.reply_to ?? null, options.job_id ?? null, options.basis_context_version ?? version, time);
    for (const ref of refs) {
      const table = ['sources','messages','decisions','constraints'].find(table => this.store.get(`SELECT id FROM ${table} WHERE project_id=? AND id=?`, project, ref));
      const kind = {sources:'source',messages:'message',decisions:'decision',constraints:'constraint'}[table];
      this.store.run('INSERT INTO message_refs VALUES(?,?,?,?)', project, id, ref, kind);
    }
    this.store.run('UPDATE threads SET updated_at=? WHERE id=?', time, threadId);
    return this.message(project, id);
  }
  post(project, threadId, options) {
    this.thread(project, threadId); keys(options, ['body','kind','reply_to','source_ids','key'], 'message');
    text(options.body, 'body', 16000);
    enumeration(options.kind ?? 'message', ['message','question','objection','unknown','conclusion','experiment','correction'], 'message kind');
    return this.store.idempotent(project, this.actor.id, `post:${threadId}`, options.key, options, () => this._post(project, threadId, options));
  }
  message(project, id) {
    this.project(project);
    const message = this.store.get('SELECT m.*,j.stale_context,j.requested_model FROM messages m LEFT JOIN jobs j ON j.id=m.job_id WHERE m.project_id=? AND m.id=?', project, id);
    if (!message) fail('not_found', 'Message not found in this project');
    return { ...message, source_ids: this.store.all('SELECT ref_id FROM message_refs WHERE project_id=? AND message_id=? ORDER BY ref_id', project, id).map(r => r.ref_id) };
  }
  read(project, threadId, { after = 0, limit = 50 } = {}) {
    this.thread(project, threadId); integer(after, 'after', 0, Number.MAX_SAFE_INTEGER); integer(limit, 'limit', 1, 100);
    return this.store.all('SELECT id FROM messages WHERE project_id=? AND thread_id=? AND seq>? ORDER BY seq LIMIT ?', project, threadId, after, limit).map(m => this.message(project, m.id));
  }
  inbox(project) { return this.threads(project).filter(t => t.unread > 0); }
  ack(project, threadId, through) {
    this.thread(project, threadId); integer(through, 'through', 0, Number.MAX_SAFE_INTEGER);
    const max = this.store.get('SELECT coalesce(max(seq),0) n FROM messages WHERE project_id=? AND thread_id=?', project, threadId).n;
    if (through > max) fail('invalid_input', 'Cursor exceeds the last message in this thread');
    this.store.run('INSERT INTO read_cursors VALUES(?,?,?,?) ON CONFLICT(thread_id,actor_id) DO UPDATE SET through_seq=max(through_seq,excluded.through_seq)', project, threadId, this.actor.id, through);
    return { thread_id: threadId, through_seq: through, acknowledged: true, comprehension_verified: false };
  }
  search(project, query, limit = 5) {
    this.project(project); text(query, 'query', 300); integer(limit, 'limit', 1, 5);
    const terms = query.match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 12) ?? [];
    if (!terms.length) return [];
    const match = terms.map(t => `"${t.replaceAll('"','""')}"`).join(' OR ');
    return this.store.all("SELECT m.id,m.thread_id,m.seq,snippet(messages_fts,0,'[',']','...',24) AS snippet FROM messages_fts JOIN messages m ON m.seq=messages_fts.rowid WHERE messages_fts MATCH ? AND m.project_id=? ORDER BY bm25(messages_fts),m.seq DESC LIMIT ?", match, project, limit);
  }
  addSource(project, threadId, options) {
    const p = this.project(project); this.thread(project, threadId);
    keys(options, ['path','revision','working_tree','required','key'], 'source');
    if (options.working_tree !== undefined && typeof options.working_tree !== 'boolean') fail('invalid_input', 'working_tree must be boolean');
    if (options.required !== undefined && typeof options.required !== 'boolean') fail('invalid_input', 'required must be boolean');
    return this.store.idempotent(project, this.actor.id, `source:${threadId}`, options.key, options, () => {
      const source = captureSource(this.store, p, options), id = uuid();
      this.store.run('INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?)', id, project, threadId, source.path, source.revision, source.working_tree, source.blob_hash, source.size, source.required, now());
      this.store.run('UPDATE threads SET context_version=context_version+1,updated_at=? WHERE id=?', now(), threadId);
      this.store.run("UPDATE jobs SET stale_context=1 WHERE thread_id=? AND status='succeeded'",threadId);
      return this.source(project, id);
    });
  }
  source(project, id) {
    this.project(project); const source = this.store.get('SELECT * FROM sources WHERE project_id=? AND id=?', project, id);
    if (!source) fail('not_found', 'Source not found in this project'); return source;
  }
  sources(project, threadId, {history=false}={}) {
    this.thread(project, threadId);
    return this.store.all(`SELECT s.* FROM sources s WHERE s.project_id=? AND s.thread_id=? ${history?'':"AND (s.working_tree=0 OR s.rowid=(SELECT max(x.rowid) FROM sources x WHERE x.project_id=s.project_id AND x.thread_id=s.thread_id AND x.path=s.path AND x.working_tree=1))"} ORDER BY s.rowid`, project, threadId);
  }
  readSource(project, id, offset = 0, maxBytes = 8192) {
    const source = this.source(project, id);
    return { source, ...excerpt(this.store.readBlob(project, source.blob_hash), offset, maxBytes) };
  }
  constraints(project, threadId) {
    this.thread(project, threadId);
    return this.store.all('SELECT c.* FROM constraints c WHERE c.project_id=? AND c.thread_id=? AND c.version=(SELECT max(x.version) FROM constraints x WHERE x.project_id=c.project_id AND x.stable_id=c.stable_id) ORDER BY c.created_at,c.id', project, threadId);
  }
  constrain(project, threadId, options) {
    this.operator(); this.thread(project, threadId); keys(options, ['body','stable_id','status','key'], 'constraint');
    text(options.body, 'constraint', 8000); enumeration(options.status ?? 'active', ['active','superseded'], 'constraint status');
    return this.store.idempotent(project, this.actor.id, `constraint:${threadId}`, options.key, options, () => {
      let previous = null;
      if (options.stable_id) {
        previous = this.constraints(project, threadId).find(c => c.stable_id === options.stable_id);
        if (!previous) fail('not_found', 'Constraint to supersede is not in this thread');
      }
      const message = this._post(project, threadId, { body: options.body, kind: 'correction' });
      const id = uuid(), stable = previous?.stable_id ?? uuid();
      this.store.run('INSERT INTO constraints VALUES(?,?,?,?,?,?,?,?,?,?)', id, stable, (previous?.version ?? 0) + 1, project, threadId, options.body, message.id, options.status ?? 'active', this.actor.id, now());
      return this.constraints(project, threadId).find(c => c.stable_id === stable);
    });
  }
  decisions(project, threadId, { history = false } = {}) {
    this.thread(project, threadId);
    return this.store.all(`SELECT d.* FROM decisions d WHERE d.project_id=? AND d.thread_id=? ${history ? '' : 'AND d.version=(SELECT max(x.version) FROM decisions x WHERE x.project_id=d.project_id AND x.stable_id=d.stable_id)'} ORDER BY d.created_at,d.id`, project, threadId).map(d => ({ ...d, citations: JSON.parse(d.citations) }));
  }
  decide(project, threadId, options) {
    const thread = this.thread(project, threadId);
    keys(options, ['statement','rationale','citations','status','stable_id','expected_context_version','key'], 'decision');
    const status = enumeration(options.status ?? 'proposed', ['proposed','accepted','rejected','superseded'], 'decision status');
    if (status !== 'proposed') this.operator();
    const refs = strings(options.citations, 'citations'); this.checkRefs(project, refs);
    text(options.statement, 'statement', 2000); text(options.rationale, 'rationale', 4000);
    return this.store.idempotent(project, this.actor.id, `decision:${threadId}`, options.key, options, () => {
      if (options.expected_context_version !== undefined && options.expected_context_version !== this.thread(project,threadId).context_version) fail('conflict', 'Thread context changed; refresh before deciding');
      let old;
      if (options.stable_id) {
        old = this.decisions(project, threadId).find(d => d.stable_id === options.stable_id);
        if (!old) fail('not_found', 'Decision is not in this thread');
        if (this.actor.role !== 'operator') fail('forbidden', 'Agents may create new proposals, not replace existing decisions');
      }
      if (status === 'accepted') {
        for (const ref of refs) if (this.store.get('SELECT m.id FROM messages m JOIN jobs j ON j.id=m.job_id WHERE m.project_id=? AND m.id=? AND j.stale_context=1', project, ref)) fail('conflict', 'This proposal cites stale consultation output; review the changed context first');
      }
      const id = uuid(), stable = old?.stable_id ?? uuid();
      const recorded=this.roomDecisionMessage(project,threadId,status,options,refs);
      this.store.run('INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, stable, (old?.version ?? 0) + 1, project, threadId, options.statement, options.rationale, status, JSON.stringify([...new Set([...refs,recorded.id])]), this.actor.id, now());
      if (status !== 'proposed') {
        this.store.run('UPDATE threads SET context_version=context_version+1,updated_at=? WHERE id=?', now(), threadId);
        this.store.run("UPDATE jobs SET stale_context=1 WHERE thread_id=? AND status='succeeded'",threadId);
      }
      return this.decisions(project, threadId).find(d => d.stable_id === stable);
    });
  }
  roomDecisionMessage(project,threadId,status,options,refs){
    return this._post(project,threadId,{kind:status==='accepted'?'conclusion':'message',body:`Decision ${status}: ${options.statement}\n\n${options.rationale}`,source_ids:refs});
  }
  policy() { return this.store.policy(); }
  setPolicy(patch) { this.operator(); return this.store.tx(() => this.store.setPolicy({ ...this.store.policy(), ...patch })); }
  _reserve(job, project, threadId) {
    const policy = this.policy(), day = now().slice(0,10);
    const dayCount = this.store.get("SELECT count(*) n FROM budget_ledger WHERE day=? AND state IN ('reserved','started')", day).n;
    const threadCount = this.store.get("SELECT count(*) n FROM budget_ledger b JOIN jobs j ON j.id=b.job_id WHERE j.project_id=? AND j.thread_id=? AND b.state IN ('reserved','started')", project, threadId).n;
    if (dayCount >= policy.max_calls_per_day || threadCount >= policy.max_calls_per_thread) fail('budget_exhausted', 'The local day or thread allowance is fully reserved');
    this.store.run('INSERT INTO budget_ledger VALUES(?,?,?,?,?)', job, day, 'reserved', fingerprint(policy), now());
  }
  ask(project, threadId, options) {
    const thread = this.thread(project, threadId);
    keys(options, ['body','to','reply_to','source_ids','key'], 'invitation'); text(options.body, 'question', 16000);
    const recipients = strings(options.to, 'recipients', 2); if (!recipients.length) fail('invalid_input', 'Name at least one participant');
    const participants = recipients.map(alias => this.participants(project).find(p => p.alias === alias || p.id === alias));
    if (participants.some(p => !p || !p.enabled || !this.policy().allowed_adapters.includes(p.adapter))) fail('invalid_input', 'Unknown or disabled participant');
    return this.store.idempotent(project, this.actor.id, `ask:${threadId}`, options.key, options, () => {
      const question = this._post(project, threadId, { ...options, kind: 'question' });
      if (this.actor.role === 'operator') this.store.run('UPDATE threads SET question_id=? WHERE id=?', question.id, threadId);
      const current = this.thread(project, threadId), jobs = [];
      for (const participant of participants) {
        const id = uuid();
        this.store.run('INSERT INTO jobs(id,project_id,thread_id,participant_id,causal_key,question_id,boundary_seq,context_version,status,requested_model,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, project, threadId, participant.id, `${threadId}:${this.actor.id}:${options.key}:${participant.id}`, question.id, question.seq, current.context_version, 'queued', participant.model, now());
        this._reserve(id, project, threadId); this.store.event(id, 'queued', { actor_id: this.actor.id }); jobs.push(id);
      }
      return { status: 'queued', question, job_ids: jobs, execution_enabled: this.policy().execution_enabled, mode: thread.mode };
    });
  }
  jobs(project, limit = 100) { this.project(project); integer(limit,'limit',1,500); return this.store.all('SELECT * FROM jobs WHERE project_id=? ORDER BY created_at DESC,id LIMIT ?', project, limit).map(j => ({ ...j, usage: j.usage ? JSON.parse(j.usage) : null, retrieval: JSON.parse(j.retrieval) })); }
  job(project, id) { this.project(project); const j = this.store.get('SELECT * FROM jobs WHERE project_id=? AND id=?', project, id); if (!j) fail('not_found','Job not found in this project'); return { ...j, usage: j.usage ? JSON.parse(j.usage) : null, retrieval: JSON.parse(j.retrieval) }; }
  cancel(project, id) {
    this.job(project, id);
    return this.store.tx(() => {
      const job = this.job(project, id);
      if (job.status === 'queued') {
        this.store.run("UPDATE jobs SET status='cancelled',cancel_requested=1,completed_at=? WHERE id=?", now(), id);
        this.store.run("UPDATE budget_ledger SET state='released' WHERE job_id=? AND state='reserved'", id);
      } else if (['running','preparing'].includes(job.status)) this.store.run('UPDATE jobs SET cancel_requested=1 WHERE id=?', id);
      this.store.event(id, 'cancel_requested', { actor_id: this.actor.id }); return this.job(project,id);
    });
  }
  retry(project, id, key) {
    this.operator(); const old = this.job(project,id);
    if (!['failed','cancelled','auth_required','quota_wait','disabled','needs_scoping','interrupted_unknown'].includes(old.status)) fail('conflict','Only a stopped/unavailable job can be explicitly retried');
    if (this.store.get('SELECT job_id FROM worker_claim WHERE job_id=?',id)) fail('conflict','Reconcile the original worker before retrying');
    return this.store.idempotent(project,this.actor.id,`retry:${id}`,key,{ id },() => {
      const next = uuid(), thread = this.thread(project,old.thread_id);
      const boundary = thread.mode==='independent'&&old.round===0?old.boundary_seq:this.store.get('SELECT max(seq) n FROM messages WHERE project_id=? AND thread_id=?',project,old.thread_id).n;
      this.store.run('INSERT INTO jobs(id,project_id,thread_id,participant_id,causal_key,question_id,boundary_seq,context_version,round,status,requested_model,parent_job_id,retrieval,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', next,project,old.thread_id,old.participant_id,`retry:${id}:${key}`,old.question_id,boundary,thread.context_version,old.round,'queued',old.requested_model,id,JSON.stringify(old.retrieval),now());
      this._reserve(next,project,old.thread_id); this.store.event(next,'explicit_retry',{ previous_job:id,actor_id:this.actor.id }); return this.job(project,next);
    });
  }
  usage(project) {
    this.project(project); const day = now().slice(0,10), p = this.policy();
    const counts = this.store.all("SELECT state,count(*) count FROM budget_ledger WHERE day=? GROUP BY state",day);
    const reserved = counts.find(c=>c.state==='reserved')?.count??0, started = counts.find(c=>c.state==='started')?.count??0;
    return { day,reset_timezone:'UTC',global_local_allowance:p.max_calls_per_day,reserved,started,remaining:Math.max(0,p.max_calls_per_day-reserved-started),provider_quota:null,provider_quota_reason:'The clients do not establish remaining provider quota during room reads' };
  }
  exportThread(project,threadId) {
    const thread=this.thread(project,threadId), sources=this.sources(project,threadId,{history:true}), decisions=this.decisions(project,threadId,{history:true}), constraints=this.constraints(project,threadId);
    const messages=this.store.all('SELECT id FROM messages WHERE project_id=? AND thread_id=? ORDER BY seq',project,threadId).map(m=>this.message(project,m.id));
    const records={schema_version:1,project:this.project(project),thread,messages,sources,decisions,constraints,jobs:this.jobs(project,500).filter(j=>j.thread_id===threadId)};
    const markdown=[`# ${thread.title}`,`Project: ${records.project.label}`,`Status: ${thread.status}`, ...messages.map(m=>`## ${m.author_name} (${m.author_role}) -- ${m.created_at}\n\n${m.body}\n\nMessage: ${m.id}${m.stale_context?' | Context changed since consultation':''}`), '## Decisions',...decisions.map(d=>`- [${d.status}] ${d.statement}\n  Rationale: ${d.rationale}\n  Version: ${d.version}`)].join('\n\n')+'\n';
    return { records,markdown };
  }
}
