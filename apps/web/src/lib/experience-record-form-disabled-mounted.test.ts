import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const web=fileURLToPath(new URL('../..',import.meta.url)),require=createRequire(path.join(web,'package.json')),{chromium}=require('playwright'),{build}=require('esbuild');

test('retained saved and seed-resolved composers follow the current busy flag without reloading or losing record identity',async()=>{
 const component=path.join(web,'src/components/apps/experience-record-form.tsx');
 const bundled=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ExperienceRecordForm} from ${JSON.stringify(component)};
 const profile={schema_version:'deft.record_form_profile.v1',max_record_bytes:491520,addresses:[{field:'to',label:'To',optional:false}],subject:{field:'subject',label:'Subject',max_characters:998},richtext:{html_field:'body_html',plain_field:'body',label:'Message',max_characters:262144,links:'host_validated',inline_images:'host_files'},files:{field:'attachments',max_files:32,max_file_bytes:26214400,max_total_bytes:26214400}};
 const original='11111111-1111-4111-8111-111111111111',resolved='22222222-2222-4222-8222-222222222222',calls=[];
 let root=null,node=null,seed=false;
 const value={to:'recipient@example.test',subject:'Saved subject',body:'Before',body_html:'<p><strong>Before</strong></p>',attachments:[]};
 let row;const ports={resolveSeed:async node=>{calls.push(['resolve',node.record_id]);return {...node,record_id:resolved};},load:async node=>{calls.push(['load',node.record_id]);return {record:structuredClone(row),identities:[]};},save:async(node,revision,value)=>{calls.push(['save',node.record_id]);row={...row,revision:revision+1,value};return structuredClone(row);},upload:async()=>{throw Error('unexpected');},detach:async()=>{throw Error('unexpected');},readFile:async()=>new Uint8Array()};
 const context={signal:new AbortController().signal,current:()=>true},emit=()=>true;
 const render=disabled=>root.render(<ExperienceRecordForm node={{...node,disabled}} ports={ports} context={context} emit={emit}/>);
 window.Probe={start:withSeed=>{root?.unmount();seed=withSeed;calls.length=0;row={record_id:seed?resolved:original,revision:7,content_digest:'sha256:'+'a'.repeat(64),status:'draft',value:structuredClone(value),files:[]};node={kind:'record_form',id:'draft_form',label:'Saved draft',store_key:'drafts',record_id:original,expected_revision:7,content_digest:row.content_digest,profile,...(seed?{seed:{value}}:{})};root=createRoot(document.getElementById('root'));render(true);},render,read:()=>({calls,row})};`,resolveDir:web,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',alias:{'@':path.join(web,'src')},define:{'process.env.NODE_ENV':'"test"'}});
 const browser=await chromium.launch({headless:true,...(process.env.DEFT_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.DEFT_TEST_BROWSER_EXECUTABLE}:{})}),page=await browser.newPage();page.setDefaultTimeout(4000);
 try{
  await page.route('**/*',(route:any)=>route.request().url().startsWith('http://127.0.0.1/')?route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}):route.abort());await page.goto('http://127.0.0.1/');await page.addScriptTag({content:bundled.outputFiles[0].text});
  for(const seed of [false,true]){
   await page.evaluate((seed:boolean)=>(window as any).Probe.start(seed),seed);const subject=page.getByRole('textbox',{name:'Subject',exact:true});await subject.waitFor();assert.equal(await subject.isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Bold',exact:true}).isDisabled(),true);
   await page.evaluate(()=>(window as any).Probe.render(false));await page.waitForFunction(()=>!(document.querySelector('input[placeholder="Subject"]') as HTMLInputElement)?.disabled && Array.from(document.querySelectorAll('input')).some(input=>input.value==='Saved subject'&&!input.disabled));
   assert.equal(await subject.isEnabled(),true,'busy completion must unlock same retained writer');assert.equal(await page.getByRole('button',{name:'Bold',exact:true}).isEnabled(),true);
   await page.evaluate(()=>(window as any).Probe.render(true));await page.waitForFunction(()=>Array.from(document.querySelectorAll('input')).some(input=>input.value==='Saved subject'&&input.disabled));assert.equal(await subject.isDisabled(),true,'new busy state must fence editing');
   await page.evaluate(()=>(window as any).Probe.render(false));await subject.fill('Edited subject');await page.waitForFunction(()=>(window as any).Probe.read().row.revision===8);
   const state=await page.evaluate(()=>(window as any).Probe.read()),expected=seed?'22222222-2222-4222-8222-222222222222':'11111111-1111-4111-8111-111111111111';assert.deepEqual(state.calls,seed?[['resolve','11111111-1111-4111-8111-111111111111'],['load',expected],['save',expected]]:[['load',expected],['save',expected]]);assert.equal(state.row.value.subject,'Edited subject');
  }
 }finally{await browser.close();}
});
