import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const web=fileURLToPath(new URL('../..',import.meta.url)),require=createRequire(path.join(web,'package.json')),{chromium}=require('playwright'),{build}=require('esbuild');
async function fixture(width=1100,coarse=false){
 const renderer=path.join(web,'src/lib/app-experience-renderer.ts'),menu=path.join(web,'src/components/apps/experience-menu.tsx');
 const bundle=await build({stdin:{contents:`import {renderExperienceView,clearExperienceView,suspendExperienceView,EXPERIENCE_RENDERER_CSS} from ${JSON.stringify(renderer)};import {createExperienceMenuHost} from ${JSON.stringify(menu)};
 const container=document.getElementById('root'),events=[],prints=[],capabilities=['menu.v1','keyboard_controls.v1'];let disabled=false;
 const node={kind:'menu',id:'more',label:'More actions',icon:'more',items:[{id:'unavailable',label:'Unavailable',disabled:true},{id:'archive',label:'Archive',icon:'archive'},{id:'trash',label:'Delete',icon:'trash',danger:true},{id:'print',label:'Print',icon:'print'}]};
 const view=()=>({schema_version:'deft.experience_view.v2',capabilities,keyboard:{schema_version:'deft.experience_keyboard.v1',bindings:[{key:'a',target_id:'primary_archive',behavior:'activate'},{key:'m',target_id:'more',behavior:'activate'}]},root:{kind:'stack',id:'root',children:[{kind:'stack',id:'toolbar',layout:'toolbar',children:[{kind:'text',id:'title',text:'A generic document',tone:'heading'},{kind:'button',id:'primary_archive',label:'Archive document',icon:'archive',variant:'ghost'},{...node,disabled}]},{kind:'document',id:'body',format:'plain',content:'Exact saved text',printable:true,print_control_id:'print'}]}});
 const style=document.createElement('style');style.textContent=EXPERIENCE_RENDERER_CSS;document.head.append(style);
 const mount=()=>renderExperienceView(container,view(),event=>{events.push(event);return true;},{capabilities,...createExperienceMenuHost(),printDocument:node=>{prints.push(node.content);return true;}});
 const button=(id,label,icon)=>({kind:'button',id,label,icon,variant:'ghost'}),stack=(id,children,extra={})=>({kind:'stack',id,children,...extra}),menuNode=(id,icon='more')=>({kind:'menu',id,label:'Actions '+id,icon,items:[{id:id+'_action',label:'A current action'}]});
 const bars=()=>renderExperienceView(container,{schema_version:'deft.experience_view.v2',capabilities:['menu.v1'],root:stack('root',[
  stack('columns',[
   stack('list',[stack('selection_bar',[stack('selection_summary',[menuNode('selection','check'),{kind:'text',id:'count',text:'100 selected',tone:'caption'}],{layout:'horizontal'}),stack('bulk',[button('bulk_archive','Archive','archive'),button('bulk_trash','Move to Trash','trash'),menuNode('bulk_more'),button('exit','Exit selection','close')],{layout:'horizontal'})],{layout:'toolbar'})],{surface:'sidebar'}),
   stack('document',[stack('reader_bar',[stack('reader_back',[button('back','Back','back')],{layout:'horizontal',mobile:'only'}),{kind:'text',id:'subject',text:'A long current document subject',tone:'heading'},stack('reader_actions',[button('reader_archive','Archive','archive'),button('reader_read','Mark as unread','unread'),menuNode('reader_more')],{layout:'horizontal'})],{layout:'toolbar'})],{surface:'document'})
  ],{layout:'split'})
 ],{layout:'workspace'})},()=>true,{capabilities:['menu.v1'],...createExperienceMenuHost()});
 const integrations=[],saved=[],governed={kind:'record_document',id:'mail_body',profile_version:'deft.record_document.v1',store_key:'drafts',resource_key:'inbox',record_id:'11111111-1111-4111-8111-111111111111',content_digest:'sha256:'+'a'.repeat(64)};
 const native=(disabled=false)=>renderExperienceView(container,{schema_version:'deft.experience_view.v2',capabilities:['menu.v1','record_document.v1'],root:{kind:'stack',id:'root',children:[{kind:'menu',id:'more',label:'Native actions',disabled,items:[{id:'task',label:'Create task',integration:{kind:'task',document_id:'mail_body'}},{id:'knowledge',label:'Capture knowledge',integration:{kind:'knowledge',document_id:'mail_body'}},{id:'denied',label:'Disabled native',disabled:true,integration:{kind:'task',document_id:'mail_body'}}]},governed]}},event=>events.push(event),{capabilities:['menu.v1','record_document.v1'],storeKeys:['drafts'],resourceKeys:['inbox'],...createExperienceMenuHost(),mountMenu:(node,wrap,select,context)=>{saved.push(select);return createExperienceMenuHost().mountMenu(node,wrap,select,context);},resolveRecordDocument:async()=>({kind:'document',id:'mail_body_rendered',format:'plain',content:'Current governed source'}),openRecordIntegration:async(node,kind,context)=>{if(context.current()&&!context.signal.aborted)integrations.push({node,kind});}});
 window.Probe={mount,bars,native,nativeRead:()=>({integrations,events}),oldNative:()=>saved[0]('task'),clear:()=>clearExperienceView(container),suspend:()=>suspendExperienceView(container),disable:()=>{disabled=true;mount();},read:()=>({events,prints})};`,resolveDir:web,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',alias:{'@':path.join(web,'src')},define:{'process.env.NODE_ENV':'"test"'}});
 const browser=await chromium.launch({headless:true,...(process.env.DEFT_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.DEFT_TEST_BROWSER_EXECUTABLE}:{})}),page=await browser.newPage({viewport:{width,height:800},hasTouch:coarse});page.setDefaultTimeout(6000);
 await page.route('**/*',(route:any)=>route.request().url().startsWith('http://127.0.0.1/')?route.fulfill({contentType:'text/html',body:'<div id="root"></div><button id="outside">Outside</button>'}):route.abort());await page.goto('http://127.0.0.1/');await page.addScriptTag({content:bundle.outputFiles[0].text});await page.evaluate(()=>(window as any).Probe.mount());
 return {page,close:()=>browser.close()};
}
test('mounted generic menu uses shared keyboard/outside/focus behavior and emits only enabled click IDs',async()=>{
 const f=await fixture();const {page}=f;
 try{
  const trigger=page.getByRole('button',{name:'More actions',exact:true});await trigger.focus();await trigger.press('ArrowDown');
  await page.getByRole('menu',{name:'More actions'}).waitFor();await page.keyboard.press('a');assert.deepEqual((await page.evaluate(()=>(window as any).Probe.read())).events,[]);await page.waitForFunction(()=>document.activeElement?.textContent==='Archive');
  await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Delete');await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Print');await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Archive');
  assert.equal(await page.getByRole('menuitem',{name:'Unavailable'}).isDisabled(),true);await page.keyboard.press('Escape');await page.getByRole('menu').waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='More actions');
  await trigger.click();await page.getByRole('menuitem',{name:'Archive'}).click();assert.deepEqual((await page.evaluate(()=>(window as any).Probe.read())).events,[{kind:'click',node_id:'archive'}]);
  await trigger.click();await page.getByRole('menuitem',{name:'Print'}).click();const result=await page.evaluate(()=>(window as any).Probe.read());assert.deepEqual(result.prints,['Exact saved text']);assert.equal(result.events.length,1);
  await trigger.click();await page.getByRole('button',{name:'Outside'}).click();await page.getByRole('menu').waitFor({state:'hidden'});
  await trigger.click();await page.evaluate(()=>(window as any).Probe.suspend());await page.getByRole('menu').waitFor({state:'hidden'});assert.equal((await page.evaluate(()=>(window as any).Probe.read())).events.length,1);
  await page.evaluate(()=>(window as any).Probe.disable());assert.equal(await trigger.isDisabled(),true);
 }finally{await f.close();}
});
test('mobile menu is the shared bottom sheet and clears its portal on view replacement',async()=>{
 const f=await fixture(375);const {page}=f;
 try{
  const trigger=page.getByRole('button',{name:'More actions',exact:true});
  const geometry=await page.evaluate(()=>{const bar=document.querySelector('[data-render-key=toolbar]')!;const buttons=Array.from(bar.querySelectorAll('button')).map(el=>el.getBoundingClientRect());return {tops:buttons.map(rect=>rect.top),overflow:bar.scrollWidth>bar.clientWidth};});assert.equal(new Set(geometry.tops).size,1);assert.equal(geometry.overflow,false);
  await trigger.click();await page.getByRole('dialog',{name:'More actions'}).waitFor();assert.equal(await page.getByRole('menuitem',{name:'Delete'}).count(),1);
  await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='More actions');
  await trigger.click();await page.evaluate(()=>(window as any).Probe.mount());await page.getByRole('dialog').waitFor({state:'hidden'});assert.deepEqual((await page.evaluate(()=>(window as any).Probe.read())).events,[]);
 }finally{await f.close();}
});


