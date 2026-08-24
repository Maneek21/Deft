/**
 * Phase 4 — delegation_self_report (I7).
 *
 * Audit-only tool. The agent reports its own `sessions_send` delegations to
 * Deft so they appear in the action log. Deft cannot observe agent-internal
 * delegations directly — this is an honesty-based surface and is named
 * accordingly.
 *
 * No approval gating. Writes a row into agent_actions with approval_status
 * 'approved' + executed_at now() so it reads as an already-completed audit log
 * entry rather than something awaiting review.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db.js';
import { agentActions, agentEmployees } from '@deft/db/schema';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';

export type DelegationSelfReportArgs = {
  caller_employee_slug: string;
  target_employee_slug: string;
  reason: string;
  session_id?: string;
};

export async function delegationSelfReport(
  args: DelegationSelfReportArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!args.target_employee_slug) {
    return errorResult('delegation_self_report requires target_employee_slug');
  }
  if (!args.reason) {
    return errorResult('delegation_self_report requires reason');
  }

  try {
    const [emp] = await db
      .select({ user_id: agentEmployees.user_id })
      .from(agentEmployees)
      .where(eq(agentEmployees.id, ctx.employee_id))
      .limit(1);
    const shadowUserId = emp?.user_id;
    if (!shadowUserId) {
      return errorResult(
        `delegation_self_report: no shadow user for employee ${ctx.employee_id}`,
      );
    }

    const now = new Date();
    const [row] = await db
      .insert(agentActions)
      .values({
        org_id: ctx.org_id,
        user_id: shadowUserId,
        agent_employee_id: ctx.employee_id,
        channel_event_id: ctx.channel_event_id,
        runtime_request_key: ctx.runtime_request_key,
        source: 'mcp',
        action: 'delegation_self_report',
        params: {
          target_employee_slug: args.target_employee_slug,
          reason: args.reason,
          session_id: args.session_id ?? null,
        },
        approval_tier: 'auto',
        approval_status: 'approved',
        approved_at: now,
        executed_at: now,
      })
      .returning({ id: agentActions.id });

    if (!row?.id) {
      return errorResult('delegation_self_report: insert returned no row');
    }
    return textResult({ logged: true, action_id: row.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`delegation_self_report failed: ${msg}`);
  }
}
