/**
 * member_list MCP tool — returns the org roster. Used by employees to resolve
 * @mentions and to know who's on the team when drafting messages.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db.js';
import { users, orgMembers } from '@deft/db/schema';
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
        ),
      )
      .limit(200);

    return textResult(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`member_list failed: ${msg}`);
  }
}
