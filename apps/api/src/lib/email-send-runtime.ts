import {getEmailMailboxAuthority} from './email-account-authority-router.js';
import type {EmailOperationActor} from './email-mailbox-service.js';
import {db} from './db.js';
import {getAppRunRuntime} from './app-run-runtime.js';
import {getEmailMailboxComponents} from './email-mailbox-runtime.js';
import {PostgresEmailMailboxAuthority} from './email-mailbox-authority.js';
import {ConnectedEmailMailboxAuthority} from './email-mailbox-connected-authority.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {EmailDraftStore} from './email-draft-store.js';
import {EmailSendStore} from './email-send-store.js';
import {EmailNativeSendService,EmailNativeSendError,type EmailSendSnapshotBuilder} from './email-native-send-service.js';
import {RegisteredEmailNativeSendProvider} from './email-native-send-provider.js';
import {createEmailNativeOutgoingSnapshotBuilder} from './email-native-outgoing-snapshot.js';
import {createEmailNativeReplyResolver} from './email-native-reply.js';
import {EmailMessageContentService} from './email-message-content.js';
import {getEmailAttachmentService} from './email-attachment-runtime.js';

/** Native human Send selects the deployed account adapter and its bundled MIME
 * serializer. No production dependency reaches into an examples checkout. */
export async function getEmailNativeSendComponents(actor:EmailOperationActor,options:Readonly<{outboxPreparation?:boolean}>={}){
 const base=await getEmailMailboxAuthority(db);
 const [{store,provider,resolve},{keys},attachments]=await Promise.all([
  getEmailMailboxComponents((scope,transaction,signal)=>base.current(actor,scope,'human_send',transaction,signal)),
  getAppRunRuntime(),getEmailAttachmentService(actor)]);
 const authority=new ConnectedEmailMailboxAuthority(base,provider),crypto=new EmailMailboxCrypto(keys),sender=new RegisteredEmailNativeSendProvider(resolve);
 const replies=createEmailNativeReplyResolver(store,new EmailMessageContentService(authority,store,provider));
 const snapshots:EmailSendSnapshotBuilder={async prepareAndBind(args){
  const selected=await resolve(args.scope,args.capability,args.recheck,args.signal,'send');await args.recheck();
  if(!selected.adapter.nativeEmailSnapshotFactory)throw new EmailNativeSendError('EMAIL_SEND_UNAVAILABLE');
  const sendAttachments={readForSend:attachments.readForSend.bind(attachments)};
  return createEmailNativeOutgoingSnapshotBuilder({accounts:sender,attachments:sendAttachments,replies,
   graphPreparation:options.outboxPreparation===true&&typeof selected.adapter.nativeEmailPrepareSend==='function',
   createOutgoingSnapshotService:selected.adapter.nativeEmailSnapshotFactory.bind(selected.adapter)}).prepareAndBind(args);
 }};
 return {authority,drafts:new EmailDraftStore(db,crypto),store:new EmailSendStore(db,crypto),snapshots,sender,crypto,keys};
}
export async function getEmailNativeSendService(actor:EmailOperationActor){
 const {authority,drafts,store,snapshots,sender}=await getEmailNativeSendComponents(actor);
 return new EmailNativeSendService(authority,drafts,store,snapshots,sender);
}
