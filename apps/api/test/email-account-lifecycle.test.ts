import test from 'node:test';
import assert from 'node:assert/strict';
import {planEmailAccountAdoption,planEmailAccountReconnect,planEmailAccountConsent,planEmailAccountStop,requireEmailAccountConsent,EmailAccountConsentSchema,type EmailAccountConnectionProof} from '../src/lib/email-account-lifecycle.js';
const uuid=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),now=Date.parse('2026-10-04T10:00:00Z');
function proof():EmailAccountConnectionProof{return {scope:{org_id:uuid(1),owner_user_id:uuid(2),account_id:'native-owner-mailbox'},provider:'gmail',principal_digest:'a'.repeat(64),native_revision:7,consent_revision:0,credential_revision:3,health:'connected',available_capabilities:['read','modify','send'],bridge:{kind:'retained_registry_v1',module_sha256:'d'.repeat(64),pins:{org_id:uuid(1),owner_user_id:uuid(2),installation_id:uuid(3),app_version_id:uuid(4),grant_snapshot_id:uuid(5),target_key:'email',resource_key:'inbox',resource_binding_id:uuid(6),action_key:'send',action_binding_id:uuid(7)}}};}
test('explicit adoption retains immutable provider namespace and increments the exact expected native revision',()=>{
 const p=proof(),plan=planEmailAccountAdoption(p,['send','read'],now);assert.equal(plan.expected_revision,0);assert.equal(plan.expected_native_revision,7);assert.equal(plan.next.revision,1);assert.equal(plan.next.native_revision,8);assert.equal(plan.next.credential_revision,3);assert.equal(plan.next.state,'active');assert.deepEqual(plan.next.capabilities,['read','send']);assert.deepEqual(plan.next.bridge,p.bridge);assert.deepEqual(plan.next.scope,p.scope);assert.equal(plan.effect_policy,'preserve_started_unknown');
 assert.equal('expires_at' in plan.next,false);assert.equal('legacy_grant_expires_at' in plan.next,false);
 retainedBridge(p.bridge).pins.installation_id=uuid(99);assert.equal(retainedBridge(plan.next.bridge).pins.installation_id,uuid(3),'plan must not retain caller mutable bridge');
});
test('ordinary reader/sync/local drafts require read only, while provider modify/send are distinct explicit consent',()=>{
 const plan=planEmailAccountAdoption(proof(),['read'],now),c=plan.next;for(const operation of ['human_read','human_sync','human_draft'] as const)assert.equal(requireEmailAccountConsent(c,c.scope,operation),'read');
 for(const operation of ['human_modify','human_send'] as const)assert.throws(()=>requireEmailAccountConsent(c,c.scope,operation),/ACCESS_DENIED/);
 assert.throws(()=>requireEmailAccountConsent(c,{...c.scope,account_id:'other'},'human_read'),/ACCESS_DENIED/);assert.throws(()=>requireEmailAccountConsent(c,c.scope,'agent_read' as never),/ACCESS_DENIED/);
 const p={...proof(),available_capabilities:['read'] as ('read'|'modify'|'send')[]};assert.throws(()=>planEmailAccountAdoption(p,['read','send'],now),/LIFECYCLE_CONFLICT/);
});
test('same-principal reconnect preserves scope/bridge/consent and fences credential rollback or changed owner/provider',()=>{
 const first=planEmailAccountAdoption(proof(),['read','send'],now).next,p={...proof(),native_revision:first.native_revision,consent_revision:first.revision,credential_revision:4};
 const second=planEmailAccountReconnect(first,p,now+1);assert.equal(second.next.revision,2);assert.equal(second.next.native_revision,9);assert.equal(second.next.credential_revision,4);assert.deepEqual(second.next.capabilities,first.capabilities);assert.deepEqual(second.next.bridge,first.bridge);assert.equal(second.next.consented_at,first.consented_at);
 for(const changed of [{principal_digest:'b'.repeat(64)},{provider:'microsoft'},{scope:{...p.scope,owner_user_id:uuid(8)}},{native_revision:7},{credential_revision:2},{bridge:{...p.bridge,pins:{...retainedBridge(p.bridge).pins,installation_id:uuid(8)}}}])assert.throws(()=>planEmailAccountReconnect(first,{...p,...changed} as EmailAccountConnectionProof,now+2));
});
test('disconnect/revoke deny consent immediately, preserve unknown effects, and healthy custody cannot restore revoked consent',()=>{
 const c=planEmailAccountAdoption(proof(),['read'],now).next,p={scope:c.scope,provider:c.provider,principal_digest:c.principal_digest,native_revision:c.native_revision,consent_revision:c.revision,credential_revision:c.credential_revision};
 for(const reason of ['pause','disconnect','revoke'] as const){const stopped=planEmailAccountStop(c,p,reason,now+1);assert.equal(stopped.effect_policy,'preserve_started_unknown');assert.throws(()=>requireEmailAccountConsent(stopped.next,c.scope,'human_read'),/ACCESS_DENIED/);assert.deepEqual(stopped.next.bridge,c.bridge);assert.equal(stopped.next.credential_revision,c.credential_revision);
  const reconnect={...proof(),native_revision:stopped.next.native_revision,consent_revision:stopped.next.revision};if(reason==='revoke')assert.throws(()=>planEmailAccountReconnect(stopped.next,reconnect,now+2),/LIFECYCLE_CONFLICT/);else assert.equal(planEmailAccountReconnect(stopped.next,reconnect,now+2).next.state,'active');
 }
});
test('consent expansion is explicit and bounded by actual granted capabilities; stale revisions and invalid state fail closed',()=>{
 const c=planEmailAccountAdoption(proof(),['read'],now).next,p={...proof(),native_revision:c.native_revision,consent_revision:c.revision};
 const changed=planEmailAccountConsent(c,p,['read','modify'],now+10);assert.deepEqual(changed.next.capabilities,['modify','read']);assert.equal(changed.next.revision,2);assert.equal(changed.next.native_revision,9);assert.equal(changed.next.consented_at,new Date(now+10).toISOString());
 assert.throws(()=>planEmailAccountConsent(c,{...p,available_capabilities:['read']},['read','send'],now+10),/LIFECYCLE_CONFLICT/);assert.throws(()=>planEmailAccountConsent(c,{...p,native_revision:7},['read'],now+10),/LIFECYCLE_CONFLICT/);assert.throws(()=>planEmailAccountConsent(c,p,['read'],now-1),/LIFECYCLE_CONFLICT/);
 assert.equal(EmailAccountConsentSchema.safeParse({...c,state:'revoked',revoked_at:null}).success,false);assert.equal(EmailAccountConsentSchema.safeParse({...c,capabilities:['read','read']}).success,false);assert.equal(EmailAccountConsentSchema.safeParse({...c,bridge:{...c.bridge,pins:{...retainedBridge(c.bridge).pins,org_id:uuid(8)}}}).success,false);
});


function retainedBridge(bridge: import('../src/lib/email-account-lifecycle.js').EmailAccountBridge){if(bridge.kind!=='retained_registry_v1')throw Error('fixture requires retained bridge');return bridge;}
