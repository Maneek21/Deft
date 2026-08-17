import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { scheduledMessages } from '@deft/db/schema';
import { enqueue, QUEUE_NAMES } from '../lib/queues.js';
import { requireSpaceMembership } from '../lib/space-membership.js';

export const scheduledRoutes = new Hono();

const scheduleSchema = z.object({
  space_id: z.string().trim().min(1),
  content: z.string().trim().min(1),
  scheduled_for: z.string().min(1), // ISO date string
});

// POST /api/scheduled-messages — create scheduled message
scheduledRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = scheduleSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);

  const scheduledFor = new Date(parsed.data.scheduled_for);
  if (isNaN(scheduledFor.getTime()) || scheduledFor <= new Date()) {
    return c.json({ error: 'scheduled_for must be a valid future date', code: 'VALIDATION_ERROR' }, 400);
  }

  if (!(await requireSpaceMembership(parsed.data.space_id, user.id))) {
    return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);
  }

  const scheduled = await db.transaction(async (tx) => {
    const [created] = await tx.insert(scheduledMessages).values({
      org_id: user.org_id,
      user_id: user.id,
      space_id: parsed.data.space_id,
      content: parsed.data.content,
      scheduled_for: scheduledFor,
    }).returning();

    if (!created) throw new Error('Failed to create scheduled message');

    await enqueue(
      QUEUE_NAMES.SCHEDULED_JOBS,
      'scheduled-message-send',
      { scheduledId: created.id },
      {
        delay: Math.max(0, scheduledFor.getTime() - Date.now()),
        maxAttempts: 5,
        orgId: user.org_id,
        dedupeKey: `scheduled-message:${created.id}`,
        executor: tx,
      },
    );

    return created;
  });

  return c.json(scheduled, 201);
});

// GET /api/scheduled-messages — list pending scheduled messages
scheduledRoutes.get('/', async (c) => {
  const user = c.get('user');
  const pending = await db.select()
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.user_id, user.id), eq(scheduledMessages.status, 'pending')))
    .orderBy(scheduledMessages.scheduled_for);
  return c.json(pending);
});

// DELETE /api/scheduled-messages/:id — cancel
scheduledRoutes.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  await db.update(scheduledMessages)
    .set({ status: 'cancelled' })
    .where(and(
      eq(scheduledMessages.id, id),
      eq(scheduledMessages.user_id, user.id),
      eq(scheduledMessages.status, 'pending'),
    ));
  return c.json({ success: true });
});

export { sendScheduledMessage } from '../workers/handlers/scheduled-message-send.js';
