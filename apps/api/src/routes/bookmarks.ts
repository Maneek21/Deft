import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { messageBookmarks, messages, users, spaces } from '@deft/db/schema';
import { loadMessageForMember, loadMessagesForMember } from '../lib/space-membership.js';

const MESSAGE_NOT_FOUND = { error: 'Message not found', code: 'NOT_FOUND' } as const;

export const bookmarkRoutes = new Hono();

// GET /api/bookmarks — list current user's saved messages in the active org.
// A bookmark whose message the caller can no longer read is omitted.
bookmarkRoutes.get('/', async (c) => {
  const user = c.get('user');

  const saved = await db.select({
    id: messageBookmarks.id,
    message_id: messageBookmarks.message_id,
    space_id: messages.space_id,
    created_at: messageBookmarks.created_at,
    message_content: messages.content,
    message_created_at: messages.created_at,
    author_name: users.name,
    author_id: messages.user_id,
    space_name: spaces.name,
  })
    .from(messageBookmarks)
    .innerJoin(messages, and(eq(messageBookmarks.message_id, messages.id), eq(messages.org_id, user.org_id)))
    .innerJoin(users, eq(messages.user_id, users.id))
    .innerJoin(spaces, and(eq(messages.space_id, spaces.id), eq(spaces.org_id, user.org_id)))
    .where(and(eq(messageBookmarks.user_id, user.id), eq(messageBookmarks.org_id, user.org_id)))
    .orderBy(desc(messageBookmarks.created_at));

  const readable = await loadMessagesForMember(saved.map((row) => row.message_id), user.id, user.org_id);
  return c.json(saved.filter((row) => readable.has(row.message_id)));
});

// POST /api/bookmarks — save a message
bookmarkRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const { message_id, space_id } = body;

  if (!message_id || !space_id) {
    return c.json({ error: 'message_id and space_id are required', code: 'VALIDATION_ERROR' }, 400);
  }

  const message = typeof message_id === 'string'
    ? await loadMessageForMember(message_id, user.id, user.org_id)
    : null;
  if (!message || message.space_id !== space_id) {
    return c.json(MESSAGE_NOT_FOUND, 404);
  }

  // Check if already bookmarked. A row for this message is unique per user;
  // one recorded under another org is re-homed to the message's own org.
  const [existing] = await db.select({ id: messageBookmarks.id, org_id: messageBookmarks.org_id })
    .from(messageBookmarks)
    .where(and(eq(messageBookmarks.user_id, user.id), eq(messageBookmarks.message_id, message.id)));

  if (existing && existing.org_id === user.org_id) {
    return c.json({ error: 'Already saved', code: 'DUPLICATE' }, 409);
  }
  if (existing) {
    const [rehomed] = await db.update(messageBookmarks)
      .set({ org_id: user.org_id, space_id: message.space_id, created_at: new Date() })
      .where(eq(messageBookmarks.id, existing.id))
      .returning();
    return c.json(rehomed, 201);
  }

  const [bookmark] = await db.insert(messageBookmarks).values({
    user_id: user.id,
    org_id: user.org_id,
    message_id: message.id,
    space_id: message.space_id,
  }).returning();

  return c.json(bookmark, 201);
});

// DELETE /api/bookmarks/:messageId — unsave a message
bookmarkRoutes.delete('/:messageId', async (c) => {
  const user = c.get('user');
  const messageId = c.req.param('messageId');

  const [deleted] = await db.delete(messageBookmarks)
    .where(and(
      eq(messageBookmarks.user_id, user.id),
      eq(messageBookmarks.org_id, user.org_id),
      eq(messageBookmarks.message_id, messageId),
    ))
    .returning();

  if (!deleted) {
    return c.json({ error: 'Bookmark not found', code: 'NOT_FOUND' }, 404);
  }

  return c.json({ success: true });
});

// GET /api/bookmarks/check/:messageId — check if a message is bookmarked
bookmarkRoutes.get('/check/:messageId', async (c) => {
  const user = c.get('user');
  const messageId = c.req.param('messageId');

  const existing = await db.select({ id: messageBookmarks.id })
    .from(messageBookmarks)
    .where(and(
      eq(messageBookmarks.user_id, user.id),
      eq(messageBookmarks.org_id, user.org_id),
      eq(messageBookmarks.message_id, messageId),
    ));

  return c.json({ bookmarked: existing.length > 0 });
});
