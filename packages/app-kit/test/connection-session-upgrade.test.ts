import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AppConnectionActionConsentsSchema,AppConnectionRuntimeV2RequestSchema} from '../src/connection-session-v2.js';
import {AppConnectionUpgradeSchema,AppConnectionUpgradeRuntimeRequestSchema} from '../src/connection-session-upgrade.js';
const consent=(key:string)=>{const id=randomUUID();return {action_binding_id:id,action_key:key,authority_epoch:1,consent_id:id,
 consent_digest:'sha256:'+'a'.repeat(64),expires_at:'2026-10-10T02:00:00Z'};};
test('independent actions are canonical and bounded; v2 never accepts singular v1 authority',()=>{
 const a=consent('organize_messages'),b=consent('send_message');assert.ok(AppConnectionActionConsentsSchema.safeParse([a,b]).success);
 for(const value of [[b,a],[a,a],[a,{...b,action_binding_id:a.action_binding_id}],[{...a,consent_id:randomUUID()}],Array.from({length:9},(_,i)=>consent('a'+i))])assert.equal(AppConnectionActionConsentsSchema.safeParse(value).success,false);
 assert.equal(AppConnectionRuntimeV2RequestSchema.safeParse({schema_version:'deft.app_connection_runtime.v2',action_consent:a}).success,false);
});
test('upgrade durable schema closes unknown fields and cannot mix a consumed receipt without review',()=>{
 const source={session_id:randomUUID(),session_revision:2,runtime_session_ref:'source_ref',account_ref:randomUUID(),scope:scope()};
 const review={account:{account_ref:source.account_ref,label:'fixture@example.test'},custody_generation:2,custody_digest:hash,digest:hash};
 const valid={schema_version:'deft.app_connection_upgrade.v1',source,transport_digest:hash,review_expires_at:'2026-10-10T01:05:00Z',begin_consumed:true,review,
  receipt:{custody_generation:3,receipt_digest:hash}};
 assert.ok(AppConnectionUpgradeSchema.safeParse(valid).success);
 const closure={reason:'callback_expired',custody_generation:3,receipt_digest:hash};
 assert.ok(AppConnectionUpgradeSchema.safeParse({...valid,receipt:null,closure}).success);
 for(const value of [{...valid,closure},{...valid,receipt:null,closure:{...closure,custody_generation:2}},
  {...valid,receipt:null,begin_consumed:false,closure}])assert.equal(AppConnectionUpgradeSchema.safeParse(value).success,false);
 for(const value of [{...valid,automatic_retry:true},{...valid,review:null},{...valid,begin_consumed:false},
  {...valid,receipt:{...valid.receipt,custody_generation:4}},{...valid,review:{...review,account:{...review.account,account_ref:randomUUID()}}},
  {...valid,source:{...source,callback_code:'forbidden'}}])assert.equal(AppConnectionUpgradeSchema.safeParse(value).success,false);
});
const hash='sha256:'+'a'.repeat(64);
function scope(){return {org_id:randomUUID(),owner_user_id:randomUUID(),installation_id:randomUUID(),app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),
 package_digest:hash,grant_snapshot_digest:hash,lifecycle_epoch:1,grant_epoch:1,target_key:'primary',resource_key:'inbox',resource_binding_id:randomUUID(),
 runtime_registration_id:randomUUID(),operator_user_id:randomUUID(),runtime_epoch:1,profile_digest:hash,consent_expires_at:'2026-10-10T02:00:00Z'};}
test('status can resolve expired review and actions under current consent, while Begin cannot',()=>{
 const current=scope(),source={session_id:randomUUID(),session_revision:2,scope:current,runtime_session_ref:'source_ref',account_ref:randomUUID()},
  review={account:{account_ref:source.account_ref,label:'fixture@example.test'},custody_generation:2,custody_digest:hash,digest:hash};
 const status={schema_version:'deft.app_connection_upgrade_runtime.v1',operation:'status',session_id:randomUUID(),scope:current,source,
  transport_digest:hash,review_expires_at:'2026-10-10T01:05:00Z',expires_at:'2026-10-10T01:10:00Z',
  action_consents:[{...consent('send_message'),expires_at:'2026-10-10T01:05:00Z'}],review,runtime_session_ref:'upgrade_ref'};
 assert.ok(AppConnectionUpgradeRuntimeRequestSchema.safeParse(status).success);
 assert.ok(AppConnectionUpgradeRuntimeRequestSchema.safeParse({...status,close_expired:true}).success);
 assert.equal(AppConnectionUpgradeRuntimeRequestSchema.safeParse({...status,close_expired:false}).success,false);
 const {runtime_session_ref:_,...begin}=status;
 assert.equal(AppConnectionUpgradeRuntimeRequestSchema.safeParse({...begin,operation:'begin',callback_state:'a'.repeat(43)}).success,false);
 assert.equal(AppConnectionUpgradeRuntimeRequestSchema.safeParse({...status,review_expires_at:'2026-10-10T03:00:00Z'}).success,false);
 assert.equal(AppConnectionUpgradeRuntimeRequestSchema.safeParse({...status,expires_at:'2026-10-10T03:00:00Z'}).success,false);
});
