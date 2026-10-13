import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {RegisteredEmailNativeDraftProvider} from '../src/lib/email-native-draft-provider.js';
import type {NativeEmailAccount,NativeEmailDraftSyncResult,NativeEmailConnectionContext} from '../src/lib/app-connection-contract.js';
const scope={org_id:'org-draft-mirror',owner_user_id:'owner-draft-mirror',account_id:'account-draft-mirror'};
const bytes=Buffer.from('From: owner@example.test\r\nSubject: Native mirror\r\n\r\nExact MIME');
const digest=createHash('sha256').update(bytes).digest('hex');
function fixture(){
 const capability={scope,resource_binding_id:'binding-mirror',authority_version:'authority-mirror',expires_at:6000};
 const account:{-readonly [K in keyof NativeEmailAccount]:NativeEmailAccount[K]}={account_id:scope.account_id,provider:'gmail',resource_binding_id:capability.resource_binding_id,authority_epoch:1,connection_revision:1,principal_digest:'a'.repeat(64),health:'connected',capabilities:['read','modify'],primary_address:'owner@example.test',display_label:'Owner'};
 let calls=0,reservations=0,after=()=>{},output:NativeEmailDraftSyncResult|undefined,override:Partial<NativeEmailDraftSyncResult>={},resolvedScope=scope,now=1000;
 const recheck=async()=>{},host={scope,capability,recheck,draft_sync_before_effect:async()=>{reservations++;return true;}};
 const service=new RegisteredEmailNativeDraftProvider(async(_scope,_cap,recheck,signal,purpose)=>{
  assert.equal(purpose,'draft_sync');const context:NativeEmailConnectionContext={...resolvedScope,installation_id:'install-mirror',resource_binding_id:capability.resource_binding_id,authority_version:capability.authority_version,expires_at:6000,recheck,signal};
  return {context,adapter:{nativeEmailAccount:async ctx=>{assert.equal(Object.hasOwn(ctx,'draft_sync_before_effect'),false);return structuredClone(account);},nativeEmailDraftSync:async(input,context)=>{
   calls++;assert.equal(await context.draft_sync_before_effect?.({operation_id:input.operation_id,operation:'create',account_id:scope.account_id,authority_epoch:1,provider_draft_ref:null,baseline_digest:null,desired_digest:digest}),true);
   output={schema_version:'deft.email_draft_sync_result.v1',account_id:scope.account_id,provider:'gmail',operation_id:input.operation_id,outcome:'created',provider_draft_ref:'private-draft-ref',baseline_digest:digest,provider_version:'private-version',limitations:['compare_before_effect_is_not_atomic_cas'],mime_bytes:Uint8Array.from(bytes),...override};after();return output;
  }}};
 },()=>now);
 return {service,host,account,get output(){return output;},get counts(){return {calls,reservations};},set after(value:()=>void){after=value;},set override(value:Partial<NativeEmailDraftSyncResult>){override=value;},set resolvedScope(value:typeof scope){resolvedScope=value;},set now(value:number){now=value;}};
}
const create=()=>({operation:'create' as const,operation_id:randomUUID(),desired:{mime_bytes:bytes,mime_digest:digest}});
test('registered draft mirror forwards only strict server MIME and exact reserved operation under modify scope',async()=>{
 const f=fixture(),input=create(),result=await f.service.sync(input,f.host);assert.equal(result.outcome,'created');assert.equal(result.provider_draft_ref,'private-draft-ref');assert.deepEqual(Buffer.from(result.mime_bytes!),bytes);assert.deepEqual(f.counts,{calls:1,reservations:1});
});
test('held reconnect/principal/withdrawal/cancellation/expiry deny ephemeral provider MIME and clear bytes',async()=>{
 for(const mutation of [f=>f.account.connection_revision++,f=>f.account.principal_digest='b'.repeat(64),f=>f.account.health='revoked',f=>f.account.capabilities=['read'],f=>f.now=6000] as ((f:ReturnType<typeof fixture>)=>void)[]){
  const f=fixture();f.after=()=>mutation(f);await assert.rejects(f.service.sync(create(),f.host));assert.ok(f.output?.mime_bytes?.every(value=>value===0));
 }
 const f=fixture(),controller=new AbortController();f.after=()=>controller.abort();await assert.rejects(f.service.sync(create(),{...f.host,signal:controller.signal}));assert.ok(f.output?.mime_bytes?.every(value=>value===0));
});
test('foreign resolver scope and absent reservation deny before adapter, malformed private results clear bytes',async()=>{
 const foreign=fixture();foreign.resolvedScope={...scope,account_id:'foreign'};await assert.rejects(foreign.service.sync(create(),foreign.host));assert.equal(foreign.counts.calls,0);
 const noReservation=fixture();await assert.rejects(noReservation.service.sync(create(),{...noReservation.host,draft_sync_before_effect:undefined}));assert.equal(noReservation.counts.calls,0);
 for(const override of [{account_id:'foreign'},{baseline_digest:'b'.repeat(64)},{provider:'microsoft' as const},{outcome:'deleted' as const},{operation_id:randomUUID()}]){
  const f=fixture();f.override=override;await assert.rejects(f.service.sync(create(),f.host));assert.ok(f.output?.mime_bytes?.every(value=>value===0));
 }
});
test('unknown create is terminal output without ref or automatic retry, operation field combinations remain strict',async()=>{
 const f=fixture();f.override={outcome:'unknown',provider_draft_ref:undefined,baseline_digest:undefined,provider_version:undefined,mime_bytes:undefined};const result=await f.service.sync(create(),f.host);assert.equal(result.outcome,'unknown');assert.equal(result.provider_draft_ref,undefined);assert.equal(f.counts.calls,1);
 for(const input of [{...create(),provider_draft_ref:'browser-ref'},{operation:'update',operation_id:randomUUID(),provider_draft_ref:'ref',baseline_digest:digest,desired:{mime_bytes:bytes,mime_digest:digest}}])await assert.rejects(f.service.sync(input as any,f.host));assert.equal(f.counts.calls,1);
});
