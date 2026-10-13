import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(fileURLToPath(new URL('../../package.json',import.meta.url))),{chromium}=require('playwright'),{build}=require('esbuild');

async function fixture(recoveryProofOnly=false){
 const component=fileURLToPath(new URL('../components/apps/experience-record-form.tsx',import.meta.url));
 const renderer=fileURLToPath(new URL('./app-experience-renderer.ts',import.meta.url));
 const bundled=await build({stdin:{contents:`import React from 'react';import {createExperienceRecordFormHost} from ${JSON.stringify(component)};import {renderExperienceView,clearExperienceView} from ${JSON.stringify(renderer)};
 const id='11111111-1111-4111-8111-111111111111',hash='sha256:'+'a'.repeat(64),calls=[];let releaseScope=null,holdScope=true,current=true;
 const profile={schema_version:'deft.record_form_profile.v1',max_record_bytes:491520,addresses:[{field:'to',label:'To',optional:false}],subject:{field:'subject',label:'Subject',max_characters:998},richtext:{html_field:'html',plain_field:'plain',label:'Message',max_characters:262144,links:'host_validated',inline_images:'host_files'},files:{field:'files',max_files:32,max_file_bytes:26214400,max_total_bytes:26214400}};
 const value={to:'',subject:'',plain:'',html:'',files:[]};
 const row={record_id:id,revision:0,content_digest:hash,status:'draft',value,files:[],summary:{initial_value_notice:''}};
 const scope={orgId:id,userId:id,installationId:id,accountId:id,stateKey:'drafts',recordId:id,resourceTargetKey:'sender'};
 const node={kind:'record_form',id:'draft_form',label:'New message',store_key:'drafts',record_id:id,expected_revision:0,content_digest:'sha256:'+'0'.repeat(64),profile,seed:{schema_version:'deft.record_form_seed.v1',value}};
 const ports={load:async()=>{calls.push('load');if(${recoveryProofOnly}&&calls.filter(v=>v==='load').length>1)await new Promise(()=>{});return {record:structuredClone(row),identities:[]};},recoveryScope:async()=>{calls.push('recoveryScope');if(holdScope)await new Promise(resolve=>releaseScope=resolve);return scope;},...(${recoveryProofOnly}?{recoverySnapshot:async()=>{calls.push('recoverySnapshot');return {scope,record:structuredClone(row)};}}:{}),save:async()=>{calls.push('save');throw Error('unexpected save');},upload:async()=>{throw Error('unexpected upload');},detach:async()=>{throw Error('unexpected detach');},readFile:async()=>new Uint8Array()};
 const host=createExperienceRecordFormHost(ports),root=document.getElementById('root');
 const mount=()=>renderExperienceView(root,{schema_version:'deft.experience_view.v2',capabilities:['record_form.v1','record_form_seed.v1'],root:node},()=>{}, {capabilities:['record_form.v1','record_form_seed.v1'],storeKeys:['drafts'],mountRecordForm:host.mountRecordForm});
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
  await page.getByText('Browser recovery ready',{exact:true}).waitFor({timeout:9000});
  const opened=await page.evaluate(()=>(window as any).Probe.read());assert.equal(opened.calls.filter((call:string)=>call==='load').length,1);assert.ok(opened.calls.includes('recoverySnapshot'));assert.equal(opened.calls.includes('save'),false);
  await page.getByRole('textbox',{name:'Subject',exact:true}).fill('Retain this text');assert.equal(await page.getByRole('textbox',{name:'Subject',exact:true}).inputValue(),'Retain this text');
 }finally{await browser.close();}
});
