import type { EmailServiceLease } from './email-mailbox-authority.js';
import { EmailMailboxError, type EmailCapability, type EmailScope } from './email-mailbox-service.js';
import { EmailTimerError, type EmailTimerLease } from './email-timer-types.js';
import { EmailTimerStore } from './email-timer-store.js';
import { explainNotificationPolicy } from './notification-policy.js';
import { syncNotificationToAttention } from './attention.js';
import { emitToUser } from '../socket.js';

type CurrentService = (scope: EmailScope, lease: EmailServiceLease, tx?: unknown, signal?: AbortSignal) => Promise<EmailCapability>;
type Connected = (scope: EmailScope, capability: EmailCapability, recheck: () => Promise<void>, signal?: AbortSignal) => Promise<void>;
const denied = () => new EmailMailboxError('EMAIL_ACCESS_DENIED');

/** Executes only local due-timer bookkeeping. It does not read message content
 * or mutate a provider mailbox. Follow-up notifications use the existing
 * calendar notification policy and a durable timer-specific dedupe key. */
export class EmailTimerWorker {
  constructor(private readonly currentService: CurrentService, private readonly connected: Connected,
    private readonly store: EmailTimerStore, private readonly now = () => new Date()) {}

  private async current(scope: EmailScope, lease: EmailTimerLease, expected?: EmailCapability,
    tx?: unknown, signal?: AbortSignal): Promise<EmailCapability> {
    signal?.throwIfAborted();
    const { lease_expires_at: _expires, ...jobLease } = lease;
    let capability: EmailCapability;
    try { capability = await this.currentService(scope, jobLease as EmailServiceLease, tx, signal); }
    catch (error) { if (signal?.aborted) throw error; throw denied(); }
    signal?.throwIfAborted();
    if (capability.scope.org_id !== scope.org_id || capability.scope.owner_user_id !== scope.owner_user_id
      || capability.scope.account_id !== scope.account_id || !Number.isFinite(capability.expires_at)
      || capability.expires_at <= this.now().getTime() || expected && (expected.authority_version !== capability.authority_version
        || expected.resource_binding_id !== capability.resource_binding_id)) throw denied();
    return capability;
  }

  async run(scope: EmailScope, timerId: string, revision: number, _authorityRevision: number,
    lease: EmailTimerLease, signal?: AbortSignal): Promise<{ state: 'completed' | 'stale' | 'waiting'; delay_ms?: number }> {
    if (lease.job_name !== 'native-email-timers' || lease.timer_id !== timerId || lease.revision !== revision
      || !lease.lease_expires_at || lease.lease_expires_at <= this.now()) throw denied();
    const initial = await this.current(scope, lease, undefined, undefined, signal);
    const recheck = async () => { await this.current(scope, lease, initial, undefined, signal); };
    try { await this.connected(scope, initial, recheck, signal); }
    catch (error) { if (signal?.aborted) throw error; throw denied(); }
    const guard = (tx: unknown) => this.current(scope, lease, initial, tx, signal).then(() => undefined);
    const currentTimer = await this.store.read(scope, timerId, guard, signal);
    if (!currentTimer || !(currentTimer.state === 'scheduled' && currentTimer.revision === revision)
      && !(currentTimer.state === 'firing' && currentTimer.revision === revision + 1)) return { state: 'stale' };
    const now = this.now().getTime();
    if (currentTimer.scheduled_at > new Date(now).toISOString()) {
      return { state: 'waiting', delay_ms: Date.parse(currentTimer.scheduled_at) - now };
    }
    const claimed = await this.store.claimDue(scope, timerId, revision, lease.job_id, lease.lock_token,
      lease.lease_expires_at!, guard, signal);
    let notification: Parameters<EmailTimerStore['completeFiring']>[7];
    if (claimed.kind === 'follow_up') {
      await recheck();
      const decision = await explainNotificationPolicy({ user_id: scope.owner_user_id, type: 'reminder' }, { channel: 'calendar' });
      if (decision.allowed) notification = { org_id: scope.org_id, user_id: scope.owner_user_id, title: 'Email follow-up',
        body: claimed.reminder_text ?? 'You scheduled a follow-up for an email.',
        delivery_policy: { reason: decision.reason, channel: decision.channel, evaluated_at: this.now().toISOString() } };
    }
    await recheck();
    const result = await this.store.completeFiring(scope, timerId, claimed.revision, lease.job_id, lease.lock_token,
      guard, signal, notification);
    if (result.notification) {
      await syncNotificationToAttention(result.notification).catch(() => undefined);
      emitToUser(scope.owner_user_id, 'notification:new', result.notification);
    }
    return { state: 'completed' };
  }
}
