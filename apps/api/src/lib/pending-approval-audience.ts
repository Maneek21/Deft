/**
 * Approvals a viewer can review, for the surfaces that present pending agent
 * actions as approvals for the viewer to act on (the Inbox approval list and
 * its count, the team "Approvals" count, an agent employee's pending count).
 *
 * Ordinary actions follow the web review gate (`reviewableActionSql`): the
 * requester when an active human member, otherwise the active owners/admins,
 * with the capture room and action source checks. App Run releases and
 * record-mirror nominations have their own approval paths, so each surface
 * keeps its own rule for them (`specialApprovalActionSql`).
 *
 * Activity feeds and action history are reads, not review queues: they use
 * the read audience (module-action-visibility.ts), not this predicate.
 */
import { and, eq, inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import { agentActions } from '@deft/db/schema';
import { db } from './db.js';
import { reviewableActionSql } from './agent-action-review-gate.js';
import { actionReviewerCandidateSql } from './agent-action-requester.js';

export const SPECIAL_APPROVAL_ACTIONS = ['app_run_invoke', 'app_record_mirror_nominate'] as const;

type Viewer = { id: string; org_id: string; role?: string };

/** Pending App Run releases and record-mirror nominations. */
export function specialApprovalActionSql(): SQL {
  return inArray(agentActions.action, [...SPECIAL_APPROVAL_ACTIONS]);
}

/**
 * Pending ordinary actions needing a human decision that the viewer reviews.
 * The review gate runs only on the viewer's candidates
 * (`actionReviewerCandidateSql`, true wherever the gate is); CASE fixes that
 * order. A positive filter only: never negate it.
 */
export function ordinaryPendingApprovalSql(viewer: Viewer): SQL {
  return and(
    eq(agentActions.org_id, viewer.org_id),
    eq(agentActions.approval_status, 'pending'),
    inArray(agentActions.approval_tier, ['quick', 'full']),
    notInArray(agentActions.action, [...SPECIAL_APPROVAL_ACTIONS]),
    sql`(CASE WHEN ${actionReviewerCandidateSql(viewer.id, viewer.org_id)}
      THEN ${reviewableActionSql(viewer)} ELSE false END)`,
  )!;
}

/**
 * Pending approvals the viewer can review, by agent employee: ordinary actions
 * through the review gate, and every pending App Run release or record-mirror
 * nomination of the employee.
 */
export async function reviewableApprovalCountsByEmployee(
  viewer: Viewer,
  employeeIds?: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (employeeIds && employeeIds.length === 0) return counts;
  const rows = await db
    .select({ employee_id: agentActions.agent_employee_id, count: sql<number>`count(*)::int` })
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, viewer.org_id),
      employeeIds
        ? inArray(agentActions.agent_employee_id, [...employeeIds])
        : sql`${agentActions.agent_employee_id} IS NOT NULL`,
      sql`((${specialApprovalActionSql()} AND ${agentActions.approval_status} = 'pending')
        OR ${ordinaryPendingApprovalSql(viewer)})`,
    ))
    .groupBy(agentActions.agent_employee_id);
  for (const row of rows) if (row.employee_id) counts.set(row.employee_id, Number(row.count));
  return counts;
}
