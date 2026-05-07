// apps/api/src/routes/inbox.ts
import { Hono } from 'hono';
import { eq, and, desc, sql, lt, gt } from 'drizzle-orm';
import { db } from '../lib/db.js';
import {
  notifications,
  spaces,
  spaceMembers,
  messages,
  agentActions,
  agentEmployees,
} from '@deft/db/schema';

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

inboxRoutes.get('/', async (c) => {
  try {
    const user = c.get('user') as { id: string; org_id: string };
    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100);
    const cursor = c.req.query('cursor');
    const kindFilter = c.req.query('kind') as InboxItemKind | undefined;
    const countOnly = c.req.query('count_only') === '1';

    await db.update(agentActions)
      .set({ approval_status: 'expired' })
      .where(and(
        eq(agentActions.org_id, user.org_id),
        eq(agentActions.approval_status, 'pending'),
        lt(agentActions.created_at, new Date(Date.now() - 24 * 60 * 60 * 1000)),
      ));

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
        preview: sql<string | null>`(SELECT content FROM ${messages} WHERE space_id = ${s.space_id} AND user_id <> ${user.id} AND is_deleted = false ORDER BY created_at DESC LIMIT 1)`,
      })
        .from(messages)
        .where(and(
          eq(messages.space_id, s.space_id),
          gt(messages.created_at, lastRead),
          eq(messages.is_deleted, false),
          sql`${messages.user_id} != ${user.id}`,
          sql`${messages.parent_id} IS NULL`,
        ));
      const count = agg?.count ?? 0;
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
      approval_tier: agentActions.approval_tier,
      created_at: agentActions.created_at,
      agent_employee_id: agentActions.agent_employee_id,
      employee_name: agentEmployees.name,
      employee_slug: agentEmployees.slug,
      employee_avatar: agentEmployees.avatar_url,
    })
      .from(agentActions)
      .leftJoin(agentEmployees, eq(agentActions.agent_employee_id, agentEmployees.id))
      .where(and(
        eq(agentActions.org_id, user.org_id),
        eq(agentActions.approval_status, 'pending'),
      ))
      .orderBy(desc(agentActions.created_at))
      .limit(limit);

    const approvalItems: InboxItem[] = approvalRows.map((r) => ({
      id: `approval:${r.id}`,
      kind: 'pending_approval',
      title: r.employee_name ? `${r.employee_name} proposes: ${r.action}` : `Defty proposes: ${r.action}`,
      body: null,
      link: `/inbox?tab=approvals&action=${r.id}`,
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
        proposer: r.agent_employee_id ? 'employee' : 'defty',
      },
    }));

    const all = [...notifItems, ...dmItems, ...approvalItems]
      .filter((it) => !kindFilter || it.kind === kindFilter)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const unreadCount = all.filter((it) => !it.read).length;

    if (countOnly) {
      return c.json({ unread_count: unreadCount });
    }

    const items = all.slice(0, limit);
    const nextCursor = items.length === limit ? items[items.length - 1].created_at : null;

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
