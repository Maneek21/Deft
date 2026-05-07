import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { reminders } from '@deft/db/schema';
import { enqueue, QUEUE_NAMES } from '../lib/queues.js';

export const reminderRoutes = new Hono();

const reminderSchema = z.object({
  content: z.string().min(1),
  remind_at: z.string().min(1),
  source_message_id: z.string().optional(),
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

  const [reminder] = await db.insert(reminders).values({
    org_id: user.org_id,
    user_id: user.id,
    message: parsed.data.content,
    remind_at: remindAt,
    source_message_id: parsed.data.source_message_id || undefined,
  }).returning();

  // Schedule firing via the scheduled-jobs queue. The Postgres-backed queue
  // persists across restarts, and rehydratePendingReminders() at boot
  // re-enqueues anything missed. Handler is idempotent (no-op when is_sent=true).
  const delay = Math.max(0, remindAt.getTime() - Date.now());
  await enqueue(
    QUEUE_NAMES.SCHEDULED_JOBS,
    'reminder-fire',
    { reminderId: reminder!.id },
    { delay },
  );

  return c.json(reminder, 201);
});

// GET /api/reminders — list pending reminders
reminderRoutes.get('/', async (c) => {
  const user = c.get('user');
  const pending = await db.select()
    .from(reminders)
    .where(and(eq(reminders.user_id, user.id), eq(reminders.is_sent, false)))
    .orderBy(reminders.remind_at);
  return c.json(pending);
});

// DELETE /api/reminders/:id — cancel
reminderRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  // Just delete it — if the timeout fires, it will find is_sent or missing and skip
  await db.delete(reminders).where(and(eq(reminders.id, id), eq(reminders.user_id, user.id)));
  return c.json({ success: true });
});

// Firing logic moved to apps/api/src/workers/handlers/reminder-fire.ts
// (Block 0 Task 0.4 — reminders → durable queue).
