/**
 * Handler: reminder-fire — scheduled-jobs queue handler that fires a single
 * reminder row. Replaces the in-process `setTimeout` path in routes/reminders.ts
 * so sub-24h (and longer) reminders survive API restarts.
 *
 * On boot, `rehydratePendingReminders` scans for reminders with remind_at in
 * the future + is_sent=false and re-enqueues each as a delayed job so anything
 * scheduled before the restart fires as expected.
 *
 * Block 0 Task 0.4 of OpenClaw Unlock plan.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../lib/db.js';
import { reminders } from '@deft/db/schema';
import { emitToUser } from '../../socket.js';
import { enqueue, QUEUE_NAMES } from '../../lib/queues.js';
import type { JobData } from '../types.js';
import { createNotificationIfAllowed } from '../../lib/notification-policy.js';
import { loadVisibleReminderSource } from '../../lib/reminder-source.js';

export type ReminderFirePayload = { reminderId: string };

export async function reminderFireHandler(job: JobData): Promise<void> {
  const { reminderId } = (job.data as ReminderFirePayload) ?? {};
  if (!reminderId) return;

  const [reminder] = await db
    .select()
    .from(reminders)
    .where(eq(reminders.id, reminderId))
    .limit(1);
  if (!reminder) {
    // cancelled / deleted before fire
    return;
  }
  if (reminder.is_sent) {
    // already fired (idempotent no-op)
    return;
  }

  let title = reminder.message.slice(0, 200);
  let link: string | undefined;
  if (reminder.source_message_id) {
    const source = await loadVisibleReminderSource({
      sourceMessageId: reminder.source_message_id,
      orgId: reminder.org_id,
      userId: reminder.user_id,
    });
    if (!source) {
      // Access was revoked or the source was deleted after scheduling. Consume
      // the reminder without surfacing its historical cached text.
      await db
        .update(reminders)
        .set({ is_sent: true, message: 'Message reminder' })
        .where(and(
          eq(reminders.id, reminderId),
          eq(reminders.org_id, reminder.org_id),
          eq(reminders.user_id, reminder.user_id),
          eq(reminders.is_sent, false),
        ));
      return;
    }
    // Notifications outlive source-space membership. Keep the durable
    // notification generic and let the destination route enforce access.
    title = 'Message reminder';
    link = `/chat?message=${source.messageId}`;
  }

  // Insert the notification.
  const notif = await createNotificationIfAllowed({
    org_id: reminder.org_id,
    user_id: reminder.user_id,
    type: 'reminder',
    title,
    link,
    metadata: { reminder_id: reminder.id },
  }, { channel: 'calendar', onConflictDoNothing: true });

  // Mark the reminder fired.
  await db
    .update(reminders)
    .set({ is_sent: true })
    .where(and(
      eq(reminders.id, reminderId),
      eq(reminders.org_id, reminder.org_id),
      eq(reminders.user_id, reminder.user_id),
      eq(reminders.is_sent, false),
    ));

  if (notif) {
    emitToUser(reminder.user_id, 'notification:new', notif);
  }
}

/**
 * Rehydrate pending reminders on server start. Scans for is_sent=false rows
 * and enqueues each as a delayed job. Stable queue dedupe keys make this safe
 * to repeat on every boot, including for reminders more than 30 days away.
 */
export async function rehydratePendingReminders(): Promise<number> {
  const now = Date.now();
  const pending = await db
    .select()
    .from(reminders)
    .where(eq(reminders.is_sent, false));

  for (const r of pending) {
    const delay = Math.max(0, r.remind_at.getTime() - now);
    await enqueue(
      QUEUE_NAMES.SCHEDULED_JOBS,
      'reminder-fire',
      { reminderId: r.id },
      {
        delay,
        orgId: r.org_id,
        dedupeKey: `reminder:${r.id}`,
      },
    );
  }

  if (pending.length > 0) {
    console.log(
      `[reminder-fire] rehydrated ${pending.length} pending reminder(s) on boot`,
    );
  }
  return pending.length;
}
