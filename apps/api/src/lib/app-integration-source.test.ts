import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAppIntegrationSource,appIntegrationSourceDigest,type AppIntegrationSourceCaller,type AppIntegrationPublishedSource} from './app-integration-source.js';
import {appIntegrationPublishedProjection,appIntegrationExactLocatorCandidate,appIntegrationProjectedIdentity,AppIntegrationSourcePendingError} from './app-integration-source-projection.js';
import {openAppIntegrationSourceLocator,appIntegrationSourceLocator} from './app-integration-source-locator.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const caller:AppIntegrationSourceCaller={org_id:id(1),user_id:id(2),kind:'human',principal_id:id(3)};
const ref={resource_key:'mail',record_id:id(4),content_digest:'sha256:'+'a'.repeat(64)};
const target={installation_id:id(5),account_ref:'account_a',store_key:'compose',resource_binding_id:id(6),projection_id:id(7),ref};
const mapping={sync_descriptor_key:'mail',record_id_field:'source_record_id',content_digest_field:'source_content_digest',observed_at_field:'source_observed_at',projection_identity_field:'logical_message_id',navigation_entry_key:'inbox'};
const record={revision:'provider_rev_1',data:{label:'Observed message',source_record_id:ref.record_id,source_content_digest:ref.content_digest,source_observed_at:'2026-10-11T00:00:00Z'}};
const published=()=>appIntegrationPublishedProjection({target,mapping,descriptor_key:'mail',checkpoint:{id:id(8),generation:1,cursor_sequence:2,state:'active'},
 row:{id:target.projection_id,resource_binding_id:target.resource_binding_id,checkpoint_id:id(8),generation:1,state:'live',applied_sequence:2},record});
