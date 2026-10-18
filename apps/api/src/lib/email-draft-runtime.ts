import type { EmailOperationActor } from './email-mailbox-service.js';
import { EmailMailboxCrypto } from './email-mailbox-crypto.js';
import { EmailDraftStore } from './email-draft-store.js';
import { EmailDraftService } from './email-draft-service.js';
import { db } from './db.js';
import { getAppRunRuntime } from './app-run-runtime.js';
import { getEmailMailboxRuntime } from './email-mailbox-runtime.js';

/** Native draft operations reuse the exact verified-human/native-consent
 * authority. No Experience lease or synthetic AI principal is introduced. */
export async function getEmailDraftRuntime(actor: EmailOperationActor): Promise<EmailDraftService> {
  const [{ authority }, { keys }] = await Promise.all([getEmailMailboxRuntime(actor), getAppRunRuntime()]);
  return new EmailDraftService(authority, new EmailDraftStore(db, new EmailMailboxCrypto(keys)));
}
