import {createHash,randomUUID} from 'node:crypto';
import {canonicalCapabilityJson} from '@deft/shared';
import {z} from 'zod';
import {NativeEmailSendIdentitySchema,NativeEmailSendResultSchema,NativeEmailPrepareSendResultSchema,type NativeEmailSendIdentity,type NativeEmailPrepareSendResult} from './app-connection-contract.js';
import type {EmailActor,EmailScope,EmailAuthority,EmailCapability} from './email-mailbox-service.js';
import type {EmailDraftStore} from './email-draft-store.js';
import type {EmailSendSnapshotBuilder,EmailSendSnapshotIdentity,EmailNativeSendProvider} from './email-native-send-service.js';
import {EmailDraftContentSchema} from './email-draft-service.js';
import {EmailOutboxScopeSchema,EmailOutboxEnqueueSchema,EmailOutboxTransportSchema,type EmailOutboxLease,type EmailOutboxPublic} from './email-outbox-contract.js';
import {resolveEmailOutboxSchedule} from './email-outbox-schedule.js';
import type {EmailOutboxStore} from './email-outbox-store.js';
export type EmailOutboxProvider=EmailNativeSendProvider&{getSendIdentity(scope:EmailScope,capability:EmailCapability,recheck:()=>Promise<void>,signal?:AbortSignal):Promise<NativeEmailSendIdentity>;
 prepare?(input:Parameters<EmailNativeSendProvider['send']>[0],host:Omit<Parameters<EmailNativeSendProvider['send']>[1],'send_before_reserve'>&{send_prepare_before_effect:(input:{operation_id:string;account_id:string;authority_epoch:number;mime_digest:string})=>Promise<boolean>}):Promise<NativeEmailPrepareSendResult>};
export type EmailOutboxServiceAuthority={current(scope:EmailScope,lease:EmailOutboxLease,transaction?:unknown,signal?:AbortSignal):Promise<EmailCapability>};
const Actor=z.strictObject({user_id:z.string().min(1).max(256),web_session_id:z.string().min(1).max(256),access_expires_at:z.number().finite()});
const Mutation=z.strictObject({outbox_id:z.string().uuid(),expected_revision:z.number().int().min(1).max(128)});
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const identity=(v:NativeEmailSendIdentity)=>canonicalCapabilityJson([v.org_id,v.owner_user_id,v.installation_id,v.account_id,v.provider,v.principal_digest,v.resource_binding_id,v.action_binding_id,v.connection_revision,v.authority_epoch,v.primary_address,v.verified_sender_identities,v.connection_target,v.implementation_digest??null]);
/** Explicit human enqueue and leased dispatch share immutable prepared transport,
 * not a synthetic human SID. No provider effect happens during preparation. */
