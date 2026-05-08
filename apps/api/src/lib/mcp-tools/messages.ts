/**
 * thread_fetch MCP tool — Phase 3 read-only conversation history fetch.
 *
 * Given a parent message id, returns the parent + its replies in chronological
 * order. The employee uses this to get context before replying in a thread.
 *
 * message_post (write) is Phase 4 and gated by trust level.
 */
import { and, eq, asc, or, desc } from 'drizzle-orm';
import { db } from '../db.js';
import { messages, users, spaces, spaceMembers, agentEmployees, agentActions } from '@deft/db/schema';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';

/**
 * Phase 12 review fix: before returning any thread content, verify the
 * caller employee is allowed to see the parent message's space:
 *   - same org
 *   - space is public OR the employee's shadow user is a space_members row
 *
 * Without this, an employee bearer-scoped to the org can read any private
 * space's threads by id-guessing a parent_message_id.
 */
async function canEmployeeSeeSpace(
  spaceId: string,
  orgId: string,
  employeeId: string,
): Promise<boolean> {
  const [space] = await db
    .select({ id: spaces.id, type: spaces.type })
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.org_id, orgId)))
    .limit(1);
  if (!space) return false;
  if (space.type === 'public') return true;

  const [emp] = await db
    .select({ user_id: agentEmployees.user_id })
    .from(agentEmployees)
    .where(eq(agentEmployees.id, employeeId))
    .limit(1);
  if (!emp?.user_id) return false;

  const [member] = await db
    .select({ id: spaceMembers.id })
    .from(spaceMembers)
    .where(
      and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, emp.user_id)),
    )
    .limit(1);
  return !!member;
}

export type ThreadFetchArgs = {
  caller_employee_slug: string;
  parent_message_id: string;
  limit?: number;
};

export async function threadFetch(
  args: ThreadFetchArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!args.parent_message_id) {
    return errorResult('thread_fetch requires parent_message_id');
  }
  const limit = Math.min(Math.max(1, args.limit ?? 50), 200);

  try {
    // Resolve the parent's space first so we can do a membership check.
    const [parent] = await db
      .select({ space_id: messages.space_id })
      .from(messages)
      .where(
        and(eq(messages.id, args.parent_message_id), eq(messages.org_id, ctx.org_id)),
      )
      .limit(1);
    if (!parent) {
      return errorResult(
        `thread_fetch: parent message ${args.parent_message_id} not found in caller's org`,
      );
    }
    if (!(await canEmployeeSeeSpace(parent.space_id, ctx.org_id, ctx.employee_id))) {
      return errorResult(
        `thread_fetch: employee not a member of space ${parent.space_id}`,
      );
    }

    const rows = await db
      .select({
        id: messages.id,
        parent_id: messages.parent_id,
        user_id: messages.user_id,
        user_name: users.name,
        content: messages.content,
        created_at: messages.created_at,
        edited_at: messages.edited_at,
        is_deleted: messages.is_deleted,
        space_id: messages.space_id,
      })
      .from(messages)
      .innerJoin(users, eq(messages.user_id, users.id))
      .where(
        and(
          eq(messages.org_id, ctx.org_id),
          or(
            eq(messages.id, args.parent_message_id),
            eq(messages.parent_id, args.parent_message_id),
          ),
        ),
      )
      .orderBy(asc(messages.created_at))
      .limit(limit);

    return textResult(
      rows.map((r) => ({
        id: r.id,
        parent_id: r.parent_id,
        user_id: r.user_id,
        user_name: r.user_name,
        content: r.is_deleted ? '[deleted]' : r.content,
        created_at: r.created_at,
        edited_at: r.edited_at,
        space_id: r.space_id,
      })),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`thread_fetch failed: ${msg}`);
  }
}

// ─── fetch_unread ────────────────────────────────────────────────────────────

export type FetchUnreadArgs = {
  caller_employee_slug: string;
  limit?: number;
  space_id?: string;
};

/**
 * Phase 3 of agent-chat unification — unified inbox tool.
 *
 * Returns:
 *   unread_messages: messages newer than caller's last_read_at in spaces they
 *     are a member of (via their shadow user), excluding their own posts.
 *   pending_actions: pending agent_actions for the calling employee.
 *
 * One MCP roundtrip surfaces both kinds of pending work, superseding
 * poll_pending_work for agents that also need to track chat.
 */
