import { Hono } from 'hono';
import { eq, and, desc, ilike, or, sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { wikiPages, wikiCitations, messages, users, spaces } from '@deft/db/schema';
import { getIO } from '../socket.js';
import { enqueue, QUEUE_NAMES } from '../lib/queues.js';
import { requireSpaceMembership } from '../lib/space-membership.js';
import { visibleWikiPageCondition, wikiPageRelevantToSpaceCondition } from '../lib/wiki-visibility.js';

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
    source_space_id: row.source_space_id ?? null,
    origin_space_id: row.origin_space_id ?? null,
    origin_message_id: row.origin_message_id ?? null,
    origin_user_id: row.origin_user_id ?? null,
    created_via: row.created_via ?? null,
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

function sourceMessageIdSql() {
  return sql<string | null>`(
    SELECT wc.source_id
    FROM wiki_citations wc
    WHERE wc.page_id = ${wikiPages.id}
      AND wc.source_type = 'message'
    ORDER BY wc.created_at DESC
    LIMIT 1
  )`;
}

function sourceSpaceIdSql() {
  return sql<string | null>`(
    SELECT COALESCE(wc.source_space_id, m.space_id)
    FROM wiki_citations wc
    LEFT JOIN messages m ON m.id = wc.source_id
    WHERE wc.page_id = ${wikiPages.id}
      AND wc.source_type = 'message'
    ORDER BY wc.created_at DESC
    LIMIT 1
  )`;
}

function cleanMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function latestMessageCitation(pageId: string): Promise<{ source_message_id: string | null; source_space_id: string | null }> {
  const [row] = await db.select({
    source_message_id: wikiCitations.source_id,
    source_space_id: sql<string | null>`COALESCE(${wikiCitations.source_space_id}, ${messages.space_id})`,
  })
    .from(wikiCitations)
    .leftJoin(messages, and(
      eq(wikiCitations.source_id, messages.id),
      eq(wikiCitations.source_type, 'message'),
    ))
    .where(eq(wikiCitations.page_id, pageId))
    .orderBy(desc(wikiCitations.created_at))
    .limit(1);

  return {
    source_message_id: row?.source_message_id ?? null,
    source_space_id: row?.source_space_id ?? null,
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
      origin_space_id: wikiPages.origin_space_id,
      origin_message_id: wikiPages.origin_message_id,
      origin_user_id: wikiPages.origin_user_id,
      created_via: wikiPages.created_via,
      user_id: wikiPages.user_id,
      slug: wikiPages.slug,
      scope: wikiPages.scope,
      metadata: wikiPages.metadata,
      source_message_id: sourceMessageIdSql(),
      source_space_id: sourceSpaceIdSql(),
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
//   1. space_id matches exactly (space-scoped pages)
//   2. OR origin_space_id matches (org memory that originated in this space)
//   3. OR a wiki citation links the page to a message sent in this space
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

    const conditions: any[] = [
      eq(wikiPages.org_id, user.org_id),
      eq(wikiPages.is_deleted, false),
      visibleWikiPageCondition(user.id),
      wikiPageRelevantToSpaceCondition(spaceId, user.org_id)!,
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
        origin_space_id: wikiPages.origin_space_id,
        origin_message_id: wikiPages.origin_message_id,
        origin_user_id: wikiPages.origin_user_id,
        created_via: wikiPages.created_via,
        user_id: wikiPages.user_id,
        slug: wikiPages.slug,
        scope: wikiPages.scope,
        metadata: wikiPages.metadata,
        source_message_id: sourceMessageIdSql(),
        source_space_id: sourceSpaceIdSql(),
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
    const { type, title, content, source_message_id } = body;
    const metadata = cleanMetadata(body.metadata);

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

    let sourceMessageId: string | null = null;
    let sourceSpaceId: string | null = null;
    let sourceMessageExcerpt: string | null = null;
    if (typeof source_message_id === 'string' && source_message_id.trim()) {
      const [sourceMessage] = await db.select({
        id: messages.id,
        space_id: messages.space_id,
        content: messages.content,
      })
        .from(messages)
        .where(and(
          eq(messages.id, source_message_id.trim()),
          eq(messages.org_id, user.org_id),
          eq(messages.space_id, spaceId),
          eq(messages.is_deleted, false),
        ))
        .limit(1);

      if (!sourceMessage) {
        return c.json({ error: 'source_message_id must reference a visible message in this space', code: 'VALIDATION_ERROR' }, 400);
      }

      sourceMessageId = sourceMessage.id;
      sourceSpaceId = sourceMessage.space_id;
      sourceMessageExcerpt = stripHtml(sourceMessage.content).slice(0, 200);
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
      origin_space_id: sourceSpaceId ?? spaceId,
      origin_message_id: sourceMessageId,
      origin_user_id: user.id,
      created_via: 'space_knowledge_panel',
      user_id: user.id,
      scope: 'space',
      type: wikiType,
      title,
      slug,
      content: content || '',
      metadata,
      confidence: 0.9,
    }).returning();

    if (!entry) {
      return c.json({ error: 'Failed to create entry', code: 'INTERNAL_ERROR' }, 500);
    }

    if (sourceMessageId) {
      await db.insert(wikiCitations).values({
        org_id: user.org_id,
        page_id: entry.id,
        source_type: 'message',
        source_id: sourceMessageId,
        source_space_id: sourceSpaceId,
        source_user_id: user.id,
        excerpt: sourceMessageExcerpt,
      });
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
      metadata,
      source_message_id: sourceMessageId,
      source_space_id: sourceSpaceId,
      origin_space_id: entry.origin_space_id,
      origin_message_id: entry.origin_message_id,
      origin_user_id: entry.origin_user_id,
      created_via: entry.created_via,
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
    if (body.metadata !== undefined) updates.metadata = cleanMetadata(body.metadata);
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

    const citation = await latestMessageCitation(updated.id);
    const result = toKnowledgeEntry({
      ...updated,
      author_name: null,
      author_avatar: null,
      metadata: updated.metadata ?? null,
      ...citation,
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
      visibleWikiPageCondition(user.id),
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
        origin_space_id: wikiPages.origin_space_id,
        origin_message_id: wikiPages.origin_message_id,
        origin_user_id: wikiPages.origin_user_id,
        created_via: wikiPages.created_via,
        user_id: wikiPages.user_id,
        slug: wikiPages.slug,
        scope: wikiPages.scope,
        metadata: wikiPages.metadata,
        source_message_id: sourceMessageIdSql(),
        source_space_id: sourceSpaceIdSql(),
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
