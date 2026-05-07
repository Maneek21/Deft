import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { pinnedMessages, messages, users } from '@deft/db/schema';
import { getIO } from '../socket.js';
import { requireSpaceMembership } from '../lib/space-membership.js';

export const pinRoutes = new Hono();

// POST /api/spaces/:spaceId/pins — pin a message
pinRoutes.post('/:spaceId/pins', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.param('spaceId');
  const { message_id } = await c.req.json();

  if (!message_id) return c.json({ error: 'message_id required', code: 'VALIDATION_ERROR' }, 400);

  const isMember = await requireSpaceMembership(spaceId, user.id);
  if (!isMember) return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);

  const [msg] = await db.select({ id: messages.id, content: messages.content })
    .from(messages)
    .where(and(eq(messages.id, message_id), eq(messages.space_id, spaceId)))
    .limit(1);
  if (!msg) return c.json({ error: 'Message not found', code: 'NOT_FOUND' }, 404);

  const [existing] = await db.select({ id: pinnedMessages.id })
    .from(pinnedMessages)
    .where(and(eq(pinnedMessages.message_id, message_id), eq(pinnedMessages.space_id, spaceId)))
    .limit(1);
  if (existing) return c.json({ error: 'Already pinned', code: 'ALREADY_PINNED' }, 409);

  const [pin] = await db.insert(pinnedMessages).values({
    message_id, space_id: spaceId, pinned_by: user.id,
  }).returning();

  await db.update(messages).set({ is_pinned: true }).where(eq(messages.id, message_id));

  // Broadcast pin — no system message, just a socket event
  const io = getIO();
  if (io) {
    io.to(`space:${spaceId}`).emit('message:pinned', { message_id });
    // Also emit pins:updated so the pinned bar refreshes
    io.to(`space:${spaceId}`).emit('pins:updated', { space_id: spaceId });
  }

  return c.json(pin, 201);
});

// DELETE /api/spaces/:spaceId/pins/:messageId — unpin
pinRoutes.delete('/:spaceId/pins/:messageId', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.param('spaceId');
  const messageId = c.req.param('messageId');

  const isMember = await requireSpaceMembership(spaceId, user.id);
  if (!isMember) return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);

  await db.delete(pinnedMessages).where(and(eq(pinnedMessages.message_id, messageId), eq(pinnedMessages.space_id, spaceId)));
  await db.update(messages).set({ is_pinned: false }).where(eq(messages.id, messageId));

  const io = getIO();
  if (io) {
    io.to(`space:${spaceId}`).emit('message:unpinned', { message_id: messageId });
    io.to(`space:${spaceId}`).emit('pins:updated', { space_id: spaceId });
  }

  return c.json({ success: true });
});

// GET /api/spaces/:spaceId/pins — get all pinned messages
pinRoutes.get('/:spaceId/pins', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.param('spaceId');

  const isMember = await requireSpaceMembership(spaceId, user.id);
  if (!isMember) return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);

  const pins = await db.select({
    id: pinnedMessages.id,
    message_id: pinnedMessages.message_id,
    pinned_by: pinnedMessages.pinned_by,
    pinned_at: pinnedMessages.pinned_at,
    content: messages.content,
    user_id: messages.user_id,
    created_at: messages.created_at,
    author_name: users.name,
    author_avatar: users.avatar_url,
  })
    .from(pinnedMessages)
    .innerJoin(messages, eq(pinnedMessages.message_id, messages.id))
    .innerJoin(users, eq(messages.user_id, users.id))
    .where(eq(pinnedMessages.space_id, spaceId))
    .orderBy(desc(pinnedMessages.pinned_at));

  return c.json(pins);
});
