import { keys,object,text,strings,fail } from './contracts.mjs';
import { buildPacket } from './context.mjs';
import { Worker } from './worker.mjs';

export function workflowEvent(room,project,options){
  keys(options,['kind','task_id','body','source_ids','attempts','failure_signature','to','key'],'workflow event');
  if(!['disagreement','stuck'].includes(options.kind))fail('invalid_input','Supported workflow triggers are disagreement and stuck');
  room.project(project);text(options.task_id,'task_id',200);text(options.body,'event body',8000);
  if(!room.policy().enabled_triggers.includes(options.kind))return {status:'disabled',trigger:options.kind,advisory:true,task_changed:false};
  const refs=strings(options.source_ids,'source_ids');room.checkRefs(project,refs);
  if(options.kind==='disagreement'&&refs.length<2)fail('invalid_input','A disagreement event needs both review references');
  if(options.kind==='stuck'){
    if(strings(options.attempts,'attempts').length<2)fail('invalid_input','Stuck work requires two distinct attempted fixes');
    text(options.failure_signature,'failure_signature',500);
  }
  return room.store.idempotent(project,room.actor.id,'event',options.key,options,()=>{
    const thread=room.openThread(project,{title:`${options.task_id}: ${options.kind==='disagreement'?'Review disagreement':'New hypothesis'}`,task_ids:[options.task_id],mode:'independent',key:`event-thread:${options.key}`});
    const ask=room.ask(project,thread.id,{body:options.body,to:options.to??(options.kind==='stuck'?['astra']:['glm','astra']),source_ids:refs,key:`event-ask:${options.key}`});
    return {...ask,thread_id:thread.id,advisory:true,task_changed:false};
  });
}
export async function execute(room,action,{project,thread,data={}}={},services={}){
  object(data,'command data');
  switch(action){
    case 'snapshot':{
      keys(data,[]);
      const projects=room.projects();
      if(!project)return {actor:room.actor,projects,policy:room.policy()};
      const result={actor:room.actor,projects,project:room.project(project),threads:room.threads(project),participants:room.participants(project),jobs:room.jobs(project),usage:room.usage(project),policy:room.policy()};
      if(thread){
        const selected=room.thread(project,thread);
        const last=room.store.all('SELECT id FROM messages WHERE project_id=? AND thread_id=? ORDER BY seq DESC LIMIT 200',project,thread).reverse();
        Object.assign(result,{thread:selected,messages:last.map(m=>room.message(project,m.id)),sources:room.sources(project,thread),constraints:room.constraints(project,thread),decisions:room.decisions(project,thread)});
      }
      return result;
    }
    case 'projects.list':return room.projects();
    case 'projects.register':return room.register(data);
    case 'projects.move':keys(data,['path']);return room.moveProject(project,data.path);
    case 'actors.attach':return room.attachActor(project,data);
    case 'participants.list':return room.participants(project);
    case 'threads.list':return room.threads(project);
    case 'threads.open':return room.openThread(project,data);
    case 'threads.get':return room.thread(project,thread);
    case 'threads.status':keys(data,['status']);return room.setThreadStatus(project,thread,data.status);
    case 'messages.post':return room.post(project,thread,data);
    case 'messages.read':keys(data,['after','limit']);return room.read(project,thread,data);
    case 'messages.get':keys(data,['id']);return room.message(project,data.id);
    case 'inbox':return room.inbox(project);
    case 'ack':keys(data,['through']);return room.ack(project,thread,data.through);
    case 'search':keys(data,['query','limit']);return room.search(project,data.query,data.limit??5);
    case 'sources.add':return room.addSource(project,thread,data);
    case 'sources.list':return room.sources(project,thread);
    case 'sources.read':keys(data,['id','offset','max_bytes']);return room.readSource(project,data.id,data.offset??0,data.max_bytes??8192);
    case 'constraints.list':return room.constraints(project,thread);
    case 'constraints.set':return room.constrain(project,thread,data);
    case 'decisions.list':keys(data,['history']);return room.decisions(project,thread,data);
    case 'decisions.set':return room.decide(project,thread,data);
    case 'ask':return room.ask(project,thread,data);
    case 'context.preview':keys(data,['participant']);return buildPacket(room,project,thread,data.participant??'astra');
    case 'policy.show':return room.policy();
    case 'policy.update':return room.setPolicy(data);
    case 'jobs.list':keys(data,['limit']);return room.jobs(project,data.limit??100);
    case 'jobs.get':keys(data,['id']);return room.job(project,data.id);
    case 'jobs.cancel':keys(data,['id']);return room.cancel(project,data.id);
    case 'jobs.retry':keys(data,['id','key']);return room.retry(project,data.id,data.key);
    case 'jobs.reconcile-capture':keys(data,['id']);room.operator();return (services.worker??new Worker(room)).reconcileCapture(project,data.id);
    case 'jobs.recover':keys(data,['id','confirm_stopped']);return (services.worker??new Worker(room)).recover(project,data.id,{confirmStopped:data.confirm_stopped===true});
    case 'jobs.inspect':keys(data,['id']);room.operator();return (services.worker??new Worker(room)).inspectRecovery(project,data.id);
    case 'worker.once':room.operator();return (services.worker??new Worker(room)).runOnce();
    case 'usage':return room.usage(project);
    case 'event':return workflowEvent(room,project,data);
    case 'export':return room.exportThread(project,thread);
    case 'backup':keys(data,['out']);room.operator();text(data.out,'backup destination',2000);return room.store.backup(data.out);
    default:fail('invalid_input',`Unknown command action: ${action}`);
  }
}
