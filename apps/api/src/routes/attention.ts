import {hasHumanMcpBulkProvenance, viewerReviewAuthority} from '../lib/agent-approval-resolver.js';
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
  currentApprovalRecipientSql,
  ensureAttentionBackfillForUser,
  lockedAttentionIdsSql,
  filterVisibleAttentionItems,
  projectAttentionItem,
  recordAttentionFeedback,
  transitionAttentionItem,
  readAttentionWithSourceTypes,
  visibleAttentionCondition,
  writeAttentionWithSourceTypes,
  type AttentionLane,
  type AttentionState,
} from '../lib/attention.js';

export const attentionRoutes = new Hono();
export function attentionActionProposer(row:Parameters<typeof hasHumanMcpBulkProvenance>[0]) {
  return hasHumanMcpBulkProvenance(row)?'user':row.source==='defty_capture'||!row.agent_employee_id?'defty':'employee';
}

const OPEN_STATES: AttentionState[] = ['open_unseen', 'open_seen', 'acknowledged'];
/** Events per insert in mark-all-seen (eight parameters each, at most 65,535 per statement). */
export const MARK_ALL_SEEN_EVENT_BATCH = 1_000;
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
  const itemWhere = and(
    eq(attentionItems.id, itemId),
    eq(attentionItems.org_id, orgId),
    eq(attentionItems.user_id, userId),
  );
  const [item] = await readAttentionWithSourceTypes(itemWhere, (tx, sourceTypes) => tx
    .select({ id: attentionItems.id })
    .from(attentionItems)
    .where(and(itemWhere, visibleAttentionCondition(userId, sourceTypes)))
    .limit(1));
  return Boolean(item);
}

/**
 * Attach each agent-action item's approval for the viewer. An item whose
 * action the viewer cannot review now (under the current role) is dropped, so neither its params nor its summary are served.
 */
async function hydrateApprovals(
  viewer: { id: string; org_id: string; role?: string },
  rows: Array<typeof attentionItems.$inferSelect>,
) {
  const actionIds = rows
    .filter((item) => item.source_type === 'agent_action')
    .map((item) => item.source_id);
  if (actionIds.length === 0) return rows.map((item) => ({ ...projectAttentionItem(item), approval: null }));

  const actions = await db
    .select({
      id: agentActions.id,
      action: agentActions.action,
      source: agentActions.source,
      has_receipt: sql<boolean>`EXISTS (SELECT 1 FROM action_receipts r WHERE r.action_id = ${agentActions.id})`,
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
    .where(and(
      inArray(agentActions.id, actionIds),
      eq(agentActions.org_id, viewer.org_id),
      currentApprovalRecipientSql(viewer.id),
    ));
  // Whether this viewer may approve or reject, as the approve and reject routes
  // answer; `viewer_can_approve` is absent when only the App Run approval path
  // can tell. The ids keep the page's order.
  const visible = new Set(actions.map((action) => action.id));
  const reviewAuthority = await viewerReviewAuthority(viewer, actionIds.filter((id) => visible.has(id)));
  const byId = new Map(actions.map((action) => [action.id, {...action,proposer:attentionActionProposer(action),
    ...reviewAuthority.get(action.id),
  }]));
  return rows.filter((item) => item.source_type !== 'agent_action' || byId.has(item.source_id)).map((item) => ({
    ...projectAttentionItem(item),
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

  // The page and the counts below each read their items' source types on
  // their own snapshot, so their visibility condition plans only those
  // types' rules (lib/attention.ts, readAttentionWithSourceTypes).
  const pageWhere = and(
    eq(attentionItems.org_id, user.org_id),
    eq(attentionItems.user_id, user.id),
    lane ? eq(attentionItems.lane, lane) : sql`true`,
    inArray(attentionItems.state, states),
    cursor
      ? sql`(${attentionItems.last_event_at}, ${attentionItems.id}) < (${cursor.at}, ${cursor.id})`
      : sql`true`,
  );
  const rows = await readAttentionWithSourceTypes(pageWhere, (tx, sourceTypes) => tx
    .select()
    .from(attentionItems)
    .where(and(pageWhere, visibleAttentionCondition(user.id, sourceTypes)))
    .orderBy(desc(attentionItems.last_event_at), desc(attentionItems.id))
    .limit(limit + 1));

  const visibleRows = await filterVisibleAttentionItems(user.id, rows);
  const hasMore = visibleRows.length > limit;
  const page = visibleRows.slice(0, limit);
  const hydrated = await hydrateApprovals(user, page);
  const openWhere = and(
    eq(attentionItems.org_id, user.org_id),
    eq(attentionItems.user_id, user.id),
    inArray(attentionItems.state, OPEN_STATES),
  );
  const counts = await readAttentionWithSourceTypes(openWhere, (tx, sourceTypes) => tx
    .select({
      lane: attentionItems.lane,
      count: sql<number>`count(*)::int`,
      unseen: sql<number>`count(*) FILTER (WHERE ${attentionItems.state} = 'open_unseen')::int`,
    })
    .from(attentionItems)
    .where(and(openWhere, visibleAttentionCondition(user.id, sourceTypes)))
    .groupBy(attentionItems.lane));
  const byLane = Object.fromEntries(counts.map((row) => [row.lane, {
    count: Number(row.count),
    unseen: Number(row.unseen),
  }]));
  const finalRows = await filterVisibleAttentionItems(user.id, hydrated);

  return c.json({
    items: finalRows.map(projectAttentionItem),
    counts: {
      needs_you: byLane.needs_you ?? { count: 0, unseen: 0 },
      updates: byLane.updates ?? { count: 0, unseen: 0 },
    },
    next_cursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null,
  });
});

attentionRoutes.get('/:id', async (c) => {
  const user = c.get('user') as { id: string; org_id: string; role?: string };
  const itemWhere = and(
    eq(attentionItems.id, c.req.param('id')),
    eq(attentionItems.org_id, user.org_id),
    eq(attentionItems.user_id, user.id),
  );
  const [item] = await readAttentionWithSourceTypes(itemWhere, (tx, sourceTypes) => tx
    .select()
    .from(attentionItems)
    .where(and(itemWhere, visibleAttentionCondition(user.id, sourceTypes)))
    .limit(1));
  if (!item) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  const visible = await filterVisibleAttentionItems(user.id, [item]);
  if (visible.length === 0) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  const [hydrated] = await filterVisibleAttentionItems(user.id, await hydrateApprovals(user, visible));
  if (!hydrated) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  return c.json({ item: projectAttentionItem(hydrated) });
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
    viewerId: user.id,
  });
  if (!item) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  return c.json({ item: projectAttentionItem(item) });
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
    viewerId: user.id,
  });
  if (!item) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  return c.json({ item: projectAttentionItem(item) });
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
    viewerId: user.id,
  });
  if (!item) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  return c.json({ item: projectAttentionItem(item) });
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
    viewerId: user.id,
  });
  if (!item) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  return c.json({ item: projectAttentionItem(item) });
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
  return c.json({ item: projectAttentionItem(item) });
});

