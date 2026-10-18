import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from './db.js';
import { enqueue, QUEUE_NAMES } from './queues.js';
import { emailAccounts } from '@deft/db/schema';
import { emailNotificationEvents } from '../../../../packages/db/src/email-notification-schema.js';
import { EMAIL_NOTIFICATION_JOB, type EmailNotificationJob } from './email-notification.js';
import { createEmailNotificationRepairScheduler, type EmailNotificationRepairCursor } from './email-notification-scheduler.js';

const scheduler = createEmailNotificationRepairScheduler({
  async scan(after, limit) {
    const rows = await db.select({ org_id: emailNotificationEvents.org_id, owner_user_id: emailNotificationEvents.owner_user_id,
      account_id: emailNotificationEvents.account_id, notification_id: emailNotificationEvents.notification_id,
      revision: emailNotificationEvents.revision, authority_revision: emailNotificationEvents.authority_revision })
      .from(emailNotificationEvents).where(and(eq(emailNotificationEvents.state, 'pending'),
        after ? sql`(${emailNotificationEvents.org_id} COLLATE "C",${emailNotificationEvents.owner_user_id} COLLATE "C",${emailNotificationEvents.account_id} COLLATE "C",${emailNotificationEvents.notification_id}) > (${after.org_id} COLLATE "C",${after.owner_user_id} COLLATE "C",${after.account_id} COLLATE "C",${after.notification_id}::uuid)` : sql`true`,
        sql`NOT EXISTS (SELECT 1 FROM job_queue q WHERE q.org_id=${emailNotificationEvents.org_id}
          AND q.queue=${QUEUE_NAMES.SCHEDULED_JOBS} AND q.name=${EMAIL_NOTIFICATION_JOB}
          AND q.dedupe_key='email-notification:'||${emailNotificationEvents.notification_id}::text||':'||${emailNotificationEvents.revision}::text)`))
      .orderBy(sql`${emailNotificationEvents.org_id} COLLATE "C"`, sql`${emailNotificationEvents.owner_user_id} COLLATE "C"`,
        sql`${emailNotificationEvents.account_id} COLLATE "C"`, emailNotificationEvents.notification_id).limit(limit);
    return rows;
  },
  async repair(candidate) {
    return db.transaction(async tx => {
      const [event] = await tx.select().from(emailNotificationEvents).where(and(eq(emailNotificationEvents.org_id, candidate.org_id),
        eq(emailNotificationEvents.owner_user_id, candidate.owner_user_id), eq(emailNotificationEvents.account_id, candidate.account_id),
        eq(emailNotificationEvents.notification_id, candidate.notification_id))).limit(1).for('update');
      if (!event || event.state !== 'pending' || event.revision !== candidate.revision
        || event.authority_revision !== candidate.authority_revision) return 'skipped' as const;
      const [account] = await tx.select({ state: emailAccounts.state, revoked_at: emailAccounts.revoked_at,
        consented_at: emailAccounts.consented_at, principal_digest: emailAccounts.principal_digest,
        authority_revision: emailAccounts.authority_revision }).from(emailAccounts).where(and(
        eq(emailAccounts.org_id, candidate.org_id), eq(emailAccounts.owner_user_id, candidate.owner_user_id),
        eq(emailAccounts.account_id, candidate.account_id))).limit(1).for('share');
      if (!account || account.state !== 'active' || account.revoked_at !== null || !account.consented_at
        || !account.principal_digest || account.authority_revision !== event.authority_revision) {
        await tx.update(emailNotificationEvents).set({ state: 'suppressed' }).where(and(
          eq(emailNotificationEvents.org_id, candidate.org_id), eq(emailNotificationEvents.owner_user_id, candidate.owner_user_id),
          eq(emailNotificationEvents.account_id, candidate.account_id), eq(emailNotificationEvents.notification_id, candidate.notification_id),
          eq(emailNotificationEvents.revision, candidate.revision), eq(emailNotificationEvents.state, 'pending')));
        return 'suppressed' as const;
      }
      const payload: EmailNotificationJob = { org_id: candidate.org_id, owner_user_id: candidate.owner_user_id,
        account_id: candidate.account_id, notification_id: candidate.notification_id, revision: candidate.revision,
        authority_revision: event.authority_revision };
      await enqueue(QUEUE_NAMES.SCHEDULED_JOBS, EMAIL_NOTIFICATION_JOB, payload, { executor: tx, orgId: candidate.org_id,
        dedupeKey: `email-notification:${candidate.notification_id}:${candidate.revision}`, maxAttempts: 5 });
      return 'queued' as const;
    });
  },
});

let repairCursor: EmailNotificationRepairCursor | null = null;
export function resetNativeEmailNotificationRepairCursor(): void { repairCursor = null; }
export async function repairNativeEmailNotificationsBatch(after: EmailNotificationRepairCursor | null = repairCursor, limit = 100) {
  const result = await scheduler.repairBatch(after, limit);
  if (after === repairCursor) repairCursor = result.done ? null : result.next;
  return result;
}
