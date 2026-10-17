import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperienceRecordDocumentHost} from './app-experience-record-document';
import type {SourcePresentation} from './app-experience-source-view';
const node={kind:'record_document' as const,id:'reader',profile_version:'deft.record_document.v1' as const,store_key:'drafts',resource_key:'inbox',record_id:'11111111-1111-4111-8111-111111111111',content_digest:'sha256:'+'a'.repeat(64)};
const presentation:SourcePresentation={format:'html',content:'<p>'+ 'exact source '.repeat(8000)+'</p>',plain_text:'🪴'.repeat(10000),images:[],headers:[],truncated:false};
test('runtime source reference uses its own complete pinned host port and bounded plain leaf',async()=>{
 let reads=0,disposed=0;const abort=new AbortController(),context={signal:abort.signal,current:()=>true};
 const host=createExperienceRecordDocumentHost({storeKeys:['drafts'],resourceKeys:['inbox'],current:()=>true,load:async ref=>{assert.equal(ref.content_digest,node.content_digest);reads++;return {presentation,expires_at:new Date(Date.now()+60000).toISOString()};},mount:(_ref,_leaf,_wrapper,_current,load)=>{void load(context.signal).then(value=>assert.equal(value.presentation.content,presentation.content));return()=>disposed++;}});
 const leaf=await host.resolveRecordDocument!(node,context);assert.equal(leaf.format,'plain');assert.ok(new TextEncoder().encode(leaf.content).length<=16384);assert.equal(leaf.content.includes('�'),false);
 const close=host.enhanceRecordDocument!(node,leaf,{} as HTMLElement,context);await Promise.resolve();abort.abort();if(typeof close==='function')close();assert.equal(reads,1);assert.equal(disposed,1);
});
test('undeclared runtime stores and late revoked bodies are denied without indexed-row fallback',async()=>{
 let reads=0,resolve!:(value:{presentation:SourcePresentation;expires_at:string})=>void,live=true;
 const host=createExperienceRecordDocumentHost({storeKeys:['drafts'],resourceKeys:['inbox'],current:()=>live,load:()=>{reads++;return new Promise(done=>resolve=done);},mount:()=>{throw Error('must not mount');}});
 const context={signal:new AbortController().signal,current:()=>true};await assert.rejects(host.resolveRecordDocument!({...node,store_key:'foreign'},context));assert.equal(reads,0);
 const pending=host.resolveRecordDocument!(node,context);live=false;resolve({presentation,expires_at:new Date(Date.now()+60000).toISOString()});await assert.rejects(pending);assert.equal(reads,1);
});
