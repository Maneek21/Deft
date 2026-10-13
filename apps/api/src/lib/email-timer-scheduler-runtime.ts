import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from './db.js';
import { enqueue, enqueueOrRearmFailed, QUEUE_NAMES } from './queues.js';
import { emailAccounts, emailTimers } from '@deft/db/schema';
import { EMAIL_TIMER_JOB, type EmailTimerJob } from './email-timer-types.js';
import { createEmailTimerScheduler, emailTimerDedupeKey, EMAIL_TIMER_MAX_BATCH, type EmailTimerCursor } from './email-timer-scheduler.js';
import type { EmailScope } from './email-mailbox-service.js';
import type { EmailTimerView } from './email-timer-types.js';

const now = () => new Date();

/** Queue a just-written timer. Re-reading makes retries after a lost HTTP
 * acknowledgement idempotent and fences stale revisions. */
export async function scheduleNativeEmailTimer(scope: EmailScope, timer: EmailTimerView): Promise<void> {
  await db.transaction(async tx => {
    const [account] = await tx.select({ authority_revision: emailAccounts.authority_revision, state: emailAccounts.state,
      revoked_at: emailAccounts.revoked_at, consented_at: emailAccounts.consented_at }).from(emailAccounts).where(and(
      eq(emailAccounts.org_id, scope.org_id), eq(emailAccounts.owner_user_id, scope.owner_user_id), eq(emailAccounts.account_id, scope.account_id))).limit(1).for('share');
    const [row] = await tx.select().from(emailTimers).where(and(eq(emailTimers.org_id, scope.org_id), eq(emailTimers.owner_user_id, scope.owner_user_id),
      eq(emailTimers.account_id, scope.account_id), eq(emailTimers.timer_id, timer.timer_id))).limit(1).for('share');
    if (!account || account.state !== 'active' || account.revoked_at || !account.consented_at || !row || row.state !== 'scheduled'
      || row.revision !== timer.revision || row.scheduled_at.toISOString() !== timer.scheduled_at) return;
    const payload: EmailTimerJob = { ...scope, timer_id: row.timer_id, revision: row.revision, authority_revision: account.authority_revision };
    const dedupeKey = emailTimerDedupeKey(payload), delay = Math.max(0, row.scheduled_at.getTime() - now().getTime());
    await enqueueOrRearmFailed(QUEUE_NAMES.SCHEDULED_JOBS, EMAIL_TIMER_JOB, payload,
      { executor: tx, orgId: scope.org_id, dedupeKey, maxAttempts: 5, delay });
  });
}

const scheduler = createEmailTimerScheduler({
  async scanDue(after, limit) {
    const conditions = [eq(emailTimers.state, 'scheduled'), sql`${emailTimers.scheduled_at} <= now()`, eq(emailAccounts.state, 'active'),
      isNull(emailAccounts.revoked_at), isNotNull(emailAccounts.consented_at), isNotNull(emailAccounts.principal_digest)];
    if (after) conditions.push(sql`(${emailTimers.org_id} COLLATE "C",${emailTimers.owner_user_id} COLLATE "C",${emailTimers.account_id} COLLATE "C",${emailTimers.timer_id} COLLATE "C") > (${after.org_id} COLLATE "C",${after.owner_user_id} COLLATE "C",${after.account_id} COLLATE "C",${after.timer_id} COLLATE "C")`);
    const rows = await db.select({ org_id: emailTimers.org_id, owner_user_id: emailTimers.owner_user_id, account_id: emailTimers.account_id,
      timer_id: emailTimers.timer_id, revision: emailTimers.revision, authority_revision: emailAccounts.authority_revision,
      scheduled_at: emailTimers.scheduled_at }).from(emailTimers).innerJoin(emailAccounts, and(eq(emailTimers.org_id, emailAccounts.org_id),
      eq(emailTimers.owner_user_id, emailAccounts.owner_user_id), eq(emailTimers.account_id, emailAccounts.account_id)))
      .where(and(...conditions)).orderBy(sql`${emailTimers.org_id} COLLATE "C"`, sql`${emailTimers.owner_user_id} COLLATE "C"`,
        sql`${emailTimers.account_id} COLLATE "C"`, sql`${emailTimers.timer_id} COLLATE "C"`).limit(limit);
    return rows.map(row => ({ ...row, scheduled_at: row.scheduled_at.toISOString() }));
  },
  async schedule(scope, timerId, revision, authorityRevision, scheduledAt) {
    if (!Number.isFinite(scheduledAt.getTime())) throw new Error('EMAIL_TIMER_INVALID');
    const payload: EmailTimerJob = { ...scope, timer_id: timerId, revision, authority_revision: authorityRevision };
    const dedupeKey = emailTimerDedupeKey(payload), delay = Math.max(0, scheduledAt.getTime() - now().getTime());
    await enqueue(QUEUE_NAMES.SCHEDULED_JOBS, EMAIL_TIMER_JOB, payload, { orgId: scope.org_id, dedupeKey, maxAttempts: 5, delay });
    await db.execute(sql`UPDATE job_queue SET status='pending',data=${JSON.stringify(payload)}::jsonb,attempts=0,max_attempts=5,
      run_at=now()+(${delay} * interval '1 millisecond'),started_at=NULL,completed_at=NULL,error=NULL,locked_by=NULL,lock_token=NULL,lock_expires_at=NULL
      WHERE org_id=${scope.org_id} AND queue=${QUEUE_NAMES.SCHEDULED_JOBS} AND name=${EMAIL_TIMER_JOB} AND dedupe_key=${dedupeKey}
      AND status='failed' AND completed_at < now()-interval '5 minutes'
      AND error IN ('EMAIL_TIMER_UNAVAILABLE','stale: worker lease expired before settlement')`);
    return 'active';
  },
});

let repairCursor: EmailTimerCursor | null = null;
export function resetNativeEmailTimerRepairCursor(): void { repairCursor = null; }
export async function repairNativeEmailTimersBatch(afterOrLimit?: EmailTimerCursor | null | number, requestedLimit?: number) {
  const automatic = afterOrLimit === undefined || typeof afterOrLimit === 'number';
  const after = automatic ? repairCursor : afterOrLimit;
  const limit = typeof afterOrLimit === 'number' ? afterOrLimit : requestedLimit ?? EMAIL_TIMER_MAX_BATCH;
  const result = await scheduler.repairBatch(after, limit);
  if (automatic) repairCursor = result.done ? null : result.next;
  return result;
}
