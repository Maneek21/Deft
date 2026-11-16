import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { files, scheduledMessages } from '@deft/db/schema';
import type { CoreDatabaseTransaction } from './database-transaction.js';
import { extractLegacyAttachmentIds } from './message-attachments.js';
import { stagedAttachmentExpiry, STAGED_ATTACHMENT_TTL_MS } from './attachment-retention.js';

/** Release cancelled uploads while preserving every other pending schedule's retention. */
export async function releaseScheduledMessageAttachments(
  tx: CoreDatabaseTransaction,
  params: { orgId: string; userId: string; attachmentIds: string[] },
): Promise<void> {
  if (params.attachmentIds.length === 0) return;
  const unclaimed = and(
    inArray(files.id, params.attachmentIds), eq(files.org_id, params.orgId), eq(files.uploaded_by, params.userId),
    isNull(files.message_id), isNull(files.task_id),
  );
  // Scheduling also updates these rows. Acquire their locks before taking the
  // next statement's snapshot, so a concurrently committed schedule is counted.
  await tx.select({ id: files.id }).from(files).where(unclaimed).orderBy(files.id).for('update');
  await tx.update(files).set({ staged_expires_at: sql`greatest(${stagedAttachmentExpiry()}, (
    SELECT max(pending.scheduled_for) + ${STAGED_ATTACHMENT_TTL_MS} * interval '1 millisecond'
    FROM ${scheduledMessages} AS pending
    WHERE pending.org_id = ${files.org_id} AND pending.user_id = ${files.uploaded_by}
      AND pending.status IN ('pending', 'sending')
      AND position(('[[file:' || ${files.id} || ':') in pending.content) > 0
  ))` }).where(unclaimed);
}

/**
 * Cancels the messages a person scheduled for a space and that have not been
 * sent yet, and releases their staged attachments, as the person's own cancel
 * (DELETE /api/scheduled-messages/:id) does. Used when the person leaves or is
 * removed from the space, after the membership row is gone. A message the send
 * worker has claimed at this moment is skipped, not waited for: the worker
 * re-checks membership before sending and cancels it itself.
 */
export async function cancelPendingScheduledMessagesForSpace(
  tx: CoreDatabaseTransaction,
  params: { orgId: string; spaceId: string; userId: string },
): Promise<number> {
  const pending = await tx.select({ id: scheduledMessages.id })
    .from(scheduledMessages)
    .where(and(
      eq(scheduledMessages.org_id, params.orgId),
      eq(scheduledMessages.space_id, params.spaceId),
      eq(scheduledMessages.user_id, params.userId),
      eq(scheduledMessages.status, 'pending'),
    ))
    .for('update', { skipLocked: true });
  if (pending.length === 0) return 0;
  const cancelled = await tx.update(scheduledMessages)
    .set({ status: 'cancelled' })
    .where(and(
      inArray(scheduledMessages.id, pending.map((row) => row.id)),
      eq(scheduledMessages.status, 'pending'),
    ))
    .returning({ content: scheduledMessages.content });
  const attachmentIds = Array.from(new Set(cancelled.flatMap((row) => extractLegacyAttachmentIds(row.content))));
  await releaseScheduledMessageAttachments(tx, { ...params, attachmentIds });
  return cancelled.length;
}
