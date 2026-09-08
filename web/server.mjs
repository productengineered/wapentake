import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Room } from '../src/room.mjs';
import { Worker } from '../src/worker.mjs';
import { execute } from '../src/commands.mjs';
import { fail,keys,integer,RoomError } from '../src/contracts.mjs';

const assets=new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/app.js',['app.js','text/javascript; charset=utf-8']],
  ['/styles.css',['styles.css','text/css; charset=utf-8']],
]);
const statusCode={auth_required:401,forbidden:403,not_found:404,conflict:409,storage_error:500};
export async function serve({store,token,port=0,runWorker=false,worker:injectedWorker}){
  integer(port,'port',0,65535);
  const operator=new Room(store,token);operator.operator();
  const worker=injectedWorker??new Worker(operator);
  let running=false,closing=false,timer=null,inFlight=null,lastResult=null,origin;
  const workerState=()=>({running,active:worker.active,last_result:lastResult});
  function stopWorker(){running=false;clearTimeout(timer);return workerState();}
  async function tick(){
    if(!running||closing)return;
    try{lastResult=await worker.runOnce();if(['disabled','quota_wait','auth_required','failed','needs_scoping'].includes(lastResult.status))running=false;}
    catch(error){lastResult={status:'failed',error:{code:error.code??'storage_error',message:error.message}};running=false;}
    finally{inFlight=null;if(running&&!closing)timer=setTimeout(schedule,lastResult?.status==='idle'?1000:25);}
  }
  function schedule(){inFlight=tick();}
  function startWorker(){if(!running){running=true;if(!inFlight)timer=setTimeout(schedule,0);}return workerState();}
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');
    function send(status,payload,type='application/json; charset=utf-8'){res.writeHead(status,{'Content-Type':type});res.end(type.startsWith('application/json')?JSON.stringify(payload):payload);}
    try{
      if(req.headers.host!==new URL(origin).host)fail('forbidden','Unexpected local Host header');
      if(req.headers.origin&&req.headers.origin!==origin)fail('forbidden','Cross-origin requests are not allowed');
      if(req.url==='/api/command'){
        if(req.method!=='POST'){send(405,{error:{code:'invalid_input',message:'Use POST'}});return;}
        if(!req.headers['content-type']?.startsWith('application/json'))fail('invalid_input','JSON content type is required');
        if(Number(req.headers['content-length']??0)>131072)fail('invalid_input','Request exceeds 128 KiB');
        const bearer=req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
        const room=new Room(store,bearer);
        let size=0,chunks=[];
        for await(const chunk of req){size+=chunk.length;if(size>131072)fail('invalid_input','Request exceeds 128 KiB');chunks.push(chunk);}
        let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('invalid_input','Malformed JSON request');}
        keys(input,['action','project','thread','data']);
        let result;
        if(['worker.start','worker.stop','worker.status'].includes(input.action)){
          room.operator();keys(input.data??{},[]);
          result=input.action==='worker.start'?startWorker():input.action==='worker.stop'?stopWorker():workerState();
        }else result=await execute(room,input.action,input,{worker});
        send(200,{result});return;
      }
      const asset=assets.get(req.url);
      if(req.method!=='GET'||!asset){send(404,{error:{code:'not_found',message:'Not found'}});return;}
      send(200,readFileSync(new URL(asset[0],import.meta.url)),asset[1]);
    }catch(error){
      send(error instanceof RoomError?(statusCode[error.code]??400):500,{error:{code:error instanceof RoomError?error.code:'storage_error',message:error instanceof RoomError?error.message:'The local operation failed'}});
    }
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=30;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  origin=`http://127.0.0.1:${server.address().port}`;
  if(runWorker)startWorker();
  return {url:origin,sessionURL:`${origin}/#token=${encodeURIComponent(token)}`,server,workerState,
    async close(){
      if(closing)return;closing=true;stopWorker();
      if(worker.active){const claim=store.get('SELECT job_id FROM worker_claim WHERE owner_pid=?',process.pid);if(claim)store.run('UPDATE jobs SET cancel_requested=1 WHERE id=?',claim.job_id);}
      const closed=new Promise(resolve=>server.close(resolve));server.closeIdleConnections();
      await inFlight;await closed;store.close();
    },
  };
}
