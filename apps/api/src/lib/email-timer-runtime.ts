import {getEmailMailboxAuthority} from './email-account-authority-router.js';
import { db } from './db.js';
import { getAppRunRuntime } from './app-run-runtime.js';
import { EmailMailboxCrypto } from './email-mailbox-crypto.js';
import { PostgresEmailMailboxAuthority } from './email-mailbox-authority.js';
import { ConnectedEmailMailboxAuthority } from './email-mailbox-connected-authority.js';
import { getEmailMailboxComponents } from './email-mailbox-runtime.js';
import { EmailTimerStore } from './email-timer-store.js';
import { EmailTimerService } from './email-timer-service.js';
import type { EmailActor, EmailListRequest, EmailScope } from './email-mailbox-service.js';
import { scheduleNativeEmailTimer } from './email-timer-scheduler-runtime.js';

/** Owner timer access uses the same verified owner/session account gate as
 * native mailbox actions. Provider connectivity checks run outside SQL locks;
 * only the SQL authority is passed as the transaction guard. */
export async function getEmailTimerService(actor: EmailActor): Promise<EmailTimerService> {
  const base = await getEmailMailboxAuthority(db);
  const [{ provider }, { keys }] = await Promise.all([
    getEmailMailboxComponents((scope, transaction, signal) => base.current(actor, scope, 'human_read', transaction, signal)),
    getAppRunRuntime(),
  ]);
  return new EmailTimerService(new ConnectedEmailMailboxAuthority(base, provider), base,
    new EmailTimerStore(db, new EmailMailboxCrypto(keys)), Date.now, scheduleNativeEmailTimer);
}

/** Route dependency for Inbox list assembly. The timer store only excludes
 * future local snoozes; the ordinary mailbox cursor still advances over the
 * scanned provider-cache page, so a page may contain fewer than its limit. */
export async function getEmailTimerAwareMailboxService(actor: EmailActor) {
  const [{ service: mailbox }, timers] = await Promise.all([
    import('./email-mailbox-runtime.js').then(module => module.getEmailMailboxRuntime(actor)),
    getEmailTimerService(actor),
  ]);
  return { list: async (human: EmailActor, scope: EmailScope, request: EmailListRequest, signal?: AbortSignal) => {
    const page = await mailbox.list(human, scope, request, signal);
    if (request.folder.trim().toLowerCase() !== 'inbox' || page.items.length === 0) return page;
    const hidden = await timers.hiddenInboxMessageIds(human, scope, page.items.map(item => item.logical_message_id), signal);
    const items = page.items.filter(item => !hidden.has(item.logical_message_id));
    return { ...page, items, count: { returned: items.length, exact_total: hidden.size ? null : page.count.exact_total } };
  } };
}
