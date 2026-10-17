import { db } from './db.js';
import { getEmailMailboxAuthority } from './email-account-authority-router.js';
import { EmailNotificationDispatcher } from './email-notification.js';

/** Durable notification jobs use the real exact-scope queue lease; no human
 * session, provider access, or synthetic actor is introduced. */
export async function getEmailNotificationDispatcher() {
  const authority = await getEmailMailboxAuthority(db);
  return new EmailNotificationDispatcher(db, (scope, lease, transaction, signal) =>
    authority.currentService(scope, lease, transaction, signal));
}
