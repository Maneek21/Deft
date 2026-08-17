import { and, asc, eq, sql } from 'drizzle-orm';
import { messages, scheduledMessages, users } from '@deft/db/schema';
import { db } from '../../lib/db.js';
import { enqueue, QUEUE_NAMES } from '../../lib/queues.js';
import { getIO } from '../../socket.js';
import type { JobData } from '../types.js';

type ScheduledMessageJobData = {
  scheduledId?: unknown;
};

/**
 * Sends one scheduled message exactly once at the database layer.
 *
 * The pending -> sending claim, message insert, and sent transition share one
 * transaction. A crash rolls the claim back; a retry after commit observes the
 * terminal status and becomes a no-op. Socket delivery remains best-effort —
 * clients recover the committed message through the normal history fetch.
 */
export async function sendScheduledMessage(scheduledId: string): Promise<boolean> {
  const result = await db.transaction(async (tx) => {
    const [scheduled] = await tx
      .update(scheduledMessages)
      .set({ status: 'sending' })
      .where(and(
        eq(scheduledMessages.id, scheduledId),
        eq(scheduledMessages.status, 'pending'),
      ))
      .returning();

    if (!scheduled) return null;

    // Permission revocation is an immediate boundary. Lock the current space,
    // space-membership, and active org-membership rows so a concurrent removal
    // is ordered either before this check (delivery is cancelled) or after the
    // message transaction commits.
    const accessResult = await tx.execute(sql`
      SELECT 1
      FROM space_members AS sm
      INNER JOIN spaces AS s
        ON s.id = sm.space_id
      INNER JOIN org_members AS om
        ON om.org_id = s.org_id
       AND om.user_id = sm.user_id
      WHERE sm.space_id = ${scheduled.space_id}
        AND sm.user_id = ${scheduled.user_id}
        AND s.org_id = ${scheduled.org_id}
        AND s.is_archived = false
        AND om.is_active = true
      LIMIT 1
      FOR SHARE OF sm, s, om
    `);
    const accessRows = (accessResult as { rows?: unknown[] }).rows
      ?? (Array.isArray(accessResult) ? accessResult : []);
    if (accessRows.length === 0) {
      await tx
        .update(scheduledMessages)
        .set({ status: 'cancelled' })
        .where(and(
          eq(scheduledMessages.id, scheduledId),
          eq(scheduledMessages.status, 'sending'),
        ));
      return null;
    }

    const [message] = await tx
      .insert(messages)
      .values({
        org_id: scheduled.org_id,
        space_id: scheduled.space_id,
        user_id: scheduled.user_id,
        content: scheduled.content,
      })
      .returning();

    if (!message) throw new Error('Failed to persist scheduled message');

    await tx
      .update(scheduledMessages)
      .set({ status: 'sent', sent_at: new Date() })
      .where(and(
        eq(scheduledMessages.id, scheduledId),
        eq(scheduledMessages.status, 'sending'),
      ));

    return {
      message,
      spaceId: scheduled.space_id,
      userId: scheduled.user_id,
    };
  });

  if (!result) return false;

  const [user] = await db
    .select({ name: users.name, avatar_url: users.avatar_url })
    .from(users)
    .where(eq(users.id, result.userId))
    .limit(1);

  getIO()?.to(`space:${result.spaceId}`).emit('message:new', {
    ...result.message,
    user_name: user?.name,
    user_avatar: user?.avatar_url,
  });

  return true;
}

export async function handleScheduledMessageSend(job: JobData): Promise<void> {
  const { scheduledId } = job.data as ScheduledMessageJobData;
  if (typeof scheduledId !== 'string' || scheduledId.length === 0) {
    throw new Error('scheduled-message-send requires data.scheduledId');
  }
  await sendScheduledMessage(scheduledId);
}

/**
 * Backfills durable jobs for pending rows created by the legacy in-process
 * timer implementation or interrupted during an older deployment.
 */
export async function rehydratePendingScheduledMessages(): Promise<number> {
  const pending = await db
    .select({
      id: scheduledMessages.id,
      orgId: scheduledMessages.org_id,
      scheduledFor: scheduledMessages.scheduled_for,
    })
    .from(scheduledMessages)
    .where(eq(scheduledMessages.status, 'pending'))
    .orderBy(asc(scheduledMessages.scheduled_for));

  for (const scheduled of pending) {
    await enqueue(
      QUEUE_NAMES.SCHEDULED_JOBS,
      'scheduled-message-send',
      { scheduledId: scheduled.id },
      {
        delay: Math.max(0, scheduled.scheduledFor.getTime() - Date.now()),
        maxAttempts: 5,
        orgId: scheduled.orgId,
        dedupeKey: `scheduled-message:${scheduled.id}`,
      },
    );
  }

  return pending.length;
}
