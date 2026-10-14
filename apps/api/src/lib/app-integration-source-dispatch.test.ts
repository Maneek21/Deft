import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAppIntegrationSourceDispatcher} from './app-integration-source-dispatch.js';
import {appIntegrationSourceDigest,type AppIntegrationSourceCaller} from './app-integration-source.js';
import {appIntegrationCaptureEvidence} from './app-integration-capture-model.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,digest='sha256:'+'a'.repeat(64);
const caller:AppIntegrationSourceCaller={org_id:id(1),user_id:id(2),kind:'capture_policy',principal_id:id(3)};
const target={installation_id:id(4),account_ref:'account_a',store_key:'drafts',resource_binding_id:id(5),projection_id:id(6),ref:{resource_key:'inbox',record_id:id(7),content_digest:digest}};
const resource={record_id:id(7),content_digest:digest,revision:'opaque_revision',label:'Observed',data:{sender:'Person',date:'2026-10-11T00:00:00Z',in_inbox:true},tombstone:false,membership_generation:1,checkpoint_generation:1};
function fixture(change?:string){let dispatches=0;
 const service=createAppIntegrationSourceDispatcher({mint:async(_caller,_target,_purpose,operation,input)=>({schema_version:'deft.app_data_runtime.v1',request_id:id(8),operation,input,
  scope:{org_id:caller.org_id,owner_user_id:caller.user_id,installation_id:target.installation_id,app_version_id:id(9),grant_snapshot_id:id(10),package_digest:digest,grant_snapshot_digest:digest,lifecycle_epoch:1,grant_epoch:1,
   target_key:'primary',resource_key:'inbox',resource_binding_id:change==='binding'?id(11):target.resource_binding_id,runtime_registration_id:id(12),operator_user_id:id(13),runtime_epoch:1,profile_digest:digest,consent_expires_at:new Date(Date.now()+60000).toISOString()},
  connection:{session_id:id(14),session_revision:1,runtime_session_ref:'runtime_current',account_ref:change==='account'?'foreign':target.account_ref},authority:{consent_id:null,consent_digest:null,data_policy_digest:digest},expires_at:new Date(Date.now()+(change==='deadline'?60000:change==='slow'?20000:2000)).toISOString()}),
  dispatch:async (request,signal)=>{dispatches++;if(change==='slow'||change==='expiry')await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,change==='slow'?6000:3000);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason??new Error('expired'));},{once:true});});return {result:{schema_version:'deft.app_data_result.v1',request_id:change==='uuid'?id(15):request.request_id,operation:request.operation,input_digest:appIntegrationSourceDigest({operation:request.operation,input:request.input}),outcome:change==='not_found'?'not_found':'completed',resource,presentation:{plain_text:'Exact observed body'}}};}});
 return {service,dispatches:()=>dispatches};
}
test('source dispatch uses existing public read envelope, current lease and exact account/binding without browser consent',async()=>{
 const f=fixture();assert.equal((await f.service(caller,target,'knowledge_capture')).resource.record_id,target.ref.record_id);assert.equal(f.dispatches(),1);
 for(const change of ['binding','account','deadline']){const wrong=fixture(change);await assert.rejects(wrong.service(caller,target,'knowledge_capture'));assert.equal(wrong.dispatches(),0);}
 for(const change of ['uuid','not_found']){const wrong=fixture(change);await assert.rejects(wrong.service(caller,target,'knowledge_capture'));}
});
test('capture validates App-owned evidence and explicit policy without domain field inference',async()=>{
 const plain_text='We agreed to retain this reusable release process and the original source evidence.';
 const nomination={schema_version:'deft.app_capture_nomination.v2',eligible:true,body:plain_text,folders:['release-notes'],sender:'Project maintainer',received_at:resource.data.date,is_bulk:false,partial:true,attachments_processed:false,body_digest:appIntegrationSourceDigest(plain_text),thread_key:appIntegrationSourceDigest('release-series')};
 const snapshot:Parameters<typeof appIntegrationCaptureEvidence>[0]={caller,purpose:'knowledge_capture',authority:{identity:'owned',expires_at:Date.now()+10000},publication:{target,checkpoint_id:id(20),generation:1,cursor_sequence:1,projection_revision:'original',applied_sequence:1,payload_digest:digest,observed_at:resource.data.date,partial:true},resource:{...resource,data:{summary:'Resource fields are not capture evidence'}},presentation:{plain_text:'This display text is not normalized source evidence.',metadata:{capture_nomination:JSON.stringify(nomination)}}};
 const policy:Parameters<typeof appIntegrationCaptureEvidence>[1]={id:id(3),revision:1,history_since:resource.data.date,enabled:true,destination:{scope:'user',space_id:null},history_days:30,expected_revision:1,include_bulk:false,excluded_senders:[],excluded_folders:[]};
 const nominated=(value:unknown)=>({...snapshot,presentation:{metadata:{capture_nomination:JSON.stringify(value)}}});
 const evidence=await appIntegrationCaptureEvidence(snapshot,policy);assert.equal(evidence.eligible,true);assert.equal(evidence.sender,'Project maintainer');assert.equal(evidence.received_at,resource.data.date);assert.equal(evidence.body,plain_text);assert.equal(evidence.thread_key,nomination.thread_key);
 assert.equal((await appIntegrationCaptureEvidence(snapshot,{...policy,excluded_folders:['RELEASE-NOTES']})).reason,'excluded_folder');
 assert.equal((await appIntegrationCaptureEvidence(snapshot,{...policy,excluded_senders:['MAINTAINER']})).reason,'excluded_sender');
 assert.equal((await appIntegrationCaptureEvidence(nominated({...nomination,eligible:false,reason:'app_excluded'}),policy)).reason,'app_excluded');
 assert.equal((await appIntegrationCaptureEvidence(nominated({...nomination,is_bulk:true}),policy)).reason,'bulk');
 assert.equal((await appIntegrationCaptureEvidence(nominated({...nomination,received_at:'unknown'}),policy)).reason,'unknown_received_date');
 const {body,folders,...legacy}=nomination;
 assert.equal((await appIntegrationCaptureEvidence(nominated({...legacy,schema_version:'deft.app_capture_nomination.v1'}),policy)).reason,'unsupported_nomination');
 for(const invalid of [{...nomination,body_digest:'sha256:'+'b'.repeat(64)},{...nomination,body:'too short'},{...nomination,folders:['invalid\nfolder']},{...nomination,body:'a'.repeat(16001)}])await assert.rejects(appIntegrationCaptureEvidence(nominated(invalid),policy),/INVALID_NOMINATION/u);
 await assert.rejects(appIntegrationCaptureEvidence({...snapshot,presentation:{metadata:{capture_nomination:'a'.repeat(98305)}}},policy),/INVALID_NOMINATION/u);
});

test('read-only dispatcher allows a six-second authority roundtrip within the existing30s read maximum',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-12T06:00:00Z')});
 const f=fixture('slow'),work=f.service(caller,target,'knowledge_capture');
 await new Promise<void>(resolve=>setImmediate(resolve));t.mock.timers.tick(6000);
 const result=await work;assert.equal(result.resource.record_id,target.ref.record_id);assert.equal(f.dispatches(),1);
});
test('read-only dispatcher still aborts at the minted earlier authority expiry',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.parse('2026-10-12T06:00:00Z')});
 const f=fixture('expiry'),work=f.service(caller,target,'knowledge_capture');const failure=assert.rejects(work);
 await new Promise<void>(resolve=>setImmediate(resolve));t.mock.timers.tick(2001);await failure;
 assert.equal(f.dispatches(),1);
});