attentionRoutes.post('/mark-all-seen', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  const body = await c.req.json().catch(() => ({}));
  const lane = parseLane(typeof body?.lane === 'string' ? body.lane : undefined);
  const now = new Date();
  const unseen = and(
    eq(attentionItems.org_id, user.org_id),
    eq(attentionItems.user_id, user.id),
    eq(attentionItems.state, 'open_unseen'),
    lane ? eq(attentionItems.lane, lane) : sql`true`,
  );
  // The unseen items are locked first, so none changes source type before the
  // update reads it (lib/attention.ts, writeAttentionWithSourceTypes).
  // Only the locked items change: one that arrives or reopens meanwhile stays
  // unseen, whole, as if it had arrived a moment later. Their events commit
  // with the change, in batches (a statement may have at most 65,535
  // parameters, eight per event).
  const updated = await writeAttentionWithSourceTypes(unseen, async (tx, sourceTypes, lockedIds) => {
    const changed = await tx
      .update(attentionItems)
      .set({
        state: 'open_seen',
        seen_at: now,
        version: sql`${attentionItems.version} + 1`,
        updated_at: now,
      })
      .where(and(unseen, lockedAttentionIdsSql(lockedIds), visibleAttentionCondition(user.id, sourceTypes)))
      .returning({ id: attentionItems.id, version: attentionItems.version });
    for (let start = 0; start < changed.length; start += MARK_ALL_SEEN_EVENT_BATCH) {
      await tx.insert(attentionEvents).values(changed.slice(start, start + MARK_ALL_SEEN_EVENT_BATCH).map((item) => ({
        org_id: user.org_id,
        attention_item_id: item.id,
        user_id: user.id,
        event_type: 'open_seen',
        source_event_id: `mark-all-seen:${item.id}:${item.version}:${now.getTime()}`,
        actor_user_id: user.id,
        payload: { bulk: true },
      })));
    }
    return changed;
  }, []);
  return c.json({ updated: updated.length });
});