test('selection and reader toolbars keep compact icon controls on one row at 350px coarse and desktop',async()=>{
 for(const [width,coarse]of [[350,true],[1100,false]] as const){
  const f=await fixture(width,coarse);const {page}=f;
  try{
   await page.evaluate(()=>(window as any).Probe.bars());await page.getByRole('button',{name:'Actions selection',exact:true}).waitFor();
   const rows=await page.evaluate(()=>['selection_bar','reader_bar'].map(id=>{
    const bar=document.querySelector<HTMLElement>('[data-render-key='+id+']')!,rect=bar.getBoundingClientRect();
    const controls=Array.from(bar.querySelectorAll<HTMLButtonElement>('button')).filter(node=>node.getClientRects().length).map(node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};});
    return {id,left:rect.left,right:rect.right,height:rect.height,overflow:bar.scrollWidth>bar.clientWidth,controls};
   }));
   for(const row of rows){assert.equal(new Set(row.controls.map((control:{top:number})=>control.top)).size,1,JSON.stringify(row));assert.equal(row.overflow,false,JSON.stringify(row));for(const control of row.controls){assert.ok(control.left>=row.left-1&&control.right<=row.right+1,JSON.stringify(row));assert.ok(control.width<=44,JSON.stringify(row));if(coarse){assert.ok(control.width>=44&&control.height>=44,JSON.stringify(row));}}}
  }finally{await f.close();}
 }
});

