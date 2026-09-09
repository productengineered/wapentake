import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { parse } from 'yaml';
import { assess, disposition, runGate } from '../.github/scripts/review-gate.mjs';
import { assessCI, CI_JOBS, runGates } from '../.github/scripts/repository-gates.mjs';

const complete={context:'CodeRabbit',state:'success',description:'Review completed',creator:{login:'coderabbitai[bot]'}};
const original={body:'Please handle this failure.',authorAssociation:'NONE',author:{login:'coderabbitai[bot]'}};
const fixed={body:'Fixed: abc1234 — Refuse missing metadata before publishing a successful check.',authorAssociation:'OWNER',author:{login:'maintainer'}};

test('trusted CI aggregate rejects missing, skipped, cancelled and different-commit evidence',()=>{
  const head='a'.repeat(40),run={head_sha:head,event:'pull_request',path:'.github/workflows/ci.yml',status:'completed',conclusion:'success'};
  const jobs=CI_JOBS.map(name=>({name,conclusion:'success'}));
  assert.deepEqual(assessCI(run,jobs,head),[]);
  assert.ok(assessCI(run,jobs.slice(1),head).length);
  for(const conclusion of ['skipped','cancelled','failure'])assert.ok(assessCI(run,[{...jobs[0],conclusion},...jobs.slice(1)],head).length);
  assert.ok(assessCI({...run,head_sha:'b'.repeat(40)},jobs,head).length);
});

test('review gate rejects green skipped, stale, pending and impersonated CodeRabbit results',()=>{
  assert.deepEqual(assess([complete],[]),[]);
  for(const statuses of [[],[{...complete,description:'Review skipped: bot user not eligible for review'}],[{...complete,description:'Review rate limited'}],[{...complete,state:'pending'},complete],[{...complete,creator:{login:'someone-else'}}]])assert.ok(assess(statuses,[]).length);
});

test('review gate requires resolution plus a substantive collaborator disposition on every thread',()=>{
  const thread={id:'thread',isResolved:true,comments:[original,fixed]};
  assert.deepEqual(assess([complete],[thread]),[]);
  assert.ok(assess([complete],[{...thread,isResolved:false}]).length);
  assert.ok(assess([complete],[{...thread,comments:[original]}]).length);
  assert.equal(disposition([original,{...fixed,authorAssociation:'CONTRIBUTOR'}]),undefined);
  assert.equal(disposition([original,{...fixed,body:'Fixed: abc1234 done'}]),undefined);
  assert.equal(disposition([original,{...fixed,author:{login:'coderabbitai[bot]'}}]),undefined);
});

