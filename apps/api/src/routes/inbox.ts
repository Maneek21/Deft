// apps/api/src/routes/inbox.ts
import { Hono } from 'hono';
import { eq, and, desc, sql, lt, gt, inArray } from 'drizzle-orm';
import { db } from '../lib/db.js';
import {
  notifications,
  spaces,
  spaceMembers,
  messages,
  agentActions,
  agentEmployees,
} from '@deft/db/schema';
import { markWorkIntentsExpiredForActions } from '../lib/work-intents.js';

export const inboxRoutes = new Hono();

export type InboxItemKind =
  | 'mention'
  | 'dm_unread'
  | 'task_assigned'
  | 'task_updated'
  | 'blocked'
  | 'cross_reference'
  | 'wiki_update'
  | 'system'
  | 'work_capture'
  | 'pending_approval';

export type InboxItem = {
  id: string;
  kind: InboxItemKind;
  title: string;
  body: string | null;
  link: string | null;
  created_at: string;
  read: boolean;
  source: 'notification' | 'dm' | 'approval';
  approval?: {
    action_id: string;
    action: string;
    params: Record<string, unknown>;
    approval_tier: 'auto' | 'quick' | 'full';
    agent_employee_id: string | null;
    employee_name: string | null;
    employee_slug: string | null;
    employee_avatar: string | null;
    proposer: 'employee' | 'defty';
  };
  dm?: { space_id: string; unread_count: number; last_message_preview: string | null };
};

const NOTIF_KIND_MAP: Record<string, InboxItemKind> = {
  mention: 'mention',
  task_assigned: 'task_assigned',
  task_updated: 'task_updated',
  blocked: 'blocked',
  cross_reference: 'cross_reference',
  wiki_update: 'wiki_update',
  system: 'system',
  task: 'task_updated',
  message: 'mention',
  reminder: 'system',
  huddle_started: 'system',
  workload_imbalance: 'system',
  agent_suggestion: 'system',
  skill_update_available: 'system',
};

function visibleCaptureActionSql(user: { id: string; org_id: string }) {
  return sql`(
    ${agentActions.source} IS DISTINCT FROM 'defty_capture'
    OR (
      (
        COALESCE(
          ${agentActions.params}->>'source_space_id',
          ${agentActions.params}->>'origin_space_id',
          ${agentActions.params}->>'space_id'
        ) IS NULL
        OR EXISTS (
          SELECT 1
          FROM space_members inbox_capture_sm
          INNER JOIN spaces inbox_capture_s
            ON inbox_capture_s.id = inbox_capture_sm.space_id
          WHERE inbox_capture_sm.space_id = COALESCE(
              ${agentActions.params}->>'source_space_id',
              ${agentActions.params}->>'origin_space_id',
              ${agentActions.params}->>'space_id'
            )
            AND inbox_capture_sm.user_id = ${user.id}
            AND inbox_capture_s.org_id = ${user.org_id}
            AND inbox_capture_s.is_archived = false
        )
      )
      AND (
        ${agentActions.params}->>'source_message_id' IS NULL
        OR EXISTS (
          SELECT 1
          FROM messages inbox_capture_m
          INNER JOIN space_members inbox_capture_msg_sm
            ON inbox_capture_msg_sm.space_id = inbox_capture_m.space_id
          INNER JOIN spaces inbox_capture_msg_s
            ON inbox_capture_msg_s.id = inbox_capture_m.space_id
          WHERE inbox_capture_m.id = ${agentActions.params}->>'source_message_id'
            AND inbox_capture_m.org_id = ${user.org_id}
            AND inbox_capture_m.is_deleted = false
            AND inbox_capture_msg_sm.user_id = ${user.id}
            AND inbox_capture_msg_s.org_id = ${user.org_id}
            AND inbox_capture_msg_s.is_archived = false
            AND (
              COALESCE(
                ${agentActions.params}->>'source_space_id',
                ${agentActions.params}->>'origin_space_id',
                ${agentActions.params}->>'space_id'
              ) IS NULL
              OR inbox_capture_m.space_id = COALESCE(
                ${agentActions.params}->>'source_space_id',
                ${agentActions.params}->>'origin_space_id',
                ${agentActions.params}->>'space_id'
              )
            )
        )
      )
      AND (
        ${agentActions.params}->>'source_message_id' IS NULL
        OR EXISTS (
          SELECT 1
          FROM messages inbox_capture_m
          INNER JOIN space_members inbox_capture_msg_sm
            ON inbox_capture_msg_sm.space_id = inbox_capture_m.space_id
          INNER JOIN spaces inbox_capture_msg_s
            ON inbox_capture_msg_s.id = inbox_capture_m.space_id
          WHERE inbox_capture_m.id = ${agentActions.params}->>'source_message_id'
            AND inbox_capture_m.org_id = ${user.org_id}
            AND inbox_capture_m.is_deleted = false
            AND inbox_capture_msg_sm.user_id = ${user.id}
            AND inbox_capture_msg_s.org_id = ${user.org_id}
            AND inbox_capture_msg_s.is_archived = false
            AND (
              COALESCE(
                ${agentActions.params}->>'source_space_id',
                ${agentActions.params}->>'origin_space_id',
                ${agentActions.params}->>'space_id'
              ) IS NULL
              OR inbox_capture_m.space_id = COALESCE(
                ${agentActions.params}->>'source_space_id',
                ${agentActions.params}->>'origin_space_id',
                ${agentActions.params}->>'space_id'
              )
            )
        )
      )
    )
  )`;
}

