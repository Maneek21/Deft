import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { messageBookmarks, messages, users, spaces } from '@deft/db/schema';

export const bookmarkRoutes = new Hono();

// GET /api/bookmarks — list current user's saved messages
bookmarkRoutes.get('/', async (c) => {
  const user = c.get('user');

  const saved = await db.select({
    id: messageBookmarks.id,
    message_id: messageBookmarks.message_id,
    space_id: messageBookmarks.space_id,
    created_at: messageBookmarks.created_at,
    message_content: messages.content,
    message_created_at: messages.created_at,
    author_name: users.name,
    author_id: messages.user_id,
    space_name: spaces.name,
  })
    .from(messageBookmarks)
    .innerJoin(messages, eq(messageBookmarks.message_id, messages.id))
    .innerJoin(users, eq(messages.user_id, users.id))
    .innerJoin(spaces, eq(messageBookmarks.space_id, spaces.id))
    .where(eq(messageBookmarks.user_id, user.id))
    .orderBy(desc(messageBookmarks.created_at));

  return c.json(saved);
});

// POST /api/bookmarks — save a message
bookmarkRoutes.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const { message_id, space_id } = body;

  if (!message_id || !space_id) {
    return c.json({ error: 'message_id and space_id are required', code: 'VALIDATION_ERROR' }, 400);
  }

  // Check if already bookmarked
  const existing = await db.select({ id: messageBookmarks.id })
    .from(messageBookmarks)
    .where(and(eq(messageBookmarks.user_id, user.id), eq(messageBookmarks.message_id, message_id)));

  if (existing.length > 0) {
    return c.json({ error: 'Already saved', code: 'DUPLICATE' }, 409);
  }

  const [bookmark] = await db.insert(messageBookmarks).values({
    user_id: user.id,
    org_id: user.org_id,
    message_id,
    space_id,
  }).returning();

  return c.json(bookmark, 201);
});

// DELETE /api/bookmarks/:messageId — unsave a message
bookmarkRoutes.delete('/:messageId', async (c) => {
  const user = c.get('user');
  const messageId = c.req.param('messageId');

  const [deleted] = await db.delete(messageBookmarks)
    .where(and(eq(messageBookmarks.user_id, user.id), eq(messageBookmarks.message_id, messageId)))
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
    .where(and(eq(messageBookmarks.user_id, user.id), eq(messageBookmarks.message_id, messageId)));

  return c.json({ bookmarked: existing.length > 0 });
});
