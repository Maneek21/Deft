import { Hono } from 'hono';
import { eq, and, desc, ilike, sql } from 'drizzle-orm';
import { db } from '../lib/db.js';
import { decisions, users, spaces } from '@deft/db/schema';

export const decisionRoutes = new Hono();

// GET /api/decisions — list decisions for the org
decisionRoutes.get('/', async (c) => {
  const user = c.get('user');
  const query = c.req.query('query');
  const spaceId = c.req.query('space_id');
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10), 100);
  const offset = (page - 1) * limit;

  const conditions: any[] = [eq(decisions.org_id, user.org_id)];

  if (query) {
    conditions.push(
      sql`(${ilike(decisions.decision_text, `%${query}%`)} OR ${ilike(decisions.context, `%${query}%`)})`,
    );
  }

  if (spaceId) {
    conditions.push(eq(decisions.space_id, spaceId));
  }

  const results = await db
    .select({
      id: decisions.id,
      decision_text: decisions.decision_text,
      decided_by: decisions.decided_by,
      decided_by_name: users.name,
      space_id: decisions.space_id,
      space_name: spaces.name,
      message_id: decisions.message_id,
      context: decisions.context,
      tags: decisions.tags,
      is_reversed: decisions.is_reversed,
      created_at: decisions.created_at,
      updated_at: decisions.updated_at,
    })
    .from(decisions)
    .innerJoin(users, eq(decisions.decided_by, users.id))
    .innerJoin(spaces, eq(decisions.space_id, spaces.id))
    .where(and(...conditions))
    .orderBy(desc(decisions.created_at))
    .limit(limit)
    .offset(offset);

  return c.json({ decisions: results, page, limit });
});

// GET /api/decisions/:id — get single decision
decisionRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const [decision] = await db
    .select({
      id: decisions.id,
      decision_text: decisions.decision_text,
      decided_by: decisions.decided_by,
      decided_by_name: users.name,
      space_id: decisions.space_id,
      space_name: spaces.name,
      message_id: decisions.message_id,
      context: decisions.context,
      tags: decisions.tags,
      is_reversed: decisions.is_reversed,
      created_at: decisions.created_at,
      updated_at: decisions.updated_at,
    })
    .from(decisions)
    .innerJoin(users, eq(decisions.decided_by, users.id))
    .innerJoin(spaces, eq(decisions.space_id, spaces.id))
    .where(and(eq(decisions.id, id), eq(decisions.org_id, user.org_id)))
    .limit(1);

  if (!decision) {
    return c.json({ error: 'Decision not found', code: 'NOT_FOUND' }, 404);
  }

  return c.json(decision);
});

// PATCH /api/decisions/:id — mark as reversed
decisionRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();

  const [existing] = await db
    .select({ id: decisions.id })
    .from(decisions)
    .where(and(eq(decisions.id, id), eq(decisions.org_id, user.org_id)))
    .limit(1);

  if (!existing) {
    return c.json({ error: 'Decision not found', code: 'NOT_FOUND' }, 404);
  }

  const updates: Record<string, any> = {};
  if (typeof body.is_reversed === 'boolean') {
    updates.is_reversed = body.is_reversed;
  }
  if (body.tags !== undefined) {
    updates.tags = body.tags;
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No valid fields to update', code: 'VALIDATION_ERROR' }, 400);
  }

  await db
    .update(decisions)
    .set(updates)
    .where(eq(decisions.id, id));

  return c.json({ success: true });
});