inboxRoutes.get('/', async (c) => {
  try {
    const user = c.get('user') as { id: string; org_id: string };
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100);
    const cursor = c.req.query('cursor');
    const kindFilter = c.req.query('kind') as InboxItemKind | undefined;
    const countOnly = c.req.query('count_only') === '1';

    const expiredActions = await db.update(agentActions)
      .set({ approval_status: 'expired' })
      .where(and(
        eq(agentActions.org_id, user.org_id),
        eq(agentActions.approval_status, 'pending'),
        lt(agentActions.created_at, new Date(Date.now() - 24 * 60 * 60 * 1000)),
      ))
      .returning({ id: agentActions.id, params: agentActions.params });
    await markWorkIntentsExpiredForActions({
      orgId: user.org_id,
      actions: expiredActions,
    });

    const notifRows = await db.select()
      .from(notifications)
      .where(and(
        eq(notifications.user_id, user.id),
        eq(notifications.org_id, user.org_id),
        cursor ? lt(notifications.created_at, new Date(cursor)) : sql`TRUE`,
      ))
      .orderBy(desc(notifications.created_at))
      .limit(limit);

    const notifItems: InboxItem[] = notifRows.map((n) => ({
      id: `notif:${n.id}`,
      kind: NOTIF_KIND_MAP[n.type as string] ?? 'system',
      title: n.title,
      body: n.body ?? null,
      link: n.link ?? null,
      created_at: (n.created_at instanceof Date ? n.created_at : new Date(n.created_at as unknown as string)).toISOString(),
      read: n.is_read,
      source: 'notification',
    }));

    const dmSpaces = await db.select({
      space_id: spaceMembers.space_id,
      last_read_at: spaceMembers.last_read_at,
      space_name: spaces.name,
      space_type: spaces.type,
    })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaceMembers.space_id, spaces.id))
      .where(and(
        eq(spaceMembers.user_id, user.id),
        eq(spaces.org_id, user.org_id),
        eq(spaces.is_archived, false),
        sql`${spaces.type} IN ('dm','group_dm')`,
      ));

    const dmItems: InboxItem[] = [];
    for (const s of dmSpaces) {
      const lastRead = s.last_read_at ?? new Date(0);
      const [agg] = await db.select({
        count: sql<number>`count(*)::int`,
        latest: sql<Date | null>`MAX(${messages.created_at})`,
        preview: sql<string | null>`(SELECT content FROM ${messages} WHERE space_id = ${s.space_id} AND org_id = ${user.org_id} AND user_id <> ${user.id} AND is_deleted = false ORDER BY created_at DESC LIMIT 1)`,
      })
        .from(messages)
        .where(and(
          eq(messages.space_id, s.space_id),
          eq(messages.org_id, user.org_id),
          gt(messages.created_at, lastRead),
          eq(messages.is_deleted, false),
          sql`${messages.user_id} != ${user.id}`,
          sql`${messages.parent_id} IS NULL`,
        ));
      if (!agg) continue;
      const count = agg.count ?? 0;
      if (count <= 0) continue;
      dmItems.push({
        id: `dm:${s.space_id}`,
        kind: 'dm_unread',
        title: `${count} unread message${count === 1 ? '' : 's'} in ${s.space_name ?? 'DM'}`,
        body: agg.preview,
        link: `/chat?space=${s.space_id}`,
        created_at: (agg.latest instanceof Date ? agg.latest : new Date()).toISOString(),
        read: false,
        source: 'dm',
        dm: { space_id: s.space_id, unread_count: count, last_message_preview: agg.preview },
      });
    }

    const approvalRows = await db.select({
      id: agentActions.id,
      action: agentActions.action,
      params: agentActions.params,
      action_source: agentActions.source,
      approval_tier: agentActions.approval_tier,
      created_at: agentActions.created_at,
      agent_employee_id: agentActions.agent_employee_id,
      employee_name: agentEmployees.name,
      employee_slug: agentEmployees.slug,
      employee_avatar: agentEmployees.avatar_url,
    })
      .from(agentActions)
      .leftJoin(agentEmployees, and(
        eq(agentActions.agent_employee_id, agentEmployees.id),
        eq(agentEmployees.org_id, user.org_id),
      ))
      .where(and(
        eq(agentActions.org_id, user.org_id),
        eq(agentActions.approval_status, 'pending'),
        // Auto-tier rows don't need human approval (chat_mention routing,
        // heartbeat ticks, trigger dispatch, task assignments are
        // pull-queue entries for BYOA runtimes — not user-actionable).
        inArray(agentActions.approval_tier, ['quick', 'full']),
        visibleCaptureActionSql(user),
      ))
      .orderBy(desc(agentActions.created_at))
      .limit(limit);

    const approvalItems: InboxItem[] = approvalRows.map((r) => {
      const isCapture = r.action_source === 'defty_capture';
      return {
        id: `approval:${r.id}`,
        kind: isCapture ? 'work_capture' : 'pending_approval',
        title: isCapture || !r.agent_employee_id
          ? `Defty proposes: ${r.action}`
          : `${r.employee_name ?? 'Agent'} proposes: ${r.action}`,
        body: null,
        link: `/inbox?tab=${isCapture ? 'captures' : 'approvals'}&action=${r.id}`,
        created_at: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at as unknown as string)).toISOString(),
        read: false,
        source: 'approval',
        approval: {
          action_id: r.id,
          action: r.action,
          params: (r.params ?? {}) as Record<string, unknown>,
          approval_tier: r.approval_tier as 'auto' | 'quick' | 'full',
          agent_employee_id: r.agent_employee_id,
          employee_name: r.employee_name,
          employee_slug: r.employee_slug,
          employee_avatar: r.employee_avatar,
          proposer: isCapture || !r.agent_employee_id ? 'defty' : 'employee',
        },
      };
    });

    const all = [...notifItems, ...dmItems, ...approvalItems]
      .filter((it) => !kindFilter || it.kind === kindFilter)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const unreadCount = all.filter((it) => !it.read).length;

    if (countOnly) {
      return c.json({ unread_count: unreadCount });
    }

    const items = all.slice(0, limit);
    const lastItem = items[items.length - 1];
    const nextCursor = items.length === limit && lastItem ? lastItem.created_at : null;

    return c.json({
      items,
      unread_count: unreadCount,
      has_more: nextCursor !== null,
      next_cursor: nextCursor,
    });
  } catch (err) {
    console.error('Failed to fetch inbox:', err);
    return c.json({ error: 'Failed to fetch inbox', code: 'INTERNAL_ERROR' }, 500);
  }
});

