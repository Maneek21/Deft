import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const web=process.env.E3_INLINE_TEST_WEB_ROOT??fileURLToPath(new URL('../..',import.meta.url)),require=createRequire(path.join(web,'package.json')),{chromium}=require('playwright'),{build}=require('esbuild');
const owned=new Set(['experience-record-form.tsx','experience-record-files.tsx','experience-compose-controls.tsx','experience-compose-controls-rich-editor.tsx']);

test('mounted saved image action inserts the same owned file without uploading and rejects retired form callbacks',async()=>{
 const component=path.join(web,'src/components/apps/experience-record-form.tsx');
 const bundled=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ExperienceRecordForm} from ${JSON.stringify(component)};
 const id='03b30669-e589-4cc3-8b72-c298fb3fd193',image={file_id:'b56234b2-ef9e-4fb5-a1bd-934640e6ac6d',filename:'synthetic.png',media_type:'image/png',size_bytes:11571,sha256:'0'.repeat(64)},pdf={file_id:'1149ee5b-ee5e-4b44-856d-0ffb8197c3b2',filename:'synthetic.pdf',media_type:'application/pdf',size_bytes:1840,sha256:'1'.repeat(64)},calls=[],events=[];let live=true;
 const profile={schema_version:'deft.record_form_profile.v1',max_record_bytes:491520,addresses:[{field:'to',label:'To',optional:false}],subject:{field:'subject',label:'Subject',max_characters:998},richtext:{html_field:'body_html',plain_field:'body',label:'Message',max_characters:262144,links:'host_validated',inline_images:'host_files'},files:{field:'attachments',max_files:32,max_file_bytes:26214400,max_total_bytes:26214400}};
 let row={record_id:id,revision:7,content_digest:'sha256:'+'a'.repeat(64),status:'draft',value:{to:'recipient@example.test',subject:'Controlled fixture',body:'Before',body_html:'<p><strong>Before</strong></p>',attachments:[pdf,image]},files:[{file_id:pdf.file_id,upload_revision:5,sha256:pdf.sha256},{file_id:image.file_id,upload_revision:7,sha256:image.sha256}]};
 const node={kind:'record_form',id:'draft_form',label:'Saved draft',store_key:'drafts',record_id:id,expected_revision:7,content_digest:row.content_digest,profile};
 const ports={load:async()=>{calls.push('load');return {record:structuredClone(row),identities:[]};},save:async(_node,revision,value)=>{calls.push('save');row={...row,revision:revision+1,content_digest:'sha256:'+'b'.repeat(64),value:structuredClone(value)};return structuredClone(row);},upload:async()=>{calls.push('upload');throw Error('must not upload');},detach:async()=>{calls.push('detach');throw Error('must not detach');},readFile:async()=>new Uint8Array()};
 const abort=new AbortController();createRoot(document.getElementById('root')).render(<ExperienceRecordForm node={node} ports={ports} context={{signal:abort.signal,current:()=>live}} emit={event=>events.push(event)}/>);
 window.Probe={read:()=>({row,calls,events}),revoke:()=>live=false};`,resolveDir:web,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',alias:{'@':path.join(web,'src')},define:{'process.env.NODE_ENV':'"test"'},plugins:process.env.E3_INLINE_OVERLAY_DIR?[{name:'exact-owned-overlay',setup(builder:any){builder.onLoad({filter:/experience-(?:record-form|record-files|compose-controls(?:-rich-editor)?)\.tsx$/},(args:{path:string})=>owned.has(path.basename(args.path))?{contents:readFileSync(path.join(process.env.E3_INLINE_OVERLAY_DIR!,path.basename(args.path)),'utf8'),loader:'tsx',resolveDir:path.dirname(args.path)}:undefined);}}]:[]});
 const browser=await chromium.launch({headless:true,...(process.env.DEFT_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.DEFT_TEST_BROWSER_EXECUTABLE}:{})}),page=await browser.newPage();page.setDefaultTimeout(8000);
 try{
  await page.route('**/*',(route:any)=>route.request().url().startsWith('http://127.0.0.1/')?route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}):route.abort());await page.goto('http://127.0.0.1/');await page.addScriptTag({content:bundled.outputFiles[0].text});
  const insert=page.getByRole('button',{name:'Insert synthetic.png in message',exact:true});await insert.waitFor();assert.equal(await page.getByRole('button',{name:'Insert synthetic.pdf in message',exact:true}).count(),0);
  assert.equal((await page.evaluate(()=>(window as any).Probe.read())).calls.includes('save'),false,'opening does not insert or save');
  await insert.click();await page.waitForFunction(()=>(window as any).Probe.read().row.revision===8);
  const result=await page.evaluate(()=>(window as any).Probe.read());assert.equal(result.calls.filter((call:string)=>call==='upload').length,0);assert.equal(result.calls.filter((call:string)=>call==='save').length,1);assert.match(result.row.value.body_html,/<img src="cid:deft-b56234b2-ef9e-4fb5-a1bd-934640e6ac6d@deft.invalid"/);assert.match(result.row.value.body_html,/<strong>Before<\/strong>/);assert.match(result.row.value.body,/Image: synthetic.png/);assert.deepEqual(result.row.value.attachments.map((file:{file_id:string})=>file.file_id),['1149ee5b-ee5e-4b44-856d-0ffb8197c3b2','b56234b2-ef9e-4fb5-a1bd-934640e6ac6d']);assert.equal(result.row.files[1].upload_revision,7);
  await page.evaluate(()=>(window as any).Probe.revoke());await insert.click();assert.equal((await page.evaluate(()=>(window as any).Probe.read())).row.revision,8,'retired action cannot edit or save');
 }finally{await browser.close();}
});
