import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { reminders } from '@deft/db/schema';
import { enqueue, QUEUE_NAMES } from '../lib/queues.js';
import { loadVisibleReminderSource } from '../lib/reminder-source.js';

export const reminderRoutes = new Hono();

const reminderSchema = z.object({
  content: z.string().min(1).max(4000).optional(),
  remind_at: z.string().min(1),
  source_message_id: z.string().optional(),
}).refine((value) => Boolean(value.content || value.source_message_id), {
  message: 'content or source_message_id is required',
});

// POST /api/reminders — create a reminder
reminderRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = reminderSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);

  const remindAt = new Date(parsed.data.remind_at);
  if (isNaN(remindAt.getTime()) || remindAt <= new Date()) {
    return c.json({ error: 'remind_at must be a valid future time', code: 'VALIDATION_ERROR' }, 400);
  }

  let reminderContent: string;
  if (parsed.data.source_message_id) {
    const sourceMessage = await loadVisibleReminderSource({
      sourceMessageId: parsed.data.source_message_id,
      orgId: user.org_id,
      userId: user.id,
    });

    if (!sourceMessage) {
      return c.json({ error: 'Message not found', code: 'NOT_FOUND' }, 404);
    }

    reminderContent = sourceMessage.preview;
  } else {
    reminderContent = parsed.data.content!;
  }

  const reminder = await db.transaction(async (tx) => {
    const [created] = await tx.insert(reminders).values({
      org_id: user.org_id,
      user_id: user.id,
      // Never persist a copy of source message text. Resolve it against current
      // membership and deletion state whenever it is read or fired.
      message: parsed.data.source_message_id ? 'Message reminder' : reminderContent,
      remind_at: remindAt,
      source_message_id: parsed.data.source_message_id || undefined,
    }).returning();

    if (!created) throw new Error('Failed to create reminder');

    // Commit the reminder and its durable job together. The stable dedupe key
    // also makes boot-time rehydration safe to repeat.
    await enqueue(
      QUEUE_NAMES.SCHEDULED_JOBS,
      'reminder-fire',
      { reminderId: created.id },
      {
        delay: Math.max(0, remindAt.getTime() - Date.now()),
        orgId: user.org_id,
        dedupeKey: `reminder:${created.id}`,
        executor: tx,
      },
    );

    return created;
  });

  return c.json({ ...reminder, message: reminderContent }, 201);
});

// GET /api/reminders — list pending reminders
reminderRoutes.get('/', async (c) => {
  const user = c.get('user');
  const pending = await db.select()
    .from(reminders)
    .where(and(
      eq(reminders.org_id, user.org_id),
      eq(reminders.user_id, user.id),
      eq(reminders.is_sent, false),
    ))
    .orderBy(reminders.remind_at);
  const visible: typeof pending = [];
  for (const reminder of pending) {
    if (!reminder.source_message_id) {
      visible.push(reminder);
      continue;
    }
    const source = await loadVisibleReminderSource({
      sourceMessageId: reminder.source_message_id,
      orgId: reminder.org_id,
      userId: reminder.user_id,
    });
    if (source) visible.push({ ...reminder, message: source.preview });
  }
  return c.json(visible);
});

// DELETE /api/reminders/:id — cancel
reminderRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  // Just delete it — if the timeout fires, it will find is_sent or missing and skip
  await db.delete(reminders).where(and(
    eq(reminders.id, id),
    eq(reminders.org_id, user.org_id),
    eq(reminders.user_id, user.id),
  ));
  return c.json({ success: true });
});

// Firing logic moved to apps/api/src/workers/handlers/reminder-fire.ts
// (Block 0 Task 0.4 — reminders → durable queue).