export class EmailOutboxService{
 constructor(private readonly human:EmailAuthority,private readonly service:EmailOutboxServiceAuthority,private readonly drafts:Pick<EmailDraftStore,'read'>,
  private readonly store:EmailOutboxStore,private readonly snapshots:EmailSendSnapshotBuilder,private readonly provider:EmailOutboxProvider,private readonly now=Date.now){}
 private checked(scope:EmailScope,value:EmailCapability,expected?:EmailCapability){
  if(!value||canonicalCapabilityJson(value.scope)!==canonicalCapabilityJson(scope)||!value.resource_binding_id||!value.authority_version||!Number.isFinite(value.expires_at)||value.expires_at<=this.now()
   ||expected&&(value.resource_binding_id!==expected.resource_binding_id||value.authority_version!==expected.authority_version))throw Error('EMAIL_OUTBOX_ACCESS_DENIED');return value;
 }
 private async authorized(actorRaw:EmailActor,scopeRaw:EmailScope,operation:'human_read'|'human_send',signal?:AbortSignal){
  const actor=Actor.parse(actorRaw),scope=EmailOutboxScopeSchema.parse(scopeRaw);if(actor.user_id!==scope.owner_user_id||actor.access_expires_at<=this.now())throw Error('EMAIL_OUTBOX_ACCESS_DENIED');
  const cap=this.checked(scope,await this.human.current(actor,scope,operation,undefined,signal));
  const current=async(tx?:unknown)=>{signal?.throwIfAborted();if(actor.access_expires_at<=this.now())throw Error('EMAIL_OUTBOX_ACCESS_DENIED');return this.checked(scope,await this.human.current(actor,scope,operation,tx,signal),cap);};
  await current();return {actor,scope,cap,current,guard:async(tx:unknown)=>{await current(tx);}};
 }
 async enqueue(actorRaw:EmailActor,scopeRaw:EmailScope,raw:unknown,signal?:AbortSignal):Promise<EmailOutboxPublic>{
  const request=EmailOutboxEnqueueSchema.parse(raw),a=await this.authorized(actorRaw,scopeRaw,'human_send',signal),prior=await this.store.byRequest(a.scope,request,a.guard,signal);if(prior)return prior;
  const draft=await this.drafts.read(a.scope,request.draft_id,a.guard,signal);if(!draft||draft.status!=='draft'||draft.revision!==request.expected_revision||draft.content_revision!==request.expected_revision)throw Error('EMAIL_OUTBOX_CONFLICT');
  const schedule=request.schedule?resolveEmailOutboxSchedule(request.schedule,new Date(this.now())):null,operationId=randomUUID(),outboxId=randomUUID();
  const before=NativeEmailSendIdentitySchema.parse(await this.provider.getSendIdentity(a.scope,a.cap,async()=>{await a.current();},signal));
  let captured:EmailSendSnapshotIdentity|undefined,prepared:Awaited<ReturnType<EmailSendSnapshotBuilder['prepareAndBind']>>|undefined;
  try{
   prepared=await this.snapshots.prepareAndBind({actor:a.actor,scope:a.scope,capability:a.cap,recheck:async()=>{await a.current();},draft,operation_id:operationId,signal,
    // This host-only callback proves the serializer binding. The subsequent
    // encrypted enqueue transaction is the durable boundary, before any effect.
    reserve:async value=>{if(captured||value.operation_id!==operationId||value.account_id!==a.scope.account_id||value.scope.org_id!==a.scope.org_id||value.scope.owner_id!==a.scope.owner_user_id||value.scope.installation_id!==before.installation_id
     ||value.draft_id!==request.draft_id||value.draft_revision!==request.expected_revision||value.authority_epoch!==before.authority_epoch)throw Error('EMAIL_OUTBOX_INVALID');captured=structuredClone(value);await a.current();return 'reserved';}});
   const transport=EmailOutboxTransportSchema.parse(prepared.transport),bytes=prepared.mime_bytes;
   if(!captured||prepared.state!=='reserved'||!(bytes instanceof Uint8Array)||!bytes.length||digest(bytes)!==prepared.mime_digest||transport.mime_digest!==prepared.mime_digest
    ||canonicalCapabilityJson(captured)!==canonicalCapabilityJson(Object.fromEntries(Object.entries(transport).filter(([key])=>!['from_address','transport_kind','thread_id','envelope'].includes(key)))))throw Error('EMAIL_OUTBOX_INVALID');
   const fresh=NativeEmailSendIdentitySchema.parse(await this.provider.getSendIdentity(a.scope,a.cap,async()=>{await a.current();},signal));if(identity(before)!==identity(fresh))throw Error('EMAIL_OUTBOX_ACCESS_DENIED');
   const content=EmailDraftContentSchema.parse(draft.content),undoUntil=new Date(this.now()+request.undo_delay_seconds*1000).toISOString();await a.current();
   return await this.store.enqueue(a.scope,outboxId,{schema_version:'deft.email_outbox_snapshot.v1',request,identity:fresh,transport,mime_digest:prepared.mime_digest!,byte_length:bytes.length,
    display:{subject:content.subject,to:content.to,cc:content.cc,bcc:content.bcc},schedule,undo_until:undoUntil},bytes,a.guard,signal);
  }finally{prepared?.mime_bytes?.fill(0);}
 }
 async cancel(actor:EmailActor,scope:EmailScope,raw:unknown,signal?:AbortSignal){const input=Mutation.parse(raw),a=await this.authorized(actor,scope,'human_send',signal);return this.store.cancel(a.scope,input.outbox_id,input.expected_revision,a.guard,signal);}
 async reschedule(actor:EmailActor,scope:EmailScope,raw:unknown,signal?:AbortSignal){const input=Mutation.extend({schedule:z.unknown()}).parse(raw),schedule=resolveEmailOutboxSchedule(input.schedule,new Date(this.now())),a=await this.authorized(actor,scope,'human_send',signal);return this.store.reschedule(a.scope,input.outbox_id,input.expected_revision,schedule,a.guard,signal);}
 async read(actor:EmailActor,scope:EmailScope,outboxId:string,signal?:AbortSignal){z.string().uuid().parse(outboxId);const a=await this.authorized(actor,scope,'human_read',signal);return (await this.store.read(a.scope,outboxId,a.guard,signal))?.public??null;}
 async readRequest(actor:EmailActor,scope:EmailScope,requestId:string,signal?:AbortSignal){z.string().uuid().parse(requestId);const a=await this.authorized(actor,scope,'human_read',signal);return this.store.readRequest(a.scope,requestId,a.guard,signal);}
 async readDraft(actor:EmailActor,scope:EmailScope,draftId:string,revision:number,signal?:AbortSignal){const a=await this.authorized(actor,scope,'human_read',signal);return this.store.readDraft(a.scope,draftId,revision,a.guard,signal);}
 async list(actor:EmailActor,scope:EmailScope,input:{limit:number;cursor:string|null},signal?:AbortSignal){const a=await this.authorized(actor,scope,'human_read',signal);return this.store.list(a.scope,input.limit,input.cursor,a.guard,signal);}
 async dispatch(scopeRaw:EmailScope,lease:EmailOutboxLease,signal?:AbortSignal):Promise<{state:string;delay_ms?:number}>{
  const scope=EmailOutboxScopeSchema.parse(scopeRaw);if(lease.job_name!=='native-email-outbox'||!lease.job_id||!lease.lock_token)throw Error('EMAIL_OUTBOX_LEASE_DENIED');z.string().uuid().parse(lease.outbox_id);z.string().uuid().parse(lease.operation_id);
  const cap=this.checked(scope,await this.service.current(scope,lease,undefined,signal)),current=async(tx?:unknown)=>this.checked(scope,await this.service.current(scope,lease,tx,signal),cap),guard=async(tx:unknown)=>{signal?.throwIfAborted();await current(tx);};
  const held=await this.store.read(scope,lease.outbox_id,guard,signal);if(!held)throw Error('EMAIL_OUTBOX_NOT_FOUND');
  // Recovery of an already started row must precede identity work: it can only
  // become uncertain, even if the provider account no longer matches.
  if(held.public.state==='queued'){
   const fresh=NativeEmailSendIdentitySchema.parse(await this.provider.getSendIdentity(scope,cap,async()=>{await current();},signal));
   if(identity(fresh)!==identity(held.snapshot.identity)){await this.store.pause(scope,lease.outbox_id,'authority_changed',guard,signal);return {state:'paused'};}
   if(held.snapshot.identity.provider==='microsoft'&&held.snapshot.byte_length>3*1024*1024){
    const preparing=await this.store.readPreparation(scope,lease.outbox_id,lease,guard,signal);
    if(preparing.kind==='wait')return {state:'waiting',delay_ms:preparing.delay_ms};if(preparing.kind==='settled')return {state:preparing.state};
    if(preparing.kind==='missed'){await this.store.pause(scope,lease.outbox_id,'missed_schedule',guard,signal);return {state:'paused'};}
    try{
     if(!this.provider.prepare)throw Error('EMAIL_OUTBOX_PREPARATION_UNAVAILABLE');const snapshot=preparing.snapshot;
     const result=NativeEmailPrepareSendResultSchema.parse(await this.provider.prepare({operation_id:lease.operation_id,mime_bytes:preparing.bytes,mime_digest:snapshot.mime_digest,from_address:snapshot.transport.from_address,transport_kind:'graph_raw'},
      {scope,capability:cap,recheck:async()=>{await current();},signal,send_prepare_before_effect:async input=>input.operation_id===lease.operation_id&&input.account_id===scope.account_id&&input.authority_epoch===snapshot.transport.authority_epoch&&input.mime_digest===snapshot.mime_digest
       &&await this.store.verifyQueuedPreparation(scope,lease.outbox_id,lease,snapshot.mime_digest,guard,signal)}));
     await current();if(result.account_id!==scope.account_id||result.operation_id!==lease.operation_id||result.mime_digest!==snapshot.mime_digest)throw Error('EMAIL_OUTBOX_PREPARATION_UNAVAILABLE');
     if(result.state==='pending')return {state:'waiting',delay_ms:result.retry_after_ms??5000};
     if(result.state==='unknown'||result.state==='conflict'){await this.store.pause(scope,lease.outbox_id,result.state==='unknown'?'preparation_unknown':'preparation_conflict',guard,signal);return {state:'paused'};}
    }finally{preparing.bytes.fill(0);}
   }
  }
  const claim=await this.store.claim(scope,lease.outbox_id,lease,guard,signal);if(claim.kind==='wait')return {state:'waiting',delay_ms:claim.delay_ms};if(claim.kind==='settled')return {state:claim.value.state};
  const {snapshot,bytes,attempt_id:attemptId}=claim;
  try{
   await current();const raw=await this.provider.send({operation_id:lease.operation_id,mime_bytes:bytes,mime_digest:snapshot.mime_digest,from_address:snapshot.transport.from_address,
    transport_kind:snapshot.transport.transport_kind,...(snapshot.transport.thread_id?{thread_id:snapshot.transport.thread_id}:{}),...(snapshot.transport.envelope?{envelope:snapshot.transport.envelope}:{})},
    {scope,capability:cap,recheck:async()=>{await current();},signal,send_before_reserve:async input=>input.operation_id===lease.operation_id&&input.account_id===scope.account_id&&input.authority_epoch===snapshot.transport.authority_epoch&&input.mime_digest===snapshot.mime_digest
     &&await this.store.verifyAttempt(scope,lease.outbox_id,lease,attemptId,snapshot.mime_digest,guard,signal)});
   const result=NativeEmailSendResultSchema.parse(raw);if(result.operation_id!==lease.operation_id||result.account_id!==scope.account_id||result.provider!==snapshot.identity.provider)throw Error('EMAIL_OUTBOX_UNCERTAIN');
   await this.store.finish(scope,lease.outbox_id,lease,attemptId,'accepted',result.provider_message_id,guard,signal);return {state:'accepted'};
  }catch(error){let retained=false;try{await this.store.finish(scope,lease.outbox_id,lease,attemptId,'uncertain',null,async tx=>{this.checked(scope,await this.service.current(scope,lease,tx));});retained=true;}catch{}
   // Even known acceptance with a lost SQL commit must not re-dispatch.
   if(signal?.aborted)throw error;if(!retained)throw Error('EMAIL_OUTBOX_RECONCILIATION_REQUIRED');return {state:'uncertain'};
  }finally{bytes.fill(0);}
 }
}
