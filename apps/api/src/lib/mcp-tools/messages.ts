/**
 * thread_fetch MCP tool — Phase 3 read-only conversation history fetch.
 *
 * Given a parent message id, returns the parent + its replies in chronological
 * order. The employee uses this to get context before replying in a thread.
 *
 * message_post (write) is Phase 4 and gated by trust level.
 */
import { and, eq, asc, or } from 'drizzle-orm';
import { db } from '../db.js';
import { messages, users, spaces, spaceMembers, agentEmployees } from '@deft/db/schema';
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
