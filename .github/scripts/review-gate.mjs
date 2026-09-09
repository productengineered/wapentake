import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CHECK_NAME='Wapentake review gate';
const trusted=new Set(['OWNER','MEMBER','COLLABORATOR']);

export function disposition(comments){
  return comments.slice(1).filter(comment=>trusted.has(comment.authorAssociation)&&comment.author?.login&&!comment.author.login.endsWith('[bot]')).map(comment=>{
    const match=comment.body.trim().match(/^(Fixed|Deferred|Superseded|Not applicable):\s+`?([^\s`]+)`?\s+(?:[-—:]\s*)?(.{20,})$/is);
    return match?{kind:match[1],reference:match[2],reason:match[3],author:comment.author.login}:null;
  }).filter(Boolean).at(-1);
}

export function assess(statuses,threads){
  const errors=[];
  // The statuses endpoint is newest first. A later pending/skipped status supersedes completion.
  const status=statuses.find(item=>item.context==='CodeRabbit');
  if(!status||status.creator?.login!=='coderabbitai[bot]'||status.state!=='success'||!/^Review completed\.?$/i.test(status.description??'')){
    errors.push('CodeRabbit must complete a review of the current HEAD; pending, skipped and unknown results do not count.');
  }
  for(const thread of threads){
    if(!thread.isResolved)errors.push(`Unresolved review thread: ${thread.id}`);
    if(!disposition(thread.comments))errors.push(`Missing written disposition from a repository collaborator: ${thread.id}`);
  }
  return errors;
}

export async function runGate(){
  const repository=process.env.GITHUB_REPOSITORY;
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository??''))throw Error('Invalid GITHUB_REPOSITORY');
  const [owner,name]=repository.split('/');
  const token=process.env.GH_TOKEN;
  if(!token)throw Error('GH_TOKEN is required');
  async function request(path,options={}){
    const response=await fetch(`https://api.github.com${path}`,{...options,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...options.headers},signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error(`GitHub API ${response.status}: ${path.split('?')[0]}`);
    return response;
  }
  const get=async path=>(await request(path)).json();
  async function pages(path){
    const result=[];
    for(let page=1;;page++){
      const batch=await get(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);
      if(!Array.isArray(batch))throw Error('Expected paginated array');
      result.push(...batch);
      if(batch.length<100)return result;
    }
  }
  async function graph(query,variables){
    const body=await (await request('/graphql',{method:'POST',body:JSON.stringify({query,variables}),headers:{'Content-Type':'application/json'}})).json();
    if(body.errors?.length)throw Error('GraphQL review metadata query failed');
    return body.data;
  }
  const fields='id isResolved comments(first:100) { nodes { body authorAssociation author { login } } pageInfo { hasNextPage endCursor } }';
  async function threadsFor(number){
    const result=[];let cursor=null;
    do{
      const data=await graph(`query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{${fields}} pageInfo{hasNextPage endCursor}}}}}`,{owner,name,number,cursor});
      const connection=data.repository.pullRequest.reviewThreads;
      for(const thread of connection.nodes){
        const comments=[...thread.comments.nodes];let info=thread.comments.pageInfo;
        while(info.hasNextPage){
          const data=await graph('query($id:ID!,$cursor:String!){node(id:$id){... on PullRequestReviewThread{comments(first:100,after:$cursor){nodes{body authorAssociation author{login}} pageInfo{hasNextPage endCursor}}}}}',{id:thread.id,cursor:info.endCursor});
          comments.push(...data.node.comments.nodes);info=data.node.comments.pageInfo;
        }
        result.push({...thread,comments});
      }
      cursor=connection.pageInfo.hasNextPage?connection.pageInfo.endCursor:null;
    }while(cursor);
    return result;
  }
  async function verifyReference(item,head){
    if(item.kind==='Fixed'){
      if(!/^[a-f0-9]{7,40}$/i.test(item.reference))throw Error('Fixed disposition requires a commit SHA');
      const comparison=await get(`/repos/${repository}/compare/${item.reference}...${head}`);
      if(!['ahead','identical'].includes(comparison.status))throw Error('Fixed commit is not in the current PR history');
      return;
    }
    const url=new URL(item.reference);
    if(url.origin!=='https://github.com'||!url.pathname.toLowerCase().startsWith(`/${repository.toLowerCase()}/`))throw Error('Disposition evidence must link to this repository');
    const tail=url.pathname.slice(repository.length+2);
    if(item.kind==='Deferred'){
      const match=tail.match(/^issues\/(\d+)$/);
      if(!match)throw Error('Deferred disposition requires an issue URL');
      const issue=await get(`/repos/${repository}/issues/${match[1]}`);
      if(issue.pull_request||issue.state!=='open')throw Error('Deferred issue must be an open tracking issue');
    }else if(/^commit\/[a-f0-9]{7,40}$/i.test(tail)){
      await get(`/repos/${repository}/commits/${tail.split('/')[1]}`);
    }else if(/^pull\/\d+$/.test(tail)&&/^#discussion_r\d+$/.test(url.hash)){
      const comment=await get(`/repos/${repository}/pulls/comments/${url.hash.slice('#discussion_r'.length)}`);
      if(comment.pull_request_url.split('/').at(-1)!==tail.split('/')[1])throw Error('Evidence comment belongs to a different pull request');
    }else throw Error('Superseded/Not applicable disposition requires a commit or review-comment URL');
  }
  const prefix=`/repos/${repository}`;
  const repo=await get(prefix);
  const event=process.env.GITHUB_EVENT_PATH?JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')):{};
  if(process.env.GITHUB_EVENT_NAME==='status'&&event.context!=='CodeRabbit')return;
  const prs=await pages(`${prefix}/pulls?state=open&base=${encodeURIComponent(repo.default_branch)}`);
  let failed=false;
  for(const pr of prs.filter(pr=>!pr.draft)){
    try{
    const head=pr.head.sha;
    let errors=[];
    try{
      const [statuses,threads]=await Promise.all([pages(`${prefix}/commits/${head}/statuses`),threadsFor(pr.number)]);
      errors=assess(statuses,threads);
      for(const thread of threads){
        const item=disposition(thread.comments);
        if(item){try{await verifyReference(item,head);}catch(error){errors.push(`${thread.id}: ${error.message}`);}}
      }
    }catch(error){errors=[`Could not verify all review metadata: ${error.message}`];}
    const latest=await get(`${prefix}/pulls/${pr.number}`);
    if(latest.head.sha!==head||latest.state!=='open'||latest.draft){console.log(`PR #${pr.number} changed during verification; await its next event.`);continue;}
    const summary=errors.length?errors.join('\n\n'):'CodeRabbit completed the current HEAD review. Every review thread is resolved with a written, linked disposition.';
    console.log(`PR #${pr.number} at ${head}: ${summary}`);
    if(process.env.REVIEW_GATE_READ_ONLY!=='1'){
      await request(`${prefix}/check-runs`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:CHECK_NAME,head_sha:head,status:'completed',conclusion:errors.length?'failure':'success',completed_at:new Date().toISOString(),output:{title:errors.length?'Review requirements are incomplete':'Review requirements verified',summary:summary.slice(0,60000)}})});
    }
    // The required check carries eligibility; publishing a blocking result is successful delivery.
    if(process.env.REVIEW_GATE_READ_ONLY==='1')failed ||= errors.length>0;
    }catch(error){
      console.error(`Could not publish review gate for PR #${pr.number}: ${error.message}`);
      failed=true;
    }
  }
  if(failed)process.exitCode=1;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runGate().catch(error=>{console.error(error.message);process.exitCode=1;});
