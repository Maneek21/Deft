import { and, eq, inArray, lt, type SQL } from 'drizzle-orm';
import { agentActions } from '@deft/db/schema';
import { db } from './db.js';
import {
  deftyModuleActor,
  employeeModuleActor,
  moduleIdempotencyDigest,
  moduleMutationInputDigest,
  sanitizeModuleActionParamsForHistory,
} from './module-service.js';
import {
  MODULE_WRITE_ACTION_NAMES,
  isModuleWriteActionName,
  type ModuleWriteActionName,
} from './module-action-visibility.js';
import { generateReceipt } from './receipts.js';
import { resolveAttentionBySource } from './attention.js';
import { markWorkIntentsExpiredForActions } from './work-intents.js';

type PendingModuleAction = Pick<
  typeof agentActions.$inferSelect,
  'id' | 'org_id' | 'user_id' | 'agent_employee_id' | 'action' | 'params'
>;

export type TerminalizedModuleAction = {
  id: string;
  org_id: string;
  params: Record<string, unknown>;
};

function mutationOperation(
  action: ModuleWriteActionName,
): 'create' | 'update' | 'archive' {
  if (action === 'module_record_create') return 'create';
  if (action === 'module_record_update') return 'update';
  return 'archive';
}

/**
 * Produce the only module-action payload that may survive a terminal state.
 * Record values and raw idempotency keys are removed; stable digests preserve
 * enough evidence to audit/reconcile the attempted write without retaining
 * workspace data in the broad agent-action history.
 */
export function terminalModuleActionParams(
  action: ModuleWriteActionName,
  paramsValue: unknown,
  actor: { orgId: string; userId: string; employeeId: string | null },
): Record<string, unknown> {
  const params = paramsValue && typeof paramsValue === 'object' && !Array.isArray(paramsValue)
    ? paramsValue as Record<string, unknown>
    : {};
  const sanitized = sanitizeModuleActionParamsForHistory(action, params);
  if (typeof params.idempotency_key !== 'string') {
    // A retry/reconciliation row may already have passed through a terminal
    // sanitizer. Preserve only well-formed digests; never copy arbitrary
    // history fields back into the terminal payload.
    for (const key of ['idempotency_digest', 'input_digest'] as const) {
      const value = params[key];
      if (typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)) {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  const digestActor = actor.employeeId
    ? employeeModuleActor({
      orgId: actor.orgId,
      employeeId: actor.employeeId,
      trustLevel: 'conservative',
      source: 'mcp',
    })
    : deftyModuleActor({
      orgId: actor.orgId,
      userId: actor.userId,
      role: 'member',
    });

  return {
    ...sanitized,
    idempotency_digest: moduleIdempotencyDigest(digestActor, params.idempotency_key),
    input_digest: moduleMutationInputDigest(mutationOperation(action), params),
  };
}

/**
 * Safely terminalize pending module writes invalidated outside the normal
 * approval executor (for example TTL expiry or employee deletion).
 *
 * The pending-state compare-and-set makes concurrent approval/expiry races
 * deterministic: only the winner writes terminal artifacts. Receipt creation
 * is itself idempotent, so retries cannot create duplicate signed decisions.
 */
export async function terminalizePendingModuleActions(params: {
  orgId: string;
  reason: string;
  attentionResolution: string;
  employeeId?: string;
  createdBefore?: Date;
}): Promise<TerminalizedModuleAction[]> {
  const conditions: SQL[] = [
    eq(agentActions.org_id, params.orgId),
    eq(agentActions.approval_status, 'pending'),
    inArray(agentActions.action, [...MODULE_WRITE_ACTION_NAMES]),
  ];
  if (params.employeeId) conditions.push(eq(agentActions.agent_employee_id, params.employeeId));
  if (params.createdBefore) conditions.push(lt(agentActions.created_at, params.createdBefore));

  const candidates = await db
    .select({
      id: agentActions.id,
      org_id: agentActions.org_id,
      user_id: agentActions.user_id,
      agent_employee_id: agentActions.agent_employee_id,
      action: agentActions.action,
      params: agentActions.params,
    })
    .from(agentActions)
    .where(and(...conditions));

  const reason = params.reason.slice(0, 2_000);
  const terminalized: TerminalizedModuleAction[] = [];
  for (const candidate of candidates as PendingModuleAction[]) {
    if (!isModuleWriteActionName(candidate.action)) continue;
    const terminalParams = terminalModuleActionParams(candidate.action, candidate.params, {
      orgId: candidate.org_id,
      userId: candidate.user_id,
      employeeId: candidate.agent_employee_id,
    });
    const expired = await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(agentActions)
        .set({
          approval_status: 'expired',
          params: terminalParams,
          result: null,
          error: reason,
          before_state: null,
          after_state: null,
          executed_at: new Date(),
        })
        .where(and(
          eq(agentActions.id, candidate.id),
          eq(agentActions.org_id, candidate.org_id),
          eq(agentActions.approval_status, 'pending'),
        ))
        .returning({ id: agentActions.id });
      if (!claimed) return null;
      // Preserve the raw work_intent_id only in this transaction; the action
      // row is scrubbed and the linked intent closes atomically with it.
      await markWorkIntentsExpiredForActions({
        orgId: candidate.org_id,
        actions: [{ id: candidate.id, params: candidate.params }],
        reason,
      }, tx);
      return claimed;
    });
    if (!expired) continue;

    await Promise.all([
      generateReceipt({
        actionId: candidate.id,
        orgId: candidate.org_id,
        employeeId: candidate.agent_employee_id,
        proposer: candidate.agent_employee_id ? 'employee' : 'defty',
        proposerId: candidate.agent_employee_id ?? candidate.user_id,
        approverId: null,
        decision: 'expired',
        decisionReason: reason,
        actionName: candidate.action,
        actionParams: terminalParams,
        resultJson: null,
      }),
      resolveAttentionBySource({
        orgId: candidate.org_id,
        sourceType: 'agent_action',
        sourceId: candidate.id,
        resolution: params.attentionResolution,
      }),
    ]);

    terminalized.push({
      id: candidate.id,
      org_id: candidate.org_id,
      params: terminalParams,
    });
  }
  return terminalized;
}
