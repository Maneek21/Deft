import type {EmailOperationActor} from './email-mailbox-service.js';
import {db} from './db.js';
import {getEmailMailboxRuntime} from './email-mailbox-runtime.js';
import {getAppRunRuntime} from './app-run-runtime.js';
import {EmailAttachmentService} from './email-attachment-service.js';
import {EmailAttachmentStore} from './email-attachment-store.js';
import {EmailAttachmentCrypto} from './email-attachment-crypto.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
export async function getEmailAttachmentService(actor:EmailOperationActor){
 const [{authority},{keys}]=await Promise.all([getEmailMailboxRuntime(actor),getAppRunRuntime()]);
 return new EmailAttachmentService(authority,new EmailAttachmentStore(db,new EmailMailboxCrypto(keys),new EmailAttachmentCrypto(keys)));
}
