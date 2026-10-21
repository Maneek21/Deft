import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(fileURLToPath(new URL('../../package.json',import.meta.url))),{chromium}=require('playwright'),{build}=require('esbuild');

async function fixture(recoveryProofOnly=false,lostSubmission=false,stalledOpening=false){
 const component=fileURLToPath(new URL('../components/apps/experience-record-form.tsx',import.meta.url));
 const renderer=fileURLToPath(new URL('./app-experience-renderer.ts',import.meta.url));
 const bundled=await build({stdin:{contents:`import React from 'react';import {createExperienceRecordFormHost} from ${JSON.stringify(component)};import {renderExperienceView,clearExperienceView} from ${JSON.stringify(renderer)};
 const id='11111111-1111-4111-8111-111111111111',hash='sha256:'+'a'.repeat(64),calls=[];let releaseScope=null,holdScope=true,current=true;
 const profile={schema_version:'deft.record_form_profile.v1',max_record_bytes:491520,addresses:[{field:'to',label:'To',optional:false}],subject:{field:'subject',label:'Subject',max_characters:998},richtext:{html_field:'html',plain_field:'plain',label:'Message',max_characters:262144,links:'host_validated',inline_images:'host_files'},files:{field:'files',max_files:32,max_file_bytes:26214400,max_total_bytes:26214400}};
 const value={to:'',subject:'',plain:'',html:'',files:[]};
 let row={record_id:id,revision:0,content_digest:hash,status:'draft',value,files:[],summary:{initial_value_notice:''}};
 const scope={orgId:id,userId:id,installationId:id,accountId:id,stateKey:'drafts',recordId:id,resourceTargetKey:'sender'};
 const node={kind:'record_form',id:'draft_form',label:'New message',store_key:'drafts',record_id:id,expected_revision:0,content_digest:'sha256:'+'0'.repeat(64),profile,seed:{schema_version:'deft.record_form_seed.v1',value},...(${lostSubmission}?{action_key:'send_message'}:{})};
 const ports={load:async()=>{calls.push('load');if(${stalledOpening}&&calls.filter(v=>v==='load').length===1)await new Promise(()=>{});if(${recoveryProofOnly}&&calls.filter(v=>v==='load').length>1)await new Promise(()=>{});return {record:structuredClone(row),identities:[]};},recoveryScope:async()=>{calls.push('recoveryScope');if(holdScope)await new Promise(resolve=>releaseScope=resolve);return scope;},...(${recoveryProofOnly}?{recoverySnapshot:async()=>{calls.push('recoverySnapshot');return {scope,record:structuredClone(row)};}}:{}),save:async(_node,_revision,value)=>{calls.push('save');if(!${lostSubmission})throw Error('unexpected save');row={...row,revision:1,value};return structuredClone(row);},upload:async()=>{throw Error('unexpected upload');},detach:async()=>{throw Error('unexpected detach');},readFile:async()=>new Uint8Array(),...(${lostSubmission}?{review:async(_node,currentRow,_signal,recovery)=>{calls.push('review');await recovery.beforeSubmit({key:id,purpose:'send',state:'pending',submissionId:'22222222-2222-4222-8222-222222222222',sessionId:id,actionKey:'send_message',revision:currentRow.revision,digest:currentRow.content_digest});throw Error('Controlled lost acknowledgement');},submissionStatus:async()=>{calls.push('submissionStatus');return false;}}:{})};
 const host=createExperienceRecordFormHost(ports),root=document.getElementById('root');
 const mount=()=>renderExperienceView(root,{schema_version:'deft.experience_view.v2',capabilities:['record_form.v1','record_form_seed.v1'],root:node},()=>{}, {capabilities:['record_form.v1','record_form_seed.v1'],storeKeys:['drafts'],actionKeys:['send_message'],mountRecordForm:host.mountRecordForm});
 window.Probe={mount,release:()=>{holdScope=false;releaseScope?.();},read:()=>({calls,text:root.textContent,controls:root.querySelectorAll('input,textarea').length}),close:()=>clearExperienceView(root)};`,resolveDir:fileURLToPath(new URL('../..',import.meta.url)),loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"test"'}});
 const browser=await chromium.launch({headless:true,...(process.env.DEFT_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.DEFT_TEST_BROWSER_EXECUTABLE}:{})}),page=await browser.newPage();page.setDefaultTimeout(8000);
 try{await page.route('**/*',(route:any)=>route.request().url().startsWith('http://127.0.0.1/')?route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}):route.abort());await page.goto('http://127.0.0.1/');await page.addScriptTag({content:bundled.outputFiles[0].text});await page.addScriptTag({content:'window.__name=value=>value;'});return {browser,page};}catch(error){await browser.close();throw error;}
}

