import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const web=fileURLToPath(new URL('../..',import.meta.url)),require=createRequire(path.join(web,'package.json')),{chromium}=require('playwright'),{build}=require('esbuild');

test('file picker supports Enter, cancel and repeat selection without focusing a hidden input or scrolling the installed surface',async()=>{
 const controls=path.join(web,'src/components/apps/experience-compose-controls.tsx'),renderer=path.join(web,'src/lib/app-experience-renderer.ts');
 const bundled=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ExperienceFilePicker} from ${JSON.stringify(controls)};import {EXPERIENCE_RENDERER_CSS} from ${JSON.stringify(renderer)};
 const calls=[];let disabled=false;const root=createRoot(document.getElementById('root')),render=()=>root.render(<div className="deft-experience"><style>{EXPERIENCE_RENDERER_CSS}</style><div id="surface" style={{width:280,height:160,overflow:'auto'}}><ExperienceFilePicker label="Add files" className="trigger" multiple disabled={disabled} accept="application/pdf" onSelect={files=>calls.push(files.map(file=>({name:file.name,bytes:file.size})))}>Add files</ExperienceFilePicker><div style={{height:400}}>Synthetic fixture</div></div></div>);window.Probe={start:render,disable:()=>{disabled=true;render();},read:()=>calls};`,resolveDir:web,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',alias:{'@':path.join(web,'src')},define:{'process.env.NODE_ENV':'"test"'}});
 const browser=await chromium.launch({headless:true,...(process.env.DEFT_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.DEFT_TEST_BROWSER_EXECUTABLE}:{})}),page=await browser.newPage({viewport:{width:360,height:640}});page.setDefaultTimeout(6000);
 try{
  await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/'?route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}):route.abort());await page.goto('http://127.0.0.1/');await page.addScriptTag({content:bundled.outputFiles[0].text});await page.evaluate(()=>(window as any).Probe.start());
  const trigger=page.getByRole('button',{name:'Add files',exact:true});await trigger.waitFor();
  await trigger.focus();const before=await page.evaluate(()=>{const surface=document.getElementById('surface')!;surface.scrollTop=31;return {left:surface.scrollLeft,top:surface.scrollTop};});
  for(let count=1;count<=2;count++){
   const chooser=page.waitForEvent('filechooser');await trigger.press('Enter');await (await chooser).setFiles({name:'synthetic.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-synthetic')});await page.waitForFunction((expected:number)=>(window as any).Probe.read().length===expected,count);
   const state=await page.evaluate(()=>{const surface=document.getElementById('surface')!,input=document.querySelector('input[type=file]') as HTMLInputElement;return {left:surface.scrollLeft,top:surface.scrollTop,active:document.activeElement?.textContent,hidden:input.hidden,display:getComputedStyle(input).display,value:input.value};});
   assert.equal(state.active,'Add files');assert.equal(state.hidden,true);assert.equal(state.display,'none');assert.equal(state.value,'');assert.deepEqual({left:state.left,top:state.top},before);
  }
  await page.evaluate(()=>{const other=document.createElement('button');other.textContent='Other fixture control';document.body.append(other);other.focus();});await page.locator('input[type=file]').dispatchEvent('cancel');assert.equal(await trigger.evaluate((el:any)=>el===document.activeElement),true);assert.equal((await page.evaluate(()=>(window as any).Probe.read())).length,2);
  await page.evaluate(()=>(window as any).Probe.disable());await page.waitForFunction(()=>document.querySelector('button')?.disabled);assert.equal(await trigger.isDisabled(),true);assert.equal(await page.locator('input[type=file]').isDisabled(),true);
 }finally{await browser.close();}
});
