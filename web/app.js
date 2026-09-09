'use strict';
const $=id=>document.getElementById(id);
const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
let token=sessionStorage.getItem('wapentake-token'),project=sessionStorage.getItem('wapentake-project'),thread=sessionStorage.getItem('wapentake-thread'),state=null,worker={running:false},busy=false,refreshing=false,renderKey='';
const fragment=new URLSearchParams(location.hash.slice(1));
if(fragment.has('token')){token=fragment.get('token');sessionStorage.setItem('wapentake-token',token);history.replaceState(null,'',location.pathname);}
const requestKey=()=>crypto.randomUUID();
function notice(message,error=false){$('notice').textContent=message;$('notice').hidden=!message;$('notice').classList.toggle('error',error);}
async function call(action,data={},scope={}){
  const response=await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({action,project:scope.project??project,thread:scope.thread??thread,data})});
  const payload=await response.json();if(!response.ok)throw Error(payload.error?.message??'The local request failed');return payload.result;
}
function actionButton(label,fn,className='text-button'){const button=el('button',className,label);button.type='button';button.addEventListener('click',()=>perform(fn));return button;}
let actionTail=Promise.resolve();
function perform(fn){
  actionTail=actionTail.then(async()=>{busy=true;try{notice('');await fn();await refresh(true);}catch(error){notice(error.message,true);}finally{busy=false;}});
  return actionTail;
}
function openDialog(title,content){$('dialog-title').textContent=title;$('dialog-content').replaceChildren(content);if(!$('dialog').open)$('dialog').showModal();}
function showData(title,data){openDialog(title,el('pre','',typeof data==='string'?data:JSON.stringify(data,null,2)));}
function formDialog(title,fields,onSubmit,{submit='Save',description}={}){
  const form=el('form','dialog-form');if(description)form.append(el('p','dialog-copy',description));const controls={};
  for(const field of fields){
    const label=el('label',field.type==='checkbox'?'checkbox-label':'',field.label),input=document.createElement(field.type==='textarea'?'textarea':field.type==='select'?'select':'input');
    if(field.type==='select'){for(const [value,text] of field.options){const option=el('option','',text);option.value=value;input.append(option);}}
    else if(field.type!=='textarea')input.type=field.type??'text';
    if(field.type==='checkbox'){input.checked=field.value??false;label.prepend(input);}else{if(field.type!=='select'||field.value!==undefined)input.value=field.value??'';label.append(input);}
    input.name=field.name;input.required=field.required??field.type!=='checkbox';if(field.placeholder)input.placeholder=field.placeholder;if(field.min!==undefined)input.min=field.min;if(field.max!==undefined)input.max=field.max;controls[field.name]=input;form.append(label);
  }
  const submitButton=el('button','button primary',submit);submitButton.type='submit';form.append(submitButton);
  form.addEventListener('submit',event=>{event.preventDefault();perform(async()=>{submitButton.disabled=true;try{const values=Object.fromEntries(fields.map(f=>[f.name,f.type==='checkbox'?controls[f.name].checked:controls[f.name].value]));await onSubmit(values);$('dialog').close();}finally{submitButton.disabled=false;}});});openDialog(title,form);
}
function startThread(){
  if(!project){registerProject();return;}
  formDialog('Start a conversation',[{name:'title',label:'What are we thinking through?'},{name:'mode',label:'First responses',type:'select',options:[['independent','Independent perspectives'],['brainstorm','Open brainstorm']]},{name:'tasks',label:'Task references (comma separated, optional)',required:false}],async v=>{const result=await call('threads.open',{title:v.title,mode:v.mode,task_ids:v.tasks.split(',').map(s=>s.trim()).filter(Boolean),key:requestKey()});thread=result.id;renderKey='';},{submit:'Start conversation'});
}
function registerProject(){formDialog('Register a project',[{name:'path',label:'Existing project directory',placeholder:'/absolute/path/to/project'},{name:'label',label:'Display name (optional)',required:false}],async v=>{const result=await call('projects.register',{path:v.path,...(v.label?{label:v.label}:{})});project=result.id;thread=null;renderKey='';},{submit:'Register project',description:'Each project has its own conversation history and evidence. Registration does not scan files or invite consultants.'});}
function renderThreads(){
  $('thread-count').textContent=state.threads?.length??0;
  $('threads').replaceChildren(...(state.threads??[]).map(t=>{
    const button=actionButton('',async()=>{thread=t.id;renderKey='';},`thread-link${t.id===thread?' active':''}`);
    button.append(el('strong','',t.title),el('span','thread-meta',`${t.status.replaceAll('_',' ')} · ${t.unread} unread`));if(t.unread)button.append(el('span','unread-dot'));return button;
  }));
}
function renderMessages(){
  const box=$('messages'),nearBottom=box.scrollHeight-box.scrollTop-box.clientHeight<80;
  box.replaceChildren(...state.messages.map(m=>{
    const item=el('article','message'),avatar=el('div',`avatar ${m.author_role}`,m.author_name.slice(0,1).toUpperCase());
    const main=el('div','message-main'),top=el('div','message-top');top.append(el('strong','',m.author_name),el('span','muted',m.author_role==='operator'?'Human':m.author_role==='consultant'?'Consultant':'Active agent'));
    if(m.kind!=='message'&&m.kind!=='answer')top.append(el('span','badge',m.kind.replaceAll('_',' ')));
    if(m.stale_context)top.append(el('span','badge','Context changed'));
    const time=el('time','',new Date(m.created_at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}));time.dateTime=m.created_at;top.append(time);
    main.append(top,el('p','message-body',m.body));const refs=el('div','message-ref');
    refs.append(actionButton(`#${m.seq}`,()=>showData('Message reference',m)));
    for(const ref of m.source_ids)refs.append(actionButton(`Evidence ${ref.slice(0,7)}`,async()=>{
      if(state.sources.some(s=>s.id===ref))showData('Captured evidence',await call('sources.read',{id:ref}));
      else{try{showData('Referenced message',await call('messages.get',{id:ref}));}catch{showData('Reference',ref);}}
    }));main.append(refs);item.append(avatar,main);return item;
  }));
  if(nearBottom||renderKey==='')box.scrollTop=box.scrollHeight;
  $('history-note').hidden=state.messages.length<200;
}
function renderCards(id,items,empty,fn){$(id).replaceChildren(...(items.length?items.map(fn):[el('p','placeholder',empty)]));}
function renderContext(){
  renderCards('constraints',state.constraints.filter(c=>c.status==='active'),'Pin the instructions every consultant should see.',c=>{
    const card=el('div','card');card.append(el('div','eyebrow',`Human constraint · v${c.version}`),el('p','',c.body));card.append(actionButton('Revise',()=>formDialog('Revise pinned constraint',[{name:'body',label:'Current instruction',type:'textarea',value:c.body}],v=>call('constraints.set',{body:v.body,stable_id:c.stable_id,key:requestKey()}))));return card;
  });
  renderCards('sources',state.sources,'Attach selected files to make the evidence inspectable.',s=>{
    const button=actionButton('',async()=>showData(s.path,await call('sources.read',{id:s.id})),'card source-button');button.append(el('strong','',s.path),el('span','',`${s.working_tree?'Working tree':s.revision.slice(0,8)} · ${s.size_bytes??s.size} bytes${s.required?' · required':''}`));return button;
  });
  renderCards('decisions',state.decisions,'Record the choice and the reasoning worth keeping.',d=>{
    const card=el('div','card');card.append(el('div','eyebrow',`${d.status} · v${d.version}`),el('strong','',d.statement),el('p','muted',d.rationale));
    const actions=el('div','card-actions');actions.append(actionButton('Inspect',()=>showData('Decision & citations',d)));
    if(d.status==='proposed'){actions.append(actionButton('Review & accept',()=>decisionDialog(d)),actionButton('Reject',()=>decisionDialog(d,'rejected')));}else if(d.status==='accepted')actions.append(actionButton('Supersede',()=>decisionDialog(d,'superseded')));
    card.append(actions);return card;
  });
}
function decisionDialog(previous,status='accepted'){
  const basis=state.thread.context_version;
  formDialog(status==='accepted'?'Record an accepted decision':`Record decision as ${status}`,[{name:'statement',label:'Decision',type:'textarea',value:previous?.statement},{name:'rationale',label:'Why this choice?',type:'textarea',value:previous?.rationale},{name:'citations',label:'Evidence IDs (comma separated, optional)',value:previous?.citations.join(', '),required:false}],v=>call('decisions.set',{statement:v.statement,rationale:v.rationale,citations:v.citations.split(',').map(s=>s.trim()).filter(Boolean),status,...(previous?{stable_id:previous.stable_id}:{}),expected_context_version:basis,key:requestKey()}),{submit:status==='accepted'?'Accept decision':`Record ${status}`,description:'This records your decision and rationale. It does not change task status or review dispositions.'});
}
function renderJobs(){
  $('execution-status').textContent=state.policy.execution_enabled?'Execution enabled':'Execution paused';
  $('worker-toggle').textContent=worker.running?'Stop worker':'Start worker';
  renderCards('jobs',(state.jobs??[]).filter(j=>!thread||j.thread_id===thread).slice(0,12),'Consultants join only when invited.',j=>{
    const card=el('div','card'),top=el('div','job-top');top.append(el('strong','',state.participants.find(p=>p.id===j.participant_id)?.alias??'Consultant'),el('span','job-status',j.status.replaceAll('_',' ')));card.append(top);
    if(j.error_message)card.append(el('p','muted',j.error_message));
    const actions=el('div','card-actions');actions.append(actionButton('Inspect',()=>showData('Consultation details',j)));
    if(['queued','preparing','running'].includes(j.status))actions.append(actionButton('Cancel',()=>call('jobs.cancel',{id:j.id})));
    else if(!['succeeded'].includes(j.status))actions.append(actionButton('Retry',()=>formDialog('Retry consultation',[],()=>call('jobs.retry',{id:j.id,key:requestKey()}),{submit:'Reserve another call',description:'A retry is a new invitation and may consume another plan call. An uncertain run must be reconciled before retrying.'})));
    card.append(actions);return card;
  });
}
async function refresh(force=false){
  if(!token||refreshing)return;refreshing=true;
  try{
    state=await call('snapshot');
    if(!project&&state.projects.length){project=state.projects[0].id;state=await call('snapshot');}
    $('workspace').hidden=false;$('connect').hidden=true;$('identity').textContent=state.actor.name;
    const projectKey=state.projects.map(p=>p.id+p.label).join();if($('project').dataset.key!==projectKey){$('project').replaceChildren(...state.projects.map(p=>{const option=el('option','',p.label);option.value=p.id;return option;}));$('project').dataset.key=projectKey;}
    $('project').value=project??'';$('project-path').textContent=state.project?.path??'Register an existing project directory.';
    renderThreads();
    if(!thread&&state.threads?.length){thread=state.threads[0].id;state=await call('snapshot');renderThreads();}
    $('empty').hidden=Boolean(thread);$('thread-view').hidden=!thread;
    for(const id of ['preview','add-constraint','add-source','add-decision'])$(id).disabled=!thread;
    if(thread&&state.thread){
      $('thread-title').textContent=state.thread.title;$('thread-mode').textContent=state.thread.mode==='independent'?'Independent perspectives':'Open brainstorm';$('thread-status').value=state.thread.status;
      $('participants').replaceChildren(...[['H','You'],['G','GLM'],['A','Astra']].map(([letter,name])=>{const span=el('span');span.append(el('i','mini-avatar',letter),document.createTextNode(name));return span;}));
      const nextKey=JSON.stringify([thread,state.messages,state.constraints,state.sources,state.decisions]);
      if(force||nextKey!==renderKey){renderMessages();renderContext();renderKey=nextKey;}
      const latest=state.messages.at(-1)?.seq;if(latest&&document.visibilityState==='visible')await call('ack',{through:latest});
    }
    if(project)sessionStorage.setItem('wapentake-project',project);else sessionStorage.removeItem('wapentake-project');
    if(thread)sessionStorage.setItem('wapentake-thread',thread);else sessionStorage.removeItem('wapentake-thread');
    if(state.actor.role==='operator')worker=await call('worker.status');renderJobs();
  }catch(error){notice(error.message,true);if(!state){$('connect').hidden=false;$('workspace').hidden=true;}}
  finally{refreshing=false;}
}
function allowanceDialog(){
  const p=state.policy,u=state.usage;
  formDialog('Local call allowance',[{name:'enabled',label:'Enable consultant execution',type:'checkbox',value:p.execution_enabled},{name:'max',label:'Maximum calls per UTC day (all projects)',type:'number',min:1,max:1000,value:p.max_calls_per_day},{name:'rounds',label:'Automatic follow-up',type:'select',value:String(p.automatic_follow_up_rounds),options:[['0','Off'],['1','At most one round']]}],async v=>call('policy.update',{execution_enabled:v.enabled,max_calls_per_day:Number(v.max),automatic_follow_up_rounds:Number(v.rounds)}),{submit:'Save allowance',description:`${u?`${u.started} launched, ${u.reserved} reserved today. `:''}This is a local limit, not remaining provider quota. Calls use your saved plan logins. Starting the worker executes queued invitations.`});
}
$('dialog-close').addEventListener('click',()=>$('dialog').close());
$('dialog').addEventListener('click',event=>{if(event.target===$('dialog')){const r=$('dialog').getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)$('dialog').close();}});
$('register').addEventListener('click',registerProject);$('new-thread').addEventListener('click',startThread);$('empty-new').addEventListener('click',startThread);
$('project').addEventListener('change',()=>perform(async()=>{project=$('project').value;thread=null;renderKey='';}));
$('thread-status').addEventListener('change',()=>perform(()=>call('threads.status',{status:$('thread-status').value})));
for(const kind of ['post','ask'])$(kind).addEventListener('click',()=>perform(async()=>{
  const body=$('message-body').value;if(!body.trim())throw Error('Write a message first.');
  const data={body,key:requestKey()};if(kind==='ask'){data.to=['glm','astra'].filter(p=>$(`invite-${p}`).checked);if(!data.to.length)throw Error('Choose at least one consultant.');}
  const result=await call(kind==='ask'?'ask':'messages.post',data);$('message-body').value='';
  if(kind==='ask')notice(result.execution_enabled?'Invitation queued. The worker runs consultants one at a time.':'Invitation queued. Enable an allowance and start the worker when ready.');
}));
$('message-body').addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key==='Enter'){event.preventDefault();$('post').click();}});
$('add-constraint').addEventListener('click',()=>formDialog('Pin a human constraint',[{name:'body',label:'Instruction for every consultant',type:'textarea'}],v=>call('constraints.set',{body:v.body,key:requestKey()}),{submit:'Pin constraint'}));
$('add-source').addEventListener('click',()=>formDialog('Attach source evidence',[{name:'path',label:'Path relative to this project',placeholder:'docs/design.md'},{name:'revision',label:'Git revision (leave blank for working tree)',required:false},{name:'required',label:'Required in consultant context',type:'checkbox',value:true}],v=>call('sources.add',{path:v.path,working_tree:!v.revision,...(v.revision?{revision:v.revision}:{}),required:v.required,key:requestKey()}),{submit:'Capture evidence',description:'Captures this selected file with its content hash. Later changes can be detected without losing the captured version.'}));
$('add-decision').addEventListener('click',()=>decisionDialog());
$('preview').addEventListener('click',()=>perform(async()=>{const packet=await call('context.preview',{participant:'astra'});showData(`Consultant context · ${packet.bytes??packet.byte_length??new TextEncoder().encode(packet.prompt).length} bytes`,packet.prompt);}));
$('export').addEventListener('click',()=>perform(async()=>{
  const result=await call('export'),blob=new Blob([result.markdown],{type:'text/markdown'}),url=URL.createObjectURL(blob),link=el('a');link.href=url;link.download='wapentake-conversation.md';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}));
$('usage-button').addEventListener('click',allowanceDialog);
$('worker-toggle').addEventListener('click',()=>perform(async()=>{if(!worker.running&&!state.policy.execution_enabled){allowanceDialog();return;}worker=await call(worker.running?'worker.stop':'worker.start');notice(worker.running?'Worker started. Queued invitations can now run.':'Worker stopped taking new jobs. Cancel an active job separately if needed.');}));
$('search-form').addEventListener('submit',event=>{event.preventDefault();perform(async()=>{
  const results=await call('search',{query:$('query').value}),content=el('div');if(!results.length)content.append(el('p','muted','No matching messages in this project.'));
  for(const result of results)content.append(actionButton(result.snippet,async()=>{thread=result.thread_id;renderKey='';$('dialog').close();const message=await call('messages.get',{id:result.id});showData(`Search result · #${message.seq}`,message);},'card search-result'));
  openDialog('Search room history',content);
});});
$('connect-form').addEventListener('submit',event=>{event.preventDefault();token=$('capability').value.trim();sessionStorage.setItem('wapentake-token',token);$('capability').value='';state=null;refresh(true);});
if(token)refresh(true);else $('connect').hidden=false;
setInterval(()=>{if(!busy&&document.visibilityState==='visible')refresh();},3000);
