import { readFileSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { fail,now,uuid,sha256,fingerprint,validateResponse,RoomError } from './contracts.mjs';
import { privateDir,privateWrite } from './store.mjs';
import { buildPacket } from './context.mjs';
import { sourceFreshness,safeSource } from './sources.mjs';
import { adapters as defaultAdapters } from './adapters/index.mjs';
import { processIdentity,processAlive,redact } from './adapters/process.mjs';

export class Worker {
  constructor(room,{adapters=defaultAdapters()}={}){
    room.refreshActor();
    if (room.actor.role !== 'operator' && room.actor.execution_scope !== 'own_jobs') fail('forbidden', 'Worker execution requires an operator or an explicitly issued runner capability');
    this.room=room;this.store=room.store;this.adapters=adapters;this.active=false;
  }
  inspectRecovery(project,id){
    this.room.operator();
    const job=this.room.job(project,id),claim=this.store.get('SELECT * FROM worker_claim WHERE job_id=?',id)??null;
    return {job,claim,owner_alive:claim?processAlive(claim.owner_pid,claim.owner_identity):false,child_alive:claim?.child_pid?processAlive(claim.child_pid,claim.child_identity):false,automatic_retry:false};
  }
  recover(project,id,{confirmStopped=false}={}){
    this.room.operator();
    if(!confirmStopped)fail('invalid_input','Inspect the claim, then explicitly confirm stopped before reconciling');
    return this.store.tx(()=>{
      const state=this.inspectRecovery(project,id);
      if(state.owner_alive||state.child_alive)fail('conflict','A matching local worker or child is still live; refusing to steal its claim');
      if(!['preparing','running','interrupted_unknown'].includes(state.job.status))return state;
      const ledger = this.store.get('SELECT state FROM budget_ledger WHERE job_id=?', id);
      if (!ledger) fail('storage_error', 'Interrupted job has no budget ledger record');
      // A current reservation proves no launch only in the original store. A
      // backup may predate a launch, and its uncertainty survives later recovery.
      const restored = Boolean(this.store.get("SELECT 1 FROM job_events WHERE job_id=? AND event='restored_uncertain' LIMIT 1", id));
      const released = ledger.state === 'reserved' && !restored;
      if (released) this.store.run("UPDATE budget_ledger SET state='released' WHERE job_id=? AND state='reserved'", id);
      const message = released || ledger.state === 'released'
        ? 'Original local process is stopped; confirmed pre-launch reservation is released'
        : 'Original local process is stopped; remote result/usage remains uncertain';
      this.store.run("UPDATE jobs SET status='interrupted_unknown',error_code='interrupted_unknown',error_message=?,completed_at=? WHERE id=?",message,now(),id);
      this.store.run('DELETE FROM worker_claim WHERE job_id=?',id);
      this.store.event(id,'operator_reconciled',{actor_id:this.room.actor.id,automatic_retry:false,reservation_released:released,launch_recorded:ledger.state==='started',restored_uncertain:restored});
      return this.inspectRecovery(project,id);
    });
  }
  refreshSources(project,thread){
    const sources=this.room.sources(project,thread),changes=sourceFreshness(this.store,sources);
    for(const change of changes){
      const source=sources.find(s=>s.id===change.source_id);
      if(change.reason!=='working_tree_changed')fail('needs_scoping','Selected evidence is no longer available within its capture policy',changes);
      const path=safeSource(this.room.project(project).path,source.path),hash=sha256(readFileSync(path.path));
      this.room.addSource(project,thread,{path:source.path,working_tree:true,required:Boolean(source.required),key:`refresh:${source.id}:${hash}`});
    }
    return changes;
  }
  claim({project,jobId}={}){
    if (jobId) {
      const named = this.room.authorizeJob(project, jobId);
      if (named.status !== 'queued') fail('conflict', 'The named job is not queued; no job was executed', { job_id: jobId, status: named.status });
    } else this.room.operator();
    const policy=this.room.policy();
    if(!policy.execution_enabled)return {status:'disabled',reason:'Model execution is disabled; queued discussions remain readable'};
    const identity=processIdentity();
    if(!identity)fail('client_unsupported','Cannot establish the local worker process identity');
    return this.store.tx(()=>{
      const selected = jobId ? this.room.authorizeJob(project, jobId) : null;
      if (selected && selected.status !== 'queued') fail('conflict', 'The named job is not queued; no job was executed', { job_id: jobId, status: selected.status });
      const old=this.store.get('SELECT * FROM worker_claim WHERE singleton=1');
      if(old) {
        if (jobId) {
          const blocker = this.store.get('SELECT project_id FROM jobs WHERE id=?', old.job_id);
          fail('conflict', 'The single worker is occupied; the requested job was not executed', {
            job_id: jobId,
            blocking_job_id: this.room.actor.role === 'operator' || blocker?.project_id === this.room.actor.project_id ? old.job_id : null,
            recovery_required: !processAlive(old.owner_pid, old.owner_identity),
          });
        }
        return {status:'busy',job_id:old.job_id,recovery_required:!processAlive(old.owner_pid,old.owner_identity)};
      }
      const job=selected??this.store.get("SELECT * FROM jobs WHERE status='queued' ORDER BY rowid LIMIT 1");
      if(!job)return {status:'idle'};
      const participant=this.room.jobParticipant(job.project_id,job);
      if(!participant?.enabled||!policy.allowed_adapters.includes(participant.adapter)){
        this.store.run("UPDATE jobs SET status='disabled',error_code='disabled',error_message='Participant disabled by current policy',completed_at=? WHERE id=?",now(),job.id);
        this.store.run("UPDATE budget_ledger SET state='released' WHERE job_id=? AND state='reserved'",job.id);
        return {status:'disabled',job_id:job.id};
      }
      const reservation=this.store.get('SELECT * FROM budget_ledger WHERE job_id=?',job.id),day=now().slice(0,10);
      if(!reservation||reservation.state!=='reserved')fail('storage_error','Queued job has no intact budget reservation');
      if(reservation.day!==day){
        const used=this.store.get("SELECT count(*) n FROM budget_ledger WHERE day=? AND state IN ('reserved','started')",day).n;
        if(used>=policy.max_calls_per_day)return {status:'quota_wait',reason:'Local daily allowance is fully reserved'};
        this.store.run('UPDATE budget_ledger SET day=?,policy_hash=? WHERE job_id=?',day,fingerprint(policy),job.id);
      }
      const spent=this.store.get("SELECT count(*) n FROM budget_ledger WHERE day=? AND state='started'",day).n;
      const threadSpent=this.store.get("SELECT count(*) n FROM budget_ledger b JOIN jobs j ON j.id=b.job_id WHERE j.thread_id=? AND b.state='started'",job.thread_id).n;
      if(spent>=policy.max_calls_per_day||threadSpent>=policy.max_calls_per_thread)return {status:'quota_wait',reason:'Current policy allowance is exhausted'};
      this.store.run('INSERT INTO worker_claim(singleton,job_id,owner_pid,owner_identity,heartbeat) VALUES(1,?,?,?,?)',job.id,process.pid,identity,now());
      this.store.run("UPDATE jobs SET status='preparing' WHERE id=?",job.id);
      this.store.event(job.id,'preparing',{owner_pid:process.pid,owner_identity:identity});
      return {status:'claimed',job:this.room.job(job.project_id,job.id),participant};
    });
  }
  async runOnce(){
    this.room.operator();
    if(this.active)return {status:'busy'};
    return this.runClaimed();
  }
  async runJob(project,id){
    this.room.authorizeJob(project,id);
    if(this.active)fail('conflict','This worker already has an active consultation',{job_id:id});
    return {job_id:id,...await this.runClaimed({project,jobId:id})};
  }
  async runClaimed(target={}){
    const claimed=this.claim(target);if(claimed.status!=='claimed')return claimed;
    this.active=true;
    const {job,participant}=claimed,dir=this.store.jobDir(job.project_id,job.id),controller=new AbortController();
    let timer,started=false,packet;
    try{
      privateDir(dir);
      const changes=this.refreshSources(job.project_id,job.thread_id);
      if(changes.length)this.store.event(job.id,'sources_refreshed',{changes});
      packet=buildPacket(this.room,job.project_id,job.thread_id,participant.id,{job});
      const adapter=this.adapters.get(participant.adapter);
      if(!adapter)fail('client_unsupported','Participant adapter is not installed');
      const prepared=await adapter.prepare({dir,participant,packet,policy:this.room.policy()});
      // Capability inspection can take time: rebuild the captured packet if the operator changed it.
      const latest=this.room.thread(job.project_id,job.thread_id);
      if(latest.context_version!==packet.context_version||sourceFreshness(this.store,packet.source_snapshot).length){
        this.refreshSources(job.project_id,job.thread_id);
        packet=buildPacket(this.room,job.project_id,job.thread_id,participant.id,{job});
      }
      privateWrite(join(dir,'packet.json'),JSON.stringify(packet,null,2));
      privateWrite(join(dir,'packet.md'),packet.prompt);
      privateWrite(join(dir,'invocation.json'),JSON.stringify({adapter:participant.adapter,requested_model:participant.model,reasoning_effort:participant.reasoning_effort,model_selection:participant.model_selection,model_selection_hash:participant.model_selection_hash,capabilities:prepared.capabilities,packet_hash:packet.hash,configuration_hash:packet.config_hash,environment_policy:'allowlisted saved-client-auth environment; API keys/provider overrides excluded',source_scope:'selected packet only'},null,2));
      this.store.tx(()=>{
        this.room.authorizeJob(job.project_id,job.id);
        if(!this.room.policy().execution_enabled)fail('disabled','Execution was paused before launch');
        if(this.room.job(job.project_id,job.id).cancel_requested)fail('cancelled','Invitation was cancelled before launch');
        this.store.run("UPDATE jobs SET status='running',packet_hash=?,config_hash=?,context_version=?,started_at=? WHERE id=?",packet.hash,packet.config_hash,packet.context_version,now(),job.id);
        this.store.run("UPDATE budget_ledger SET state='started' WHERE job_id=?",job.id);
        this.store.event(job.id,'launch_intent',{packet_hash:packet.hash});
      });
      started=true;
      timer=setInterval(()=>{
        try{
          this.store.run('UPDATE worker_claim SET heartbeat=? WHERE job_id=?',now(),job.id);
          this.room.authorizeJob(job.project_id,job.id);
          if(this.room.job(job.project_id,job.id).cancel_requested)controller.abort();
        }catch{controller.abort();}
      },250);timer.unref();
      const normalized=await adapter.run(prepared,{prompt:packet.prompt,policy:this.room.policy(),signal:controller.signal,
        onSpawn:pid=>{this.store.run('UPDATE worker_claim SET child_pid=?,child_identity=?,heartbeat=? WHERE job_id=?',pid,processIdentity(pid),now(),job.id);this.store.event(job.id,'spawned',{child_pid:pid});},
        onCapture:result=>{privateWrite(join(dir,'native-events.jsonl'),result.stdout);privateWrite(join(dir,'client-diagnostic.txt'),result.stderr??'');privateWrite(join(dir,'client-result.json'),JSON.stringify({exit_code:result.code,signal:result.signal,spawned:result.spawned},null,2));},
      });
      if(controller.signal.aborted||this.room.job(job.project_id,job.id).cancel_requested)fail('cancelled','Consultation was cancelled; output was not promoted');
      this.room.authorizeJob(job.project_id,job.id);
      const finished=this.persistResponse(job,participant,packet,normalized,dir);
      this.queueFollowUps(job.project_id,job.question_id);
      return finished;
    }catch(error){
      const code=error instanceof RoomError?error.code:'provider_error';
      const status=code==='cancelled'?'cancelled':['needs_scoping','auth_required','quota_wait','disabled'].includes(code)?code:'failed';
      const message=redact(error.message??'Consultant failed').slice(0,1500);
      this.store.tx(()=>{
        this.store.run('UPDATE jobs SET status=?,error_code=?,error_message=?,completed_at=? WHERE id=?',status,code,message,now(),job.id);
        if(!started||error.details?.spawned===false)this.store.run("UPDATE budget_ledger SET state='released' WHERE job_id=?",job.id);
        this.store.event(job.id,status,{error_code:code,message,launch_attempted:started,spawned:error.details?.spawned??null});
        this.store.run('DELETE FROM worker_claim WHERE job_id=?',job.id);
      });
      this.queueFollowUps(job.project_id,job.question_id);
      return {status,job:this.room.job(job.project_id,job.id),error:{code,message}};
    }finally{clearInterval(timer);this.active=false;}
  }
  async reconcileCapture(project,id){
    this.room.operator();
    const job=this.room.job(project,id);
    if(job.status==='succeeded')return {status:'succeeded',job,already_recorded:true};
    if(job.status!=='failed'||job.cancel_requested||this.store.get('SELECT job_id FROM worker_claim WHERE job_id=?',id))fail('conflict','Only a stopped, failed, uncancelled capture can be reconciled');
    const participant=this.room.jobParticipant(project,job);
    if(participant?.adapter!=='opencode-glm-plan'||job.error_code!=='client_unsupported'||!['OpenCode session export was not JSON','Could not inspect the completed OpenCode session metadata'].includes(job.error_message))fail('conflict','This failure has no supported metadata-only reconciliation');
    const dir=this.store.jobDir(project,id),read=name=>JSON.parse(readFileSync(join(dir,name),'utf8'));
    const receipt=read('client-result.json'),packet=read('packet.json'),invocation=read('invocation.json');
    if(receipt.exit_code!==0||receipt.signal!==null||receipt.spawned!==true)fail('conflict','Captured client did not have a proven successful exit');
    if(this.store.get('SELECT state FROM budget_ledger WHERE job_id=?',id)?.state!=='started')fail('storage_error','Captured invocation has no charged launch record');
    if(sha256(packet.prompt)!==job.packet_hash||packet.hash!==job.packet_hash||readFileSync(join(dir,'packet.md'),'utf8')!==packet.prompt||invocation.packet_hash!==job.packet_hash||invocation.requested_model!==participant.model||packet.config_hash!==job.config_hash)fail('storage_error','Saved invocation or packet integrity check failed');
    // Read the structured packet from the hashed original prompt, not mutable JSON metadata.
    const marker='\n\nROOM PACKET\n';
    if(!packet.prompt.includes(marker))fail('storage_error','Saved packet has no structured room content');
    packet.packet=JSON.parse(packet.prompt.slice(packet.prompt.lastIndexOf(marker)+marker.length));
    packet.context_version=packet.packet.thread.context_version;
    packet.source_snapshot=[...new Set([...packet.packet.sources.map(s=>s.id),...packet.packet.retrieval.filter(r=>r.kind==='read').map(r=>r.source_id)])].map(source=>this.room.source(project,source));
    const adapter=this.adapters.get(participant.adapter);
    if(!adapter?.normalizeCapture)fail('client_unsupported','Adapter has no metadata-only capture reader');
    const prepared=await adapter.prepare({dir,participant,policy:this.room.policy()});
    const normalized=await adapter.normalizeCapture(prepared,{stdout:readFileSync(join(dir,'native-events.jsonl'),'utf8'),code:receipt.exit_code});
    // Another operator may have retried, cancelled or recorded this job during inspection.
    return this.store.tx(()=>{
      const current=this.room.job(project,id);
      if(current.status!==job.status||current.cancel_requested)fail('conflict','Job changed while verifying its capture');
      this.store.event(id,'capture_reconciled',{actor_id:this.room.actor.id,prior_error_code:job.error_code,prior_error_message:job.error_message,new_model_calls:0});
      return this.persistResponse(job,participant,packet,normalized,dir);
    });
  }
  persistResponse(job,participant,packet,normalized,dir){
      if (normalized.observed_model !== null && normalized.observed_model !== undefined && (typeof normalized.observed_model !== 'string' || !normalized.observed_model.trim())) fail('invalid_output', 'Client reported an invalid model identity');
      if(normalized.observed_model&&normalized.observed_model!==participant.model&&normalized.observed_model!==participant.model.split('/').at(-1))fail('model_unavailable','Client reported a different model than requested');
      const response=validateResponse(normalized.value,{citations:packet.packet.allowed_citations,participants:packet.packet.discussion_participants.map(p=>p.id)});
      for (const request of response.context_requests) if (request.kind === 'read') {
        try { this.room.source(job.project_id, request.source_id); }
        catch (error) {
          if (error instanceof RoomError && error.code === 'not_found') fail('invalid_output', 'Consultant requested a source that does not exist in this project');
          throw error;
        }
      }
      const changed=this.room.thread(job.project_id,job.thread_id).context_version!==packet.context_version||sourceFreshness(this.store,packet.source_snapshot).length>0;
      const output={response,requested_model:participant.model,reasoning_effort:participant.reasoning_effort,model_selection_hash:participant.model_selection_hash,observed_model:normalized.observed_model??null,model_identity_verified:normalized.observed_model!==null&&normalized.observed_model!==undefined,model_identity_source:normalized.model_identity_source??null,diagnostics:normalized.diagnostics??[],usage:normalized.usage??null,usage_unknown_reason:normalized.usage_unknown_reason??null,terminal_state:normalized.terminal_state,session_id:normalized.session_id??null,stale_context:changed,completed_at:now()};
      privateWrite(join(dir,'output.json'),JSON.stringify(output,null,2));
      return this.store.tx(()=>{
        const author={id:participant.id,name:participant.alias,role:'consultant'};
        const message=this.room._post(job.project_id,job.thread_id,{body:response.body,kind:response.kind,reply_to:job.question_id,source_ids:response.citations,job_id:job.id,basis_context_version:packet.context_version},author);
        this.store.run("UPDATE jobs SET status='succeeded',reply_id=?,stale_context=?,usage=?,completed_at=?,error_code=NULL,error_message=NULL WHERE id=?",message.id,changed?1:0,JSON.stringify(normalized.usage??null),now(),job.id);
        if(response.proposed_decision&&!changed){
          const d=response.proposed_decision,id=uuid();
          this.store.run('INSERT INTO decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,uuid(),1,job.project_id,job.thread_id,d.statement,d.rationale,'proposed',JSON.stringify([...new Set([...d.citations,message.id])]),participant.id,now());
        }
        if(response.kind==='needs_context')this.store.run("UPDATE threads SET status='waiting_for_input' WHERE id=?",job.thread_id);
        this.store.event(job.id,'succeeded',{reply_id:message.id,stale_context:changed,usage_available:normalized.usage!==null&&normalized.usage!==undefined});
        this.store.run('DELETE FROM worker_claim WHERE job_id=?',job.id);
        return {status:'succeeded',job:this.room.job(job.project_id,job.id),reply:this.room.message(job.project_id,message.id)};
      });
  }
  queueFollowUps(project,questionId){
    const policy=this.room.policy();if(!policy.execution_enabled||policy.automatic_follow_up_rounds!==1)return [];
    const first=this.store.all('SELECT * FROM jobs WHERE project_id=? AND question_id=? AND round=0 ORDER BY rowid',project,questionId);
    if(first.some(j=>['queued','preparing','running'].includes(j.status)))return [];
    const created=[];
    for(const parent of first.filter(j=>j.status==='succeeded'&&!j.stale_context)){
      const path=join(this.store.jobDir(project,parent.id),'output.json');if(!existsSync(path))continue;
      let output;try{output=JSON.parse(readFileSync(path,'utf8')).response;}catch{continue;}
      if(!output.follow_up&&!output.context_requests?.length)continue;
      const target=output.follow_up?.participant_id??parent.participant_id;
      const key=`followup:${questionId}:${target}:1`;
      if(this.store.get('SELECT id FROM jobs WHERE project_id=? AND causal_key=?',project,key))continue;
      try{
        const next=this.store.tx(()=>{
          if(this.store.get('SELECT id FROM jobs WHERE project_id=? AND causal_key=?',project,key))return null;
          const participant=this.room.participants(project).find(p=>p.id===target);
          if(!participant||!first.some(j=>j.participant_id===target))fail('invalid_output','Follow-up recipient was not in the first-round discussion');
          const model = this.store.jobModel(first.find(j => j.participant_id === target).id);
          const body=output.follow_up?.question??'Respond to the original question using the requested retrieved context. Preserve the current operator constraints.';
          const question=this.room._post(project,parent.thread_id,{body,kind:'question',reply_to:parent.reply_id,source_ids:output.follow_up?.citations??[]},{id:parent.participant_id,name:'Bounded follow-up',role:'consultant'});
          const id=uuid(),thread=this.room.thread(project,parent.thread_id);
          this.store.run('INSERT INTO jobs(id,project_id,thread_id,participant_id,causal_key,question_id,boundary_seq,context_version,round,status,requested_model,parent_job_id,retrieval,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,project,parent.thread_id,target,key,question.id,question.seq,thread.context_version,1,'queued',model.selection.model,parent.id,JSON.stringify(output.context_requests??[]),now());
          this.store.saveJobModel(id, model.owner_actor_id, model.selection);
          this.room._reserve(id,project,parent.thread_id);this.store.event(id,'bounded_follow_up',{parent_job_id:parent.id});return id;
        });
        if(next)created.push(next);
      }catch(error){this.store.event(parent.id,'follow_up_not_queued',{reason:error.code??'storage_error'});}
    }
    return created;
  }
}