function fixture(){
 let publication:AppIntegrationPublishedSource=published(),identity='current-human-read',expiry=2000,runtimeDigest=ref.content_digest,tombstone=false,now=1000;
 const calls:string[]=[],tx={};
 const service=createAppIntegrationSource({clock:()=>now,authority:async(_caller,_target,purpose,transaction)=>{calls.push('authority:'+purpose+':'+!!transaction);return {identity,expires_at:expiry};},
 publication:async(_caller,_target,transaction)=>{calls.push('publication:'+!!transaction);return structuredClone(publication);},
 runtime:async()=>{calls.push('runtime');return {resource:{record_id:ref.record_id,content_digest:runtimeDigest,revision:'opaque_rev',label:'Observed message',data:{subject:'Subject'},tombstone,membership_generation:1,checkpoint_generation:1},presentation:{plain_text:'Observed source body',metadata:{}}};}});
 // Runtime returns only the existing public resource fields, not resource_key.
 const old=service;
 return {service:old,calls,tx,set:(values:{identity?:string;expiry?:number;now?:number;publication?:AppIntegrationPublishedSource;tombstone?:boolean;runtimeDigest?:string})=>{
  if(values.identity!==undefined)identity=values.identity;if(values.expiry!==undefined)expiry=values.expiry;if(values.now!==undefined)now=values.now;
  if(values.publication)publication=values.publication;if(values.tombstone!==undefined)tombstone=values.tombstone;if(values.runtimeDigest)runtimeDigest=values.runtimeDigest;
 },runtimeDigest:()=>runtimeDigest};
}
test('mapping binds exact source UUID/digest, current generation and checkpoint without provider identity',()=>{
 const value=published();assert.equal(value.payload_digest,appIntegrationSourceDigest(record));assert.equal(value.partial,true);
 for(const bad of [{target:{...target,ref:{...ref,record_id:id(9)}}},{mapping:{...mapping,sync_descriptor_key:'foreign'}},
  {row:{id:target.projection_id,resource_binding_id:target.resource_binding_id,checkpoint_id:id(8),generation:2,state:'live',applied_sequence:2}},
  {checkpoint:{id:id(8),generation:1,cursor_sequence:1,state:'active'}}]){
  assert.throws(()=>appIntegrationPublishedProjection({target,mapping,descriptor_key:'mail',checkpoint:{id:id(8),generation:1,cursor_sequence:2,state:'active'},
   row:{id:target.projection_id,resource_binding_id:target.resource_binding_id,checkpoint_id:id(8),generation:1,state:'live',applied_sequence:2},record,...bad}));
 }
});
test('current checkpoint locator matches exact key/fingerprint pair and denies ambiguous or excessive candidates',()=>{
 const locators=[{key_version:'old',fingerprint:'hmac-a'},{key_version:'new',fingerprint:'hmac-b'}],row={id:'current',resource_id_hmac_key_version:'new',resource_id_hmac:'hmac-b'};
 assert.equal(appIntegrationExactLocatorCandidate([row,{...row,id:'wrong-cross-pair',resource_id_hmac_key_version:'old'}],locators).id,'current');
 assert.throws(()=>appIntegrationExactLocatorCandidate([row,{...row,id:'duplicate'}],locators));
 assert.throws(()=>appIntegrationExactLocatorCandidate([] ,locators));
 assert.throws(()=>appIntegrationExactLocatorCandidate(Array.from({length:33},()=>row),locators));
});
test('only an absent exact published locator reports recoverable pending; ambiguous sources still deny',()=>{
 const locator={key_version:'current',fingerprint:'hash'},row={resource_id_hmac_key_version:'current',resource_id_hmac:'hash'};
 assert.throws(()=>appIntegrationExactLocatorCandidate([],[locator]),AppIntegrationSourcePendingError);
 assert.throws(()=>appIntegrationExactLocatorCandidate([row,row],[locator]),error=>error instanceof Error&&!(error instanceof AppIntegrationSourcePendingError));
});
test('fresh Runtime read precedes transaction and minted immutable guard performs no network',async()=>{
 const f=fixture(),snapshot=await f.service.read(caller,target,'read');assert.ok(Object.isFrozen(snapshot.presentation));
 const before=f.calls.filter(value=>value==='runtime').length;await f.service.guard(f.tx,caller,snapshot,'read');assert.equal(f.calls.filter(value=>value==='runtime').length,before);
 assert.deepEqual(f.calls.slice(-2),['authority:read:true','publication:true']);
 await assert.rejects(f.service.guard(f.tx,caller,structuredClone(snapshot),'read'));
});
test('guard rejects publication movement, expiry, actor and independent purpose reuse',async()=>{
 for(const change of ['checkpoint','expiry','identity','actor','purpose'] as const){
  const f=fixture(),snapshot=await f.service.read(caller,target,'read');
  if(change==='checkpoint')f.set({publication:{...published(),cursor_sequence:3}});
  if(change==='expiry')f.set({now:2000});if(change==='identity')f.set({identity:'revoked'});
  await assert.rejects(f.service.guard(f.tx,change==='actor'?{...caller,user_id:id(10)}:caller,snapshot,change==='purpose'?'transfer':'read'));
 }
});
test('Runtime tombstone prevents disclosure before destination use',async()=>{const f=fixture();f.set({tombstone:true});await assert.rejects(f.service.read(caller,target,'read'));});
test('changed Runtime source digest prevents disclosure of an old published snapshot',async()=>{const f=fixture();f.set({runtimeDigest:'sha256:'+'b'.repeat(64)});await assert.rejects(f.service.read(caller,target,'read'));});
test('source locator requires a fresh human read and current signed navigation; citation can be retained without link',async()=>{
 const f=fixture(),snapshot=await f.service.read(caller,target,'read'),locator=appIntegrationSourceLocator(snapshot,'inbox');
 assert.equal('resource_binding_id' in locator.target,false);assert.equal('projection_id' in locator.target,false);
 let reads=0;const ports={resolve:async()=>({...target,resource_binding_id:id(30),projection_id:id(31)}),read:async(_caller:AppIntegrationSourceCaller,live:typeof target)=>{reads++;assert.equal(live.resource_binding_id,id(30));return snapshot;},navigation:async()=>({entry_key:'inbox',href:'/apps/email?source='+ref.record_id})};
 assert.match(await openAppIntegrationSourceLocator(caller,locator,ports),/^\/apps\/email/u);assert.equal(reads,1);
 await assert.rejects(openAppIntegrationSourceLocator({...caller,kind:'personal_mcp'},locator,ports));
 await assert.rejects(openAppIntegrationSourceLocator(caller,locator,{...ports,read:async()=>{throw Error('revoked');}}));
 await assert.rejects(openAppIntegrationSourceLocator(caller,locator,{...ports,navigation:async()=>({entry_key:'inbox',href:'https://author.example'})}));
 await assert.rejects(openAppIntegrationSourceLocator(caller,locator,{...ports,resolve:async()=>({...target,account_ref:'foreign_account'})}));
 await assert.rejects(openAppIntegrationSourceLocator(caller,locator,{...ports,resolve:async()=>({...target,ref:{...ref,content_digest:'sha256:'+'b'.repeat(64)}})}));
});

test('opaque signed locator derives source UUID/digest only from the exact current projection and rejects header/value mismatch',()=>{
 const logical='mail_'+'c'.repeat(64),scope={installation_id:target.installation_id,account_ref:target.account_ref,store_key:target.store_key,resource_key:ref.resource_key};
 const current={data:{...record.data,logical_message_id:logical}};
 assert.deepEqual(appIntegrationProjectedIdentity(scope,mapping,current,logical),{installation_id:scope.installation_id,account_ref:scope.account_ref,store_key:scope.store_key,ref});
 assert.throws(()=>appIntegrationProjectedIdentity(scope,mapping,current,'<message-id@example.test>'));
 assert.throws(()=>appIntegrationProjectedIdentity(scope,mapping,{data:{...current.data,logical_message_id:'mail_'+'d'.repeat(64)}},logical));
 assert.throws(()=>appIntegrationProjectedIdentity(scope,mapping,{data:{...current.data,source_record_id:logical}},logical));
 assert.throws(()=>appIntegrationProjectedIdentity(scope,mapping,{data:{...current.data,source_content_digest:'expired-binding'}},logical));
});
