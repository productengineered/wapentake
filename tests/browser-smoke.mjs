// Optional real-browser verification; uses only synthetic projects and in-process fake consultants.
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Store,Room } from '../src/room.mjs';
import { Worker } from '../src/worker.mjs';
import { serve } from '../web/server.mjs';
import { response } from './helpers.mjs';

const playwrightModule=process.env.WAPENTAKE_PLAYWRIGHT_MODULE;
if(!playwrightModule)throw Error('Set WAPENTAKE_PLAYWRIGHT_MODULE to an installed Playwright index.mjs');
const {chromium}=await import(pathToFileURL(playwrightModule));
const chromeExecutable=process.env.WAPENTAKE_CHROME_EXECUTABLE;
const screenshotDir=process.env.WAPENTAKE_SCREENSHOT_DIR;
const root=mkdtempSync(join(tmpdir(),'wapentake-browser-')),repo=join(root,'project'),state=join(root,'state');mkdirSync(repo);
const store=new Store(state,{initialize:true}),operator=store.ensureOperator('Brandon'),token=readFileSync(operator.tokenPath,'utf8').trim(),room=new Room(store,token);
const project=room.register({path:repo,label:'Toolkit architecture'}),thread=room.openThread(project.id,{title:'Keep our decisions across sessions',mode:'independent',key:'thread'});
writeFileSync(join(repo,'design.md'),'# Room design\n\nStore immutable messages and versioned decisions in SQLite. Keep source captures with their hashes. Consultants receive bounded packets.');
room.constrain(project.id,thread.id,{body:'Use the existing GLM and ChatGPT plan logins. Every accepted decision needs its rationale and source references.',key:'constraint'});
const source=room.addSource(project.id,thread.id,{path:'design.md',working_tree:true,key:'source'});
room.ask(project.id,thread.id,{body:'How should we retain useful context when a fresh agent joins the conversation?',source_ids:[source.id],to:['glm','astra'],key:'ask'});
room.setPolicy({execution_enabled:true});
let launches=0;
const fake={prepare:async({participant,packet})=>({participant,packet,capabilities:{fixture:true}}),run:async prepared=>{
  launches++;const glm=prepared.participant.alias==='glm';
  const output=response(glm?'Keep the original messages immutable, then record decisions as explicit versions. A fresh session can retrieve the rationale without replaying the whole conversation.\n\nInclude the current human constraints and source hashes in every consultant packet.':'I agree with preserving the original record. I would also make omitted context visible: a consultant should be able to request a specific source before making a recommendation.\n\nWhen evidence changes, keep the earlier answer and mark its context as changed.',prepared.packet.packet.allowed_citations.slice(0,1));
  if(glm)output.proposed_decision={statement:'Keep a durable decision record with source references.',rationale:'Fresh sessions need the reasoning behind a choice, alongside the current constraints.',citations:output.citations};
  return {value:output,observed_model:prepared.participant.model,terminal_state:'fixture',usage:{input_tokens:100,output_tokens:100}};
}};
const worker=new Worker(room,{adapters:new Map([['opencode-glm-plan',fake],['codex-chatgpt-astra',fake]])});await worker.runOnce();await worker.runOnce();room.setPolicy({execution_enabled:false});
const app=await serve({store,token,worker});let browser,page;
try{
  browser=await chromium.launch({headless:true,...(chromeExecutable?{executablePath:chromeExecutable}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1100},acceptDownloads:true}),errors=[];page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(app.sessionURL);await page.getByRole('heading',{name:'Keep our decisions across sessions',exact:true}).waitFor();
  assert.equal(await page.title(),'Wapentake');
  await page.getByText('Keep the original messages immutable, then record decisions as explicit versions.',{exact:false}).waitFor();
  assert.equal(new URL(page.url()).hash,'');await page.waitForTimeout(3200);assert.equal(launches,2);
  const shots=screenshotDir??root;mkdirSync(shots,{recursive:true});await page.screenshot({path:join(shots,'wapentake-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'Preview consultant context',exact:true}).click();await page.getByRole('dialog').waitFor();assert.match(await page.locator('#dialog-content').textContent(),/existing GLM and ChatGPT plan logins/);await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.getByRole('button',{name:'Review & accept',exact:true}).click();await page.getByRole('button',{name:'Accept decision',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(room.decisions(project.id,thread.id)[0].status,'accepted');
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export',exact:true}).click();assert.equal((await download).suggestedFilename(),'wapentake-conversation.md');
  await page.getByRole('button',{name:'+ New conversation',exact:true}).click();await page.getByLabel('What are we thinking through?').fill('Room smoke trace');await page.getByRole('button',{name:'Start conversation',exact:true}).click();await page.getByRole('heading',{name:'Room smoke trace',exact:true}).waitFor();
  await page.getByLabel('Your message',{exact:true}).fill('<script>window.roomInjected = true</script> Quoted @astra stays ordinary text.');await page.getByRole('button',{name:'Post',exact:true}).click();await page.getByText('Quoted @astra stays ordinary text.',{exact:false}).waitFor();assert.equal(await page.evaluate(()=>window.roomInjected),undefined);assert.equal(launches,2);
  await page.getByRole('button',{name:'Pin constraint',exact:true}).click();await page.getByLabel('Instruction for every consultant').fill('Keep every source inspectable.');await page.getByRole('button',{name:'Pin constraint',exact:true}).last().click();await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Attach source',exact:true}).click();await page.getByLabel('Path relative to this project').fill('design.md');await page.getByRole('button',{name:'Capture evidence',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  await page.getByLabel('Your message',{exact:true}).fill('Review the current record.');await page.getByRole('button',{name:'Ask consultants ↗',exact:true}).click();await page.getByText('Invitation queued. Enable an allowance and start the worker when ready.',{exact:true}).waitFor();assert.equal(launches,2);
  await page.getByRole('button',{name:'Cancel',exact:true}).first().click();
  await page.getByRole('button',{name:'View local allowance',exact:true}).click();await page.getByLabel('Enable consultant execution').check();await page.getByRole('button',{name:'Save allowance',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});await page.getByRole('button',{name:'Start worker',exact:true}).click();await page.locator('#jobs .job-status').filter({hasText:'succeeded'}).waitFor();assert.equal(launches,3);await page.getByRole('button',{name:'Stop worker',exact:true}).click();
  await page.reload();await page.getByRole('heading',{name:'Room smoke trace',exact:true}).waitFor();assert.equal(launches,3);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(shots,'wapentake-mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'passed',fake_consultant_launches:launches,real_model_calls:0,screenshots:shots,checks:['Wapentake title','post','literal HTML','invite','cancel','worker start/stop','context preview','source capture','constraint','decision accept','export','reload','desktop/mobile overflow','passive reads do not launch']}));
}catch(error){if(page){console.error(await page.locator('body').innerText());await page.screenshot({path:join(screenshotDir??root,'failure.png'),fullPage:true});}throw error;}
finally{await browser?.close();await app.close();rmSync(root,{recursive:true,force:true});}
