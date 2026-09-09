import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapters } from './adapters/index.mjs';
import { openCodeEnvironment } from './adapters/opencode.mjs';
import { resolveModels } from './models.mjs';

export function runtimeReport(){
  const [major,minor,patch]=process.versions.node.split('.').map(Number);
  const supported=process.platform==='darwin'&&((major===24&&(minor>20||(minor===20&&patch>=0)))||major===26);
  let sqlite=null,fts5=false,error=null;
  try{
    const db=new DatabaseSync(':memory:');sqlite=db.prepare('SELECT sqlite_version() version').get().version;
    db.exec('CREATE VIRTUAL TABLE probe USING fts5(body)');fts5=true;db.close();
  }catch(e){error=e.message;}
  return {node:process.versions.node,node_executable:process.execPath,platform:process.platform,architecture:process.arch,supported_runtime:supported,sqlite,fts5,error,required_node:'24.20.x or 26.x; see release verification for tested patches'};
}
export async function doctor({runtimeOnly=false,modelsFile,modelProfile}={}){
  const runtime=runtimeReport(),providers=[];
  if(!runtimeOnly){
    const dir=mkdtempSync(join(tmpdir(),'wapentake-doctor-'));
    try{
      const models=resolveModels({file:modelsFile,profile:modelProfile}).models;
      for(const [id,adapter] of adapters()){
        try{
          const selected=id==='opencode-glm-plan'?models.glm:models.astra;
          const options=id==='opencode-glm-plan'?{cwd:dir,model:selected.model,env:openCodeEnvironment(dir,selected.model),checkProfile:true}:{cwd:dir,model:selected.model,reasoningEffort:selected.reasoning_effort};
          providers.push({id,status:'local_checks_passed',...await adapter.inspect(options)});
        }catch(error){providers.push({id,status:'unavailable',error_code:error.code??'client_unsupported',message:error.message});}
      }
    }finally{rmSync(dir,{recursive:true,force:true});}
  }
  return {runtime,providers,inference_performed:false,live_compatibility_verified:false,ready_offline:runtime.supported_runtime&&runtime.fts5,ready_for_live_check:!runtimeOnly&&runtime.supported_runtime&&runtime.fts5&&providers.every(p=>p.status==='local_checks_passed')};
}
