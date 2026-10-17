import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {ResourceObservationConnectionSchema,ResourceObservationSnapshotSchema,createResourceObservationClient,digestResourceObservation,ResourceObservationContextSchema,ResourceObservationReviewSchema} from '../src/resource-observation.js';
import {ResourceSyncClaimV3Schema} from '../src/resource-sync-client-v3.js';
const hash='sha256:'+'a'.repeat(64),expiry=new Date(Date.now()+3600000).toISOString();
const scope={org_id:randomUUID(),owner_user_id:randomUUID(),installation_id:randomUUID(),app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),
 package_digest:hash,grant_snapshot_digest:hash,lifecycle_epoch:1,grant_epoch:2,target_key:'personal',resource_key:'inbox',resource_binding_id:randomUUID(),
 runtime_registration_id:randomUUID(),operator_user_id:randomUUID(),runtime_epoch:1,profile_digest:hash,consent_expires_at:expiry};
const snapshot=ResourceObservationSnapshotSchema.parse({schema_version:'deft.app_resource_observation_consent.v1',consent_id:randomUUID(),scope,
 connection:{session_id:randomUUID(),runtime_session_ref:'custody_ref',account_ref:randomUUID(),expected_custody_generation:null,receipt_digest:null},
 resource_policy_digest:hash,interval_seconds:60,expires_at:expiry});
const credential={session_id:randomUUID(),session_token:'s'.repeat(43)};
const claim=ResourceSyncClaimV3Schema.parse({schema_version:'deft.app_runtime_channel.v3',audience:'app_resource_sync',work_kind:'sync_page',
 org_id:scope.org_id,app_installation_id:scope.installation_id,app_version_id:scope.app_version_id,grant_snapshot_id:scope.grant_snapshot_id,
 lifecycle_epoch:scope.lifecycle_epoch,grant_epoch:scope.grant_epoch,runtime_registration_id:scope.runtime_registration_id,
 resource_binding_id:scope.resource_binding_id,runtime_epoch:scope.runtime_epoch,session_id:credential.session_id,session_epoch:1,
 run_id:randomUUID(),attempt_id:randomUUID(),attempt_number:1,claim_token:randomUUID(),sequence:1,lease_expires_at:expiry,descriptor_digest:hash});
test('ordinary OAuth generation stays opaque; reattachment receipt/generation pair is closed',()=>{
 assert.equal(snapshot.connection.expected_custody_generation,null);
 assert.equal(ResourceObservationConnectionSchema.safeParse({...snapshot.connection,expected_custody_generation:2}).success,false);
 assert.equal(ResourceObservationConnectionSchema.safeParse({...snapshot.connection,receipt_digest:hash}).success,false);
 assert.equal(ResourceObservationConnectionSchema.safeParse({...snapshot.connection,expected_custody_generation:2,receipt_digest:hash}).success,true);
 assert.equal(ResourceObservationSnapshotSchema.safeParse({...snapshot,expires_at:new Date(Date.parse(expiry)+1).toISOString()}).success,false);
 assert.equal(ResourceObservationSnapshotSchema.safeParse({...snapshot,connection:{...snapshot.connection,session_revision:1}}).success,false);
 assert.equal(ResourceSyncClaimV3Schema.safeParse({...claim,observation:snapshot}).success,false);
});
async function fixture(mutate:(reply:any)=>void=()=>{}){
 const calls:{url:string;init:RequestInit;body:any}[]=[];
 const fetcher:typeof fetch=async(url,init)=>{const body=JSON.parse(String(init?.body));calls.push({url:String(url),init:init!,body});
  const reply={...body,allowed:true,snapshot:structuredClone(snapshot),consent_digest:await digestResourceObservation(snapshot)};
  mutate(reply);return Response.json(reply);};
 return {calls,client:createResourceObservationClient({channel_url:'http://127.0.0.1:12345/api/app-resource-observations/runtime',credential,fetch:fetcher})};
}
test('SDK uses same credential and a separate bounded transcript with no redirects',async()=>{
 const {client,calls}=await fixture();assert.deepEqual((await client.authorize(claim)).snapshot,snapshot);
 assert.equal(calls[0]!.body.schema_version,'deft.app_resource_observation_authority.v1');assert.equal(calls[0]!.body.session_token,undefined);
 assert.equal((calls[0]!.init.headers as Record<string,string>).authorization,'AppRuntime '+credential.session_token);
 assert.equal(calls[0]!.init.redirect,'error');assert.equal(calls[0]!.init.credentials,'omit');assert.match(calls[0]!.url,/runtime\/authority$/u);
});
for(const field of ['run_id','attempt_id','claim_token','session_id','sequence'] as const)test('SDK denies reply drift '+field,async()=>{
 const {client}=await fixture(reply=>{reply[field]=field==='sequence'?2:randomUUID();});await assert.rejects(client.authorize(claim));
});
test('SDK denies altered scope, custody pair, digest and deadline',async()=>{
 for(const mutate of [(reply:any)=>{reply.snapshot.scope.owner_user_id=randomUUID();},(reply:any)=>{reply.snapshot.connection.expected_custody_generation=2;},
  (reply:any)=>{reply.consent_digest='sha256:'+'b'.repeat(64);},(reply:any)=>{reply.expires_at=new Date(Date.now()-1).toISOString();}]){
  const {client}=await fixture(mutate);await assert.rejects(client.authorize(claim));
 }
});

test('human review and bounded discovery explicitly exclude attachment transfer',()=>{
 const review={schema_version:'deft.app_resource_observation_review.v1',consent_id:snapshot.consent_id,review_digest:hash,scope,
  connection_session_id:snapshot.connection.session_id,account:{account_ref:snapshot.connection.account_ref,label:'Synthetic account'},
  expected_custody_generation:null,interval_seconds:60,expires_at:expiry,attachment_mode:'unsupported'};
 assert.equal(ResourceObservationReviewSchema.safeParse(review).success,true);
 assert.equal(ResourceObservationReviewSchema.safeParse({...review,attachment_mode:'supported'}).success,false);
 const target={target_key:scope.target_key,scope,connection_session_id:snapshot.connection.session_id,account:review.account,
  min_interval_seconds:60,attachment_mode:'unsupported',consent:null};
 const context={schema_version:'deft.app_resource_observation_context.v1',installation_id:scope.installation_id,org_id:scope.org_id,owner_user_id:scope.owner_user_id,targets:[target]};
 assert.equal(ResourceObservationContextSchema.safeParse(context).success,true);
 assert.equal(ResourceObservationContextSchema.safeParse({...context,targets:[{...target,runtime_session_ref:'secret'}]}).success,false);
 assert.equal(ResourceObservationContextSchema.safeParse({...context,targets:Array(33).fill(target)}).success,false);
});
