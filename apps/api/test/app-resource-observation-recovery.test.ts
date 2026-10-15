import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import type {LiveAttachmentSyncBindingAuthority} from '../src/lib/app-attachment-sync-authority.js';
process.env.DATABASE_URL='postgresql://fixture@127.0.0.1:1/observation_recovery_no_database';
process.env.ENCRYPTION_KEY='synthetic-observation-recovery-key';
const {assertObservationRecoveryIdentity}=await import('../src/lib/app-resource-observation-recovery.js');
const {buildAttachmentSyncAuthorizationSnapshot}=await import('../src/lib/app-attachment-sync-run.js');
const {observedResourceAuthorization}=await import('../src/lib/app-resource-observation-authority.js');
const {digestAppGrantValue}=await import('../src/lib/app-grant-service.js');
const {ResourceObservationSnapshotSchema}=await import('../../../packages/app-kit/src/resource-observation.js');

function fixture(){
 const owner=randomUUID(),id=randomUUID(),org=randomUUID(),digest='sha256:'+'a'.repeat(64);
 const authority={binding:{id,org_id:org,owner_user_id:owner,reviewed_by_user_id:owner,
  reviewed_at:new Date('2030-01-01T10:00:00Z'),consent_expires_at:new Date('2030-01-01T12:00:00Z'),
  attachment_consent_digest:digest,risk_class:'read_only',review_requirement:'none',review_scope:'reviewed_resource_sync',
  retry_class:'never',retention_class:'standard',max_records_per_page:25,max_page_bytes:524288,
  max_retained_records:100,max_retained_bytes:1048576,min_interval_seconds:300},
  installation:{id:randomUUID(),lifecycle_epoch:1,grant_epoch:1},version:{id:randomUUID(),package_digest:digest},
  grant:{id:randomUUID(),snapshot_digest:digest},registration:{id:randomUUID(),operator_user_id:owner,runtime_epoch:1},
  descriptor_digest:digest,provider_snapshot:{id:randomUUID(),snapshot_digest:digest}} as unknown as LiveAttachmentSyncBindingAuthority;
 const base=buildAttachmentSyncAuthorizationSnapshot(authority),sid=randomUUID(),consent=randomUUID();
 const snapshot={schema_version:'deft.app_resource_observation_consent.v1' as const,consent_id:consent,
  scope:{org_id:org,owner_user_id:owner,installation_id:authority.installation.id,app_version_id:authority.version.id,
   grant_snapshot_id:authority.grant.id,package_digest:digest,grant_snapshot_digest:digest,lifecycle_epoch:1,grant_epoch:1,
   target_key:'mailbox',resource_key:'inbox',resource_binding_id:id,runtime_registration_id:authority.registration.id,
   operator_user_id:owner,runtime_epoch:1,profile_digest:digest,consent_expires_at:'2030-01-01T12:00:00.000Z'},
  connection:{session_id:sid,runtime_session_ref:'historical-synthetic-custody',account_ref:'synthetic-account',
   expected_custody_generation:1,receipt_digest:digest},
  resource_policy_digest:digestAppGrantValue(base.authority_refs.filter(ref=>ref.authority_kind==='policy')),
  interval_seconds:300,expires_at:'2030-01-01T11:00:00.000Z'};
 const previous={org_id:org,owner_user_id:owner,consent_id:consent,resource_binding_id:id,connection_session_id:sid,
  state:'revoked',consent_digest:digestAppGrantValue(snapshot),snapshot,expires_at:new Date(snapshot.expires_at),
  created_at:new Date('2030-01-01T10:00:00Z'),updated_at:new Date('2030-01-01T11:00:00Z')};
 const currentSnapshot=structuredClone(snapshot);currentSnapshot.consent_id=randomUUID();
 currentSnapshot.scope.consent_expires_at='2030-01-01T14:00:00.000Z';currentSnapshot.expires_at='2030-01-01T13:30:00.000Z';
 currentSnapshot.connection={...currentSnapshot.connection,session_id:randomUUID(),runtime_session_ref:'renewed-synthetic-custody',expected_custody_generation:2};
 const current={row:{...previous,consent_id:currentSnapshot.consent_id,state:'active',snapshot:currentSnapshot,
  consent_digest:digestAppGrantValue(currentSnapshot)},snapshot:currentSnapshot};
 const authorization=observedResourceAuthorization(base,previous);
 authority.binding.consent_expires_at=new Date(currentSnapshot.scope.consent_expires_at);
 authority.binding.reviewed_at=new Date('2030-01-01T12:00:00Z');
 return {authority,previous,current,authorization};
}

