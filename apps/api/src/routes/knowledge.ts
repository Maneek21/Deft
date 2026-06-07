import { Hono } from 'hono';
import { eq, and, desc, ilike, or, sql, inArray } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { wikiPages, wikiCitations, messages, users, spaces } from '@deft/db/schema';
import { getIO } from '../socket.js';
import { enqueue, QUEUE_NAMES } from '../lib/queues.js';
import { requireSpaceMembership } from '../lib/space-membership.js';
import { visibleWikiPageCondition } from '../lib/wiki-visibility.js';

export const knowledgeRoutes = new Hono();
export const knowledgeAggRoutes = new Hono();

// Wiki's 7 canonical types
const WIKI_TYPES = ['concept', 'entity', 'decision', 'resource', 'procedure', 'preference', 'fact'] as const;
type WikiType = typeof WIKI_TYPES[number];

// Type mapping: legacy 4-type input -> wiki type (for backwards-compat POST/PATCH from old UI)
const LEGACY_TO_WIKI: Record<string, WikiType> = {
  decision: 'decision',
  resource: 'resource',
  action_item: 'procedure',
  note: 'fact',
};

function slugify(title: string): string {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

// Map a wiki page row to the knowledge entry shape the panel expects
function toKnowledgeEntry(row: any) {
  return {
    id: row.id,
    type: row.type, // now expose wiki's 7 types directly
    title: row.title,
    content: row.content,
    metadata: row.metadata ?? null,
    source_message_id: row.source_message_id ?? null,
    space_id: row.space_id,
    created_by: row.user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    author_name: row.author_name || null,
    author_avatar: row.author_avatar || null,
    slug: row.slug,
    scope: row.scope,
  };
}

// GET /api/knowledge — cross-space knowledge aggregation
knowledgeAggRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const typeFilter = c.req.query('type');
    const page = parseInt(c.req.query('page') || '1');
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
    const offset = (page - 1) * limit;

    const conditions: any[] = [
      eq(wikiPages.org_id, user.org_id),
      eq(wikiPages.is_deleted, false),
      visibleWikiPageCondition(user.id),
    ];

    if (typeFilter) {
      // Accept both wiki types and legacy aliases
      const wikiType = LEGACY_TO_WIKI[typeFilter] || (WIKI_TYPES.includes(typeFilter as WikiType) ? typeFilter : null);
      if (wikiType) {
        conditions.push(eq(wikiPages.type, wikiType as any));
      }
    }

    const entries = await db.select({
      id: wikiPages.id,
      type: wikiPages.type,
      title: wikiPages.title,
      content: wikiPages.content,
      space_id: wikiPages.space_id,
      user_id: wikiPages.user_id,
      slug: wikiPages.slug,
      scope: wikiPages.scope,
      metadata: sql<any>`NULL`,
      source_message_id: sql<string | null>`NULL`,
      created_at: wikiPages.created_at,
      updated_at: wikiPages.updated_at,
      space_name: spaces.name,
      author_name: users.name,
      author_avatar: sql<string | null>`NULL`,
    })
      .from(wikiPages)
      .leftJoin(users, eq(wikiPages.user_id, users.id))
      .leftJoin(spaces, eq(wikiPages.space_id, spaces.id))
      .where(and(...conditions))
      .orderBy(desc(wikiPages.updated_at))
      .limit(limit)
      .offset(offset);

    const [countResult] = await db.select({ count: sql<number>`count(*)` })
      .from(wikiPages)
      .where(and(...conditions));

    return c.json({
      entries: entries.map(toKnowledgeEntry),
      total: Number(countResult?.count || 0),
      page,
      limit,
    });
  } catch (err) {
    console.error('Failed to fetch knowledge:', err);
    return c.json({ error: 'Failed to fetch knowledge', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/spaces/:spaceId/knowledge — list entries for a space
// Returns wiki pages where:
//   1. space_id matches exactly (org-scoped pages written from this space, or manually scoped)
//   2. OR a wiki citation exists linking the page to a message sent in this space
knowledgeRoutes.get('/:spaceId/knowledge', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('spaceId');
    const typeFilter = c.req.query('type');
    const limitParam = Math.min(parseInt(c.req.query('limit') || '50'), 100);

    const isMember = await requireSpaceMembership(spaceId, user.id);
    if (!isMember) {
      return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);
    }

    // Find page IDs that have a citation from a message in this space
    const citedPageIds = await db.select({ page_id: wikiCitations.page_id })
      .from(wikiCitations)
      .innerJoin(messages, and(
        eq(wikiCitations.source_id, messages.id),
        eq(wikiCitations.source_type, 'message'),
      ))
      .where(and(
        eq(messages.space_id, spaceId),
        eq(messages.org_id, user.org_id),
      ));

    const citedIds = [...new Set(citedPageIds.map(r => r.page_id))];

    // Build conditions: space_id match OR cited from this space
    const spaceCondition = citedIds.length > 0
      ? or(eq(wikiPages.space_id, spaceId), inArray(wikiPages.id, citedIds))
      : eq(wikiPages.space_id, spaceId);

    const conditions: any[] = [
      eq(wikiPages.org_id, user.org_id),
      eq(wikiPages.is_deleted, false),
      visibleWikiPageCondition(user.id),
      spaceCondition!,
    ];

    if (typeFilter) {
      const wikiType = LEGACY_TO_WIKI[typeFilter] || (WIKI_TYPES.includes(typeFilter as WikiType) ? typeFilter : null);
      if (wikiType) {
        conditions.push(eq(wikiPages.type, wikiType as any));
      }
    }

    const entries = await db
      .select({
        id: wikiPages.id,
        type: wikiPages.type,
        title: wikiPages.title,
        content: wikiPages.content,
        space_id: wikiPages.space_id,
        user_id: wikiPages.user_id,
        slug: wikiPages.slug,
        scope: wikiPages.scope,
        metadata: sql<any>`NULL`,
        source_message_id: sql<string | null>`NULL`,
        created_at: wikiPages.created_at,
        updated_at: wikiPages.updated_at,
        author_name: users.name,
        author_avatar: users.avatar_url,
      })
      .from(wikiPages)
      .leftJoin(users, eq(wikiPages.user_id, users.id))
      .where(and(...conditions))
      .orderBy(desc(wikiPages.updated_at))
      .limit(limitParam);

    return c.json({ entries: entries.map(toKnowledgeEntry) });
  } catch (err) {
    console.error('Failed to fetch knowledge:', err);
    return c.json({ error: 'Failed to fetch knowledge', code: 'INTERNAL_ERROR' }, 500);
  }
});

