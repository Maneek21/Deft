import {createRecordEventDelivery} from './app-experience-record-event-delivery';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {RecordSurface} from '../components/apps/experience-record-form';
const source=ts.createSourceFile('record.tsx',readFileSync(new URL('../components/apps/experience-record-form.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function actual(name:string,env:Record<string,unknown>){let found:ts.FunctionDeclaration|undefined;const walk=(node:ts.Node)=>{if(ts.isFunctionDeclaration(node)&&node.name?.text===name)found=node;ts.forEachChild(node,walk);};walk(source);assert.ok(found);const text=found.getText(source).replace(/^export /u,'');return runInNewContext(ts.transpileModule('('+text+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,env);}
test('actual trusted surface has an accessible neutral Expand control around an unchanged writing subtree',()=>{
 const html=renderToStaticMarkup(<RecordSurface label="Draft"><textarea aria-label="Message" defaultValue={"  kept\ttext\n\n"}/></RecordSurface>);
 assert.match(html,/aria-label="Expand record"/);assert.match(html,/aria-expanded="false"/);assert.match(html,/max-w-4xl/);assert.match(html,/  kept\ttext\n\n/);assert.doesNotMatch(html,/data-record-primary="true"/);
});
test('actual Expand/Restore changes only layout while retaining children and avoiding pointer caret blur',()=>{
 let expanded=false,updates=0;const writing=<div><textarea defaultValue="Saved text"/><div data-rich-selection="retained"/></div>;const model={selection:{anchor:3,head:7},writer:{revision:6},imageURL:'blob:current'};const before=structuredClone(model);
 const render=actual('RecordSurface',{React,useState:()=>[expanded,(fn:(value:boolean)=>boolean)=>{expanded=fn(expanded);updates++;}],useId:()=> 'surface-id',recordSurfaceStyles:'',Maximize2:()=>null,Minimize2:()=>null});
 const view=()=>render({label:'Draft',children:writing}) as React.ReactElement<any>;const locate=(element:React.ReactElement<any>,type:string):React.ReactElement<any>|undefined=>{if(element.type===type)return element;for(const child of React.Children.toArray(element.props.children))if(React.isValidElement(child)){const found=locate(child as React.ReactElement<any>,type);if(found)return found;}return undefined;};
 const a=view(),control=locate(a,'button')!;let prevented=0;control.props.onPointerDown({preventDefault:()=>prevented++});assert.equal(prevented,1);control.props.onClick();const b=view();assert.match(b.props.className,/max-w-none/);assert.equal(locate(b,'button')!.props['aria-expanded'],true);assert.equal(locate(b,'div')!.props.children,writing);
 locate(b,'button')!.props.onClick();const c=view();assert.match(c.props.className,/max-w-4xl/);assert.equal(locate(c,'button')!.props['aria-expanded'],false);assert.equal(locate(c,'div')!.props.children,writing);assert.equal(updates,2);assert.deepEqual(model,before);
});
test('actual host reference acknowledgments retain the same root and lifetime; record change disposes it',async()=>{
 let roots=0,unmounts=0;const renders:any[]=[];const factory=actual('createExperienceRecordFormHost',{createRecordEventDelivery,React,ExperienceRecordForm:()=>null,AbortController,queueMicrotask,document:{createElement:()=>({})},createRoot:()=>{roots++;return {render:(view:unknown)=>renders.push(view),unmount:()=>unmounts++};}});
 const host=factory({}),wrapper={append:()=>{}},node={id:'form',store_key:'drafts',record_id:'one',profile:{kind:'profile'},expected_revision:1,content_digest:'sha256:'+'1'.repeat(64)},context={signal:new AbortController().signal,current:()=>true};
 const old=host.mountRecordForm(node,wrapper,()=>true,context);const first=renders[0];await first.props.emit({kind:'input',node_id:'form',record_id:'one',record_revision:2,content_digest:'sha256:'+'2'.repeat(64),record_state:'saved',dirty:false,valid:true});host.mountRecordForm({...node,expected_revision:2,content_digest:'sha256:'+'2'.repeat(64)},wrapper,()=>true,context);old();await new Promise<void>(resolve=>queueMicrotask(resolve));assert.equal(roots,1);assert.equal(unmounts,0);assert.equal(renders[1].type,first.type);assert.equal(renders[1].props.context.signal,first.props.context.signal);assert.equal(first.props.context.signal.aborted,false);
 host.mountRecordForm({...node,record_id:'another'},wrapper,()=>true,context);assert.equal(roots,2);assert.equal(unmounts,1);assert.equal(first.props.context.signal.aborted,true);
});

 test('actual form host minimize and restore preserve editor root; a foreign revision replaces it',async()=>{let roots=0,unmounts=0;const renders:any[]=[],elements:any[]=[];const factory=actual('createExperienceRecordFormHost',{createRecordEventDelivery,React,ExperienceRecordForm:()=>null,AbortController,queueMicrotask,document:{createElement:()=>({})},createRoot:()=>{roots++;return {render:(view:unknown)=>renders.push(view),unmount:()=>unmounts++};}});const host=factory({}),wrapper={hidden:false,append:(el:unknown)=>elements.push(el)},node={id:'form',store_key:'drafts',record_id:'one',profile:{kind:'profile'},expected_revision:1,content_digest:'sha256:'+'1'.repeat(64)},context={signal:new AbortController().signal,current:()=>true};const dispose=host.mountRecordForm(node,wrapper,()=>true,context),first=renders[0];host.mountRecordForm({...node,presentation:'minimized'},wrapper,()=>true,context);dispose();await new Promise<void>(resolve=>queueMicrotask(resolve));assert.equal(wrapper.hidden,true);assert.equal(roots,1);assert.equal(unmounts,0);host.mountRecordForm(node,wrapper,()=>true,context);assert.equal(wrapper.hidden,false);assert.equal(roots,1);assert.ok(elements.every(el=>el===elements[0]));assert.equal(renders[2].props.context.signal,first.props.context.signal);host.mountRecordForm({...node,expected_revision:8,content_digest:'sha256:'+'8'.repeat(64)},wrapper,()=>true,context);assert.equal(roots,2);assert.equal(unmounts,1);assert.equal(first.props.context.signal.aborted,true);});


test('trusted seed UUID acknowledgement retains only the exact unchanged source profile and accepts the subsequent saved revision',async()=>{
 for(const mode of ['same','denied','old_id','next_id','revision','dirty','seed','action','initial','profile','source','controls','store','foreign']){
  let roots=0,unmounts=0;const renders:any[]=[];
  const factory=actual('createExperienceRecordFormHost',{createRecordEventDelivery,React,ExperienceRecordForm:()=>null,AbortController,queueMicrotask,document:{createElement:()=>({})},createRoot:()=>{roots++;return {render:(view:unknown)=>renders.push(view),unmount:()=>unmounts++};}});
  const host=factory({}),wrapper={append:()=>{}},id='11111111-1111-4111-8111-111111111111',next='22222222-2222-4222-8222-222222222222',zero='sha256:'+'0'.repeat(64),node:any={id:'form',store_key:'drafts',record_id:id,profile:{kind:'profile'},expected_revision:0,content_digest:zero,seed:{schema_version:'deft.record_form_seed.v1',value:{mode:'reply',record_seed:{source:'exact'}}}},context={signal:new AbortController().signal,current:()=>true};
  host.mountRecordForm(node,wrapper,()=>mode!=='denied',context);const first=renders[0];
  const event:any={kind:'input',node_id:'form',record_id:next,expected_seed_record_id:id,record_revision:0,content_digest:zero,record_state:'saved',dirty:false,valid:true,record_seed:true};
  if(mode==='old_id')event.expected_seed_record_id=next;if(mode==='next_id')event.record_id='invalid';if(mode==='revision')event.record_revision=1;if(mode==='dirty')event.dirty=true;
  await first.props.emit(event);const updated:any={...node,record_id:next};
  if(mode==='seed')updated.seed={...node.seed,value:{mode:'forward',record_seed:{source:'other'}}};if(mode==='action')updated.action_key='other_action';if(mode==='initial')updated.initial_change={operation_key:'other'};if(mode==='profile')updated.profile={kind:'other'};if(mode==='source')updated.source_refs=[{source:'other'}];if(mode==='controls')updated.record_changes=[{operation_key:'other'}];if(mode==='store')updated.store_key='other';if(mode==='foreign')updated.record_id='33333333-3333-4333-8333-333333333333';
  host.mountRecordForm(updated,wrapper,()=>true,context);
  assert.equal(roots,mode==='same'?1:2,mode);assert.equal(unmounts,mode==='same'?0:1,mode);
  if(mode==='same'){await renders.at(-1).props.emit({kind:'input',node_id:'form',record_id:next,record_revision:1,content_digest:'sha256:'+'a'.repeat(64),record_state:'saved',dirty:false,valid:true});host.mountRecordForm({...updated,expected_revision:1,content_digest:'sha256:'+'a'.repeat(64)},wrapper,()=>true,context);assert.equal(roots,1,'first create acknowledgement retains the same writer');}
 }
});
