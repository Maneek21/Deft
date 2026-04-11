import { Hono } from 'hono';
import { eq, and, desc, ilike, or } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { spaceKnowledge, users } from '@deft/db/schema';
import { getIO } from '../socket.js';

export const knowledgeRoutes = new Hono();

// GET /api/spaces/:spaceId/knowledge — list entries
knowledgeRoutes.get('/:spaceId/knowledge', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('spaceId');
    const typeFilter = c.req.query('type');
    const conditions = [
      eq(spaceKnowledge.org_id, user.org_id),
      eq(spaceKnowledge.space_id, spaceId),
      eq(spaceKnowledge.is_deleted, false),
    ];

    if (typeFilter && ['decision', 'resource', 'action_item', 'note'].includes(typeFilter)) {
      conditions.push(eq(spaceKnowledge.type, typeFilter as any));
    }

    const entries = await db
      .select({
        id: spaceKnowledge.id,
        type: spaceKnowledge.type,
        title: spaceKnowledge.title,
        content: spaceKnowledge.content,
        metadata: spaceKnowledge.metadata,
        source_message_id: spaceKnowledge.source_message_id,
        created_by: spaceKnowledge.created_by,
        created_at: spaceKnowledge.created_at,
        updated_at: spaceKnowledge.updated_at,
        author_name: users.name,
        author_avatar: users.avatar_url,
      })
      .from(spaceKnowledge)
      .leftJoin(users, eq(spaceKnowledge.created_by, users.id))
      .where(and(...conditions))
      .orderBy(desc(spaceKnowledge.created_at))
      .limit(100);

    return c.json({ entries });
  } catch (err) {
    console.error('Failed to fetch knowledge:', err);
    return c.json({ error: 'Failed to fetch knowledge', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/spaces/:spaceId/knowledge — create entry
knowledgeRoutes.post('/:spaceId/knowledge', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('spaceId');
    const body = await c.req.json();
    const { type, title, content, metadata, source_message_id } = body;

    if (!type || !title) {
      return c.json({ error: 'type and title are required', code: 'VALIDATION_ERROR' }, 400);
    }

    if (!['decision', 'resource', 'action_item', 'note'].includes(type)) {
      return c.json({ error: 'Invalid type', code: 'VALIDATION_ERROR' }, 400);
    }

    const [entry] = await db.insert(spaceKnowledge).values({
      org_id: user.org_id,
      space_id: spaceId,
      type,
      title,
      content: content || null,
      metadata: metadata || null,
      source_message_id: source_message_id || null,
      created_by: user.id,
    }).returning();

    // Fetch with author info
    const [full] = await db
      .select({
        id: spaceKnowledge.id,
        type: spaceKnowledge.type,
        title: spaceKnowledge.title,
        content: spaceKnowledge.content,
        metadata: spaceKnowledge.metadata,
        source_message_id: spaceKnowledge.source_message_id,
        created_by: spaceKnowledge.created_by,
        created_at: spaceKnowledge.created_at,
        updated_at: spaceKnowledge.updated_at,
        author_name: users.name,
        author_avatar: users.avatar_url,
      })
      .from(spaceKnowledge)
      .leftJoin(users, eq(spaceKnowledge.created_by, users.id))
      .where(eq(spaceKnowledge.id, entry!.id));

    const io = getIO();
    if (io) {
      io.to(`space:${spaceId}`).emit('knowledge:created', full);
    }

    return c.json(full, 201);
  } catch (err) {
    console.error('Failed to create knowledge entry:', err);
    return c.json({ error: 'Failed to create entry', code: 'INTERNAL_ERROR' }, 500);
  }
});

// PATCH /api/spaces/:spaceId/knowledge/:id — update entry
knowledgeRoutes.patch('/:spaceId/knowledge/:id', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('spaceId');
    const entryId = c.req.param('id');
    const body = await c.req.json();

    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (body.title !== undefined) updates.title = body.title;
    if (body.content !== undefined) updates.content = body.content;
    if (body.metadata !== undefined) updates.metadata = body.metadata;
    if (body.type !== undefined) updates.type = body.type;

    const [updated] = await db.update(spaceKnowledge)
      .set(updates)
      .where(and(
        eq(spaceKnowledge.id, entryId),
        eq(spaceKnowledge.org_id, user.org_id),
        eq(spaceKnowledge.is_deleted, false),
      ))
      .returning();

    if (!updated) {
      return c.json({ error: 'Entry not found', code: 'NOT_FOUND' }, 404);
    }

    const io = getIO();
    if (io) {
      io.to(`space:${spaceId}`).emit('knowledge:updated', updated);
    }

    return c.json(updated);
  } catch (err) {
    console.error('Failed to update knowledge entry:', err);
    return c.json({ error: 'Failed to update entry', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/spaces/:spaceId/knowledge/:id — soft delete
knowledgeRoutes.delete('/:spaceId/knowledge/:id', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('spaceId');
    const entryId = c.req.param('id');

    const [deleted] = await db.update(spaceKnowledge)
      .set({ is_deleted: true, updated_at: new Date() })
      .where(and(
        eq(spaceKnowledge.id, entryId),
        eq(spaceKnowledge.org_id, user.org_id),
      ))
      .returning();

    if (!deleted) {
      return c.json({ error: 'Entry not found', code: 'NOT_FOUND' }, 404);
    }

    const io = getIO();
    if (io) {
      io.to(`space:${spaceId}`).emit('knowledge:deleted', { id: entryId });
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to delete knowledge entry:', err);
    return c.json({ error: 'Failed to delete entry', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/spaces/:spaceId/knowledge/search — search entries across spaces (for agent)
knowledgeRoutes.get('/knowledge/search', async (c) => {
  try {
    const user = c.get('user');
    const query = c.req.query('q') || '';
    const typeFilter = c.req.query('type');

    if (!query) {
      return c.json({ entries: [] });
    }

    const pattern = `%${query}%`;
    const conditions = [
      eq(spaceKnowledge.org_id, user.org_id),
      eq(spaceKnowledge.is_deleted, false),
      or(ilike(spaceKnowledge.title, pattern), ilike(spaceKnowledge.content, pattern)),
    ];

    if (typeFilter) {
      conditions.push(eq(spaceKnowledge.type, typeFilter as any));
    }

    const entries = await db
      .select({
        id: spaceKnowledge.id,
        type: spaceKnowledge.type,
        title: spaceKnowledge.title,
        content: spaceKnowledge.content,
        metadata: spaceKnowledge.metadata,
        space_id: spaceKnowledge.space_id,
        created_at: spaceKnowledge.created_at,
        author_name: users.name,
      })
      .from(spaceKnowledge)
      .leftJoin(users, eq(spaceKnowledge.created_by, users.id))
      .where(and(...conditions))
      .orderBy(desc(spaceKnowledge.created_at))
      .limit(20);

    return c.json({ entries });
  } catch (err) {
    console.error('Failed to search knowledge:', err);
    return c.json({ error: 'Failed to search', code: 'INTERNAL_ERROR' }, 500);
  }
});
