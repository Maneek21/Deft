import { and, eq, inArray, isNull } from 'drizzle-orm';
import { files, scheduledMessages } from '@deft/db/schema';
import type { CoreDatabaseTransaction } from './database-transaction.js';
import { extractLegacyAttachmentIds } from './message-attachments.js';
import { stagedAttachmentExpiry } from './attachment-retention.js';

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
  if (attachmentIds.length > 0) {
    await tx.update(files)
      .set({ staged_expires_at: stagedAttachmentExpiry() })
      .where(and(
        inArray(files.id, attachmentIds),
        eq(files.org_id, params.orgId),
        eq(files.uploaded_by, params.userId),
        isNull(files.message_id),
        isNull(files.task_id),
      ));
  }
  return cancelled.length;
}
