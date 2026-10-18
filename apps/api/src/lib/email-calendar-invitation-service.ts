import {z} from 'zod';
import type {EmailActor,EmailAuthority,EmailCapability,EmailScope} from './email-mailbox-service.js';
import {EmailInvitationApplySchema} from './email-calendar-invitation-contract.js';
import {EmailInvitationPreviewService} from './email-calendar-invitation-preview.js';
import {EmailCalendarInvitationStore} from './email-calendar-invitation-store.js';
import {EmailCalendarReplyOutbox} from './email-calendar-reply-outbox.js';
const Id=z.string().min(1).max(256),Scope=z.strictObject({org_id:Id,owner_user_id:Id,account_id:Id}),Actor=z.strictObject({user_id:Id,web_session_id:Id,access_expires_at:z.number().finite()});
/** Deliberate owner Calendar actions. Preview/read never require provider Send;
 * an explicitly checked send_response alone prepares a durable RSVP Outbox. */
export class EmailCalendarInvitationService{
 constructor(private readonly authority:EmailAuthority,private readonly previews:EmailInvitationPreviewService,private readonly store:EmailCalendarInvitationStore,
  private readonly replies:Pick<EmailCalendarReplyOutbox,'prepare'>,private readonly now=Date.now){}
 preview(actor:EmailActor,scope:EmailScope,logicalId:string,signal?:AbortSignal){return this.previews.preview(actor,scope,logicalId,signal);}
 private async authorized(rawActor:EmailActor,rawScope:EmailScope,operation:'human_read'|'human_send',expected?:EmailCapability,signal?:AbortSignal){
  const actor=Actor.parse(rawActor),scope=Scope.parse(rawScope);
  const check=async(tx?:unknown)=>{
   signal?.throwIfAborted();if(actor.user_id!==scope.owner_user_id||actor.access_expires_at<=this.now())throw Error('EMAIL_INVITATION_ACCESS_DENIED');
   const cap=await this.authority.current(actor,scope,operation,tx,signal);
   if(cap.scope.org_id!==scope.org_id||cap.scope.owner_user_id!==scope.owner_user_id||cap.scope.account_id!==scope.account_id||!Number.isFinite(cap.expires_at)||cap.expires_at<=this.now()
    ||expected&&(cap.resource_binding_id!==expected.resource_binding_id||cap.authority_version!==expected.authority_version))throw Error('EMAIL_INVITATION_ACCESS_DENIED');signal?.throwIfAborted();return cap;
  };
  const cap=await check();expected=structuredClone(cap);return {actor,scope,cap,current:async()=>{await check();},guard:async(tx:unknown)=>{await check(tx);}};
 }
 async readRequest(actor:EmailActor,scope:EmailScope,requestId:string,signal?:AbortSignal){const a=await this.authorized(actor,scope,'human_read',undefined,signal);return this.store.readRequest(a.scope,requestId,a.guard,signal);}
 async apply(actor:EmailActor,scope:EmailScope,raw:unknown,signal?:AbortSignal){
  const input=EmailInvitationApplySchema.parse(raw),resolved=await this.previews.resolve(actor,scope,input.preview_token,signal);
  if(input.action.kind==='rsvp'?(resolved.invitation.method!=='REQUEST'||!resolved.attendee):resolved.invitation.method!=='CANCEL')throw Error('EMAIL_INVITATION_INVALID');
  const receivingAddress=resolved.attendee?.address??null;
  const sending=input.action.kind==='rsvp'&&input.action.send_response;
  const a=await this.authorized(resolved.actor,resolved.scope,sending?'human_send':'human_read',resolved.capability,signal);
  let prepared:Awaited<ReturnType<EmailCalendarReplyOutbox['prepare']>>|undefined;
  try{
   if(input.action.kind==='rsvp'&&input.action.send_response){
    prepared=await this.replies.prepare({actor:a.actor,scope:a.scope,capability:a.cap,invitation:resolved.invitation,receiving_address:receivingAddress!,
     response:input.action.response,request_id:input.request_id,recheck:a.current,guard:a.guard,signal});
   }
   // Preparation may await current sender/custody. Re-read the nomination's
   // exact message bytes before committing any Calendar/Outbox write.
   const fresh=await this.previews.resolve(a.actor,a.scope,input.preview_token,signal);await a.current();
   if(input.action.kind==='rsvp'&&(fresh.attendee?.address??null)!==receivingAddress)throw Error('EMAIL_INVITATION_PREVIEW_STALE');
   return await this.store.apply(a.scope,resolved.token.logical_message_id,resolved.invitation,input,receivingAddress,a.guard,prepared,signal);
  }finally{prepared?.dispose();}
 }
}
