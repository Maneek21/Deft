import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { users } from '@deft/db/schema';
import { getIO } from '../socket.js';

export const userStatusRoutes = new Hono();

// PATCH /api/users/status — set status
userStatusRoutes.patch('/status', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const { emoji, text, expires_at } = body;

  await db.update(users).set({
    status_emoji: emoji || null,
    status_text: text || null,
    status_expires_at: expires_at ? new Date(expires_at) : null,
  }).where(eq(users.id, user.id));

  // Broadcast status change
  const io = getIO();
  if (io) {
    io.to(`org:${user.org_id}`).emit('user:status_changed', {
      user_id: user.id,
      status_emoji: emoji || null,
      status_text: text || null,
    });
  }

  return c.json({ success: true });
});

// PATCH /api/users/dnd — set DND (uses status system)
userStatusRoutes.patch('/dnd', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const { enabled } = body;

  const emoji = enabled ? '🌙' : null;
  const text = enabled ? 'Do Not Disturb' : null;

  await db.update(users).set({
    status_emoji: emoji,
    status_text: text,
    status_expires_at: null,
  }).where(eq(users.id, user.id));

  const io = getIO();
  if (io) {
    io.to(`org:${user.org_id}`).emit('user:status_changed', {
      user_id: user.id,
      status_emoji: emoji,
      status_text: text,
      dnd: enabled,
    });
  }

  return c.json({ success: true, dnd: enabled });
});

// DELETE /api/users/status — clear status
userStatusRoutes.delete('/status', async (c) => {
  const user = c.get('user');

  await db.update(users).set({
    status_emoji: null,
    status_text: null,
    status_expires_at: null,
  }).where(eq(users.id, user.id));

  const io = getIO();
  if (io) {
    io.to(`org:${user.org_id}`).emit('user:status_changed', {
      user_id: user.id,
      status_emoji: null,
      status_text: null,
    });
  }

  return c.json({ success: true });
});
