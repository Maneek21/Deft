import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {RegisteredEmailNativeSendProvider} from '../src/lib/email-native-send-provider.js';
import type {AppConnectionAdapter,NativeEmailSendIdentity} from '../src/lib/app-connection-contract.js';
import type {EmailScope,EmailCapability} from '../src/lib/email-mailbox-service.js';
const scope:EmailScope={org_id:'org-send',owner_user_id:'owner-send',account_id:'account-send'};
const cap:EmailCapability={scope,resource_binding_id:'binding-send',authority_version:'authority-send',expires_at:5000};
const mime=Buffer.from('From: owner@example.test\r\nTo: recipient@example.test\r\n\r\nSynthetic');
const digest=createHash('sha256').update(mime).digest('hex');
const input=()=>({operation_id:randomUUID(),mime_bytes:mime,mime_digest:digest,from_address:'owner@example.test',transport_kind:'gmail_raw' as const});
function fixture(){
  let live=true,calls=0,identityCalls=0,late=false;const reserved:any[]=[];
  let identity:NativeEmailSendIdentity={account_id:scope.account_id,provider:'gmail',resource_binding_id:cap.resource_binding_id,authority_epoch:2,
    connection_revision:3,principal_digest:'a'.repeat(64),health:'connected',capabilities:['read','send'],primary_address:'owner@example.test',display_label:'Send account',
    org_id:scope.org_id,owner_user_id:scope.owner_user_id,installation_id:'installation-send',connection_target:'target-send',action_binding_id:'real-action-binding-send',verified_sender_identities:['owner@example.test']};
  const adapter:AppConnectionAdapter={handle:async()=>new Response(),nativeEmailSendIdentity:async context=>{assert.equal(context.send_before_reserve,undefined);identityCalls++;return structuredClone(identity);},
    nativeEmailSend:async(request,context)=>{calls++;assert.equal('transport_kind' in request,false);assert.equal('account_id' in request,false);
      assert.equal(await context.send_before_reserve!({operation_id:request.operation_id,account_id:scope.account_id,authority_epoch:identity.authority_epoch,mime_digest:request.mime_digest}),true);
      if(late)identity={...identity,principal_digest:'b'.repeat(64)};
      return {schema_version:'deft.email_send_result.v1',account_id:scope.account_id,provider:'gmail',operation_id:request.operation_id,provider_message_id:'provider-private-id',transport_outcome:'provider_accepted',sent_copy_outcome:'pending',delivery_status:'unknown'};}};
  const provider=new RegisteredEmailNativeSendProvider(async(selected,capability,recheck,signal,purpose)=>{assert.equal(purpose,'send');assert.deepEqual(selected,scope);
    return {adapter,context:{...scope,installation_id:'installation-send',resource_binding_id:capability.resource_binding_id,authority_version:capability.authority_version,expires_at:4000,recheck,signal}};},()=>1000);
  const host={scope,capability:cap,recheck:async()=>{if(!live)throw Error('Revoked');},send_before_reserve:async(value:any)=>{reserved.push(value);return true;}};
  return {provider,adapter,host,reserved,get counts(){return {calls,identityCalls};},set identity(value:Partial<NativeEmailSendIdentity>){identity={...identity,...value};},deny(){live=false;},late(){late=true;}};
}
test('server-only send identity retains actual binding, sender and installation; send forwards immutable host reservation',async()=>{
  const f=fixture(),identity=await f.provider.getSendIdentity(scope,cap,f.host.recheck);assert.equal(identity.action_binding_id,'real-action-binding-send');assert.equal(identity.installation_id,'installation-send');assert.deepEqual(identity.verified_sender_identities,['owner@example.test']);assert.equal(f.counts.calls,0);
  const request=input(),result=await f.provider.send(request,f.host);assert.equal(result.transport_outcome,'provider_accepted');assert.equal(result.delivery_status,'unknown');
  assert.deepEqual(f.reserved,[{operation_id:request.operation_id,account_id:scope.account_id,authority_epoch:2,mime_digest:digest}]);assert.equal(f.counts.calls,1);
});
test('foreign/agent-selected identity, missing actual send capability and wrong transport/sender deny before effect',async()=>{
  for(const changed of [{account_id:'foreign'},{owner_user_id:'another-owner'},{installation_id:'fabricated'},{resource_binding_id:'foreign-binding'},{action_binding_id:''},{capabilities:['read']},{verified_sender_identities:[]}]){
    const f=fixture();f.identity=changed;await assert.rejects(f.provider.send(input(),f.host));assert.equal(f.counts.calls,0);
  }
  const f=fixture();await assert.rejects(f.provider.send({...input(),transport_kind:'graph_raw'},f.host));await assert.rejects(f.provider.send({...input(),from_address:'attacker@example.test'},f.host));assert.equal(f.counts.calls,0);
  await assert.rejects(f.provider.send({...input(),account_id:'caller-nomination'} as any,f.host));
});
test('held principal change and malformed provider accepted response deny outcome and never retry',async()=>{
  const f=fixture();f.late();await assert.rejects(f.provider.send(input(),f.host));assert.equal(f.counts.calls,1);assert.equal(f.reserved.length,1);
  const wrong=fixture(),original=wrong.adapter.nativeEmailSend!;wrong.adapter.nativeEmailSend=async(input,context)=>({...await original(input,context),account_id:'foreign'});
  await assert.rejects(wrong.provider.send(input(),wrong.host));assert.equal(wrong.counts.calls,1);
  const delivered=fixture();delivered.adapter.nativeEmailSend=async(input)=>({schema_version:'deft.email_send_result.v1',account_id:scope.account_id,provider:'gmail',operation_id:input.operation_id,provider_message_id:'private',transport_outcome:'provider_accepted',sent_copy_outcome:'pending',delivery_status:'delivered'} as any);
  await assert.rejects(delivered.provider.send(input(),delivered.host));
});
test('revoked, expired and aborted account admissions never send',async()=>{
  const f=fixture();f.deny();await assert.rejects(f.provider.send(input(),f.host));assert.equal(f.counts.calls,0);
  const expired=fixture();await assert.rejects(expired.provider.send(input(),{...expired.host,capability:{...cap,expires_at:999}}));assert.equal(expired.counts.calls,0);
  const aborted=fixture();await assert.rejects(aborted.provider.send(input(),{...aborted.host,signal:AbortSignal.abort()}));assert.equal(aborted.counts.calls,0);
});