inboxRoutes.post('/read', async (c) => {
  try {
    const user = c.get('user') as { id: string; org_id: string };
    const body = await c.req.json().catch(() => ({})) as { ids?: string[]; all?: boolean };

    if (body.all) {
      const updated = await db.update(notifications)
        .set({ is_read: true })
        .where(and(
          eq(notifications.user_id, user.id),
          eq(notifications.org_id, user.org_id),
          eq(notifications.is_read, false),
        ))
        .returning({ id: notifications.id });
      return c.json({ success: true, updated: updated.length });
    }

    // Filter for valid string ids before parsing — clients (or attackers)
    // may send non-string entries (numbers, null, etc.) which would crash
    // the .startsWith call without a typeof guard.
    const notifIds = (Array.isArray(body.ids) ? body.ids : [])
      .filter((id): id is string => typeof id === 'string' && id.startsWith('notif:'))
      .map((id) => id.slice('notif:'.length));

    if (notifIds.length === 0) {
      return c.json({ success: true, updated: 0 });
    }

    const updated = await db.update(notifications)
      .set({ is_read: true })
      .where(and(
        inArray(notifications.id, notifIds),
        eq(notifications.user_id, user.id),
        eq(notifications.org_id, user.org_id),
      ))
      .returning({ id: notifications.id });

    return c.json({ success: true, updated: updated.length });
  } catch (err) {
    console.error('Failed to mark inbox read:', err);
    return c.json({ error: 'Failed to mark read', code: 'INTERNAL_ERROR' }, 500);
  }
});