test('native menu binds exact resolved document and refuses stale, suspended or disabled selections',async()=>{
 const f=await fixture();const {page}=f;
 try{
  await page.evaluate(()=>(window as any).Probe.native());await page.getByText('Current governed source').waitFor();
  await page.getByRole('button',{name:'Native actions',exact:true}).click();await page.getByRole('menuitem',{name:'Create task',exact:true}).click();
  let actual=await page.evaluate(()=>(window as any).Probe.nativeRead());assert.equal(actual.integrations.length,1);assert.equal(actual.integrations[0].node.id,'mail_body');assert.equal(actual.integrations[0].node.record_id,'11111111-1111-4111-8111-111111111111');assert.equal(actual.integrations[0].kind,'task');assert.deepEqual(actual.events,[]);
  await page.getByRole('button',{name:'Native actions',exact:true}).click();assert.equal(await page.getByRole('menuitem',{name:'Disabled native'}).isDisabled(),true);await page.getByRole('menuitem',{name:'Capture knowledge',exact:true}).click();
  assert.equal((await page.evaluate(()=>(window as any).Probe.nativeRead())).integrations[1].kind,'knowledge');
  await page.evaluate(()=>(window as any).Probe.native(true));await page.evaluate(()=>(window as any).Probe.oldNative());assert.equal(await page.getByRole('button',{name:'Native actions',exact:true}).isDisabled(),true);
  await page.evaluate(()=>(window as any).Probe.suspend());await page.evaluate(()=>(window as any).Probe.oldNative());
  actual=await page.evaluate(()=>(window as any).Probe.nativeRead());assert.equal(actual.integrations.length,2);assert.deepEqual(actual.events,[]);
 }finally{await f.close();}
});
