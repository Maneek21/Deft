import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appConsentDeadline, appConsentExpiryValid, appConsentIsCurrent, appConsentWithin } from '../src/consent-lifetime.js';

test('finite historical lifetimes retain exact bounds; explicit until-revoked has no wall-clock deadline', () => {
  const finite='2026-10-15T12:00:00.000Z';
  assert.equal(appConsentDeadline(finite), Date.parse(finite));
  assert.equal(appConsentDeadline('2026-10-15T17:30:00+05:30'),Date.parse(finite));
  assert.equal(appConsentIsCurrent(finite, undefined, Date.parse(finite)), false);
  assert.equal(appConsentIsCurrent(null, 'until_revoked', Date.parse('2099-01-01T00:00:00.000Z')), true);
  assert.equal(appConsentWithin(finite, null, undefined, 'until_revoked'), true);
  assert.equal(appConsentWithin(null, finite, 'until_revoked'), false);
});
test('null/missing/unknown/mixed lifetime cannot become permission', () => {
  for (const [expiry,mode] of [[null,undefined],[undefined,undefined],['not-a-date',undefined],
    [null,'forever'],['2026-10-15T12:00:00.000Z','until_revoked']]) {
    assert.equal(appConsentExpiryValid(expiry as never,mode as never), false);
    assert.throws(() => appConsentDeadline(expiry as never,mode as never));
  }
});

import {AppConnectionSessionScopeSchema,AppConnectionActionConsentSchema,AppConnectionSessionBegunSchema} from '../src/connection-session.js';
import {ResourceObservationSnapshotSchema,ResourceObservationReviewRequestSchema} from '../src/resource-observation.js';
import {AppDataConsentSnapshotSchema,AppDataConsentReviewRequestSchema} from '../src/app-data.js';
import {validAppRuntimeRenewal} from '../src/runtime-client.js';
const id='11111111-1111-4111-8111-111111111111',digest='sha256:'+'a'.repeat(64);
const expiry='2026-10-15T12:00:00.000Z';
const finiteScope={org_id:id,owner_user_id:id,installation_id:id,app_version_id:id,grant_snapshot_id:id,package_digest:digest,
 grant_snapshot_digest:digest,lifecycle_epoch:1,grant_epoch:1,target_key:'personal',resource_key:'messages',resource_binding_id:id,
 runtime_registration_id:id,operator_user_id:id,runtime_epoch:1,profile_digest:digest,consent_expires_at:expiry};
const persistentScope={...finiteScope,consent_expires_at:null,consent_lifetime:'until_revoked' as const};
test('public scope/action contracts preserve finite JSON and deny implicit or mixed persistent lifetime',()=>{
 assert.equal(JSON.stringify(AppConnectionSessionScopeSchema.parse(finiteScope)),JSON.stringify(finiteScope));
 assert.deepEqual(AppConnectionSessionScopeSchema.parse(persistentScope),persistentScope);
 for(const value of [{...finiteScope,consent_expires_at:null},{...finiteScope,consent_lifetime:'until_revoked'},
  {...persistentScope,consent_expires_at:undefined},{...persistentScope,consent_lifetime:'forever'}])assert.equal(AppConnectionSessionScopeSchema.safeParse(value).success,false);
 const action={action_binding_id:id,action_key:'send_message',authority_epoch:1,consent_id:id,consent_digest:digest,expires_at:null};
 assert.equal(AppConnectionActionConsentSchema.safeParse(action).success,false);
 assert.equal(AppConnectionActionConsentSchema.safeParse({...action,consent_lifetime:'until_revoked'}).success,true);
});
test('persistent account permission does not make OAuth begin or review deadlines infinite',()=>{
 const begun={schema_version:'deft.app_connection_session.v1',session_id:id,state:'awaiting_callback',scope:persistentScope,
  expires_at:expiry,account:null,callback_state:'s'.repeat(43),authorization_url:'https://example.test/authorize'};
 assert.equal(AppConnectionSessionBegunSchema.safeParse(begun).success,true);
 assert.equal(AppConnectionSessionBegunSchema.safeParse({...begun,expires_at:null}).success,false);
 const snapshot={schema_version:'deft.app_resource_observation_consent.v1',consent_id:id,scope:persistentScope,
  connection:{session_id:id,runtime_session_ref:'opaque',account_ref:'opaque',expected_custody_generation:null,receipt_digest:null},
  resource_policy_digest:digest,interval_seconds:60,expires_at:null,consent_lifetime:'until_revoked',review_expires_at:expiry};
 assert.equal(ResourceObservationSnapshotSchema.safeParse(snapshot).success,true);
 assert.equal(ResourceObservationSnapshotSchema.safeParse({...snapshot,review_expires_at:undefined}).success,false);
 assert.equal(ResourceObservationSnapshotSchema.safeParse({...snapshot,expires_at:expiry}).success,false);
 assert.equal(ResourceObservationReviewRequestSchema.safeParse({connection_session_id:id,request_id:id,interval_seconds:60,
  expires_at:null,consent_lifetime:'until_revoked'}).success,true);
 const data={schema_version:'deft.app_data_consent.v1',consent_id:id,scope:persistentScope,
  connection:{session_id:id,session_revision:1,runtime_session_ref:'opaque',account_ref:'opaque'},
  store:{schema_version:'deft.app_record_store.v1',key:'drafts',resource_key:'messages',runtime_requirement_key:'mail',max_record_bytes:1024,
   max_files:1,max_file_bytes:1024,max_total_file_bytes:1024},data_policy_digest:digest,purpose:'human_record_write',
  expires_at:null,consent_lifetime:'until_revoked',review_expires_at:expiry};
 assert.equal(AppDataConsentSnapshotSchema.safeParse(data).success,true);
 assert.equal(AppDataConsentSnapshotSchema.safeParse({...data,review_expires_at:undefined}).success,false);
 assert.equal(AppDataConsentReviewRequestSchema.safeParse({store_key:'drafts',expires_at:null}).success,false);
});
test('renewal reply keeps a short finite lease and requires exact explicit persistent mode',()=>{
 const current=new Date(Date.now()+60000).toISOString(),next=new Date(Date.now()+120000).toISOString();
 const value={session_id:id,expires_at:next,renewable_until:null,renewal_lifetime:'until_revoked'};
 assert.equal(validAppRuntimeRenewal(value,current,id),true);
 assert.equal(validAppRuntimeRenewal({...value,renewal_lifetime:undefined},current,id),false);
 assert.equal(validAppRuntimeRenewal({...value,expires_at:null},current,id),false);
 assert.equal(validAppRuntimeRenewal({...value,renewable_until:next},current,id),false);
 assert.equal(validAppRuntimeRenewal({...value,session_id:'foreign'},current,id),false);
});
