import assert from 'node:assert/strict';
import test from 'node:test';
import {createEmailStandaloneConnectionResolver,type EmailStandaloneRegistryEntry} from '../src/lib/email-account-connection.js';
import {planEmailAccountAdoption,type EmailAccountConnectionProof} from '../src/lib/email-account-lifecycle.js';
const uuid=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),clock=Date.now();
function fixture(){const scope={org_id:uuid(1),owner_user_id:uuid(2),account_id:'stable-mail-account'},pins={org_id:scope.org_id,owner_user_id:scope.owner_user_id,installation_id:uuid(3),app_version_id:uuid(4),grant_snapshot_id:uuid(5),target_key:'mail',resource_key:'inbox',resource_binding_id:uuid(6),action_key:'send',action_binding_id:uuid(7)};
 const proof:EmailAccountConnectionProof={scope,provider:'gmail',principal_digest:'a'.repeat(64),native_revision:7,consent_revision:0,credential_revision:3,health:'connected',available_capabilities:['read','modify','send'],bridge:{kind:'retained_registry_v1',module_sha256:'d'.repeat(64),pins}},consent=planEmailAccountAdoption(proof,['read'],clock).next;
 let version='native-sql-v1',selected=0,accountCalls=0,release:Promise<void>|null=null;const cap={scope,resource_binding_id:pins.resource_binding_id,authority_version:version,expires_at:clock+60000},account={account_id:scope.account_id,provider:'gmail' as const,resource_binding_id:pins.resource_binding_id,authority_epoch:9,connection_revision:3,principal_digest:proof.principal_digest,health:'connected',capabilities:['read','search','thread','modify','send'],primary_address:'owner@example.test',display_label:'Owned'};
 const entry:EmailStandaloneRegistryEntry={pins:{...pins,app_version_id:uuid(90),grant_snapshot_id:uuid(91)},module_sha256:'d'.repeat(64),adapter:{nativeEmailAccount:async context=>{accountCalls++;await context.recheck();if(release)await release;return account;},nativeEmailPage:async()=>{throw Error('NOT_CALLED');}}};
 const resolve=createEmailStandaloneConnectionResolver({currentSql:async()=>({...cap,authority_version:version}),readConsent:async()=>consent,select:async input=>{selected++;assert.deepEqual(input,{org_id:scope.org_id,owner_user_id:scope.owner_user_id,installation_id:pins.installation_id,target_key:pins.target_key});return entry;},now:()=>clock});
 return {scope,cap,consent,entry,account,resolve,setVersion:(value:string)=>version=value,hold:(value:Promise<void>)=>release=value,calls:()=>({selected,accountCalls})};
}
test('standalone read resolver survives changed App version/grant while preserving immutable namespace/module and consent intersection',async()=>{
 const f=fixture(),resolved=await f.resolve(f.scope,{...f.cap,authority_version:'decorated-current-custody'},async()=>{},undefined,'status'),account=await resolved.adapter.nativeEmailAccount!(resolved.context);
 assert.deepEqual(account.capabilities,['read','search','thread']);assert.equal(resolved.context.installation_id,uuid(3));assert.equal(resolved.context.resource_binding_id,uuid(6));assert.equal('projection' in resolved.context,false);assert.equal('triage_journal' in resolved.context,false);assert.equal('nativeEmailSend' in resolved.adapter,false);
});
test('changed deployment module/routing/principal and a foreign account cannot select standalone credentials',async()=>{
 for(const change of ['module','target','principal','account']){const f=fixture();if(change==='module')(f.entry as {module_sha256:string}).module_sha256='e'.repeat(64);if(change==='target')f.entry.pins.target_key='other';if(change==='principal')f.account.principal_digest='b'.repeat(64);
  if(change==='account'){await assert.rejects(f.resolve({...f.scope,account_id:'other'},f.cap,async()=>{},undefined,'status'),/ACCESS_DENIED/);assert.equal(f.calls().selected,0);}
  else{await assert.rejects(async()=>{const resolved=await f.resolve(f.scope,f.cap,async()=>{},undefined,'status');await resolved.adapter.nativeEmailAccount!(resolved.context);},/ACCESS_DENIED/);}
 }
});
test('held native SQL revision withdrawal denies private identity; unsupported effects never select a module',async()=>{
 const f=fixture();let finish!:()=>void;f.hold(new Promise<void>(resolve=>finish=resolve));const resolved=await f.resolve(f.scope,f.cap,async()=>{},undefined,'status'),pending=resolved.adapter.nativeEmailAccount!(resolved.context);await Promise.resolve();f.setVersion('revoked-or-revised');finish();await assert.rejects(pending,/ACCESS_DENIED/);
 const g=fixture();for(const purpose of ['triage','send','draft_sync','sent_copy'] as const)await assert.rejects(g.resolve(g.scope,g.cap,async()=>{},undefined,purpose),/ACCESS_DENIED/);assert.equal(g.calls().selected,0);
});
