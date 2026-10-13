import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from './db.js';
import { enqueue, QUEUE_NAMES } from './queues.js';
import { emailAccounts } from '@deft/db/schema';
import {
  createEmailMailboxScheduler,
  EMAIL_MAILBOX_SYNC_JOB,
  EMAIL_MAILBOX_REARMABLE_FAILURES,
  EMAIL_MAILBOX_WORKER_SHUTDOWN_PATTERN,
  type EmailMailboxScheduleCursor,
} from './email-mailbox-scheduler.js';

let repairCursor: EmailMailboxScheduleCursor | null = null;

const scheduler = createEmailMailboxScheduler({
  enqueue: async (_queue, name, payload, options) => enqueue(QUEUE_NAMES.SCHEDULED_JOBS, name, payload, options),
  rearmFailed: async (_queue, name, payload, options) => {
    await enqueue(QUEUE_NAMES.SCHEDULED_JOBS, name, payload, options);
    const rearmed = await db.execute(sql`
      UPDATE job_queue
      SET status = 'pending', data = ${JSON.stringify(payload)}::jsonb,
          attempts = 0, max_attempts = ${options.maxAttempts}, run_at = now(),
          started_at = NULL, completed_at = NULL, error = NULL,
          locked_by = NULL, lock_token = NULL, lock_expires_at = NULL
      WHERE org_id = ${options.orgId}
        AND queue = ${QUEUE_NAMES.SCHEDULED_JOBS}
        AND name = ${EMAIL_MAILBOX_SYNC_JOB}
        AND dedupe_key = ${options.dedupeKey}
        AND status = 'failed'
        AND data = ${JSON.stringify(payload)}::jsonb
        AND EXISTS (
          SELECT 1 FROM email_accounts
          WHERE org_id = ${payload.org_id} AND owner_user_id = ${payload.owner_user_id}
            AND account_id = ${payload.account_id} AND authority_revision = ${payload.authority_revision}
            AND state = 'active' AND consented_at IS NOT NULL
            AND revoked_at IS NULL AND principal_digest IS NOT NULL
        )
        AND (
          -- A deployment shutdown is controlled interruption of read-only sync,
          -- not a provider failure. Repair it immediately under current scope.
          error ~ ${EMAIL_MAILBOX_WORKER_SHUTDOWN_PATTERN}
          OR (
            completed_at < now() - interval '5 minutes'
            AND error IN (${sql.join(EMAIL_MAILBOX_REARMABLE_FAILURES.map(value => sql`${value}`), sql`, `)})
          )
        )
      RETURNING id
    `);
    const rows = (rearmed as { rows?: unknown[] }).rows ?? [];
    return rows.length === 1 ? 'rearmed' : 'active';
  },
  scanActive: async (after: EmailMailboxScheduleCursor | null, limit: number) => {
    const conditions = [
      eq(emailAccounts.state, 'active'),
      isNotNull(emailAccounts.consented_at),
      isNull(emailAccounts.revoked_at),
      isNotNull(emailAccounts.principal_digest),
    ];
    if (after) conditions.push(sql`(${emailAccounts.org_id} COLLATE "C", ${emailAccounts.owner_user_id} COLLATE "C", ${emailAccounts.account_id} COLLATE "C") > (${after.org_id} COLLATE "C", ${after.owner_user_id} COLLATE "C", ${after.account_id} COLLATE "C")`);
    return db.select({
      org_id: emailAccounts.org_id,
      owner_user_id: emailAccounts.owner_user_id,
      account_id: emailAccounts.account_id,
      authority_revision: emailAccounts.authority_revision,
    }).from(emailAccounts)
      .where(and(...conditions))
      .orderBy(sql`${emailAccounts.org_id} COLLATE "C"`, sql`${emailAccounts.owner_user_id} COLLATE "C"`, sql`${emailAccounts.account_id} COLLATE "C"`)
      .limit(limit);
  },
});

/** Enqueue one server-owned account scope after adoption or authority revision. */
export function scheduleNativeEmailAccount(scope: Parameters<typeof scheduler.scheduleActiveAccount>[0]) {
  return scheduler.scheduleActiveAccount(scope);
}

/** Repair one bounded page of currently active accounts after process startup. */
export function resetNativeEmailSyncRepairCursor(): void {
  repairCursor = null;
}

/** A numeric-only call advances the process-local bounded repair cursor. Pass
 * an explicit cursor for externally checkpointed scans; null starts at the beginning. */
export async function repairNativeEmailSyncBatch(
  afterOrLimit?: EmailMailboxScheduleCursor | null | number,
  requestedLimit?: number,
) {
  const automatic = afterOrLimit === undefined || typeof afterOrLimit === 'number';
  const after = automatic ? repairCursor : afterOrLimit;
  const limit = typeof afterOrLimit === 'number' ? afterOrLimit : requestedLimit;
  const batch = await scheduler.repairBatch(after, limit);
  if (automatic) repairCursor = batch.done ? null : batch.next;
  return batch;
}
