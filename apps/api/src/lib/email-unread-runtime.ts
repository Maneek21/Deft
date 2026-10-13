import type { EmailActor } from './email-mailbox-service.js';
import { getEmailMailboxRuntime } from './email-mailbox-runtime.js';
import { getEmailTimerService } from './email-timer-runtime.js';
import { EmailUnreadService } from './email-unread.js';

/** Connected current authority and the durable local-snooze projection are
 * both reused; account IDs remain nominations that must pass owner authority. */
export async function getEmailUnreadService(actor: EmailActor) {
  const [{ authority, store }, timers] = await Promise.all([
    getEmailMailboxRuntime(actor), getEmailTimerService(actor),
  ]);
  return new EmailUnreadService(authority, store, async (scope, signal) =>
    timers.futureInboxMessageIds(actor, scope, signal));
}
