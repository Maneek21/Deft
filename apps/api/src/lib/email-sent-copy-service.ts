import {canonicalCapabilityJson} from '@deft/shared';
import type {EmailScope,EmailCapability,EmailActor,EmailAuthority} from './email-mailbox-service.js';
import type {EmailOutboxStore} from './email-outbox-store.js';
import type {RegisteredEmailSentCopyProvider} from './email-sent-copy-provider.js';
import {z} from 'zod';
import {EmailSentCopyScopeSchema,NativeEmailSentCopyResultSchema,type EmailSentCopyLease} from './email-sent-copy-contract.js';
export type EmailSentCopyAuthority={current(scope:EmailScope,lease:EmailSentCopyLease,transaction?:unknown,signal?:AbortSignal):Promise<EmailCapability>};
export class EmailSentCopyService{
 constructor(private readonly service:EmailSentCopyAuthority,private readonly store:EmailOutboxStore,private readonly provider:Pick<RegisteredEmailSentCopyProvider,'copy'>,private readonly now=Date.now){}
 async dispatch(rawScope:EmailScope,lease:EmailSentCopyLease,signal?:AbortSignal){
  const scope=EmailSentCopyScopeSchema.parse(rawScope);signal?.throwIfAborted();const cap=await this.service.current(scope,lease,undefined,signal);
  const current=async(tx?:unknown)=>{signal?.throwIfAborted();const fresh=await this.service.current(scope,lease,tx,signal);if(canonicalCapabilityJson(fresh.scope)!==canonicalCapabilityJson(scope)||fresh.resource_binding_id!==cap.resource_binding_id||fresh.authority_version!==cap.authority_version||fresh.expires_at<=this.now())throw Error('EMAIL_ACCESS_DENIED');};
  await current();const sealed=await this.store.readAcceptedCopy(scope,lease,current,signal);
  try{const result=NativeEmailSentCopyResultSchema.parse(await this.provider.copy({operation_id:lease.operation_id,mime_bytes:sealed.bytes,mime_digest:sealed.snapshot.mime_digest},{scope,capability:cap,recheck:async()=>current(),signal,
   sent_copy_before_append:async nomination=>nomination.operation_id===lease.operation_id&&nomination.account_id===scope.account_id&&nomination.mime_digest===sealed.snapshot.mime_digest
    &&Number.isSafeInteger(nomination.authority_epoch)&&nomination.authority_epoch>=1&&await this.store.verifyAcceptedCopy(scope,lease,nomination.mime_digest,current,signal)}));
   await current();if(result.account_id!==scope.account_id||result.operation_id!==lease.operation_id||result.mime_digest!==sealed.snapshot.mime_digest)throw Error('EMAIL_SENT_COPY_RESULT_INVALID');return result;
  }finally{sealed.bytes.fill(0);}
 }
}
/** Human inspection exposes only copy status under fresh account read authority. */
export async function readEmailSentCopyStatus(authority:EmailAuthority,store:EmailOutboxStore,actor:EmailActor,scope:EmailScope,outboxId:string,signal?:AbortSignal){
 EmailSentCopyScopeSchema.parse(scope);z.string().uuid().parse(outboxId);if(actor.user_id!==scope.owner_user_id||actor.access_expires_at<=Date.now())throw Error('EMAIL_ACCESS_DENIED');const cap=await authority.current(actor,scope,'human_read',undefined,signal);
 if(canonicalCapabilityJson(cap.scope)!==canonicalCapabilityJson(scope)||cap.expires_at<=Date.now())throw Error('EMAIL_ACCESS_DENIED');
 return store.readCopyStatus(scope,outboxId,async tx=>{const fresh=await authority.current(actor,scope,'human_read',tx,signal);if(canonicalCapabilityJson(fresh.scope)!==canonicalCapabilityJson(scope)||fresh.expires_at<=Date.now()||actor.access_expires_at<=Date.now()||fresh.authority_version!==cap.authority_version||fresh.resource_binding_id!==cap.resource_binding_id)throw Error('EMAIL_ACCESS_DENIED');},signal);
}
export async function reconcileEmailSentCopy(authority:EmailAuthority,store:EmailOutboxStore,actor:EmailActor,scope:EmailScope,outboxId:string,signal?:AbortSignal){
 EmailSentCopyScopeSchema.parse(scope);z.string().uuid().parse(outboxId);if(actor.user_id!==scope.owner_user_id||actor.access_expires_at<=Date.now())throw Error('EMAIL_ACCESS_DENIED');const cap=await authority.current(actor,scope,'human_modify',undefined,signal);
 if(canonicalCapabilityJson(cap.scope)!==canonicalCapabilityJson(scope)||cap.expires_at<=Date.now())throw Error('EMAIL_ACCESS_DENIED');
 return store.reconcileCopy(scope,outboxId,async tx=>{const fresh=await authority.current(actor,scope,'human_modify',tx,signal);if(canonicalCapabilityJson(fresh.scope)!==canonicalCapabilityJson(scope)||fresh.expires_at<=Date.now()||actor.access_expires_at<=Date.now()||fresh.authority_version!==cap.authority_version||fresh.resource_binding_id!==cap.resource_binding_id)throw Error('EMAIL_ACCESS_DENIED');},signal);
}
