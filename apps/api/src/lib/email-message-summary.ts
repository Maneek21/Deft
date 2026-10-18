import {z} from 'zod';
import {EmailMailboxError,EmailMessageRecordSchema,type EmailActor,type EmailAuthority,type EmailScope,type EmailCapability} from './email-mailbox-service.js';
import type {EmailMessageContentStore} from './email-message-content.js';
const Id=z.string().min(1).max(256).refine(v=>v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f]/u.test(v));
/** Exact cached public metadata only. No MIME/provider request and no private
 * provider source is returned; IDs remain owner-scoped nominations. */
export class EmailMessageSummaryService{
 constructor(private readonly authority:EmailAuthority,private readonly store:EmailMessageContentStore,private readonly now=Date.now){}
 async read(rawActor:EmailActor,rawScope:EmailScope,rawId:string,signal?:AbortSignal){
  const actor=z.strictObject({user_id:Id,web_session_id:Id,access_expires_at:z.number().finite()}).parse(rawActor),scope=z.strictObject({org_id:Id,owner_user_id:Id,account_id:Id}).parse(rawScope),id=z.string().regex(/^mail_[a-f0-9]{64}$/u).parse(rawId);
  const current=async(expected?:EmailCapability)=>{signal?.throwIfAborted();if(actor.user_id!==scope.owner_user_id||actor.access_expires_at<=this.now())throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
   const cap=await this.authority.current(actor,scope,'human_read',undefined,signal);signal?.throwIfAborted();if(actor.access_expires_at<=this.now()||!Number.isFinite(cap.expires_at)||cap.expires_at<=this.now()||cap.scope.org_id!==scope.org_id||cap.scope.owner_user_id!==scope.owner_user_id||cap.scope.account_id!==scope.account_id||!Id.safeParse(cap.authority_version).success||!Id.safeParse(cap.resource_binding_id).success||expected&&(expected.authority_version!==cap.authority_version||expected.resource_binding_id!==cap.resource_binding_id))throw new EmailMailboxError('EMAIL_ACCESS_DENIED');return cap;
  };
  const first=await current(),raw=await this.store.readMessage(scope,id,signal);await current(first);if(raw===null)return null;
  const parsed=EmailMessageRecordSchema.safeParse(raw);if(!parsed.success)throw new EmailMailboxError('EMAIL_PAGE_INVALID');const row=parsed.data;if(row.account_id!==scope.account_id||row.logical_message_id!==id)throw new EmailMailboxError('EMAIL_ACCESS_DENIED');
  const {logical_message_id,revision,received_at,folders,flags,data}=row;return {account_id:scope.account_id,logical_message_id,revision,received_at,folders,flags,data};
 }
}
