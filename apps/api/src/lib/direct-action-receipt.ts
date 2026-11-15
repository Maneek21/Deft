import { and, eq } from 'drizzle-orm';
import { actionReceipts, agentActions } from '@deft/db/schema';
import { db } from './db.js';
import { generateReceipt } from './receipts.js';

/**
 * C11: a native action the built-in assistant ran directly or automatically
 * (agent runner, plans, the MCP call route) leaves a signed receipt, as an
 * action approved on the web does. Marked "approved" when the stored row has
 * an approver, otherwise "auto_executed". Writes nothing when the action
 * already has a receipt, so a path that signs its own outcome is never
 * doubled. Never throws: a receipt failure must not turn an executed action
 * into a failed one.
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
      })
      .from(agentActions)
      .where(and(eq(agentActions.id, input.actionId), eq(agentActions.org_id, input.orgId)))
      .limit(1);
    if (!row || row.approval_status !== 'approved') return;
    const [existing] = await db
      .select({ id: actionReceipts.id })
      .from(actionReceipts)
      .where(and(eq(actionReceipts.action_id, input.actionId), eq(actionReceipts.org_id, input.orgId)))
      .limit(1);
    if (existing) return;
    const { terminalHistoryParams } = await import('./agent-action-execution-lease.js');
    const approverId = row.approved_by_user_id ?? null;
    await generateReceipt({
      actionId: input.actionId,
      orgId: input.orgId,
      employeeId: input.agentEmployeeId,
      proposer: input.agentEmployeeId ? 'employee' : 'defty',
      proposerId: input.agentEmployeeId ?? input.userId,
      approverId,
      decision: approverId ? 'approved' : 'auto_executed',
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
