import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EmailAccountRegistry} from './account-registry.mjs';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/launch-stage0/fixtures.json',import.meta.url))),scope={...fixture.scope,installation_id:'stage1-installation'};
const account=(id='gmail-personal')=>{const row=fixture.accounts.find(row=>row.id===id);return {account_id:id,provider:row.provider_hint==='imap'?'imap_smtp':row.provider_hint,display_label:row.display_name,primary_address:row.address,verified_sender_identities:[row.address],capabilities:['read','search','thread','send'],connection_target:`target-${id}`,resource_binding_id:`read-${id}`,action_binding_id:`send-${id}`,authority_epoch:1,health:'connected'};};

test('two Gmail accounts route by exact scoped account target and revoke independently',async()=>{
 const calls=[],registry=new EmailAccountRegistry({scope,authorize:async request=>{calls.push(request);return true;}});registry.register(scope,account());registry.register(scope,account('gmail-work'));
 assert.equal((await registry.resolve(scope,'gmail-personal','send')).action_binding_id,'send-gmail-personal');assert.equal((await registry.resolve(scope,'gmail-work','read')).connection_target,'target-gmail-work');assert.equal(registry.list(scope).length,2);
 assert.equal(Object.hasOwn(registry.list(scope)[0],'connection_target'),false);registry.revoke(scope,'gmail-personal');await assert.rejects(registry.resolve(scope,'gmail-personal','read'),/EMAIL_ACCOUNT_REVOKED/);assert.equal((await registry.resolve(scope,'gmail-work','read')).authority_epoch,1);
 assert.equal(calls.length,3);await assert.rejects(registry.resolve({...scope,owner_id:'another-owner'},'gmail-work','read'),/EMAIL_ACCOUNT_SCOPE_DENIED/);assert.throws(()=>registry.exportState({...scope,org_id:'another-org'}),/EMAIL_ACCOUNT_SCOPE_DENIED/);
});
test('current host denial and revocation during async authorization stop resolution',async()=>{
 let registry;registry=new EmailAccountRegistry({scope,authorize:async()=>{registry.revoke(scope,'gmail-personal');return true;}});registry.register(scope,account());await assert.rejects(registry.resolve(scope,'gmail-personal','send'),/EMAIL_ACCOUNT_AUTHORITY_DENIED/);
 const denied=new EmailAccountRegistry({scope,authorize:async()=>false});denied.register(scope,account());await assert.rejects(denied.resolve(scope,'gmail-personal','read'),/EMAIL_ACCOUNT_AUTHORITY_DENIED/);
});
test('private state restoration still needs current authority; descriptors reject secret fields and stale epochs',async()=>{
 const registry=new EmailAccountRegistry({scope,authorize:async()=>true});registry.register(scope,account());assert.throws(()=>registry.register(scope,{...account(),access_token:'secret'}),/EMAIL_ACCOUNT_INVALID/);assert.throws(()=>registry.register(scope,account()),/EMAIL_ACCOUNT_REPLACEMENT_INVALID/);
 const restored=new EmailAccountRegistry({scope,state:registry.exportState(scope),authorize:async()=>false});assert.equal(restored.list(scope).length,1);await assert.rejects(restored.resolve(scope,'gmail-personal','read'),/EMAIL_ACCOUNT_AUTHORITY_DENIED/);
 assert.throws(()=>new EmailAccountRegistry({scope,state:{...registry.exportState(scope),scope:{...scope,installation_id:'different'}},authorize:async()=>true}),/EMAIL_ACCOUNT_STATE_INVALID/);
});
test('connection rotation while authorization is pending cannot release the stale account descriptor',async()=>{
 let registry;registry=new EmailAccountRegistry({scope,authorize:async()=>{registry.register(scope,{...account(),authority_epoch:2,resource_binding_id:'rotated-binding'});return true;}});registry.register(scope,account());await assert.rejects(registry.resolve(scope,'gmail-personal','read'),/EMAIL_ACCOUNT_AUTHORITY_DENIED/);assert.equal(registry.exportState(scope).accounts[0].resource_binding_id,'rotated-binding');
});