test('mounted unsaved form remains visible while recovery authorization waits and then renders controls without creating a record',async()=>{
 const {browser,page}=await fixture();try{
  await page.evaluate(()=>(window as any).Probe.mount());
  await page.waitForFunction(()=>(window as any).Probe.read().calls.includes('recoveryScope'));
  const pending=await page.evaluate(()=>(window as any).Probe.read());
  assert.ok(pending.text.trim(),'waiting for recovery must not blank the mounted form');
  await page.evaluate(()=>(window as any).Probe.mount());
  assert.ok((await page.evaluate(()=>(window as any).Probe.read())).text.trim(),'author rerender must preserve the mounted pending form');
  await page.evaluate(()=>(window as any).Probe.release());await page.getByRole('textbox',{name:'Subject',exact:true}).waitFor();
  assert.equal(await page.getByRole('textbox',{name:'Message',exact:true}).count(),1);
  assert.equal((await page.evaluate(()=>(window as any).Probe.read())).calls.includes('save'),false);
 }finally{await browser.close();}
});

test('closing a mounted form while recovery waits prevents late controls and writes',async()=>{
 const {browser,page}=await fixture();try{
  await page.evaluate(()=>(window as any).Probe.mount());await page.waitForFunction(()=>(window as any).Probe.read().calls.includes('recoveryScope'));
  await page.evaluate(()=>(window as any).Probe.close());await page.evaluate(()=>(window as any).Probe.release());
  await page.waitForTimeout(50);const closed=await page.evaluate(()=>(window as any).Probe.read());assert.equal(closed.controls,0);assert.equal(closed.text,'');assert.equal(closed.calls.includes('save'),false);
 }finally{await browser.close();}
});

test('mounted recovery proves the current row without repeating a slow full draft and identity load',async()=>{
 const {browser,page}=await fixture(true);try{
  await page.evaluate(()=>(window as any).Probe.mount());await page.waitForFunction(()=>(window as any).Probe.read().calls.includes('recoveryScope'));
  await page.evaluate(()=>(window as any).Probe.release());
  await page.waitForFunction(()=>!(document.querySelector('input[aria-label="Subject"]') as HTMLInputElement)?.disabled);assert.equal(await page.getByText('Browser recovery ready',{exact:true}).count(),0);
  const opened=await page.evaluate(()=>(window as any).Probe.read());assert.equal(opened.calls.filter((call:string)=>call==='load').length,1);assert.ok(opened.calls.includes('recoverySnapshot'));assert.equal(opened.calls.includes('save'),false);
  await page.getByRole('textbox',{name:'Subject',exact:true}).fill('Retain this text');assert.equal(await page.getByRole('textbox',{name:'Subject',exact:true}).inputValue(),'Retain this text');
 }finally{await browser.close();}
});


test('quiet recovery-ready presentation never hides an original unconfirmed submission or its status control',async()=>{
 const {browser,page}=await fixture(false,true);try{
  await page.evaluate(()=>(window as any).Probe.mount());await page.waitForFunction(()=>(window as any).Probe.read().calls.includes('recoveryScope'));await page.evaluate(()=>(window as any).Probe.release());
  const save=page.getByRole('button',{name:'Save',exact:true});await save.waitFor();await page.waitForFunction(()=>!(document.querySelector('input[aria-label="Subject"]') as HTMLInputElement)?.disabled);await save.click();
  const review=page.getByRole('button',{name:'Review action',exact:true});await review.click();await page.getByRole('button',{name:'Check original submission',exact:true}).waitFor();
  assert.match(await page.getByLabel('Submission reference').textContent(),/22222222-2222-4222-8222-222222222222/);await page.getByRole('button',{name:'Check original submission',exact:true}).click();
  const result=await page.evaluate(()=>(window as any).Probe.read());assert.equal(result.calls.filter((call:string)=>call==='review').length,1);assert.equal(result.calls.filter((call:string)=>call==='submissionStatus').length,1);assert.equal(result.calls.filter((call:string)=>call==='save').length,1);
 }finally{await browser.close();}
});


test('stalled form opening ends with an enabled Retry and a fresh retry renders the untouched local seed without writes',async()=>{
 const {browser,page}=await fixture(false,false,true);try{
  await page.evaluate(()=>{const original=window.setTimeout.bind(window);window.setTimeout=((callback:TimerHandler,delay?:number,...args:unknown[])=>original(callback,delay===30000?25:delay,...args)) as typeof window.setTimeout;(window as any).Probe.release();(window as any).Probe.mount();});
  const retry=page.getByRole('button',{name:'Retry opening draft',exact:true});await retry.waitFor();assert.equal(await retry.isEnabled(),true);assert.doesNotMatch((await page.evaluate(()=>(window as any).Probe.read())).text,/Opening draft/);
  await page.evaluate(()=>{const current=window.setTimeout.bind(window);window.setTimeout=((callback:TimerHandler,delay?:number,...args:unknown[])=>current(callback,delay===30000?10000:delay,...args)) as typeof window.setTimeout;});
  await retry.click();await page.getByRole('textbox',{name:'Subject',exact:true}).waitFor();const opened=await page.evaluate(()=>(window as any).Probe.read());assert.equal(opened.calls.filter((call:string)=>call==='load').length,3,'one stalled load, one retry and the mandatory recovery proof');assert.equal(opened.calls.includes('save'),false);
 }finally{await browser.close();}
});