function apiFixture(t,{changedHead=false,graphFailure=false,reply=fixed,multiplePRs=false,failFirstPublish=false,cleanReview=false}={}){
  const savedFetch=globalThis.fetch,savedExit=process.exitCode;
  const environment={GITHUB_REPOSITORY:'fixture/project',GITHUB_RUN_ID:'123',GH_TOKEN:'fixture',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_EVENT_PATH:undefined,REVIEW_GATE_READ_ONLY:undefined,SCAN_RESULTS:undefined};
  const saved=Object.fromEntries(Object.keys(environment).map(key=>[key,process.env[key]]));
  for(const [key,value] of Object.entries(environment)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  t.after(()=>{globalThis.fetch=savedFetch;process.exitCode=savedExit;for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const head='a'.repeat(40),pr={number:1,head:{sha:head},draft:false,state:'open'};
  const second={...pr,number:2,head:{sha:'c'.repeat(40)}};
  const published=[],calls=[];
  globalThis.fetch=async(input,options={})=>{
    const url=new URL(input),path=url.pathname;
    const body=options.body?JSON.parse(options.body):null;
    calls.push({path,query:url.search,variables:body?.variables});
    let data;
    if(path==='/repos/fixture/project')data={default_branch:'main'};
    else if(path==='/repos/fixture/project/pulls')data=multiplePRs?[pr,second]:[pr];
    else if(path==='/repos/fixture/project/pulls/1')data={...pr,head:{sha:changedHead?'b'.repeat(40):head}};
    else if(path==='/repos/fixture/project/pulls/2')data=second;
    else if(path.endsWith('/statuses'))data=url.searchParams.get('page')==='1'?Array.from({length:100},()=>({context:'another check'})):[complete];
    else if(path.includes('/compare/'))data={status:'ahead'};
    else if(path.endsWith('/issues/12'))data={state:'open'};
    else if(path==='/graphql'){
      const variables=body.variables;
      if(graphFailure)data={errors:[{message:'Metadata unavailable'}]};
      else if(cleanReview)data={data:{repository:{pullRequest:{reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}}}}}};
      else if(variables.id)data={data:{node:{comments:{nodes:[reply],pageInfo:{hasNextPage:false}}}}};
      else{
        const first=!variables.cursor;
        const nodes=first?[{id:'thread-one',isResolved:true,comments:{nodes:[original,...Array.from({length:99},()=>original)],pageInfo:{hasNextPage:true,endCursor:'comments-next'}}}]:[{id:'thread-two',isResolved:false,comments:{nodes:[original],pageInfo:{hasNextPage:false}}}];
        data={data:{repository:{pullRequest:{reviewThreads:{nodes,pageInfo:{hasNextPage:first,endCursor:first?'threads-next':null}}}}}};
      }
    }else if(new RegExp('^/repos/fixture/project/statuses/[a-f0-9]{40}$').test(path)&&options.method==='POST'){
      const publishedHead=path.split('/').at(-1);
      if(failFirstPublish&&publishedHead===head)return new Response('{}',{status:503});
      assert.ok(['success','failure'].includes(body.state));
      assert.ok(body.description.length<=140);
      published.push({head_sha:publishedHead,...body});data={id:1};
    }
    else throw Error(`Unexpected fixture API path ${path}`);
    return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
  };
  return {published,calls};
}

test('metadata gate paginates statuses, review threads and thread comments before publishing',async t=>{
  const f=apiFixture(t);await runGate();
  assert.equal(f.published.length,1);
  assert.equal(f.published[0].state,'failure');
  assert.match(f.published[0].description,/Unresolved review thread: thread-two/);
  assert.doesNotMatch(f.published[0].description,/thread-one/);
  assert.ok(f.calls.some(call=>call.query.includes('page=2')));
  assert.ok(f.calls.some(call=>call.variables?.cursor==='threads-next'));
  assert.ok(f.calls.some(call=>call.variables?.cursor==='comments-next'));
});

test('metadata gate publishes no stale result when the PR head changes during verification',async t=>{
  const f=apiFixture(t,{changedHead:true});await runGate();assert.deepEqual(f.published,[]);
});

test('metadata gate fails closed when GraphQL cannot provide the review evidence',async t=>{
  const f=apiFixture(t,{graphFailure:true});await runGate();
  assert.equal(f.published[0].state,'failure');
  assert.match(f.published[0].description,/Could not verify all review metadata/);
});

test('metadata gate accepts same-repository evidence links with mixed case',async t=>{
  const f=apiFixture(t,{reply:{...fixed,body:'Deferred: https://github.com/Fixture/Project/issues/12 — Track this separately because the current change preserves the existing contract.'}});
  await runGate();
  assert.doesNotMatch(f.published[0].description,/thread-one/);
  assert.ok(f.calls.some(call=>call.path.endsWith('/issues/12')));
});

test('repository publisher requires trusted scan evidence for the current head',async t=>{
  const f=apiFixture(t);
  for(const head of [null,'b'.repeat(40),'a'.repeat(40)]){
    process.env.SCAN_RESULTS=JSON.stringify(head?[{number:1,head,secrets:true,ci:true,summary:'Fixture verified'}]:[]);
    f.published.length=0;
    await runGates('--publish');
    assert.equal(f.published.length,2);
    assert.ok(f.published.every(check=>check.state===(head==='a'.repeat(40)?'success':'failure')));
  }
});

test('both metadata publishers continue to later PRs when one check publication fails',async t=>{
  const f=apiFixture(t,{multiplePRs:true,failFirstPublish:true});
  await runGates('--publish');
  assert.equal(f.published.length,2);
  assert.ok(f.published.every(check=>check.head_sha==='c'.repeat(40)));
  assert.equal(process.exitCode,1);
  f.published.length=0;
  await runGate();
  assert.equal(f.published.length,1);
  assert.equal(f.published[0].head_sha,'c'.repeat(40));
  assert.equal(process.exitCode,1);
});

test('incomplete reviews block the required check without leaving a stale publisher failure',async t=>{
  const f=apiFixture(t);
  await runGate();
  assert.equal(f.published[0].state,'failure');
  assert.notEqual(process.exitCode,1);
  process.env.REVIEW_GATE_READ_ONLY='1';
  f.published.length=0;
  await runGate();
  assert.deepEqual(f.published,[]);
  assert.equal(process.exitCode,1);
});

test('completed review publishes a commit status for the current head with workflow evidence',async t=>{
  const f=apiFixture(t,{cleanReview:true});
  await runGate();
  assert.equal(f.published[0].head_sha,'a'.repeat(40));
  assert.equal(f.published[0].context,'Wapentake / review');
  assert.equal(f.published[0].state,'success');
  assert.equal(f.published[0].target_url,'https://github.com/fixture/project/actions/runs/123');
});

test('legacy report adapter preserves failures and refuses unknown gate reports',async()=>{
  const workflow=parse(readFileSync(new URL('../.github/workflows/repository-gates.yml',import.meta.url),'utf8'));
  const step=workflow.jobs.publish.steps.find(step=>step.name==='Publish verified statuses');
  const source=step.run.split("node --input-type=module <<'JS'\n")[1].split('const { runGates }')[0];
  const calls=[];
  const sandbox={process:{env:{GITHUB_REPOSITORY:'fixture/project',GITHUB_RUN_ID:'123'}},fetch:async(url,options)=>{calls.push({url,options});return 'delivered';}};
  new Script(source).runInNewContext(sandbox);
  const prefix='https://api.github.com/repos/fixture/project';
  const report={name:'CI required',head_sha:'a'.repeat(40),status:'completed',conclusion:'failure',output:{summary:'The required CI run did not pass.'}};
  const publish=report=>sandbox.fetch(`${prefix}/check-runs`,{method:'POST',body:JSON.stringify(report),headers:{Authorization:'fixture'}});
  assert.equal(await publish(report),'delivered');
  assert.equal(calls[0].url,`${prefix}/statuses/${report.head_sha}`);
  assert.equal(JSON.parse(calls[0].options.body).state,'failure');
  assert.equal(JSON.parse(calls[0].options.body).context,'Wapentake / CI');
  assert.equal(calls[0].options.headers.Authorization,'fixture');
  for(const invalid of [{name:'unrecognized'},{head_sha:'main'},{status:'queued'},{conclusion:'neutral'}]){
    assert.throws(()=>publish({...report,...invalid}),/Refusing an unknown legacy gate report/);
  }
  assert.equal(calls.length,1);
  await sandbox.fetch(`${prefix}/pulls`,{method:'GET'});
  assert.equal(calls[1].url,`${prefix}/pulls`);
});
