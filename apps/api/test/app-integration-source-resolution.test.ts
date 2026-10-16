import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {createAppIntegrationSource} from '../src/lib/app-integration-source.js';
import {AppIntegrationSourceIdentitySchema} from '../../../packages/app-kit/src/app-integration-source.js';
// Execute the real component closure with only DB/public transport ports replaced.
const source=readFileSync(new URL('../src/lib/app-integration-capture-runtime.ts',import.meta.url),'utf8');
const begin=source.indexOf(' const components='),end=source.indexOf('\n const human=components()',begin);
assert.ok(begin>=0&&end>begin);
const make=new Function('input','publication','now','denied','policyGuard','createAppIntegrationSource','createAppIntegrationSourceDispatcher','AppIntegrationSourceIdentitySchema',stripTypeScriptTypes(source.slice(begin,end),{mode:'transform'})+';return components;');
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,hash='sha256:'+'a'.repeat(64);
function fixture(change?:string){
 const caller={org_id:id(1),user_id:id(2),kind:'human',principal_id:id(3)},identity={installation_id:id(4),account_ref:'account_one',store_key:'drafts',ref:{resource_key:'inbox',record_id:id(7),content_digest:hash}},target={...identity,resource_binding_id:id(5),projection_id:id(6)};
 const resource={record_id:id(7),content_digest:hash,revision:'provider_revision',label:'Observed source',data:{logical_message_id:'opaque_app_identity'},tombstone:false,membership_generation:1,checkpoint_generation:1};
 const ops:string[]=[],published={target,checkpoint_id:id(16),generation:1,cursor_sequence:1,projection_revision:'revision',applied_sequence:1,payload_digest:hash,observed_at:'2026-10-16T04:00:00Z',partial:true};let revoked=false,bodyRead=false;
 const publication=Object.assign(async()=>({...published,...(change==='publication_changed'&&bodyRead?{cursor_sequence:2}:{})}),{resolve:async(_caller:unknown,_identity:unknown,_binding:unknown,value:typeof resource)=>{assert.equal(value.record_id,identity.ref.record_id);assert.equal(value.content_digest,identity.ref.content_digest);return target;}});
 const gateway={currentAccount:async()=>{if(revoked)throw Error('revoked');return {resource_binding_id:target.resource_binding_id,resource_key:'inbox',identity:'current-authority',expires_at:Date.now()+60000};}};
 const dispatcher=(_ports:unknown,content='presentation')=>async(_caller:unknown,_target:unknown,_purpose:unknown,signal?:AbortSignal)=>{
  signal?.throwIfAborted();ops.push(content);if(change==='revoked_after_resolve')revoked=true;if(content==='presentation')bodyRead=true;
  return {resource:{...resource,...(change==='content_changed'&&bodyRead?{content_digest:'sha256:'+'b'.repeat(64)}:{})},presentation:content==='metadata'?{}:{plain_text:'Exact current source body'}};
 };
 const components=make({gateway,transaction:async(fn:any)=>fn({})},publication,Date.now,()=>Error('denied'),async()=>{},createAppIntegrationSource,dispatcher,AppIntegrationSourceIdentitySchema);
 return {ops,run:async()=>{const c=components(),resolved=await c.resolve(caller,identity,'read');return c.source.read(caller,resolved,'read');}};
}
test('actual source opening resolves metadata once and reads presentation once without discarded body reads',async()=>{
 const f=fixture(),snapshot=await f.run();assert.deepEqual(f.ops,['metadata','presentation']);assert.equal(snapshot.presentation.plain_text,'Exact current source body');assert.ok(Object.isFrozen(snapshot.presentation));
});
test('metadata resolve retains current authority, exact content and publication checks',async()=>{
 for(const change of ['revoked_after_resolve','content_changed','publication_changed'])await assert.rejects(fixture(change).run(),change);
});
