import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {AppConnectionUpgradeContextSchema} from '../src/connection-session-upgrade-context.js';
const digest='sha256:'+'a'.repeat(64);
function context(){
 const installation_id=randomUUID(),org_id=randomUUID(),owner_user_id=randomUUID(),session_id=randomUUID();
 const scope={org_id,owner_user_id,installation_id,app_version_id:randomUUID(),grant_snapshot_id:randomUUID(),package_digest:digest,
  grant_snapshot_digest:digest,lifecycle_epoch:1,grant_epoch:1,target_key:'primary',resource_key:'inbox',resource_binding_id:randomUUID(),
  runtime_registration_id:randomUUID(),operator_user_id:randomUUID(),runtime_epoch:1,profile_digest:digest,consent_expires_at:'2030-01-01T00:00:00Z'};
 const target={target_key:'primary',scope,profile:{key:'independent',label:'Mailbox',authorization_origin:'https://provider.example'},runtime_ready:false,
  session:{schema_version:'deft.app_connection_session.v1',session_id,scope,state:'indeterminate',account:null,expires_at:scope.consent_expires_at},
  upgrade:{candidate:null,pending:{session_id,state:'indeterminate',begin_consumed:true,callback_consumed:false,review:null}}};
 return {schema_version:'deft.app_connection_upgrade_context.v1',installation_id,org_id,owner_user_id,targets:[target]};
}
test('closed upgrade context pairs only exact current owner/scope/session and bounded nominations',()=>{
 const valid=context();assert.ok(AppConnectionUpgradeContextSchema.safeParse(valid).success);
 const target=valid.targets[0]!;
 const changes=[{...valid,owner_user_id:randomUUID()},{...valid,targets:[target,target]},
  {...valid,targets:[{...target,runtime_session_ref:'secret'}]},
  {...valid,targets:[{...target,scope:{...target.scope,target_key:'foreign'}}]},
  {...valid,targets:[{...target,session:{...target.session,scope:{...target.scope,app_version_id:randomUUID()}}}]},
  {...valid,targets:[{...target,upgrade:{...target.upgrade,pending:{...target.upgrade.pending,session_id:randomUUID()}}}]},
  {...valid,targets:[{...target,upgrade:{...target.upgrade,pending:{...target.upgrade.pending,begin_consumed:false,callback_consumed:true}}}]},
  {...valid,targets:[{...target,upgrade:{...target.upgrade,candidate:{source_session_id:randomUUID(),source_revision:2,account:{account_ref:randomUUID(),label:'Mailbox'}}}}]}];
 for(const row of changes)assert.equal(AppConnectionUpgradeContextSchema.safeParse(row).success,false);
});
