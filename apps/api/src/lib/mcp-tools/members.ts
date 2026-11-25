/**
 * member_list MCP tool — returns the org roster. Used by employees to resolve
 * @mentions and to know who's on the team when drafting messages.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db.js';
import { users, orgMembers, agentEmployees } from '@deft/db/schema';
import { peopleViewer, personVisibleSql, withoutHiddenEmails } from '../people-visibility.js';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';

export type MemberListArgs = {
  caller_employee_slug: string;
};

export async function memberList(
  _args: MemberListArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    // The agent's own workspace role decides what it sees: an agent an owner
    // made a guest sees only the people who share a space with it, without
    // their email addresses (lib/people-visibility.ts).
    const [employee] = await db.select({ user_id: agentEmployees.user_id })
      .from(agentEmployees)
      .where(and(eq(agentEmployees.id, ctx.employee_id), eq(agentEmployees.org_id, ctx.org_id)))
      .limit(1);
    if (!employee?.user_id) return errorResult('member_list: caller employee not found');
    const viewer = await peopleViewer(ctx.org_id, employee.user_id);
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: orgMembers.role,
        is_agent: users.is_agent,
      })
      .from(orgMembers)
      .innerJoin(users, eq(orgMembers.user_id, users.id))
      .where(
        and(
          eq(orgMembers.org_id, ctx.org_id),
          eq(orgMembers.is_active, true),
          personVisibleSql(viewer, users.id),
        ),
      )
      .limit(200);

    return textResult(withoutHiddenEmails(viewer, rows, (row) => row.id));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`member_list failed: ${msg}`);
  }
}
