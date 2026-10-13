import {getEmailMailboxAuthority} from './email-account-authority-router.js';
import { db } from './db.js';
import { getAppRunRuntime } from './app-run-runtime.js';
import { EmailMailboxCrypto } from './email-mailbox-crypto.js';
import { PostgresEmailMailboxAuthority, type EmailServiceLease } from './email-mailbox-authority.js';
import { getEmailMailboxComponents } from './email-mailbox-runtime.js';
import { EmailTimerStore } from './email-timer-store.js';
import { EmailTimerWorker } from './email-timer-worker.js';
import type { EmailScope } from './email-mailbox-service.js';
import type { EmailTimerLease } from './email-timer-types.js';

/** Leased local timer execution. SQL authority and connected credential status
 * are checked before/after policy lookup; no provider mailbox write is possible. */
export async function dispatchNativeEmailTimer(scope: EmailScope, timerId: string, revision: number,
  authorityRevision: number, lease: EmailTimerLease, signal?: AbortSignal) {
  if (lease.job_name !== 'native-email-timers' || lease.timer_id !== timerId || lease.revision !== revision) throw Error('EMAIL_ACCESS_DENIED');
  const base = await getEmailMailboxAuthority(db);
  const current = (account: EmailScope, delivery: EmailServiceLease, tx?: unknown, abort?: AbortSignal) => base.currentService(account, delivery, tx, abort);
  const [{ provider }, { keys }] = await Promise.all([getEmailMailboxComponents((account, tx, abort) => current(account, lease, tx, abort)), getAppRunRuntime()]);
  const connected = async (account: EmailScope, capability: Parameters<typeof provider.assertConnected>[1], recheck: () => Promise<void>, abort?: AbortSignal) => {
    await provider.assertConnected(account, capability, recheck, abort);
  };
  const worker = new EmailTimerWorker(current, connected, new EmailTimerStore(db, new EmailMailboxCrypto(keys)));
  return worker.run(scope, timerId, revision, authorityRevision, lease, signal);
}
