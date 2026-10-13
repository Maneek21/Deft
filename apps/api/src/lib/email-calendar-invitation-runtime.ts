import type {EmailActor} from './email-mailbox-service.js';
import {db} from './db.js';
import {getAppRunRuntime} from './app-run-runtime.js';
import {getEmailMailboxRuntime} from './email-mailbox-runtime.js';
import {getEmailNativeSendComponents} from './email-send-runtime.js';
import {EmailMessageContentService} from './email-message-content.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {EmailOutboxCrypto} from './email-outbox-crypto.js';
import {EmailOutboxStore} from './email-outbox-store.js';
import {EmailInvitationPreviewService} from './email-calendar-invitation-preview.js';
import {EmailCalendarInvitationStore} from './email-calendar-invitation-store.js';
import {EmailCalendarReplyOutbox} from './email-calendar-reply-outbox.js';
import {EmailCalendarInvitationService} from './email-calendar-invitation-service.js';
/** Read-only preview resolves no Send capability/factory. Send components are
 * constructed only for an explicit send_response action after current Send. */
export async function getEmailCalendarInvitationService(actor:EmailActor){
 const [{authority,store,provider},{keys}]=await Promise.all([getEmailMailboxRuntime(actor),getAppRunRuntime()]);
 const cipher=new EmailMailboxCrypto(keys),content=new EmailMessageContentService(authority,store,provider);
 return new EmailCalendarInvitationService(authority,new EmailInvitationPreviewService(authority,content,cipher),new EmailCalendarInvitationStore(db,cipher),{
  async prepare(input){const {snapshots,sender,crypto,keys:sendKeys}=await getEmailNativeSendComponents(actor,{outboxPreparation:true});
   return new EmailCalendarReplyOutbox(snapshots,sender,new EmailOutboxStore(db,crypto,new EmailOutboxCrypto(sendKeys)),crypto).prepare(input);}
 });
}
