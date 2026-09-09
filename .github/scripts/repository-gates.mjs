import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CI_JOBS=['Core Node 24','Core Node 26','Browser smoke','Package install','Static quality','Dependency security'];

export function assessCI(run,jobs,head){
  if(!run||run.head_sha!==head||run.event!=='pull_request'||run.path!=='.github/workflows/ci.yml')return ['Missing CI evidence for this PR commit'];
  if(run.status!=='completed'||run.conclusion!=='success')return ['The latest CI run must complete successfully'];
  return CI_JOBS.filter(name=>jobs.filter(job=>job.name===name&&job.conclusion==='success').length!==1).map(name=>`${name} must succeed`);
}

export async function runGates(mode){
  if(!['--scan','--publish'].includes(mode))throw Error('Choose --scan or --publish');
  const repository=process.env.GITHUB_REPOSITORY;
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository??''))throw Error('Invalid repository');
  const token=process.env.GH_TOKEN;
  if(!token)throw Error('GH_TOKEN is required');
  const prefix=`/repos/${repository}`;
  async function request(path,options={}){
    const response=await fetch(`https://api.github.com${path}`,{...options,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...options.headers},signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error(`GitHub API ${response.status}: ${path.split('?')[0]}`);
    return response.json();
  }
  async function pages(path,key){
    const result=[];
    for(let page=1;;page++){
      const response=await request(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${page}`);
      const batch=key?response[key]:response;
      if(!Array.isArray(batch))throw Error('Invalid paginated response');
      result.push(...batch);
      if(batch.length<100)return result;
    }
  }
  const repo=await request(prefix);
  const prs=(await pages(`${prefix}/pulls?state=open&base=${encodeURIComponent(repo.default_branch)}`)).filter(pr=>!pr.draft);
  if(mode==='--scan'){
    const results=[];
    for(const pr of prs){
      const head=pr.head.sha;
      if(!/^[a-f0-9]{40}$/.test(head)||!Number.isSafeInteger(pr.number))throw Error('Invalid PR metadata');
      const result={number:pr.number,head,secrets:false,ci:false,summary:''};
      const errors=[];
      let directory;
      try{
        directory=mkdtempSync(join(tmpdir(),'wapentake-trusted-scan-'));
        const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.https://github.com/.extraheader',GIT_CONFIG_VALUE_0:`AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,GIT_TERMINAL_PROMPT:'0'};
        for(const key of ['GIT_TRACE','GIT_TRACE_CURL','GIT_CURL_VERBOSE'])delete env[key];
        function run(command,args){
          const response=spawnSync(command,args,{cwd:directory,env,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
          if(response.status!==0){
            console.error(response.stderr??'');
            const cause=response.error?.code??response.error?.message??(response.signal?`signal ${response.signal}`:`exit ${response.status}`);
            throw Error(`${command} failed during trusted history scan (${cause})`);
          }
          return response.stdout.trim();
        }
        run('git',['init','-q']);
        // Fetch Git objects only. No PR checkout, hooks, scripts, submodules or artifacts are executed.
        run('git',['fetch','--quiet','--no-recurse-submodules',`https://github.com/${repository}.git`,'+refs/heads/*:refs/remotes/origin/*','+refs/tags/*:refs/tags/*',`+refs/pull/${pr.number}/head:refs/heads/candidate`]);
        if(run('git',['rev-parse','refs/heads/candidate'])!==head)throw Error('PR changed while fetching history');
        run('python3',[fileURLToPath(new URL('./secrets.py',import.meta.url)),'--history','--trusted-policy']);
        result.secrets=true;
      }catch(error){errors.push(`Trusted secret/privacy scan did not pass: ${error.message}`);}
      finally{if(directory)rmSync(directory,{recursive:true,force:true});}
      try{
        const runs=await pages(`${prefix}/actions/workflows/ci.yml/runs?head_sha=${head}&event=pull_request`,'workflow_runs');
        const run=runs.find(run=>run.head_sha===head);
        const jobs=run?await pages(`${prefix}/actions/runs/${run.id}/jobs?filter=latest`,'jobs'):[];
        const ciErrors=assessCI(run,jobs,head);
        result.ci=ciErrors.length===0;
        errors.push(...ciErrors);
      }catch(error){errors.push(`Could not verify CI: ${error.message}`);}
      result.summary=errors.length?errors.join('\n'):'Trusted policy scanned all fetched history; every required CI job succeeded at this commit.';
      results.push(result);
      console.log(`PR #${pr.number} at ${head}: ${result.summary}`);
    }
    if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`results=${JSON.stringify(results)}\n`);
    return results;
  }
  let results;
  try{results=JSON.parse(process.env.SCAN_RESULTS??'[]');if(!Array.isArray(results))results=[];}catch{results=[];}
  for(const pr of prs){
    try{
      const record=results.find(result=>result.number===pr.number&&result.head===pr.head.sha);
      const latest=await request(`${prefix}/pulls/${pr.number}`);
      if(latest.head.sha!==pr.head.sha||latest.state!=='open'||latest.draft)continue;
      for(const [name,success] of [['Secrets and privacy',record?.secrets===true],['CI required',record?.secrets===true&&record?.ci===true]]){
        const summary=record?.summary??'Trusted scan evidence is missing or stale. Run Repository gates again.';
        await request(`${prefix}/check-runs`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,head_sha:pr.head.sha,status:'completed',conclusion:success?'success':'failure',completed_at:new Date().toISOString(),output:{title:success?'Trusted requirements verified':'Trusted requirements incomplete',summary}})});
      }
    }catch(error){
      console.error(`Could not publish gates for PR #${pr.number}: ${error.message}`);
      process.exitCode=1;
    }
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runGates(process.argv[2]).catch(error=>{console.error(error.message);process.exitCode=1;});