export async function fetchUnread(
  args: FetchUnreadArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const limit = Math.min(Math.max(1, args.limit ?? 20), 100);

  try {
    // Resolve the employee's shadow user_id so we can check space membership.
    const [emp] = await db
      .select({ user_id: agentEmployees.user_id })
      .from(agentEmployees)
      .where(
        and(eq(agentEmployees.id, ctx.employee_id), eq(agentEmployees.org_id, ctx.org_id)),
      )
      .limit(1);

    if (!emp?.user_id) {
      return errorResult('fetch_unread: employee has no shadow user — cannot resolve space membership');
    }

    const shadowUserId = emp.user_id;

    // Unread chat messages (spaces the shadow user is a member of, newer than
    // last_read_at, excluding the caller's own posts).
    const unreadRows = await db
      .select({
        id: messages.id,
        space_id: messages.space_id,
        user_id: messages.user_id,
        user_name: users.name,
        content: messages.content,
        parent_id: messages.parent_id,
        space_type: spaces.type,
        created_at: messages.created_at,
      })
      .from(messages)
      .innerJoin(
        spaceMembers,
        and(
          eq(spaceMembers.space_id, messages.space_id),
          eq(spaceMembers.user_id, shadowUserId),
        ),
      )
      .innerJoin(spaces, eq(spaces.id, messages.space_id))
      .innerJoin(users, eq(users.id, messages.user_id))
      .where(
        and(
          eq(messages.org_id, ctx.org_id),
          eq(messages.is_deleted, false),
          ...(args.space_id ? [eq(messages.space_id, args.space_id)] : []),
        ),
      )
      .orderBy(desc(messages.created_at))
      .limit(limit);

    // Filter in JS: exclude caller's own posts and messages not newer than
    // last_read_at. The join doesn't expose last_read_at on the select so we
    // re-fetch it only for the space_ids we touched — but simpler is to do
    // the filter via a subquery. For now we filter post-fetch to keep the
    // query readable; the result set is already bounded by `limit`.
    //
    // Fetch last_read_at per space for the shadow user.
    const spaceIds = [...new Set(unreadRows.map((r) => r.space_id))];
    let lastReadMap: Record<string, Date | null> = {};
    if (spaceIds.length > 0) {
      const memberRows = await db
        .select({ space_id: spaceMembers.space_id, last_read_at: spaceMembers.last_read_at })
        .from(spaceMembers)
        .where(
          and(
            eq(spaceMembers.user_id, shadowUserId),
          ),
        );
      for (const row of memberRows) {
        lastReadMap[row.space_id] = row.last_read_at ?? null;
      }
    }

    const unreadMessages = unreadRows
      .filter((r) => {
        // Exclude caller's own shadow-user posts.
        if (r.user_id === shadowUserId) return false;
        // Exclude messages not newer than last_read_at.
        const lastRead = lastReadMap[r.space_id];
        if (lastRead && r.created_at <= lastRead) return false;
        return true;
      })
      .map((r) => ({
        id: r.id,
        space_id: r.space_id,
        user_id: r.user_id,
        user_name: r.user_name,
        content: r.content,
        parent_id: r.parent_id,
        space_type: r.space_type,
        is_dm: r.space_type === 'dm' || r.space_type === 'group_dm' || r.space_type === 'agent_conversation',
        created_at: r.created_at,
      }));

    // Pending agent_actions for the calling employee.
    const actionRows = await db
      .select({
        id: agentActions.id,
        action: agentActions.action,
        params: agentActions.params,
        approval_tier: agentActions.approval_tier,
        created_at: agentActions.created_at,
      })
      .from(agentActions)
      .where(
        and(
          eq(agentActions.agent_employee_id, ctx.employee_id),
          eq(agentActions.approval_status, 'pending'),
        ),
      )
      .orderBy(desc(agentActions.created_at))
      .limit(25);

    return textResult({
      unread_messages: unreadMessages,
      pending_actions: actionRows,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`fetch_unread failed: ${msg}`);
  }
}
