import { and, eq } from 'drizzle-orm';
import { actionReceipts, agentActions, agentPlans } from '@deft/db/schema';
import { db } from './db.js';
import { generateReceipt, type ReceiptDecision, type ReceiptProposer } from './receipts.js';

/** Sources whose calls are made by a person with their own credential. */
const PERSON_SOURCES: ReadonlySet<string> = new Set([
  'mcp_api', // legacy /api/mcp/call with an API key not bound to an employee
  'mcp', // personal MCP token
]);

/** The plan context key that records who approved the plan (set by the plan approve and resume routes). */
export const PLAN_APPROVER_CONTEXT_KEY = 'approved_by_user_id';

/**
 * C11: a native action run directly or automatically (agent runner, plans,
 * the MCP call route) leaves a signed receipt, as an action approved on the
 * web does. The receipt names who actually acted:
 *
 * - proposer: the agent employee when there is one; otherwise the person
 *   behind a personal-token or legacy API-key call ("user"); otherwise Defty.
 * - decision: "approved" with the stored approver when the row has one; a
 *   step of an approved plan is "approved" by the person who approved the
 *   plan (null for a plan approved before that was recorded); anything else
 *   is "auto_executed" with no approver.
 *
 * Writes nothing when the action already has a receipt under any decision,
 * so a path that signs its own outcome is never doubled. Never throws: a
 * receipt failure must not turn an executed action into a failed one.
 */
export async function recordDirectActionReceipt(input: {
  actionId: string;
  orgId: string;
  userId: string;
  action: string;
  agentEmployeeId: string | null;
  outcome: { success: boolean; result?: unknown; error?: string };
}): Promise<void> {
  try {
    const [row] = await db
      .select({
        approval_status: agentActions.approval_status,
        approved_by_user_id: agentActions.approved_by_user_id,
        params: agentActions.params,
        source: agentActions.source,
        plan_id: agentActions.plan_id,
      })
      .from(agentActions)
      .where(and(eq(agentActions.id, input.actionId), eq(agentActions.org_id, input.orgId)))
      .limit(1);
    if (!row || row.approval_status !== 'approved') return;
    // generateReceipt dedupes per (action, decision) only; this also keeps a
    // second receipt under a different decision from being written.
    const [existing] = await db
      .select({ id: actionReceipts.id })
      .from(actionReceipts)
      .where(and(eq(actionReceipts.action_id, input.actionId), eq(actionReceipts.org_id, input.orgId)))
      .limit(1);
    if (existing) return;

    let decision: ReceiptDecision = 'auto_executed';
    let approverId: string | null = null;
    if (row.approved_by_user_id) {
      decision = 'approved';
      approverId = row.approved_by_user_id;
    } else if (row.plan_id) {
      const [plan] = await db
        .select({ context: agentPlans.context })
        .from(agentPlans)
        .where(and(eq(agentPlans.id, row.plan_id), eq(agentPlans.org_id, input.orgId)))
        .limit(1);
      decision = 'approved';
      const recorded = (plan?.context as Record<string, unknown> | null)?.[PLAN_APPROVER_CONTEXT_KEY];
      approverId = typeof recorded === 'string' && recorded ? recorded : null;
    }

    let proposer: ReceiptProposer = 'defty';
    let proposerId: string = input.userId;
    if (input.agentEmployeeId) {
      proposer = 'employee';
      proposerId = input.agentEmployeeId;
    } else if (row.source && PERSON_SOURCES.has(row.source)) {
      proposer = 'user';
    }

    const { terminalHistoryParams } = await import('./agent-action-execution-lease.js');
    await generateReceipt({
      actionId: input.actionId,
      orgId: input.orgId,
      employeeId: input.agentEmployeeId,
      proposer,
      proposerId,
      approverId,
      decision,
      decisionReason: input.outcome.success
        ? null
        : `execution failed: ${input.outcome.error ?? 'unknown'}`.slice(0, 2_000),
      actionName: input.action,
      actionParams: terminalHistoryParams(input.action, row.params),
      resultJson: input.outcome.success ? input.outcome.result : null,
    });
  } catch (error) {
    console.warn('[direct-action-receipt] receipt not recorded', {
      actionId: input.actionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
