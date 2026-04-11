import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { scheduledMessages, messages, users } from '@deft/db/schema';
import { getIO } from '../socket.js';

export const scheduledRoutes = new Hono();

const scheduleSchema = z.object({
  space_id: z.string().min(1),
  content: z.string().min(1),
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

  const [scheduled] = await db.insert(scheduledMessages).values({
    org_id: user.org_id,
    user_id: user.id,
    space_id: parsed.data.space_id,
    content: parsed.data.content,
    scheduled_for: scheduledFor,
  }).returning();

  // Set a timeout to send (in-process for simplicity — BullMQ would be better for production)
  const delay = scheduledFor.getTime() - Date.now();
  if (delay > 0 && delay < 24 * 60 * 60 * 1000) { // Only for messages within 24h
    setTimeout(async () => {
      try {
        await sendScheduledMessage(scheduled!.id, user.id, user.org_id);
      } catch (err) {
        console.error('Failed to send scheduled message:', err);
      }
    }, delay);
  }

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
    .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.user_id, user.id)));
  return c.json({ success: true });
});

// Helper: actually send a scheduled message
async function sendScheduledMessage(scheduledId: string, userId: string, orgId: string) {
  const [scheduled] = await db.select().from(scheduledMessages)
    .where(and(eq(scheduledMessages.id, scheduledId), eq(scheduledMessages.status, 'pending')))
    .limit(1);

  if (!scheduled) return; // Already cancelled or sent

  // Insert as regular message
  const [msg] = await db.insert(messages).values({
    org_id: orgId,
    space_id: scheduled.space_id,
    user_id: userId,
    content: scheduled.content,
  }).returning();

  // Update scheduled record
  await db.update(scheduledMessages)
    .set({ status: 'sent', sent_at: new Date() })
    .where(eq(scheduledMessages.id, scheduledId));

  // Broadcast
  const [userData] = await db.select({ name: users.name, avatar_url: users.avatar_url })
    .from(users).where(eq(users.id, userId)).limit(1);

  const io = getIO();
  if (io && msg) {
    io.to(`space:${scheduled.space_id}`).emit('message:new', {
      ...msg, user_name: userData?.name, user_avatar: userData?.avatar_url,
    });
  }
}

// Export for use in a startup scheduler
export { sendScheduledMessage };
