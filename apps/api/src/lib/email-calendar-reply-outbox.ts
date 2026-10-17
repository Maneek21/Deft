import {randomUUID} from 'node:crypto';
import {emailDrafts} from '@deft/db/schema';
import {canonicalCapabilityJson} from '@deft/shared';
import {NativeEmailSendIdentitySchema} from './email-native-adapter-contract.js';
import {EmailDraftContentSchema} from './email-draft-service.js';
import {emailDraftContext,type EmailDraftRow} from './email-draft-store.js';
import type {EmailActor,EmailCapability,EmailScope} from './email-mailbox-service.js';
import type {EmailSendSnapshotBuilder,EmailSendSnapshotIdentity} from './email-native-send-service.js';
import type {EmailNativeSendIdentityReader} from './email-native-outgoing-snapshot.js';
import {EmailOutboxTransportSchema,type EmailOutboxSnapshot} from './email-outbox-contract.js';
import {EmailOutboxStore,type EmailOutboxTransaction} from './email-outbox-store.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {serializeEmailInvitationReply,type EmailCalendarInvitation} from './email-calendar-invitation.js';
import type {EmailInvitationTransaction,EmailInvitationGuard} from './email-calendar-invitation-store.js';
const identity=(value:unknown)=>canonicalCapabilityJson(value);
/** Host-only RSVP composer. Inputs are the re-resolved invitation and exact
 * receiving attendee, never user-supplied recipients, ICS or binary MIME. */
export class EmailCalendarReplyOutbox{
 constructor(private readonly snapshots:EmailSendSnapshotBuilder,private readonly accounts:EmailNativeSendIdentityReader,private readonly outbox:EmailOutboxStore,
  private readonly cipher:EmailMailboxCrypto,private readonly now=()=>new Date()){}
 async prepare(input:Readonly<{actor:EmailActor;scope:EmailScope;capability:EmailCapability;invitation:EmailCalendarInvitation;receiving_address:string;
  response:'accepted'|'tentative'|'declined';request_id:string;recheck:()=>Promise<void>;guard:EmailInvitationGuard;signal?:AbortSignal}>){
  const {scope,actor}=input;input.signal?.throwIfAborted();await input.recheck();
  const account=NativeEmailSendIdentitySchema.parse(await this.accounts.getSendIdentity(scope,input.capability,input.recheck,input.signal));
  const from=account.verified_sender_identities.find(value=>value.toLowerCase()===input.receiving_address.toLowerCase());
  if(!from||account.account_id!==scope.account_id||account.org_id!==scope.org_id||account.owner_user_id!==scope.owner_user_id||!account.capabilities.includes('send'))throw Error('EMAIL_INVITATION_SEND_UNAVAILABLE');
  const at=this.now(),draftId=randomUUID(),operationId=randomUUID(),outboxId=randomUUID();
  const content=EmailDraftContentSchema.parse({mode:'compose',to:input.invitation.organizer.address,cc:'',bcc:'',subject:`${input.response} invitation response`,body:`${input.response}: ${input.invitation.summary}`,
   body_html:'',reply_record_id:'',attachments:[],from_identity:{address:from}});
  const draft:EmailDraftRow={draft_id:draftId,revision:1,content_revision:1,status:'draft',content,origin:{kind:'human',created_by_user_id:actor.user_id,originating_run_id:null},last_edited_by_user_id:actor.user_id,created_at:at.toISOString(),updated_at:at.toISOString()};
  const ics=serializeEmailInvitationReply(input.invitation,[from],input.response,at);let captured:EmailSendSnapshotIdentity|undefined;
  const prepared=await this.snapshots.prepareAndBind({actor,scope,capability:input.capability,recheck:input.recheck,draft,operation_id:operationId,calendar_reply:{ics_text:ics,method:'REPLY'},signal:input.signal,
   reserve:async value=>{if(captured||value.operation_id!==operationId||value.account_id!==scope.account_id||value.scope.org_id!==scope.org_id||value.scope.owner_id!==scope.owner_user_id||value.scope.installation_id!==account.installation_id
    ||value.draft_id!==draftId||value.draft_revision!==1||value.authority_epoch!==account.authority_epoch)throw Error('EMAIL_INVITATION_OUTBOX_INVALID');captured=structuredClone(value);await input.recheck();return 'reserved';}});
  const inputCipher=this.cipher,inputOutbox=this.outbox;
  try{
   if(prepared.state!=='reserved'||!captured||!(prepared.mime_bytes instanceof Uint8Array)||!prepared.mime_digest)throw Error('EMAIL_INVITATION_OUTBOX_INVALID');
   const transport=EmailOutboxTransportSchema.parse(prepared.transport);
   if(transport.from_address!==from||identity(captured)!==identity(Object.fromEntries(Object.entries(transport).filter(([key])=>!['from_address','transport_kind','thread_id','envelope'].includes(key)))))throw Error('EMAIL_INVITATION_OUTBOX_INVALID');
   const fresh=NativeEmailSendIdentitySchema.parse(await this.accounts.getSendIdentity(scope,input.capability,input.recheck,input.signal));if(identity(account)!==identity(fresh))throw Error('EMAIL_INVITATION_SEND_UNAVAILABLE');await input.recheck();
   const bytes=prepared.mime_bytes,snapshot:EmailOutboxSnapshot={schema_version:'deft.email_outbox_snapshot.v1',request:{draft_id:draftId,expected_revision:1,request_id:input.request_id,undo_delay_seconds:10},
    identity:fresh,transport,mime_digest:prepared.mime_digest,byte_length:bytes.length,display:{subject:content.subject,to:content.to,cc:'',bcc:''},schedule:null,undo_until:new Date(this.now().getTime()+10000).toISOString()};
   return {outbox_id:outboxId,dispose:()=>bytes.fill(0),async enqueue(tx:EmailInvitationTransaction){
    await input.guard(tx);input.signal?.throwIfAborted();
    await tx.insert(emailDrafts).values({...scope,draft_id:draftId,revision:1,content_revision:1,status:'draft',origin:'human',origin_run_id:null,created_by_user_id:actor.user_id,last_edited_by_user_id:actor.user_id,
     content_envelope:inputCipher.seal(content,emailDraftContext(scope,draftId,1)),created_at:at,updated_at:at});
    const value=await inputOutbox.enqueueInTransaction(tx as unknown as EmailOutboxTransaction,scope,outboxId,snapshot,bytes,input.guard,input.signal);
    if(value.state!=='queued')throw Error('EMAIL_INVITATION_OUTBOX_INVALID');return {outbox_id:value.outbox_id,state:'queued' as const};
   }};
  }catch(error){prepared.mime_bytes?.fill(0);throw error;}
 }
}
