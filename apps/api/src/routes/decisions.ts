import { Hono } from 'hono';
import { eq, and, desc, ilike, sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { wikiPages } from '@deft/db/schema';

export const decisionRoutes = new Hono();

// GET /api/decisions — list decisions for the org (backed by wiki_pages type='decision')
decisionRoutes.get('/', async (c) => {
  const user = c.get('user');
  const query = c.req.query('query');
  const spaceId = c.req.query('space_id');
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
  const offset = (page - 1) * limit;

  const conditions: any[] = [
    eq(wikiPages.org_id, user.org_id),
    eq(wikiPages.type, 'decision'),
    eq(wikiPages.is_deleted, false),
  ];

  if (query) {
    conditions.push(
      sql`(${ilike(wikiPages.title, `%${query}%`)} OR ${ilike(wikiPages.content, `%${query}%`)})`,
    );
  }

  if (spaceId) {
    conditions.push(eq(wikiPages.space_id, spaceId));
  }

  const results = await db
    .select({
      id: wikiPages.id,
      decision_text: wikiPages.title,
      space_id: wikiPages.space_id,
      tags: wikiPages.tags,
      confidence: wikiPages.confidence,
      // is_reversed derived: confidence < 0.5 OR 'reversed' in tags
      created_at: wikiPages.created_at,
      updated_at: wikiPages.updated_at,
    })
    .from(wikiPages)
    .where(and(...conditions))
    .orderBy(desc(wikiPages.created_at))
    .limit(limit)
    .offset(offset);

  // Map to stable response shape (consumers expect is_reversed boolean)
  const decisions = results.map((r) => ({
    ...r,
    is_reversed: r.confidence < 0.5 || (r.tags ?? []).includes('reversed'),
  }));

  return c.json({ decisions, page, limit });
});

// GET /api/decisions/:id — get single decision
decisionRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const [row] = await db
    .select({
      id: wikiPages.id,
      decision_text: wikiPages.title,
      space_id: wikiPages.space_id,
      tags: wikiPages.tags,
      confidence: wikiPages.confidence,
      created_at: wikiPages.created_at,
      updated_at: wikiPages.updated_at,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.id, id),
        eq(wikiPages.org_id, user.org_id),
        eq(wikiPages.type, 'decision'),
        eq(wikiPages.is_deleted, false),
      ),
    )
    .limit(1);

  if (!row) {
    return c.json({ error: 'Decision not found', code: 'NOT_FOUND' }, 404);
  }

  return c.json({
    ...row,
    is_reversed: row.confidence < 0.5 || (row.tags ?? []).includes('reversed'),
  });
});

// PATCH /api/decisions/:id — mark as reversed / re-activate (updates wiki_pages)
decisionRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();

  const [existing] = await db
    .select({ id: wikiPages.id, tags: wikiPages.tags, confidence: wikiPages.confidence })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.id, id),
        eq(wikiPages.org_id, user.org_id),
        eq(wikiPages.type, 'decision'),
        eq(wikiPages.is_deleted, false),
      ),
    )
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Decision not found', code: 'NOT_FOUND' }, 404);
  }

  const updates: Record<string, any> = {};

  if (typeof body.is_reversed === 'boolean') {
    if (body.is_reversed) {
      // Reversing: lower confidence, ensure 'reversed' tag is present (idempotent)
      updates.confidence = 0.2;
      const currentTags: string[] = existing.tags ?? [];
      updates.tags = currentTags.includes('reversed')
        ? currentTags
        : [...currentTags, 'reversed'];
    } else {
      // Re-activating: restore confidence, remove 'reversed' tag
      updates.confidence = 0.9;
      const currentTags: string[] = existing.tags ?? [];
      updates.tags = currentTags.filter((t) => t !== 'reversed');
    }
  }

  if (body.tags !== undefined) {
    // Union provided tags with existing (after applying is_reversed mutation above)
    const base: string[] = updates.tags ?? existing.tags ?? [];
    const incoming: string[] = body.tags;
    const merged = Array.from(new Set([...base, ...incoming]));
    updates.tags = merged;
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No valid fields to update', code: 'VALIDATION_ERROR' }, 400);
  }

  updates.updated_at = new Date();

  await db
    .update(wikiPages)
    .set(updates)
    .where(eq(wikiPages.id, id));

  const [updated] = await db
    .select({
      id: wikiPages.id,
      decision_text: wikiPages.title,
      space_id: wikiPages.space_id,
      tags: wikiPages.tags,
      confidence: wikiPages.confidence,
      created_at: wikiPages.created_at,
      updated_at: wikiPages.updated_at,
    })
    .from(wikiPages)
    .where(eq(wikiPages.id, id))
    .limit(1);

  return c.json({
    ...updated,
    is_reversed: updated.confidence < 0.5 || (updated.tags ?? []).includes('reversed'),
  });
});
