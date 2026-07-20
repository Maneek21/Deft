import { Hono } from 'hono';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  agentActions,
  agentEmployees,
  attentionEvents,
  attentionItems,
} from '@deft/db/schema';
import { db } from '../lib/db.js';
import {
  ensureAttentionBackfillForUser,
  filterVisibleAttentionItems,
  recordAttentionFeedback,
  transitionAttentionItem,
  visibleAttentionCondition,
  type AttentionLane,
  type AttentionState,
} from '../lib/attention.js';

export const attentionRoutes = new Hono();

const OPEN_STATES: AttentionState[] = ['open_unseen', 'open_seen', 'acknowledged'];
const ALL_STATES: AttentionState[] = [
  ...OPEN_STATES,
  'snoozed',
  'resolved',
  'expired',
  'superseded',
];

function encodeCursor(item: { last_event_at: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ at: item.last_event_at.toISOString(), id: item.id })).toString('base64url');
}

function decodeCursor(value: string | undefined): { at: Date; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown };
    const at = typeof parsed.at === 'string' ? new Date(parsed.at) : null;
    if (!at || Number.isNaN(at.getTime()) || typeof parsed.id !== 'string') return null;
    return { at, id: parsed.id };
  } catch {
    return null;
  }
}

function parseLane(value: string | undefined): AttentionLane | null {
  if (!value) return null;
  return value === 'needs_you' || value === 'updates' ? value : null;
}

function parseStates(value: string | undefined): AttentionState[] | null {
  if (!value || value === 'open') return OPEN_STATES;
  if (value === 'all') return ALL_STATES;
  const states = value.split(',').map((state) => state.trim()) as AttentionState[];
  if (states.length === 0 || states.some((state) => !ALL_STATES.includes(state))) return null;
  return states;
}

async function hasVisibleItem(orgId: string, userId: string, itemId: string) {
  const [item] = await db
    .select({ id: attentionItems.id })
    .from(attentionItems)
    .where(and(
      eq(attentionItems.id, itemId),
      eq(attentionItems.org_id, orgId),
      eq(attentionItems.user_id, userId),
      visibleAttentionCondition(userId),
    ))
    .limit(1);
  return Boolean(item);
}

async function hydrateApprovals(rows: Array<typeof attentionItems.$inferSelect>) {
  const actionIds = rows
    .filter((item) => item.source_type === 'agent_action')
    .map((item) => item.source_id);
  if (actionIds.length === 0) return rows.map((item) => ({ ...item, approval: null }));

  const actions = await db
    .select({
      id: agentActions.id,
      action: agentActions.action,
      params: agentActions.params,
      approval_tier: agentActions.approval_tier,
      approval_status: agentActions.approval_status,
      result: agentActions.result,
      error: agentActions.error,
      agent_employee_id: agentActions.agent_employee_id,
      employee_name: agentEmployees.name,
      employee_slug: agentEmployees.slug,
      employee_avatar: agentEmployees.avatar_url,
    })
    .from(agentActions)
    .leftJoin(agentEmployees, eq(agentEmployees.id, agentActions.agent_employee_id))
    .where(inArray(agentActions.id, actionIds));
  const byId = new Map(actions.map((action) => [action.id, action]));
  return rows.map((item) => ({
    ...item,
    approval: item.source_type === 'agent_action' ? byId.get(item.source_id) ?? null : null,
  }));
}

attentionRoutes.get('/', async (c) => {
  const user = c.get('user') as { id: string; org_id: string; role: string };
  const laneParam = c.req.query('lane');
  const lane = parseLane(laneParam);
  if (laneParam && !lane) return c.json({ error: 'Invalid attention lane', code: 'VALIDATION_ERROR' }, 400);
  const states = parseStates(c.req.query('state'));
  if (!states) return c.json({ error: 'Invalid attention state', code: 'VALIDATION_ERROR' }, 400);
  const limit = Math.min(Math.max(Number.parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 100);
  const cursorValue = c.req.query('cursor');
  const cursor = decodeCursor(cursorValue);
  if (cursorValue && !cursor) return c.json({ error: 'Invalid cursor', code: 'VALIDATION_ERROR' }, 400);

  await ensureAttentionBackfillForUser({ orgId: user.org_id, userId: user.id, role: user.role });

  const rows = await db
    .select()
    .from(attentionItems)
    .where(and(
      eq(attentionItems.org_id, user.org_id),
      eq(attentionItems.user_id, user.id),
      lane ? eq(attentionItems.lane, lane) : sql`true`,
      inArray(attentionItems.state, states),
      visibleAttentionCondition(user.id),
      cursor
        ? sql`(${attentionItems.last_event_at}, ${attentionItems.id}) < (${cursor.at}, ${cursor.id})`
        : sql`true`,
    ))
    .orderBy(desc(attentionItems.last_event_at), desc(attentionItems.id))
    .limit(limit + 1);

  const visibleRows = await filterVisibleAttentionItems(user.id, rows);
  const hasMore = visibleRows.length > limit;
  const page = visibleRows.slice(0, limit);
  const hydrated = await hydrateApprovals(page);
  const counts = await db
    .select({
      lane: attentionItems.lane,
      count: sql<number>`count(*)::int`,
      unseen: sql<number>`count(*) FILTER (WHERE ${attentionItems.state} = 'open_unseen')::int`,
    })
    .from(attentionItems)
    .where(and(
      eq(attentionItems.org_id, user.org_id),
      eq(attentionItems.user_id, user.id),
      inArray(attentionItems.state, OPEN_STATES),
      visibleAttentionCondition(user.id),
    ))
    .groupBy(attentionItems.lane);
  const byLane = Object.fromEntries(counts.map((row) => [row.lane, {
    count: Number(row.count),
    unseen: Number(row.unseen),
  }]));

  return c.json({
    items: hydrated,
    counts: {
      needs_you: byLane.needs_you ?? { count: 0, unseen: 0 },
      updates: byLane.updates ?? { count: 0, unseen: 0 },
    },
    next_cursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null,
  });
});

attentionRoutes.get('/:id', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const [item] = await db
    .select()
    .from(attentionItems)
    .where(and(
      eq(attentionItems.id, c.req.param('id')),
      eq(attentionItems.org_id, user.org_id),
      eq(attentionItems.user_id, user.id),
      visibleAttentionCondition(user.id),
    ))
    .limit(1);
  if (!item) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  const visible = await filterVisibleAttentionItems(user.id, [item]);
  if (visible.length === 0) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  const [hydrated] = await hydrateApprovals(visible);
  return c.json({ item: hydrated });
});

