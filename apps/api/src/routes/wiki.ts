import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, sql, or, ilike, inArray } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { wikiPages, wikiLinks, wikiCitations, wikiOpsLog, wikiPageVersions, spaces, notifications, orgMembers, messages } from '@deft/db/schema';
import { ne } from 'drizzle-orm';
import { requireSpaceMembership } from '../lib/space-membership.js';
import { visibleWikiPageCondition } from '../lib/wiki-visibility.js';

/** Notify all org members about a wiki change (except the actor) */
async function notifyWikiChange(orgId: string, actorId: string, title: string, body: string, slug: string) {
  try {
    const members = await db.select({ user_id: orgMembers.user_id })
      .from(orgMembers)
      .where(and(eq(orgMembers.org_id, orgId), eq(orgMembers.is_active, true), ne(orgMembers.user_id, actorId)))
      .limit(50);

    if (members.length > 0) {
      await db.insert(notifications).values(
        members.map(u => ({
          org_id: orgId,
          user_id: u.user_id,
          type: 'wiki_update' as const,
          title,
          body,
          link: `/knowledge?slug=${slug}`,
        }))
      );
    }
  } catch {
    // Non-critical
  }
}

export const wikiRoutes = new Hono();

// Helper: generate slug from title
function slugify(title: string): string {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function wikiPageRelevantToSpaceCondition(spaceId: string, orgId: string, includeOrg: boolean) {
  const relevant = or(
    and(eq(wikiPages.scope, 'space'), eq(wikiPages.space_id, spaceId)),
    ...(includeOrg ? [
      eq(wikiPages.origin_space_id, spaceId),
      sql`EXISTS (
        SELECT 1
        FROM wiki_citations wc
        LEFT JOIN messages m
          ON m.id = wc.source_id
         AND wc.source_type = 'message'
        WHERE wc.page_id = ${wikiPages.id}
          AND (
            wc.source_space_id = ${spaceId}
            OR (m.space_id = ${spaceId} AND m.org_id = ${orgId})
          )
      )`,
    ] : []),
  );
  return relevant;
}

// GET /api/wiki — list/search wiki pages
wikiRoutes.get('/', async (c) => {
  try {
    const user = c.get('user');
    const query = c.req.query('q')?.trim();
    const typeFilter = c.req.query('type');
    const scopeFilter = c.req.query('scope');
    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
    const offset = (page - 1) * limit;

    const baseConditions: any[] = [
      eq(wikiPages.org_id, user.org_id),
      eq(wikiPages.is_deleted, false),
      visibleWikiPageCondition(user.id),
    ];

    if (typeFilter && ['concept', 'entity', 'decision', 'resource', 'procedure', 'preference', 'fact'].includes(typeFilter)) {
      baseConditions.push(eq(wikiPages.type, typeFilter as any));
    }

    if (scopeFilter && ['org', 'space', 'user'].includes(scopeFilter)) {
      baseConditions.push(eq(wikiPages.scope, scopeFilter as any));
    }

    const ftsCondition = query
      ? sql`search_vector @@ websearch_to_tsquery('english', ${query})`
      : null;
    const fallbackPattern = query ? `%${query}%` : null;
    const fallbackSlugPattern = query ? `%${query.toLowerCase().replace(/\s+/g, '-')}%` : null;
    const fallbackCondition = query && fallbackPattern && fallbackSlugPattern
      ? or(
          ilike(wikiPages.title, fallbackPattern),
          ilike(wikiPages.summary, fallbackPattern),
          ilike(wikiPages.content, fallbackPattern),
          ilike(wikiPages.slug, fallbackSlugPattern),
        )
      : null;

    const fetchPageBatch = async (conditions: any[], useFullText: boolean) => db.select({
      id: wikiPages.id,
      type: wikiPages.type,
      scope: wikiPages.scope,
      title: wikiPages.title,
      slug: wikiPages.slug,
      summary: wikiPages.summary,
      metadata: wikiPages.metadata,
      confidence: wikiPages.confidence,
      version: wikiPages.version,
      space_id: wikiPages.space_id,
      origin_space_id: wikiPages.origin_space_id,
      origin_message_id: wikiPages.origin_message_id,
      origin_user_id: wikiPages.origin_user_id,
      created_via: wikiPages.created_via,
      created_at: wikiPages.created_at,
      updated_at: wikiPages.updated_at,
      ...(useFullText && query ? { rank: sql<number>`ts_rank(search_vector, websearch_to_tsquery('english', ${query}))` } : {}),
    })
      .from(wikiPages)
      .where(and(...conditions))
      .orderBy(
        ...(useFullText && query
          ? [sql`ts_rank(search_vector, websearch_to_tsquery('english', ${query})) DESC`, desc(wikiPages.confidence)]
          : [desc(wikiPages.confidence), desc(wikiPages.updated_at)])
      )
      .limit(limit)
      .offset(offset);

    let conditions = ftsCondition ? [...baseConditions, ftsCondition] : baseConditions;
    let pages = await fetchPageBatch(conditions, !!ftsCondition);
    let searchMode = ftsCondition ? 'full_text' : 'list';

    if (query && pages.length === 0 && fallbackCondition) {
      conditions = [...baseConditions, fallbackCondition];
      pages = await fetchPageBatch(conditions, false);
      searchMode = 'fallback';
    }

    // Get link counts for each page
    const pageIds = pages.map(p => p.id);
    let linkCounts: Record<string, number> = {};
    if (pageIds.length > 0) {
      const links = await db.select({
        page_id: wikiLinks.source_page_id,
        cnt: sql<number>`count(*)`,
      }).from(wikiLinks)
        .where(and(
          inArray(wikiLinks.source_page_id, pageIds),
          eq(wikiLinks.org_id, user.org_id),
        ))
        .groupBy(wikiLinks.source_page_id);

      const backlinks = await db.select({
        page_id: wikiLinks.target_page_id,
        cnt: sql<number>`count(*)`,
      }).from(wikiLinks)
        .where(and(
          inArray(wikiLinks.target_page_id, pageIds),
          eq(wikiLinks.org_id, user.org_id),
        ))
        .groupBy(wikiLinks.target_page_id);

      for (const row of [...links, ...backlinks]) {
        linkCounts[row.page_id] = (linkCounts[row.page_id] || 0) + Number(row.cnt);
      }
    }

    const [countResult] = await db.select({ count: sql<number>`count(*)` })
      .from(wikiPages)
      .where(and(...conditions));

    return c.json({
      pages: pages.map(p => ({ ...p, link_count: linkCounts[p.id] || 0 })),
      total: Number(countResult?.count || 0),
      page,
      limit,
      search_mode: searchMode,
    });
  } catch (err) {
    console.error('Failed to fetch wiki pages:', err);
    return c.json({ error: 'Failed to fetch wiki pages', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/wiki/graph — knowledge graph data (must be before /:slug)
wikiRoutes.get('/graph', async (c) => {
  try {
    const user = c.get('user');
    const mode = c.req.query('mode') === 'space' ? 'space' : 'org';
    const spaceId = c.req.query('space_id') || c.req.query('spaceId') || null;
    const includeOrg = c.req.query('include_org') !== 'false';
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '200'), 25), 500);

    const conditions: any[] = [
      eq(wikiPages.org_id, user.org_id),
      eq(wikiPages.is_deleted, false),
      visibleWikiPageCondition(user.id),
    ];

    let scopeLabel = 'Company';
    if (mode === 'space') {
      if (!spaceId) {
        return c.json({ error: 'space_id is required for space graph mode', code: 'VALIDATION_ERROR' }, 400);
      }
      const isMember = await requireSpaceMembership(spaceId, user.id);
      if (!isMember) {
        return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);
      }
      const [space] = await db.select({ name: spaces.name })
        .from(spaces)
        .where(and(eq(spaces.id, spaceId), eq(spaces.org_id, user.org_id)))
        .limit(1);
      if (!space) {
        return c.json({ error: 'Space not found', code: 'NOT_FOUND' }, 404);
      }
      scopeLabel = space.name;
      conditions.push(wikiPageRelevantToSpaceCondition(spaceId, user.org_id, includeOrg)!);
    } else {
      conditions.push(eq(wikiPages.scope, 'org'));
    }

    const nodes = await db.select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      title: wikiPages.title,
      type: wikiPages.type,
      scope: wikiPages.scope,
      space_id: wikiPages.space_id,
      origin_space_id: wikiPages.origin_space_id,
      origin_message_id: wikiPages.origin_message_id,
      created_via: wikiPages.created_via,
      confidence: wikiPages.confidence,
      origin_space_name: spaces.name,
      citation_count: sql<number>`(
        SELECT count(*)
        FROM wiki_citations wc
        WHERE wc.page_id = ${wikiPages.id}
      )`,
    })
      .from(wikiPages)
      .leftJoin(spaces, eq(spaces.id, wikiPages.origin_space_id))
      .where(and(...conditions))
      .orderBy(desc(wikiPages.confidence))
      .limit(limit);

    const nodeIds = nodes.map(n => n.id);
    let edges: { source: string; target: string; context: string | null }[] = [];

    if (nodeIds.length > 0) {
      edges = await db.select({
        source: wikiLinks.source_page_id,
        target: wikiLinks.target_page_id,
        context: wikiLinks.context,
      })
        .from(wikiLinks)
        .where(and(
          eq(wikiLinks.org_id, user.org_id),
          inArray(wikiLinks.source_page_id, nodeIds),
          inArray(wikiLinks.target_page_id, nodeIds),
        ));
    }

    return c.json({
      mode,
      space_id: mode === 'space' ? spaceId : null,
      scope_label: scopeLabel,
      include_org: includeOrg,
      nodes,
      edges,
    });
  } catch (err) {
    console.error('Failed to fetch wiki graph:', err);
    return c.json({ error: 'Failed to fetch graph', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/wiki/log — activity log (Karpathy log.md equivalent)
wikiRoutes.get('/log', async (c) => {
  try {
    const user = c.get('user');
    const opFilter = c.req.query('operation');
    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
    const offset = (page - 1) * limit;

    const conditions: any[] = [eq(wikiOpsLog.org_id, user.org_id)];
    if (opFilter) conditions.push(eq(wikiOpsLog.operation, opFilter));

    const entries = await db.select({
      id: wikiOpsLog.id,
      operation: wikiOpsLog.operation,
      page_id: wikiOpsLog.page_id,
      details: wikiOpsLog.details,
      performed_by: wikiOpsLog.performed_by,
      created_at: wikiOpsLog.created_at,
      page_title: wikiPages.title,
      page_slug: wikiPages.slug,
    })
      .from(wikiOpsLog)
      .leftJoin(wikiPages, eq(wikiOpsLog.page_id, wikiPages.id))
      .where(and(...conditions))
      .orderBy(desc(wikiOpsLog.created_at))
      .limit(limit)
      .offset(offset);

    const [countResult] = await db.select({ count: sql<number>`count(*)` })
      .from(wikiOpsLog)
      .where(and(...conditions));

    return c.json({ entries, total: Number(countResult?.count || 0), page, limit });
  } catch (err) {
    console.error('Failed to fetch wiki log:', err);
    return c.json({ error: 'Failed to fetch log', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/wiki/stats — wiki statistics and health
wikiRoutes.get('/stats', async (c) => {
  try {
    const user = c.get('user');
    const orgId = user.org_id;

    const [totals] = await db.select({ count: sql<number>`count(*)` })
      .from(wikiPages)
      .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.is_deleted, false), visibleWikiPageCondition(user.id)));

    const byType = await db.select({
      type: wikiPages.type,
      count: sql<number>`count(*)`,
    })
      .from(wikiPages)
      .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.is_deleted, false), visibleWikiPageCondition(user.id)))
      .groupBy(wikiPages.type);

    const byConfidence = await db.select({
      band: sql<string>`CASE
        WHEN confidence >= 0.8 THEN 'high'
        WHEN confidence >= 0.5 THEN 'medium'
        ELSE 'low'
      END`,
      count: sql<number>`count(*)`,
    })
      .from(wikiPages)
      .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.is_deleted, false), visibleWikiPageCondition(user.id)))
      .groupBy(sql`CASE WHEN confidence >= 0.8 THEN 'high' WHEN confidence >= 0.5 THEN 'medium' ELSE 'low' END`);

    const [linkCount] = await db.select({ count: sql<number>`count(*)` })
      .from(wikiLinks)
      .where(eq(wikiLinks.org_id, orgId));

    // Pages needing review (low confidence)
    const needsReview = await db.select({
      id: wikiPages.id,
      title: wikiPages.title,
      slug: wikiPages.slug,
      confidence: wikiPages.confidence,
      type: wikiPages.type,
    })
      .from(wikiPages)
      .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.is_deleted, false), visibleWikiPageCondition(user.id), sql`confidence < 0.5`))
      .orderBy(wikiPages.confidence)
      .limit(10);

    // Recent ops
    const recentOps = await db.select({
      operation: wikiOpsLog.operation,
      count: sql<number>`count(*)`,
    })
      .from(wikiOpsLog)
      .where(and(
        eq(wikiOpsLog.org_id, orgId),
        sql`${wikiOpsLog.created_at} > NOW() - INTERVAL '7 days'`,
      ))
      .groupBy(wikiOpsLog.operation);

    return c.json({
      total: Number(totals?.count || 0),
      by_type: Object.fromEntries(byType.map(r => [r.type, Number(r.count)])),
      by_confidence: Object.fromEntries(byConfidence.map(r => [r.band, Number(r.count)])),
      total_links: Number(linkCount?.count || 0),
      needs_review: needsReview,
      recent_ops: Object.fromEntries(recentOps.map(r => [r.operation, Number(r.count)])),
    });
  } catch (err) {
    console.error('Failed to fetch wiki stats:', err);
    return c.json({ error: 'Failed to fetch stats', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/wiki/contradictions — unresolved contradictions
wikiRoutes.get('/contradictions', async (c) => {
  try {
    const user = c.get('user');
    const entries = await db.select({
      id: wikiOpsLog.id,
      details: wikiOpsLog.details,
      created_at: wikiOpsLog.created_at,
    })
      .from(wikiOpsLog)
      .where(and(
        eq(wikiOpsLog.org_id, user.org_id),
        eq(wikiOpsLog.operation, 'contradiction'),
      ))
      .orderBy(desc(wikiOpsLog.created_at))
      .limit(50);

    return c.json({ contradictions: entries });
  } catch (err) {
    console.error('Failed to fetch contradictions:', err);
    return c.json({ error: 'Failed to fetch contradictions', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/wiki/export — export wiki pages
wikiRoutes.get('/export', async (c) => {
  try {
    const user = c.get('user');
    const format = c.req.query('format') || 'json';

    const pages = await db.select()
      .from(wikiPages)
      .where(and(eq(wikiPages.org_id, user.org_id), eq(wikiPages.is_deleted, false), visibleWikiPageCondition(user.id)))
      .orderBy(desc(wikiPages.confidence), desc(wikiPages.updated_at));

    if (format === 'md') {
      const md = pages.map(p =>
        `# ${p.title}\n\n> Type: ${p.type} | Scope: ${p.scope} | Confidence: ${Math.round(p.confidence * 100)}% | v${p.version}\n\n${p.summary ? `*${p.summary}*\n\n` : ''}${p.content}\n\n---\n`
      ).join('\n');
      return new Response(md, {
        headers: { 'Content-Type': 'text/markdown', 'Content-Disposition': 'attachment; filename="wiki-export.md"' },
      });
    }

    if (format === 'csv') {
      const header = 'id,title,type,scope,confidence,version,summary,content,created_at,updated_at\n';
      const rows = pages.map(p => {
        const escape = (s: string | null) => s ? `"${s.replace(/"/g, '""')}"` : '""';
        return `${p.id},${escape(p.title)},${p.type},${p.scope},${p.confidence},${p.version},${escape(p.summary)},${escape(p.content)},${p.created_at?.toISOString?.() || p.created_at},${p.updated_at?.toISOString?.() || p.updated_at}`;
      }).join('\n');
      return new Response(header + rows, {
        headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="wiki-export.csv"' },
      });
    }

    // Default: JSON
    return c.json({ pages, exported_at: new Date().toISOString(), count: pages.length });
  } catch (err) {
    console.error('Failed to export wiki:', err);
    return c.json({ error: 'Failed to export', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/wiki/:slug — get single page with links and citations
wikiRoutes.get('/:slug', async (c) => {
  try {
    const user = c.get('user');
    const slug = c.req.param('slug');

    const [page] = await db.select()
      .from(wikiPages)
      .where(and(
        eq(wikiPages.org_id, user.org_id),
        eq(wikiPages.slug, slug),
        eq(wikiPages.is_deleted, false),
        visibleWikiPageCondition(user.id),
      ))
      .limit(1);

    if (!page) {
      return c.json({ error: 'Page not found', code: 'NOT_FOUND' }, 404);
    }

    // Get linked pages (outbound)
    const linkedPages = await db.select({
      slug: wikiPages.slug,
      title: wikiPages.title,
      type: wikiPages.type,
      summary: wikiPages.summary,
      confidence: wikiPages.confidence,
      context: wikiLinks.context,
    })
      .from(wikiLinks)
      .innerJoin(wikiPages, eq(wikiLinks.target_page_id, wikiPages.id))
      .where(eq(wikiLinks.source_page_id, page.id));

    // Get backlinks (inbound)
    const backlinks = await db.select({
      slug: wikiPages.slug,
      title: wikiPages.title,
      type: wikiPages.type,
      summary: wikiPages.summary,
      context: wikiLinks.context,
    })
      .from(wikiLinks)
      .innerJoin(wikiPages, eq(wikiLinks.source_page_id, wikiPages.id))
      .where(eq(wikiLinks.target_page_id, page.id));

    // Get citations
    const citations = await db.select({
      id: wikiCitations.id,
      page_id: wikiCitations.page_id,
      source_type: wikiCitations.source_type,
      source_id: wikiCitations.source_id,
      excerpt: wikiCitations.excerpt,
      created_at: wikiCitations.created_at,
      source_space_id: sql<string | null>`COALESCE(${wikiCitations.source_space_id}, ${messages.space_id})`,
      source_user_id: sql<string | null>`COALESCE(${wikiCitations.source_user_id}, ${messages.user_id})`,
    })
      .from(wikiCitations)
      .leftJoin(messages, and(
        eq(wikiCitations.source_id, messages.id),
        eq(wikiCitations.source_type, 'message'),
      ))
      .where(eq(wikiCitations.page_id, page.id))
      .orderBy(desc(wikiCitations.created_at));

    return c.json({
      ...page,
      linked_pages: linkedPages,
      backlinks,
      citations,
    });
  } catch (err) {
    console.error('Failed to fetch wiki page:', err);
    return c.json({ error: 'Failed to fetch page', code: 'INTERNAL_ERROR' }, 500);
  }
});


// POST /api/wiki — create a wiki page
const createPageSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  type: z.enum(['concept', 'entity', 'decision', 'resource', 'procedure', 'preference', 'fact']),
  scope: z.enum(['org', 'space', 'user']).default('org'),
  space_id: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  related_slugs: z.array(z.string().regex(/^[a-z0-9-]+$/)).optional(),
});

wikiRoutes.post('/', async (c) => {
  try {
    const user = c.get('user');
    const body = await c.req.json();
    const parsed = createPageSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const { title, content, type, scope, space_id, summary, confidence, tags, metadata, related_slugs } = parsed.data;

    // Validate space_id belongs to org when scope is 'space'
    if (scope === 'space') {
      if (!space_id) {
        return c.json({ error: 'space_id is required when scope is space', code: 'VALIDATION_ERROR' }, 400);
      }
      const [space] = await db.select({ id: spaces.id })
        .from(spaces)
        .where(and(eq(spaces.id, space_id), eq(spaces.org_id, user.org_id)))
        .limit(1);
      if (!space) {
        return c.json({ error: 'Space not found in your organization', code: 'FORBIDDEN' }, 403);
      }
      const isMember = await requireSpaceMembership(space_id, user.id);
      if (!isMember) {
        return c.json({ error: 'Not a member of this space', code: 'FORBIDDEN' }, 403);
      }
    }

    let slug = slugify(title);

    // Ensure unique slug within org
    const [existing] = await db.select({ id: wikiPages.id })
      .from(wikiPages)
      .where(and(eq(wikiPages.org_id, user.org_id), eq(wikiPages.slug, slug)))
      .limit(1);

    if (existing) {
      slug = `${slug}-${Date.now().toString(36)}`;
    }

    const [page] = await db.insert(wikiPages).values({
      org_id: user.org_id,
      scope,
      space_id: scope === 'space' ? space_id : null,
      origin_space_id: scope === 'space' ? space_id : null,
      origin_user_id: user.id,
      created_via: 'manual',
      user_id: scope === 'user' ? user.id : null,
      type,
      title,
      slug,
      summary: summary || null,
      content,
      metadata: metadata ?? null,
      confidence: confidence ?? 1.0,
      tags: tags && tags.length > 0 ? tags : [],
    }).returning();

    // Create links to related pages
    if (related_slugs && related_slugs.length > 0) {
      const relatedPages = await db.select({ id: wikiPages.id, slug: wikiPages.slug })
        .from(wikiPages)
        .where(and(
          eq(wikiPages.org_id, user.org_id),
          inArray(wikiPages.slug, related_slugs),
        ));

      for (const related of relatedPages) {
        await db.insert(wikiLinks).values({
          org_id: user.org_id,
          source_page_id: page!.id,
          target_page_id: related.id,
        }).onConflictDoNothing();
      }
    }

    // Log operation
    await db.insert(wikiOpsLog).values({
      org_id: user.org_id,
      operation: 'create',
      page_id: page!.id,
      details: { title, type, scope },
      performed_by: user.id,
    });

    notifyWikiChange(user.org_id, user.id, `New wiki page: ${title}`, `A new ${type} page was created`, slug);

    return c.json(page, 201);
  } catch (err) {
    console.error('Failed to create wiki page:', err);
    return c.json({ error: 'Failed to create page', code: 'INTERNAL_ERROR' }, 500);
  }
});

// PATCH /api/wiki/:slug — update a wiki page
const updatePageSchema = z.object({
  title: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  summary: z.string().nullable().optional(),
  type: z.enum(['concept', 'entity', 'decision', 'resource', 'procedure', 'preference', 'fact']).optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  related_slugs: z.array(z.string().regex(/^[a-z0-9-]+$/)).optional(),
});

wikiRoutes.patch('/:slug', async (c) => {
  try {
    const user = c.get('user');
    const slug = c.req.param('slug');
    const body = await c.req.json();
    const parsed = updatePageSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    const [existing] = await db.select()
      .from(wikiPages)
      .where(and(eq(wikiPages.org_id, user.org_id), eq(wikiPages.slug, slug), eq(wikiPages.is_deleted, false), visibleWikiPageCondition(user.id)))
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Page not found', code: 'NOT_FOUND' }, 404);
    }

    // Snapshot current state before any update
    await db.insert(wikiPageVersions).values({
      page_id: existing.id,
      version: existing.version,
      title: existing.title,
      content: existing.content,
      summary: existing.summary,
      edited_by: user.id,
    }).onConflictDoNothing();

    const updates: Record<string, any> = {};
    if (parsed.data.title !== undefined) updates.title = parsed.data.title;
    if (parsed.data.summary !== undefined) updates.summary = parsed.data.summary;
    if (parsed.data.type !== undefined) updates.type = parsed.data.type;
    if (parsed.data.confidence !== undefined) updates.confidence = parsed.data.confidence;
    if (parsed.data.metadata !== undefined) updates.metadata = parsed.data.metadata ?? null;

    if (parsed.data.content !== undefined && parsed.data.content !== existing.content) {
      updates.content = parsed.data.content;
      updates.previous_content = existing.content;
      updates.version = existing.version + 1;
    }
    if (parsed.data.tags !== undefined) updates.tags = parsed.data.tags;

    if (Object.keys(updates).length === 0 && !parsed.data.related_slugs) {
      return c.json({ error: 'No fields to update', code: 'EMPTY_UPDATE' }, 400);
    }

    if (Object.keys(updates).length > 0) {
      await db.update(wikiPages).set(updates).where(eq(wikiPages.id, existing.id));
    }

    // Update links if provided
    if (parsed.data.related_slugs) {
      // Remove old outbound links
      await db.delete(wikiLinks).where(eq(wikiLinks.source_page_id, existing.id));

      // Add new links
      const relatedPages = await db.select({ id: wikiPages.id })
        .from(wikiPages)
        .where(and(
          eq(wikiPages.org_id, user.org_id),
          inArray(wikiPages.slug, parsed.data.related_slugs),
        ));

      for (const related of relatedPages) {
        await db.insert(wikiLinks).values({
          org_id: user.org_id,
          source_page_id: existing.id,
          target_page_id: related.id,
        }).onConflictDoNothing();
      }
    }

    // Log operation
    await db.insert(wikiOpsLog).values({
      org_id: user.org_id,
      operation: 'update',
      page_id: existing.id,
      details: { updated_fields: Object.keys(updates) },
      performed_by: user.id,
    });

    notifyWikiChange(user.org_id, user.id, `Wiki updated: ${existing.title}`, `Fields changed: ${Object.keys(updates).join(', ')}`, slug);

    return c.json({ success: true, slug });
  } catch (err) {
    console.error('Failed to update wiki page:', err);
    return c.json({ error: 'Failed to update page', code: 'INTERNAL_ERROR' }, 500);
  }
});

// DELETE /api/wiki/:slug — soft delete
wikiRoutes.delete('/:slug', async (c) => {
  try {
    const user = c.get('user');
    const slug = c.req.param('slug');

    const [page] = await db.select({ id: wikiPages.id })
      .from(wikiPages)
      .where(and(eq(wikiPages.org_id, user.org_id), eq(wikiPages.slug, slug), eq(wikiPages.is_deleted, false), visibleWikiPageCondition(user.id)))
      .limit(1);

    if (!page) {
      return c.json({ error: 'Page not found', code: 'NOT_FOUND' }, 404);
    }

    await db.update(wikiPages).set({ is_deleted: true }).where(eq(wikiPages.id, page.id));

    await db.insert(wikiOpsLog).values({
      org_id: user.org_id,
      operation: 'delete',
      page_id: page.id,
      performed_by: user.id,
    });

    return c.json({ success: true });
  } catch (err) {
    console.error('Failed to delete wiki page:', err);
    return c.json({ error: 'Failed to delete page', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/wiki/:slug/history — version list
wikiRoutes.get('/:slug/history', async (c) => {
  try {
    const user = c.get('user');
    const slug = c.req.param('slug');

    const [page] = await db.select({ id: wikiPages.id })
      .from(wikiPages)
      .where(and(eq(wikiPages.org_id, user.org_id), eq(wikiPages.slug, slug), visibleWikiPageCondition(user.id)))
      .limit(1);

    if (!page) {
      return c.json({ error: 'Page not found', code: 'NOT_FOUND' }, 404);
    }

    const versions = await db.select()
      .from(wikiPageVersions)
      .where(eq(wikiPageVersions.page_id, page.id))
      .orderBy(desc(wikiPageVersions.version));

    return c.json({ versions });
  } catch (err) {
    console.error('Failed to fetch version history:', err);
    return c.json({ error: 'Failed to fetch history', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/wiki/:slug/history/:version — specific version
wikiRoutes.get('/:slug/history/:version', async (c) => {
  try {
    const user = c.get('user');
    const slug = c.req.param('slug');
    const versionNum = parseInt(c.req.param('version'));

    const [page] = await db.select({ id: wikiPages.id })
      .from(wikiPages)
      .where(and(eq(wikiPages.org_id, user.org_id), eq(wikiPages.slug, slug), visibleWikiPageCondition(user.id)))
      .limit(1);

    if (!page) {
      return c.json({ error: 'Page not found', code: 'NOT_FOUND' }, 404);
    }

    const [version] = await db.select()
      .from(wikiPageVersions)
      .where(and(eq(wikiPageVersions.page_id, page.id), eq(wikiPageVersions.version, versionNum)))
      .limit(1);

    if (!version) {
      return c.json({ error: 'Version not found', code: 'NOT_FOUND' }, 404);
    }

    return c.json(version);
  } catch (err) {
    console.error('Failed to fetch version:', err);
    return c.json({ error: 'Failed to fetch version', code: 'INTERNAL_ERROR' }, 500);
  }
});

