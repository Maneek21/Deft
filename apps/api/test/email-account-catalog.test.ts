import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EmailAccountCatalogService} from '../src/lib/email-account-catalog.js';
import type {EmailScope} from '../src/lib/email-mailbox-service.js';
const actor={user_id:'owner',web_session_id:'sid',access_expires_at:9000};
const capability=(scope:EmailScope)=>({scope,resource_binding_id:'binding-'+scope.account_id,authority_version:'v1',expires_at:9000});
function fixture(){
 const calls:unknown[][]=[],changed=new Set<string>(),offline=new Set<string>();
 const service=new EmailAccountCatalogService({listCandidates:async(...args)=>{calls.push(args);return ['one','two'];},
  inspect:async(_actor,scope)=>{if(offline.has(scope.account_id))throw Error('private custody failure');return {capability:capability(scope),account:{account_id:scope.account_id,provider:'gmail',resource_binding_id:'binding-'+scope.account_id,authority_epoch:1,connection_revision:1,principal_digest:'a'.repeat(64),health:'connected',capabilities:['read'],primary_address:scope.account_id+'@example.test',display_label:'Mailbox '+scope.account_id}};},
  current:async(_actor,scope)=>({...capability(scope),authority_version:changed.has(scope.account_id)?'v2':'v1'})},()=>1000);
 return {service,calls,changed,offline};
}
test('account catalogue discovers only verified owner candidates and publishes minimal identities',async()=>{
 const {service,calls}=fixture();const value=await service.list(actor,'org');
 assert.deepEqual(calls[0]?.slice(0,3),['org','owner',17]);assert.equal(value.accounts.length,2);
 assert.deepEqual(Object.keys(value.accounts[0]!).sort(),['account_id','capabilities','display_label','primary_address','provider']);
 assert.equal(value.unavailable_count,0);assert.equal(value.has_more,false);
});
test('offline and late-revoked identities cannot leak while healthy account remains usable',async()=>{
 const {service,changed,offline}=fixture();changed.add('one');let value=await service.list(actor,'org');
 assert.deepEqual(value.accounts.map(row=>row.account_id),['two']);assert.equal(value.unavailable_count,1);
 changed.clear();offline.add('two');value=await service.list(actor,'org');assert.deepEqual(value.accounts.map(row=>row.account_id),['one']);
 assert.equal(JSON.stringify(value).includes('custody'),false);
});
test('expired session and abort prevent account inventory I/O',async()=>{
 const {service,calls}=fixture();await assert.rejects(service.list({...actor,access_expires_at:999},'org'),/EMAIL_ACCESS_DENIED/);
 const controller=new AbortController();controller.abort();await assert.rejects(service.list(actor,'org',controller.signal));assert.equal(calls.length,0);
});

test('account discovery overlaps at most three provider checks and retains deterministic account order',async()=>{
 let active=0,peak=0;const ids=Array.from({length:8},(_,i)=>String(i));
 const service=new EmailAccountCatalogService({listCandidates:async()=>ids,
  inspect:async(_actor,scope)=>{active++;peak=Math.max(peak,active);await new Promise<void>(resolve=>setImmediate(resolve));active--;
   return {capability:capability(scope),account:{account_id:scope.account_id,provider:'gmail',resource_binding_id:'binding-'+scope.account_id,authority_epoch:1,connection_revision:1,principal_digest:'a'.repeat(64),health:'connected',capabilities:['read'],primary_address:scope.account_id+'@example.test',display_label:'Mailbox '+scope.account_id}};},
  current:async(_actor,scope)=>capability(scope)},()=>1000);
 const result=await service.list(actor,'org');assert.equal(peak,3);assert.equal(active,0);assert.deepEqual(result.accounts.map(row=>row.account_id),ids);
});