// POST /api/spaces/:spaceId/knowledge — create entry (writes to wiki_pages)
knowledgeRoutes.post('/:spaceId/knowledge', async (c) => {
  try {
    const user = c.get('user');
    const spaceId = c.req.param('spaceId');
    const body = await c.req.json();
    const { type, title, content } = body;

    const isMember = await requireSpaceMembership(spaceId, user.id);
    if (!isMember) {
      return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);
    }

    if (!type || !title) {
      return c.json({ error: 'type and title are required', code: 'VALIDATION_ERROR' }, 400);
    }

    // Accept both legacy 4-type names and wiki's 7 types
    const wikiType: WikiType | undefined =
      LEGACY_TO_WIKI[type] ||
      (WIKI_TYPES.includes(type as WikiType) ? (type as WikiType) : undefined);

    if (!wikiType) {
      return c.json({ error: `Invalid type. Valid types: ${WIKI_TYPES.join(', ')} (also accepts: decision, resource, action_item, note)`, code: 'VALIDATION_ERROR' }, 400);
    }

    let slug = slugify(title);

    // Ensure unique slug within org
    const [existingSlug] = await db.select({ id: wikiPages.id })
      .from(wikiPages)
      .where(and(eq(wikiPages.org_id, user.org_id), eq(wikiPages.slug, slug)))
      .limit(1);
    if (existingSlug) {
      slug = `${slug}-${Date.now().toString(36)}`;
    }

    const [entry] = await db.insert(wikiPages).values({
      org_id: user.org_id,
      space_id: spaceId,
      user_id: user.id,
      scope: 'space',
      type: wikiType,
      title,
      slug,
      content: content || '',
      confidence: 0.9,
    }).returning();

    if (!entry) {
      return c.json({ error: 'Failed to create entry', code: 'INTERNAL_ERROR' }, 500);
    }

    // Enqueue embed-content for the new page
    try {
      await enqueue(QUEUE_NAMES.AGENT_JOBS, 'embed-content', { source_type: 'wiki_page', source_id: entry.id });
    } catch (err) {
      console.warn('[knowledge] failed to enqueue embed-content for new page', entry.id, err);
    }

    const result = toKnowledgeEntry({
      ...entry,
      author_name: null,
      author_avatar: null,
      metadata: null,
      source_message_id: null,
    });

    const io = getIO();
    if (io) {
      io.to(`space:${spaceId}`).emit('knowledge:created', result);
    }

    return c.json(result, 201);
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

    const isMember = await requireSpaceMembership(spaceId, user.id);
    if (!isMember) {
      return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);
    }

    const updates: Record<string, unknown> = {};
    if (body.title !== undefined) updates.title = body.title;
    if (body.content !== undefined) updates.content = body.content;
    if (body.type !== undefined) {
      const wikiType = LEGACY_TO_WIKI[body.type] || (WIKI_TYPES.includes(body.type as WikiType) ? body.type : null);
      if (wikiType) updates.type = wikiType;
    }
    updates.updated_at = new Date();

    const [updated] = await db.update(wikiPages)
      .set(updates)
      .where(and(
        eq(wikiPages.id, entryId),
        eq(wikiPages.org_id, user.org_id),
        eq(wikiPages.space_id, spaceId),
        visibleWikiPageCondition(user.id),
        eq(wikiPages.is_deleted, false),
      ))
      .returning();

    if (!updated) {
      return c.json({ error: 'Entry not found', code: 'NOT_FOUND' }, 404);
    }

    // Re-enqueue embed-content if content was changed
    if (body.content !== undefined) {
      try {
        await enqueue(QUEUE_NAMES.AGENT_JOBS, 'embed-content', { source_type: 'wiki_page', source_id: updated.id });
      } catch (err) {
        console.warn('[knowledge] failed to enqueue embed-content for updated page', updated.id, err);
      }
    }

    const result = toKnowledgeEntry({
      ...updated,
      author_name: null,
      author_avatar: null,
      metadata: null,
      source_message_id: null,
    });

    const io = getIO();
    if (io) {
      io.to(`space:${spaceId}`).emit('knowledge:updated', result);
    }

    return c.json(result);
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

    const isMember = await requireSpaceMembership(spaceId, user.id);
    if (!isMember) {
      return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);
    }

    const [deleted] = await db.update(wikiPages)
      .set({ is_deleted: true })
      .where(and(
        eq(wikiPages.id, entryId),
        eq(wikiPages.org_id, user.org_id),
        eq(wikiPages.space_id, spaceId),
        visibleWikiPageCondition(user.id),
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

// GET /api/spaces/:spaceId/knowledge/search — search entries
knowledgeRoutes.get('/knowledge/search', async (c) => {
  try {
    const user = c.get('user');
    const query = c.req.query('q') || '';
    const typeFilter = c.req.query('type');

    if (!query) {
      return c.json({ entries: [] });
    }

    const pattern = `%${query}%`;
    const conditions: any[] = [
      eq(wikiPages.org_id, user.org_id),
      eq(wikiPages.is_deleted, false),
      or(ilike(wikiPages.title, pattern), ilike(wikiPages.content, pattern)),
    ];

    if (typeFilter) {
      const wikiType = LEGACY_TO_WIKI[typeFilter] || (WIKI_TYPES.includes(typeFilter as WikiType) ? typeFilter : null);
      if (wikiType) {
        conditions.push(eq(wikiPages.type, wikiType as any));
      }
    }

    const entries = await db
      .select({
        id: wikiPages.id,
        type: wikiPages.type,
        title: wikiPages.title,
        content: wikiPages.content,
        space_id: wikiPages.space_id,
        user_id: wikiPages.user_id,
        slug: wikiPages.slug,
        scope: wikiPages.scope,
        metadata: sql<any>`NULL`,
        source_message_id: sql<string | null>`NULL`,
        created_at: wikiPages.created_at,
        updated_at: wikiPages.updated_at,
        author_name: users.name,
        author_avatar: sql<string | null>`NULL`,
      })
      .from(wikiPages)
      .leftJoin(users, eq(wikiPages.user_id, users.id))
      .where(and(...conditions))
      .orderBy(desc(wikiPages.updated_at))
      .limit(20);

    return c.json({ entries: entries.map(toKnowledgeEntry) });
  } catch (err) {
    console.error('Failed to search knowledge:', err);
    return c.json({ error: 'Failed to search', code: 'INTERNAL_ERROR' }, 500);
  }
});
