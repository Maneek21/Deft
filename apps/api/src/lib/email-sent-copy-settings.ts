import {z} from 'zod';
import {canonicalCapabilityJson} from '@deft/shared';
import type {EmailActor,EmailScope,EmailAuthority,EmailCapability} from './email-mailbox-service.js';
import type {EmailImapCredentialCustody} from './email-imap-custody.js';
import type {RegisteredEmailSentCopyProvider} from './email-sent-copy-provider.js';
import {EmailSentCopyScopeSchema} from './email-sent-copy-contract.js';
const Update=z.strictObject({expected_revision:z.number().int().positive().safe(),sent_copy_mode:z.enum(['server_managed','append'])});
/** The host injects its existing credential CAS store. No credential profile,
 * hostname or sender can be nominated through this preferences interface. */
export class EmailSentCopySettingsService{
 constructor(private readonly authority:EmailAuthority,private readonly provider:Pick<RegisteredEmailSentCopyProvider,'settings'>,
  private readonly custodyFor:(scope:EmailScope,recheck:()=>Promise<void>)=>Promise<Pick<EmailImapCredentialCustody,'updateSentCopyMode'>>,private readonly now=Date.now){}
 private async authorized(actor:EmailActor,raw:EmailScope,operation:'human_read'|'human_modify',signal?:AbortSignal){
  const scope=EmailSentCopyScopeSchema.parse(raw);if(actor.user_id!==scope.owner_user_id||actor.access_expires_at<=this.now())throw Error('EMAIL_ACCESS_DENIED');const cap=await this.authority.current(actor,scope,operation,undefined,signal);
  const current=async(expected?:EmailCapability)=>{signal?.throwIfAborted();if(actor.access_expires_at<=this.now())throw Error('EMAIL_ACCESS_DENIED');const fresh=await this.authority.current(actor,scope,operation,undefined,signal);
   if(canonicalCapabilityJson(fresh.scope)!==canonicalCapabilityJson(scope)||fresh.resource_binding_id!==cap.resource_binding_id||fresh.expires_at<=this.now()||expected&&fresh.authority_version!==expected.authority_version)throw Error('EMAIL_ACCESS_DENIED');return fresh;};await current(cap);return {scope,cap,current};
 }
 async read(actor:EmailActor,scope:EmailScope,signal?:AbortSignal){const a=await this.authorized(actor,scope,'human_read',signal);return this.provider.settings(a.scope,a.cap,async()=>{await a.current(a.cap);},signal);}
 async update(actor:EmailActor,scope:EmailScope,input:unknown,signal?:AbortSignal){
  const request=Update.parse(input),a=await this.authorized(actor,scope,'human_modify',signal);const before=await this.provider.settings(a.scope,a.cap,async()=>{await a.current(a.cap);},signal);
  if(before.revision!==request.expected_revision)throw Error('EMAIL_IMAP_CUSTODY_CONFLICT');if(request.sent_copy_mode==='append'&&!before.append_available)throw Error('EMAIL_SENT_COPY_APPEND_UNAVAILABLE');await a.current(a.cap);
  // Expected credential revision is the write fence. After that explicit CAS,
  // its new connection/authority version is read again under the same owner and
  // binding, rather than rejecting our own successful preference mutation.
  const custody=await this.custodyFor(a.scope,async()=>{await a.current();});await custody.updateSentCopyMode(a.scope,request.expected_revision,request.sent_copy_mode,async()=>{await a.current();},signal);
  const fresh=await a.current();return this.provider.settings(a.scope,fresh,async()=>{await a.current(fresh);},signal);
 }
}