test('registered SMTP wrapper forwards sealed Bcc envelope only for current SMTP account and requires exact envelope sender',async()=>{
 const f=fixture();f.identity={provider:'imap_smtp'};const envelope={from:'owner@example.test',to:['recipient@example.test','blind@example.test']};let forwarded:any;
 f.adapter.nativeEmailSend=async(request,context)=>{forwarded=request;assert.deepEqual(request.envelope,envelope);assert.equal(await context.send_before_reserve!({operation_id:request.operation_id,account_id:scope.account_id,authority_epoch:2,mime_digest:request.mime_digest}),true);
  return {schema_version:'deft.email_send_result.v1',account_id:scope.account_id,provider:'imap_smtp',operation_id:request.operation_id,provider_message_id:null,transport_outcome:'provider_accepted',sent_copy_outcome:'pending',delivery_status:'unknown'};};
 const result=await f.provider.send({...input(),transport_kind:'smtp_raw',envelope},f.host);assert.equal(result.provider,'imap_smtp');assert.deepEqual(forwarded.envelope,envelope);
 for(const request of [{...input(),transport_kind:'smtp_raw' as const},{...input(),transport_kind:'smtp_raw' as const,envelope:{...envelope,from:'foreign@example.test'}},
  {...input(),transport_kind:'smtp_raw' as const,envelope,thread_id:'provider-thread'}])await assert.rejects(f.provider.send(request,f.host));
 const oauth=fixture();await assert.rejects(oauth.provider.send({...input(),envelope},oauth.host));assert.equal(oauth.counts.calls,0);
});

test('Graph preparation forwards only host-owned proof and rejects wrong result or unavailable modify capability',async()=>{
 const f=fixture();f.identity={provider:'microsoft',capabilities:['read','modify','send']};let prepares=0;
 f.adapter.nativeEmailPrepareSend=async(request,context)=>{prepares++;assert.equal('transport_kind' in request,false);assert.equal(context.send_before_reserve,undefined);assert.equal(await context.send_prepare_before_effect!({operation_id:request.operation_id,account_id:scope.account_id,authority_epoch:2,mime_digest:request.mime_digest}),true);
  return {schema_version:'deft.email_prepare_send_result.v1',account_id:scope.account_id,provider:'microsoft',operation_id:request.operation_id,mime_digest:request.mime_digest,state:'pending',retry_after_ms:2000,limitations:['bounded_preparation_page']};};
 const request={...input(),transport_kind:'graph_raw' as const},host={scope,capability:cap,recheck:f.host.recheck,send_prepare_before_effect:async()=>true};
 assert.equal((await f.provider.prepare(request,host)).state,'pending');assert.equal(prepares,1);assert.equal(f.reserved.length,0);
 const real=f.adapter.nativeEmailPrepareSend;f.adapter.nativeEmailPrepareSend=async(input,context)=>({...await real(input,context),mime_digest:'f'.repeat(64)});await assert.rejects(f.provider.prepare(request,host));assert.equal(prepares,2);
 f.identity={capabilities:['read','send']};await assert.rejects(f.provider.prepare(request,host));assert.equal(prepares,2);
});
