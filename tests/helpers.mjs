import { mkdtempSync,mkdirSync,readFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store,Room } from '../src/room.mjs';
export function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'wapentake-test-')),state=join(root,'state'),repo=join(root,'repo');
  mkdirSync(repo);
  const store=new Store(state,{initialize:true});
  const operator=store.ensureOperator('Test operator'),token=readFileSync(operator.tokenPath,'utf8').trim();
  const room=new Room(store,token),project=room.register({path:repo,label:'Test project'});
  const thread=room.openThread(project.id,{title:'Contract decision',key:'thread-1',mode:'independent'});
  t.after(()=>{try{store.close();}catch{} rmSync(root,{recursive:true,force:true});});
  return {root,state,repo,store,room,project,thread,token};
}
export function response(body='Use explicit errors.',citations=[]) {
  return {schema_version:1,kind:'answer',body,citations,context_requests:[],proposed_decision:null,follow_up:null};
}