attentionRoutes.post('/:id/seen', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  if (!await hasVisibleItem(user.org_id, user.id, c.req.param('id'))) {
    return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }
  const item = await transitionAttentionItem({
    orgId: user.org_id,
    userId: user.id,
    itemId: c.req.param('id'),
    state: 'open_seen',
    actorUserId: user.id,
  });
  if (!item) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  return c.json({ item });
});

attentionRoutes.post('/:id/acknowledge', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  if (!await hasVisibleItem(user.org_id, user.id, c.req.param('id'))) {
    return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }
  const item = await transitionAttentionItem({
    orgId: user.org_id,
    userId: user.id,
    itemId: c.req.param('id'),
    state: 'acknowledged',
    actorUserId: user.id,
  });
  if (!item) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  return c.json({ item });
});

attentionRoutes.post('/:id/snooze', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  if (!await hasVisibleItem(user.org_id, user.id, c.req.param('id'))) {
    return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const until = typeof body?.until === 'string' ? new Date(body.until) : null;
  if (!until || Number.isNaN(until.getTime()) || until <= new Date()) {
    return c.json({ error: 'A future snooze time is required', code: 'VALIDATION_ERROR' }, 400);
  }
  const item = await transitionAttentionItem({
    orgId: user.org_id,
    userId: user.id,
    itemId: c.req.param('id'),
    state: 'snoozed',
    snoozedUntil: until,
    actorUserId: user.id,
  });
  if (!item) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  return c.json({ item });
});

attentionRoutes.post('/:id/resolve', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  if (!await hasVisibleItem(user.org_id, user.id, c.req.param('id'))) {
    return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  const item = await transitionAttentionItem({
    orgId: user.org_id,
    userId: user.id,
    itemId: c.req.param('id'),
    state: 'resolved',
    resolution: typeof body?.resolution === 'string' ? body.resolution.slice(0, 120) : 'dismissed',
    actorUserId: user.id,
  });
  if (!item) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  return c.json({ item });
});

attentionRoutes.post('/:id/feedback', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  if (!await hasVisibleItem(user.org_id, user.id, c.req.param('id'))) {
    return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }
  const body = await c.req.json().catch(() => ({}));
  if (body?.feedback !== 'not_for_me' && body?.feedback !== 'not_urgent') {
    return c.json({ error: 'Invalid feedback', code: 'VALIDATION_ERROR' }, 400);
  }
  const item = await recordAttentionFeedback({
    orgId: user.org_id,
    userId: user.id,
    itemId: c.req.param('id'),
    feedback: body.feedback,
  });
  if (!item) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  return c.json({ item });
});

attentionRoutes.post('/mark-all-seen', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const body = await c.req.json().catch(() => ({}));
  const lane = parseLane(typeof body?.lane === 'string' ? body.lane : undefined);
  const now = new Date();
  const updated = await db
    .update(attentionItems)
    .set({
      state: 'open_seen',
      seen_at: now,
      version: sql`${attentionItems.version} + 1`,
      updated_at: now,
    })
    .where(and(
      eq(attentionItems.org_id, user.org_id),
      eq(attentionItems.user_id, user.id),
      eq(attentionItems.state, 'open_unseen'),
      lane ? eq(attentionItems.lane, lane) : sql`true`,
      visibleAttentionCondition(user.id),
    ))
    .returning({ id: attentionItems.id, version: attentionItems.version });
  if (updated.length > 0) {
    await db.insert(attentionEvents).values(updated.map((item) => ({
      org_id: user.org_id,
      attention_item_id: item.id,
      user_id: user.id,
      event_type: 'open_seen',
      source_event_id: `mark-all-seen:${item.id}:${item.version}:${now.getTime()}`,
      actor_user_id: user.id,
      payload: { bulk: true },
    })));
  }
  return c.json({ updated: updated.length });
});
