import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {currentConnectionUpgradeNomination} from '../src/lib/app-connection-upgrade-context.js';
import type {AppConnectionSessionRecord} from '../src/lib/app-connection-session-service.js';
const digest='sha256:'+'a'.repeat(64);
function fixture(){
 const operator=randomUUID(),profile={schema_version:'deft.app_connection_profile.v1' as const,key:'independent',provider_id:'fixture',
  operator_user_id:operator,runtime_requirement_key:'mail',resource_key:'inbox',action_keys:['organize_messages','send_message'],
  authorization_origin:'https://provider.example',credential_custody:'runtime' as const,executable:false as const};
 const scope={org_id:randomUUID(),owner_user_id:randomUUID(),installation_id:randomUUID(),app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),
  package_digest:digest,grant_snapshot_digest:digest,lifecycle_epoch:2,grant_epoch:2,target_key:'primary',resource_key:'inbox',
  resource_binding_id:randomUUID(),runtime_registration_id:randomUUID(),operator_user_id:operator,runtime_epoch:1,profile_digest:digest,
  consent_expires_at:'2030-01-01T00:00:00Z'};
 const source:AppConnectionSessionRecord={session_id:randomUUID(),revision:2,scope:{...scope,app_version_id:randomUUID(),grant_snapshot_id:randomUUID()},
  profile:{...profile,key:'read'},state:'connected',callback_state_hash:'a'.repeat(64),callback_consumed:true,callback_expires_at:'2020-01-01T00:00:00Z',
  account:{account_ref:randomUUID(),label:'fixture@example.test'},runtime_session_ref:'private_runtime_reference',created_at:'2020-01-01T00:00:00Z',updated_at:'2020-01-01T00:00:00Z'};
 const current={scope,profile,expires_at:Date.parse(scope.consent_expires_at)};
 const pending:AppConnectionSessionRecord={...source,session_id:randomUUID(),revision:0,scope,profile,state:'upgrade_reviewed',account:null,callback_consumed:false,
  action_consents:[],upgrade:{schema_version:'deft.app_connection_upgrade.v1',source:{session_id:source.session_id,session_revision:source.revision,
   scope:source.scope,runtime_session_ref:source.runtime_session_ref!,account_ref:source.account!.account_ref},transport_digest:digest,
   review_expires_at:'2030-01-01T00:00:00Z',begin_consumed:false,review:{account:source.account!,custody_generation:1,custody_digest:digest,digest},receipt:null}};
 return {source,current,pending};
}
test('upgrade nomination exposes compatible owned account metadata without historical authority or secrets',()=>{
 const {source,current}=fixture(),view=currentConnectionUpgradeNomination(null,source,current);
 assert.deepEqual(view.candidate,{source_session_id:source.session_id,source_revision:2,account:source.account});
 assert.equal(view.pending,null);assert.equal(JSON.stringify(view).includes('private_runtime_reference'),false);
 for(const patch of [{org_id:randomUUID()},{owner_user_id:randomUUID()},{installation_id:randomUUID()},{target_key:'foreign'},
  {operator_user_id:randomUUID()},{resource_key:'other'}])
  assert.equal(currentConnectionUpgradeNomination(null,{...source,scope:{...source.scope,...patch}},current).candidate,null);
 for(const patch of [{provider_id:'other'},{credential_custody:'other'},{runtime_requirement_key:'other'}])
  assert.equal(currentConnectionUpgradeNomination(null,{...source,profile:{...source.profile,...patch} as typeof source.profile},current).candidate,null);
});
test('lost Begin remains status-only and completed upgrade ordinary management never becomes a pending upgrade',()=>{
 const {source,current,pending}=fixture();
 const reviewed=currentConnectionUpgradeNomination(pending,source,current);
 assert.equal(reviewed.candidate,null);assert.ok(reviewed.pending!.review);
 for(const state of ['upgrade_starting','awaiting_callback','connecting','upgrade_checking','indeterminate'] as const){
  const begun={...pending,state,upgrade:{...pending.upgrade!,begin_consumed:true}};
  const view=currentConnectionUpgradeNomination(begun,source,current);
  assert.equal(view.candidate,null);assert.equal(view.pending!.begin_consumed,true);assert.equal(view.pending!.review,null);
 }
 for(const state of ['checking','disconnecting','indeterminate'] as const){
  const completed={...pending,state,account:source.account,callback_consumed:true,
   upgrade:{...pending.upgrade!,begin_consumed:true,receipt:{custody_generation:2,receipt_digest:digest}}};
  const view=currentConnectionUpgradeNomination(completed,source,current);
  assert.equal(view.pending,null);assert.equal(view.candidate,null);
 }
});
test('only expired unconsumed empty OAuth startup can nominate a fresh upgrade review',()=>{
 const {source,current,pending}=fixture();
 for(const state of ['starting','awaiting_callback'] as const){
  const startup={...pending,state,upgrade:undefined,callback_expires_at:'2020-01-01T00:00:00Z'};
  assert.ok(currentConnectionUpgradeNomination(startup,source,current).candidate);
  for(const patch of [{callback_consumed:true},{account:source.account},{callback_expires_at:'2030-01-01T00:00:00Z'}])
   assert.equal(currentConnectionUpgradeNomination({...startup,...patch},source,current).candidate,null);
 }
 assert.equal(currentConnectionUpgradeNomination({...pending,state:'indeterminate'},source,current).candidate,null);
});
