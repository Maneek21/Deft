import type {EmailActor} from './email-mailbox-service.js';
import {EmailMailboxCrypto} from './email-mailbox-crypto.js';
import {EmailTemplateStore} from './email-template-store.js';
import {EmailTemplateService} from './email-template-service.js';
import {db} from './db.js';
import {getAppRunRuntime} from './app-run-runtime.js';
import {getEmailMailboxRuntime} from './email-mailbox-runtime.js';

/** Templates inherit only the verified human native-draft authority and the
 * existing retained App Run encryption keyring. */
export async function getEmailTemplateService(actor:EmailActor):Promise<EmailTemplateService>{
  const [{authority},{keys}]=await Promise.all([getEmailMailboxRuntime(actor),getAppRunRuntime()]);
  return new EmailTemplateService(authority,new EmailTemplateStore(db,new EmailMailboxCrypto(keys)));
}
