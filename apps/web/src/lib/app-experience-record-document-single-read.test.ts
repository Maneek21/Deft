import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperienceRecordDocumentHost} from './app-experience-record-document';
import {DeftExperienceRecordDocumentNodeSchema} from '../../../../packages/app-kit/src/app-data';
import type {SourcePresentation} from './app-experience-source-view';
import type {ExperienceNode} from './app-experience-bridge';
type Document=Extract<ExperienceNode,{kind:'document'}>;

async function fixture(){
 const node=DeftExperienceRecordDocumentNodeSchema.parse({kind:'record_document',id:'reader',profile_version:'deft.record_document.v1',store_key:'drafts',resource_key:'inbox',record_id:'11111111-1111-4111-8111-111111111111',content_digest:'sha256:'+'a'.repeat(64)});
 const presentation:SourcePresentation={format:'html',content:'<p>Exact scoped source</p>',plain_text:'Exact scoped source',images:[],headers:[],truncated:false};
 const controller=new AbortController(),context={signal:controller.signal,current:()=>live};let live=true,reads=0,mounts=0,disposed=0;let expiry=Date.now()+60000;
 let mountedLoad:((signal:AbortSignal)=>Promise<{presentation:SourcePresentation;expires_at:string}>)|undefined;
 const host=createExperienceRecordDocumentHost({storeKeys:['drafts'],resourceKeys:['inbox'],current:()=>live,
  load:async()=>{reads++;return {presentation,expires_at:new Date(expiry).toISOString()};},
  mount:(_ref,_leaf,_wrapper,current,load)=>{assert.equal(current(),true);mounts++;mountedLoad=load;return()=>disposed++;}});
 return {host,node,presentation,controller,context,read:()=>host.resolveRecordDocument!(node,context),mount:(leaf:Document,ref=node,ctx=context)=>host.enhanceRecordDocument!(ref,leaf,{} as HTMLElement,ctx),load:()=>mountedLoad!,counts:()=>({reads,mounts,disposed}),revoke:()=>{live=false;},expire:()=>{expiry=Date.now()-1;}};
}
test('actual public node resolves and mounts exact body with one presentation fetch and one consumption',async()=>{
 const f=await fixture(),leaf=await f.read();const close=f.mount(leaf);assert.equal((await f.load()(f.controller.signal)).presentation.content,f.presentation.content);assert.equal(f.counts().reads,1);
 await assert.rejects(f.load()(f.controller.signal));assert.equal(f.counts().reads,1);assert.equal(typeof close,'function');if(typeof close==='function')close();assert.equal(f.counts().disposed,1);
});
test('changed nomination, leaf or render context cannot reuse a validated body or trigger fallback IO',async()=>{
 for(const change of ['uuid','digest','store','resource','id','leaf','context']){const f=await fixture(),leaf={...await f.read()};const node={...f.node};let ctx=f.context;
  if(change==='uuid')node.record_id='22222222-2222-4222-8222-222222222222';if(change==='digest')node.content_digest='sha256:'+'b'.repeat(64);if(change==='store')node.store_key='foreign';if(change==='resource')node.resource_key='foreign';if(change==='id')node.id='another';if(change==='leaf')leaf.content='forged';if(change==='context')ctx={signal:new AbortController().signal,current:()=>true};
  if(change==='store'||change==='resource')assert.equal(f.mount(leaf,node,ctx),undefined);else assert.throws(()=>f.mount(leaf,node,ctx),change);assert.deepEqual(f.counts(),{reads:1,mounts:0,disposed:0});f.controller.abort();
 }
});
test('revoked, aborted and expired fetched authority denies enhancement',async()=>{
 for(const change of ['revoked','aborted','expired']){const f=await fixture();let leaf:Document;
  if(change==='expired'){f.expire();await assert.rejects(f.read());assert.equal(f.counts().mounts,0);continue;}
  leaf=await f.read();if(change==='revoked')f.revoke();else f.controller.abort();assert.equal(f.mount(leaf),undefined);assert.equal(f.counts().mounts,0);
 }
});
test('scope revoke or abort between mount and microtask release cannot disclose cached presentation',async()=>{
 for(const change of ['current','signal','nomination']){const f=await fixture(),leaf=await f.read(),close=f.mount(leaf),readController=new AbortController();
  const waiting=f.load()(readController.signal);if(change==='current')f.revoke();if(change==='signal')readController.abort();if(change==='nomination')f.node.content_digest='sha256:'+'c'.repeat(64);
  await assert.rejects(waiting);assert.equal(f.counts().reads,1);if(typeof close==='function')close();
 }
});
test('consumed presentation cannot mount twice and a new render performs its own fresh read',async()=>{
 const f=await fixture(),leaf=await f.read(),close=f.mount(leaf);await f.load()(f.controller.signal);assert.throws(()=>f.mount(leaf));if(typeof close==='function')close();
 const fresh=await fixture(),freshLeaf=await fresh.read();fresh.mount(freshLeaf);await fresh.load()(fresh.controller.signal);assert.equal(fresh.counts().reads,1);fresh.controller.abort();
});
test('source expiry between resolve and mount denies while a still-current technical lease cannot extend it',async()=>{
 const f=await fixture();const originalNow=Date.now;let offset=0;Date.now=()=>originalNow()+offset;
 try{const leaf=await f.read();offset=120000;assert.throws(()=>f.mount(leaf));assert.equal(f.counts().mounts,0);assert.equal(f.counts().reads,1);}finally{Date.now=originalNow;f.controller.abort();}
});
