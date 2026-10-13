import assert from 'node:assert/strict';import test from 'node:test';
import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
import {EXPERIENCE_RENDERER_CSS} from './app-experience-renderer';
const require=createRequire(fileURLToPath(new URL('../../package.json',import.meta.url)));
const {chromium}=require('playwright'),{build}=require('esbuild');
test('actual safe presentation retains authored 80px image cell and 552px hero without host grid sizing',async()=>{
 const bundle=await build({entryPoints:[fileURLToPath(new URL('./app-experience-safe-document.ts',import.meta.url))],bundle:true,write:false,platform:'browser',format:'iife',globalName:'SafeDocument'});
 const browser=await chromium.launch({headless:true,...(process.env.DEFT_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.DEFT_TEST_BROWSER_EXECUTABLE}:{})});try{
  const page=await browser.newPage({viewport:{width:900,height:700}});await page.route('**/*',(route:any)=>route.abort());
  await page.setContent('<style>'+EXPERIENCE_RENDERER_CSS+'</style><div class="deft-experience" style="width:632px;padding:0"><div id="reader"></div><div class="ex-grid-scroll"><table><tr><td>Grid</td></tr></table></div></div>');
  await page.addScriptTag({content:bundle.outputFiles[0].text});await page.addScriptTag({content:'window.__name = (value) => value;'});
  const result=await page.evaluate(async()=>{
   const ref='a'.repeat(64),hero='b'.repeat(64),canvas=document.createElement('canvas');canvas.width=250;canvas.height=40;
   const blob=await new Promise<Blob>(resolve=>canvas.toBlob(value=>resolve(value!),'image/png')),url=URL.createObjectURL(blob);
   const image=(id:string,w:number)=>'<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-spacing:0px"><tr><td style="width:'+w+'px"><a><img width="'+w+'" height="auto" style="display:block;height:auto;width:100%" src="deft-image:'+id+'" alt="Synthetic image"></a></td></tr></table>';
   const content='<div style="max-width:600px;margin:0 auto"><table style="width:100%" cellpadding="0"><tr><td style="padding:24px 40px">'+image(ref,80)+'</td></tr><tr><td style="padding:12px 24px">'+image(hero,552)+'</td></tr></table></div>';
   const safe:HTMLElement=(window as any).SafeDocument.createExperiencePresentationElement({format:'html',content},[{image_ref:ref,kind:'remote'},{image_ref:hero,kind:'cid'}],new Map([[ref,url],[hero,url]]));
   document.getElementById('reader')!.append(safe);const images=Array.from(safe.querySelectorAll('img'));await Promise.all(images.map(img=>img.decode()));
   const nested=images[0].closest('table')!,grid=document.querySelector('.ex-grid-scroll table')!,cell=images[0].closest('td')!;
   const out={logo:images[0].getBoundingClientRect().width,hero:images[1].getBoundingClientRect().width,natural:images[0].naturalWidth,logoStyle:images[0].style.width,cellStyle:(cell as HTMLElement).style.width,nestedMin:getComputedStyle(nested).minWidth,gridMin:getComputedStyle(grid).minWidth,gridWidth:getComputedStyle(grid).width,requests:safe.querySelectorAll('[src^="https:"]').length};
   URL.revokeObjectURL(url);return out;
  });
  assert.equal(result.logo,80);assert.equal(result.hero,552);assert.equal(result.natural,250);assert.equal(result.logoStyle,'100%');assert.equal(result.cellStyle,'80px');assert.equal(result.nestedMin,'0px');assert.equal(result.gridMin,'560px');assert.equal(result.requests,0);
  await page.setViewportSize({width:390,height:700});await page.evaluate(()=>{(document.querySelector('.deft-experience') as HTMLElement).style.width='100%';});const narrow=await page.evaluate(()=>({logo:document.querySelector('#reader img')!.getBoundingClientRect().width,grid:getComputedStyle(document.querySelector('.ex-grid-scroll table')!).minWidth}));assert.equal(narrow.logo,80);assert.equal(narrow.grid,'510px');
 }finally{await browser.close();}
});