test('new validated consent can authorize a new read while immutable historical consent grants no effects',()=>{
 const f=fixture(),before=structuredClone(f.previous);
 assert.doesNotThrow(()=>assertObservationRecoveryIdentity(f.previous,f.current,f.authorization,f.authority));
 assert.deepEqual(f.previous,before);
});

test('finite historical consent permits only explicitly validated persistent renewal of the same account and scope',()=>{
 const f=fixture();
 const snapshot=ResourceObservationSnapshotSchema.parse({...f.current.snapshot,consent_lifetime:'until_revoked',expires_at:null,review_expires_at:'2030-01-01T12:05:00.000Z',
  scope:{...f.current.snapshot.scope,consent_lifetime:'until_revoked',consent_expires_at:null}});
 const current={snapshot,row:{...f.current.row,snapshot,expires_at:null,consent_digest:digestAppGrantValue(snapshot)}};
 f.authority.binding.consent_expires_at=null;f.authority.binding.consent_lifetime='until_revoked';
 assert.doesNotThrow(()=>assertObservationRecoveryIdentity(f.previous,current,f.authorization,f.authority));
 assert.throws(()=>ResourceObservationSnapshotSchema.parse({...snapshot,consent_lifetime:undefined}),'null without explicit lifetime is not a consent');
 assert.throws(()=>assertObservationRecoveryIdentity(f.previous,{...current,snapshot:{...snapshot,
  scope:{...snapshot.scope,grant_snapshot_id:randomUUID()}}},f.authorization,f.authority),'renewal cannot carry a foreign grant');
});

test('recovery rejects foreign historical scope/account and forged policy or authority pins',()=>{
 for(const field of ['org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','resource_binding_id',
  'runtime_registration_id','operator_user_id','profile_digest','target_key','resource_key'] as const){
  const f=fixture();f.previous.snapshot.scope[field]=field==='profile_digest'?'sha256:'+'b'.repeat(64):randomUUID();
  f.previous.consent_digest=digestAppGrantValue(f.previous.snapshot);
  assert.throws(()=>assertObservationRecoveryIdentity(f.previous,f.current,f.authorization,f.authority),field);
 }
 for(const mutate of [
  (f:ReturnType<typeof fixture>)=>{f.previous.snapshot.connection.account_ref='foreign-account';f.previous.consent_digest=digestAppGrantValue(f.previous.snapshot);},
  (f:ReturnType<typeof fixture>)=>{f.previous.consent_digest='sha256:'+'f'.repeat(64);},
  (f:ReturnType<typeof fixture>)=>{f.previous.state='proposed';},
  (f:ReturnType<typeof fixture>)=>{f.authorization.authority_refs[0]!.authority_id=randomUUID();},
  (f:ReturnType<typeof fixture>)=>{f.authorization.authority_refs.find(ref=>ref.authority_kind==='policy')!.version='sha256:'+'b'.repeat(64);},
  (f:ReturnType<typeof fixture>)=>{f.authorization.authority_refs.push({...f.authorization.authority_refs[0]!});},
 ]){const f=fixture();mutate(f);assert.throws(()=>assertObservationRecoveryIdentity(f.previous,f.current,f.authorization,f.authority));}
});
