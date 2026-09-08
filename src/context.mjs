import { readFileSync } from 'node:fs';
import { stable, sha256, fail } from './contracts.mjs';
import { excerpt, sourceFreshness } from './sources.mjs';

const instruction=readFileSync(new URL('../prompts/consultant.md',import.meta.url),'utf8').trim();
const schema=JSON.parse(readFileSync(new URL('../schemas/consultant-response.json',import.meta.url),'utf8'));
const compactMessage=m=>({id:m.id,seq:m.seq,author:m.author_name,role:m.author_role,kind:m.kind,body:m.body,reply_to:m.reply_to,source_ids:m.source_ids??[],stale_context:Boolean(m.stale_context)});
const compactDecision=d=>({id:d.id,stable_id:d.stable_id,version:d.version,status:d.status,statement:d.statement,rationale:d.rationale,citations:d.citations});
export function buildPacket(room,project,threadId,participantId,{job=null}={}) {
  const store=room.store,thread=room.thread(project,threadId),policy=room.policy();
  const participant=room.participants(project).find(p=>p.id===participantId||p.alias===participantId);
  if(!participant)fail('not_found','Participant is not registered in this project');
  const boundary=job?.boundary_seq??store.get('SELECT coalesce(max(seq),0) n FROM messages WHERE project_id=? AND thread_id=?',project,threadId).n;
  const latestQuestion=thread.question_id??job?.question_id??store.get("SELECT id FROM messages WHERE project_id=? AND thread_id=? AND kind='question' ORDER BY seq DESC LIMIT 1",project,threadId)?.id;
  if(!latestQuestion)fail('needs_scoping','Post an explicit question before assembling consultant context');
  const direct=room.message(project,job?.question_id??latestQuestion),currentQuestion=room.message(project,latestQuestion);
  const required=new Map([[direct.id,direct],[currentQuestion.id,currentQuestion]]);
  // Human corrections survive the independent first-round boundary.
  for(const row of store.all("SELECT id FROM messages WHERE project_id=? AND thread_id=? AND author_role='operator' AND seq>=? ORDER BY seq",project,threadId,currentQuestion.seq))required.set(row.id,room.message(project,row.id));
  const constraints=room.constraints(project,threadId).filter(c=>c.status==='active');
  const decisions=room.decisions(project,threadId).filter(d=>{
    if(!job||job.round!==0||thread.mode!=='independent'||d.status!=='proposed')return true;
    const after=d.citations.flatMap(id=>{const m=store.get('SELECT author_role,seq FROM messages WHERE project_id=? AND id=? AND seq>?',project,id,boundary);return m?[m]:[];});
    return !after.some(m=>m.author_role!=='operator')||after.some(m=>m.author_role==='operator');
  });
  const unresolved=store.all("SELECT m.id FROM messages m WHERE m.project_id=? AND m.thread_id=? AND m.kind IN ('objection','unknown') AND m.seq<=? AND NOT EXISTS(SELECT 1 FROM messages r WHERE r.reply_to=m.id AND r.author_role='operator' AND r.kind IN ('conclusion','correction')) ORDER BY m.seq",project,threadId,boundary);
  for(const row of unresolved)required.set(row.id,room.message(project,row.id));
  let parent=direct,chain=0;
  while(parent.reply_to&&chain++<12){parent=room.message(project,parent.reply_to);required.set(parent.id,parent);}
  if(parent.reply_to)fail('needs_scoping','The direct reply chain is too deep; start a focused question');
  const attached=room.sources(project,threadId);
  const changes=sourceFreshness(store,attached.filter(s=>s.required));
  if(changes.length)fail('needs_scoping','Attached working-tree evidence changed; capture the updated source explicitly',changes);
  const citedSources=direct.source_ids.flatMap(id=>{try{return [room.source(project,id)];}catch{return [];}});
  const requiredSources=attached.filter(s=>s.required||citedSources.some(c=>c.id===s.id||(c.working_tree&&s.working_tree&&c.path===s.path)));
  const sourceItem=(s,maxBytes=null)=>{
    const bytes=store.readBlob(project,s.blob_hash);
    const selected=maxBytes?excerpt(bytes,0,maxBytes):{text:bytes.toString('utf8'),offset_bytes:0,end_bytes:bytes.length,total_bytes:bytes.length,continuation_offset:null};
    return {id:s.id,path:s.path,revision:s.revision,working_tree_included:Boolean(s.working_tree),sha256:s.blob_hash,supersedes_cited_source_ids:citedSources.filter(c=>c.working_tree&&s.working_tree&&c.path===s.path&&c.id!==s.id).map(c=>c.id),...selected};
  };
  // Explicit message citations and accepted-decision rationale remain available even when old.
  for(const ref of [...direct.source_ids,...decisions.flatMap(d=>d.citations)]){
    const m=store.get('SELECT id FROM messages WHERE project_id=? AND id=?',project,ref);
    if(m)required.set(m.id,room.message(project,m.id));
  }
  const discussionIds=store.all('SELECT DISTINCT participant_id id FROM jobs WHERE project_id=? AND thread_id=? ORDER BY participant_id',project,threadId).map(p=>p.id);
  if(!discussionIds.includes(participant.id))discussionIds.push(participant.id);
  const packet={
    schema_version:1,project:{id:project,label:room.project(project).label},
    thread:{id:threadId,title:thread.title,mode:thread.mode,context_version:thread.context_version,first_round_boundary:boundary},
    participant:{id:participant.id,alias:participant.alias,requested_model:participant.model},
    discussion_participants:room.participants(project).filter(p=>discussionIds.includes(p.id)).map(p=>({id:p.id,alias:p.alias})),
    direct_question_id:direct.id,current_operator_question_id:currentQuestion.id,
    messages:[...required.values()].sort((a,b)=>a.seq-b.seq).map(compactMessage),
    constraints:constraints.map(c=>({id:c.id,stable_id:c.stable_id,version:c.version,text:c.body,source_message_id:c.source_message_id})),
    decisions:decisions.map(compactDecision),
    sources:requiredSources.map(s=>sourceItem(s)),retrieval:[],
    allowed_citations:[],coverage:{history_omitted_count:0,optional_omissions:[],notes:['Only captured evidence is supplied. Source bytes identify selected files, not a full application.']},
  };
  const allowed=()=>[...new Set([...packet.messages.map(m=>m.id),...packet.sources.map(s=>s.id),...packet.constraints.map(c=>c.id),...packet.decisions.map(d=>d.id),...packet.retrieval.flatMap(r=>r.hits?r.hits.map(h=>h.id):[r.source_id])])].sort();
  const render=()=>{packet.allowed_citations=allowed();return `${instruction}\n\nRESPONSE SCHEMA\n${stable(schema)}\n\nROOM PACKET\n${stable(packet)}\n`;};
  const measure=()=>Buffer.byteLength(render());
  if(job?.retrieval?.length){
    for(const request of job.retrieval){
      if(request.kind==='read'){
        const source=room.source(project,request.source_id);
        packet.retrieval.push({kind:'read',source_id:source.id,sha256:source.blob_hash,...excerpt(store.readBlob(project,source.blob_hash),request.offset_bytes,Math.min(request.max_bytes,policy.max_retrieval_bytes))});
      }else if(request.kind==='search')packet.retrieval.push({kind:'search',query:request.query,hits:room.search(project,request.query,Math.min(request.limit,5))});
      else fail('invalid_input','Unknown stored retrieval request');
    }
  }
  if(measure()>policy.max_packet_bytes)fail('needs_scoping','Required question, constraints and evidence exceed the packet budget',{required_bytes:measure(),limit_bytes:policy.max_packet_bytes});
  const omissions=[];
  const recent=store.all('SELECT id FROM messages WHERE project_id=? AND thread_id=? AND seq<=? ORDER BY seq DESC LIMIT 30',project,threadId,boundary);
  let added=0;
  for(const row of recent){
    if(required.has(row.id))continue;
    const message=room.message(project,row.id);
    if(message.stale_context){omissions.push({id:row.id,reason:'stale_consultation'});continue;}
    if(added>=6){omissions.push({id:row.id,reason:'recent_message_limit'});continue;}
    packet.messages.push(compactMessage(message));packet.messages.sort((a,b)=>a.seq-b.seq);
    if(measure()>policy.max_packet_bytes-1200){packet.messages=packet.messages.filter(m=>m.id!==row.id);omissions.push({id:row.id,reason:'packet_budget'});}else added++;
  }
  for(const source of attached.filter(s=>!requiredSources.some(r=>r.id===s.id))){
    if(sourceFreshness(store,[source]).length){omissions.push({id:source.id,reason:'working_tree_changed'});continue;}
    packet.sources.push(sourceItem(source,policy.max_retrieval_bytes));
    if(measure()>policy.max_packet_bytes-1200){packet.sources.pop();omissions.push({id:source.id,reason:'packet_budget'});}
  }
  packet.coverage.history_omitted_count=Number(store.get('SELECT count(*) n FROM messages WHERE project_id=? AND thread_id=?',project,threadId).n)-packet.messages.length;
  packet.coverage.optional_omissions=omissions.slice(0,10);
  const prompt=render(),bytes=Buffer.byteLength(prompt);
  if(bytes>policy.max_packet_bytes)fail('needs_scoping','Context coverage metadata exceeds the remaining packet budget',{required_bytes:bytes,limit_bytes:policy.max_packet_bytes});
  const includedSources=attached.filter(s=>packet.sources.some(p=>p.id===s.id)||packet.retrieval.some(r=>r.source_id===s.id));
  return {packet,prompt,hash:sha256(prompt),bytes,estimated_tokens:Math.ceil(bytes/4),token_estimator:'utf8-bytes-divided-by-four-v1-estimate-only',context_version:thread.context_version,source_snapshot:includedSources,omissions,config_hash:sha256(stable({participant,policy,prompt:sha256(instruction),schema:sha256(stable(schema))}))};
}
