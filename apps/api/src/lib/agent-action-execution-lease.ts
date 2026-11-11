/**
 * Execution lease, claim fence and terminal finaliser for approved agent
 * actions.
 *
 * Liveness. A request that executes an approved action holds a session
 * advisory lock keyed on the action (`agent-approval:<id>`) for the whole
 * execution, on a dedicated advisory-pool connection (see
 * `withDbAdvisoryLease`). PostgreSQL drops the lock when that connection or
 * its process goes away, so "the lock is free" is the only evidence that an
 * executor is gone. Time is used only to decide when the maintenance sweep
 * should try; it never decides that an executor is dead.
 *
 * Fence. The claim writes `approved_at` at microsecond precision and the
 * executing request keeps that value as its claim token. Every outcome
 * write by that request is conditional on `approved_at` still equalling the
 * token. A recovery moves `approved_at` forward by one microsecond (keeping
 * the original approval time for attribution), so a request that lost its
 * claim can neither clear a recovery nor reopen a terminal action. The
 * token lives in `approved_at` rather than in `result` because executors
 * overwrite `result` while they run.
 *
 * Outcome of an interrupted approval. Re-executed only when execution is
 * idempotent per action (`create_task`, whose bundle is keyed on the
 * action). Every other action becomes terminal-failed with a plain message.
 *
 * Finaliser. One idempotent function records the approver decision from the
 * stored approver and approval time, resolves Attention, issues the receipt
 * that outcome gets, and runs sibling confirmation. Calling it again changes
 * nothing.
 */
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { agentActionApprovers, agentActions } from '@deft/db/schema';
import { db, withDbAdvisoryLease, type DbAdvisoryLease } from './db.js';
import {
  executeAction,
  isModuleTaskLinkWriteAction,
  sanitizeModuleTaskLinkActionParamsForHistory,
} from './agent-actions.js';
import { resolveAttentionBySource } from './attention.js';
import { generateReceipt, type GenerateReceiptParams } from './receipts.js';
import { sanitizeModuleActionParamsForReceipt } from './receipt-params.js';
import { isModuleWriteActionName } from './module-action-visibility.js';
import {
  isModuleRecordBulkCreateAction,
  sanitizeModuleBulkCreateParamsForHistory,
} from './module-record-bulk-create.js';
import {
  sanitizeWorkspacePlanImportParams,
  WORKSPACE_PLAN_IMPORT_ACTION,
} from './workspace-plan-import.js';
import { DOCUMENT_SEND_ACTION, sanitizeDocumentSendParams } from './document-send.js';
import { markWorkIntentConvertedForAction, markWorkIntentFailedForAction } from './work-intents.js';
import { MODULE_OPERATION_DEFINITIONS, MODULE_OPERATION_NAMES } from '@deft/shared/modules';

export type AgentActionRow = typeof agentActions.$inferSelect;
export type ClaimToken = string;

export const APPROVAL_INTERRUPTED_ERROR =
  'Approval interrupted; outcome unknown. Check whether the change was made before asking for it again.';

/** Actions whose execution is idempotent per action id and may run again. */
const REEXECUTABLE_AFTER_INTERRUPTION: ReadonlySet<string> = new Set(['create_task']);

/** Module mutations resume through the approval resolver's own recovery. */
const RESOLVER_RESUMABLE_ACTIONS: ReadonlySet<string> = new Set(
  MODULE_OPERATION_NAMES.filter((operation) => MODULE_OPERATION_DEFINITIONS[operation].mode === 'write'),
);

const RELEASE_RECORDED_ELSEWHERE: ReadonlySet<string> = new Set(['app_run_invoke', 'app_record_mirror_nominate']);

export const approvalLeaseKey = (actionId: string) => `agent-approval:${actionId}`;

/**
 * Run with the action's execution lease, or report promptly that someone
 * holds it (`held`) or that no advisory connection freed up (`pool_busy`).
 */
export function tryWithApprovalLease<T>(
  actionId: string,
  options: { acquireTimeoutMs?: number },
  run: (lease: DbAdvisoryLease) => Promise<T>,
) {
  return withDbAdvisoryLease(approvalLeaseKey(actionId), { wait: false, ...options }, run);
}

/** Run with the action's execution lease, waiting for any current holder. */
export async function withApprovalLease<T>(
  actionId: string,
  run: (lease: DbAdvisoryLease) => Promise<T>,
): Promise<T> {
  const held = await withDbAdvisoryLease(approvalLeaseKey(actionId), { wait: true }, run);
  if (!held.acquired) throw new Error('approval lease was not acquired');
  return held.value;
}

/** Condition true only while the row still carries this request's claim. */
export function ownsClaim(token: ClaimToken) {
  return sql`${agentActions.approved_at} = ${token}::timestamp`;
}

export const claimTokenSql = sql<string>`${agentActions.approved_at}::text`;

export async function currentClaimToken(actionId: string, orgId: string): Promise<ClaimToken | null> {
  const [row] = await db
    .select({ token: claimTokenSql })
    .from(agentActions)
    .where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, orgId)))
    .limit(1);
  return row?.token ?? null;
}

/**
 * True for an approval that was claimed by an approval request and never
 * recorded an outcome. Callers must hold the action's lease: only then does
 * this mean the executor is gone. The resolver resumes its own module
 * mutations, so those are not "interrupted" when the resolver asks.
 */
export function isInterruptedApproval(
  row: Pick<AgentActionRow,
    'approval_status' | 'executed_at' | 'app_run_id' | 'action' | 'approved_by_user_id' | 'result'>,
  path: ApprovalReceiptMode = 'legacy',
): boolean {
  if (row.approval_status !== 'approved' || row.executed_at !== null || row.app_run_id !== null) return false;
  if (RELEASE_RECORDED_ELSEWHERE.has(row.action)) return false;
  if (path === 'resolver' && RESOLVER_RESUMABLE_ACTIONS.has(row.action)) return false;
  const lifecycle = row.result && typeof row.result === 'object' && !Array.isArray(row.result)
    ? (row.result as Record<string, unknown>).lifecycle_state
    : undefined;
  return row.approved_by_user_id !== null || lifecycle === 'executing';
}

export function isReexecutableAfterInterruption(action: string): boolean {
  return REEXECUTABLE_AFTER_INTERRUPTION.has(action);
}

/** Params kept on a terminal row: the same scrubbing a rejection applies. */
export function terminalHistoryParams(action: string, params: unknown): unknown {
  if (isModuleTaskLinkWriteAction(action)) return sanitizeModuleTaskLinkActionParamsForHistory(params);
  if (isModuleWriteActionName(action)) return sanitizeModuleActionParamsForReceipt(action, params);
  if (isModuleRecordBulkCreateAction(action)) return sanitizeModuleBulkCreateParamsForHistory(params);
  if (action === WORKSPACE_PLAN_IMPORT_ACTION) return sanitizeWorkspacePlanImportParams(params);
  if (action === DOCUMENT_SEND_ACTION) return sanitizeDocumentSendParams(params);
  return params;
}

function scrubsTerminalParams(action: string): boolean {
  return isModuleTaskLinkWriteAction(action)
    || isModuleWriteActionName(action)
    || isModuleRecordBulkCreateAction(action)
    || action === WORKSPACE_PLAN_IMPORT_ACTION
    || action === DOCUMENT_SEND_ACTION;
}

/**
 * Terminal-fail an interrupted approval. Conditional on the observed claim;
 * moves the claim forward so the lost owner's writes no longer match.
 */
export async function settleInterruptedApproval(row: AgentActionRow, token: ClaimToken): Promise<boolean> {
  const [settled] = await db
    .update(agentActions)
    .set({
      executed_at: new Date(),
      error: APPROVAL_INTERRUPTED_ERROR,
      result: { lifecycle_state: 'interrupted', interrupted_at: new Date().toISOString() },
      approved_at: sql`${agentActions.approved_at} + interval '1 microsecond'`,
      ...(scrubsTerminalParams(row.action) ? { params: terminalHistoryParams(row.action, row.params) as any } : {}),
    })
    .where(and(
      eq(agentActions.id, row.id),
      eq(agentActions.org_id, row.org_id),
      eq(agentActions.approval_status, 'approved'),
      isNull(agentActions.executed_at),
      ownsClaim(token),
    ))
    .returning({ id: agentActions.id });
  if (!settled) return false;
  if (row.source === 'defty_capture') {
    await markWorkIntentFailedForAction({
      actionId: row.id,
      orgId: row.org_id,
      actionParams: row.params,
      reason: APPROVAL_INTERRUPTED_ERROR,
    });
  }
  return true;
}

/** Take over an interrupted, re-executable approval. Returns the new claim. */
export async function takeOverInterruptedApproval(row: AgentActionRow, token: ClaimToken): Promise<ClaimToken | null> {
  const [taken] = await db
    .update(agentActions)
    .set({
      result: { lifecycle_state: 'executing', started_at: new Date().toISOString(), resumed: true },
      error: null,
      approved_at: sql`${agentActions.approved_at} + interval '1 microsecond'`,
    })
    .where(and(
      eq(agentActions.id, row.id),
      eq(agentActions.org_id, row.org_id),
      eq(agentActions.approval_status, 'approved'),
      isNull(agentActions.executed_at),
      ownsClaim(token),
    ))
    .returning({ token: claimTokenSql });
  return taken?.token ?? null;
}

export type ApprovalConfirmationPoster = (params: {
  orgId: string;
  actionMessageId: string | null;
  actorUserId: string;
}) => Promise<void>;

export type ApprovalFinaliserHooks = {
  postConfirmation?: ApprovalConfirmationPoster;
};

/** Which receipt the outcome gets today. */
export type ApprovalReceiptMode =
  /** Web approval of an ordinary agent action: every settled outcome of an
   *  executed native write is signed, with the failure reason when it failed. */
  | 'legacy'
  /** Resolver-owned actions: the resolver signs its own outcomes; only an
   *  interrupted outcome, which the resolver never reached, is signed here. */
  | 'resolver';

function approvalReceipt(row: AgentActionRow, mode: ApprovalReceiptMode): GenerateReceiptParams | null {
  const interrupted = row.error === APPROVAL_INTERRUPTED_ERROR;
  if (mode === 'resolver' && !interrupted) return null;
  const failed = row.error !== null;
  const proposerIsDefty = mode === 'legacy'
    ? !row.agent_employee_id
    : row.source === 'defty_capture' || !row.agent_employee_id;
  return {
    actionId: row.id,
    orgId: row.org_id,
    employeeId: row.agent_employee_id ?? null,
    proposer: proposerIsDefty ? 'defty' : 'employee',
    proposerId: proposerIsDefty ? row.user_id : row.agent_employee_id,
    approverId: row.approved_by_user_id ?? null,
    decision: 'approved',
    decisionReason: failed ? `execution failed: ${row.error}`.slice(0, 2_000) : null,
    actionName: row.action,
    actionParams: mode === 'legacy'
      ? terminalHistoryParams(row.action, row.params)
      : sanitizeModuleActionParamsForReceipt(row.action, row.params),
    resultJson: failed ? null : row.result,
  };
}

/**
 * Record the approver decision from the stored approver and approval time.
 * Only rows still pending change, so a retry neither refreshes an earlier
 * decision nor credits the user who happened to retry.
 */
async function repairApproverDecision(row: AgentActionRow): Promise<void> {
  const approverId = row.approved_by_user_id;
  if (!approverId) return;
  const decidedAt = sql`(SELECT approved_at FROM agent_actions WHERE id = ${row.id} AND org_id = ${row.org_id})`;
  await db.transaction(async (tx) => {
    await tx.insert(agentActionApprovers).values({
      org_id: row.org_id,
      action_id: row.id,
      user_id: approverId,
      decision: 'approved',
      decided_at: decidedAt as any,
    }).onConflictDoNothing();
    await tx.update(agentActionApprovers)
      .set({ decision: 'approved', decided_at: decidedAt as any })
      .where(and(
        eq(agentActionApprovers.org_id, row.org_id),
        eq(agentActionApprovers.action_id, row.id),
        eq(agentActionApprovers.user_id, approverId),
        eq(agentActionApprovers.decision, 'pending'),
      ));
    await tx.update(agentActionApprovers)
      .set({ decision: 'superseded', decided_at: decidedAt as any })
      .where(and(
        eq(agentActionApprovers.org_id, row.org_id),
        eq(agentActionApprovers.action_id, row.id),
        eq(agentActionApprovers.decision, 'pending'),
        ne(agentActionApprovers.user_id, approverId),
      ));
  });
}

/**
 * The shared, idempotent bookkeeping for a settled approval. Does nothing
 * for an approval that has not recorded an outcome yet.
 */
export async function finalizeApprovalOutcome(params: {
  actionId: string;
  orgId: string;
  receipt: ApprovalReceiptMode;
  hooks?: ApprovalFinaliserHooks;
}): Promise<boolean> {
  const [row] = await db
    .select()
    .from(agentActions)
    .where(and(eq(agentActions.id, params.actionId), eq(agentActions.org_id, params.orgId)))
    .limit(1);
  if (!row || row.approval_status !== 'approved' || row.executed_at === null) return false;

  await repairApproverDecision(row);
  await resolveAttentionBySource({
    orgId: row.org_id,
    sourceType: 'agent_action',
    sourceId: row.id,
    resolution: row.error ? 'failed' : 'approved',
    ...(row.approved_by_user_id ? { actorUserId: row.approved_by_user_id } : {}),
  });
  // Only a durable human approval (a stored approver, which every approval
  // claim records and automatic execution never does) earns an approval
  // receipt or an approver decision. An automatically executed action keeps
  // the receipt and decisions it already has.
  const receipt = row.approved_by_user_id ? approvalReceipt(row, params.receipt) : null;
  if (receipt) await generateReceipt(receipt);
  if (params.hooks?.postConfirmation) {
    try {
      await params.hooks.postConfirmation({
        orgId: row.org_id,
        actionMessageId: row.message_id,
        actorUserId: row.user_id,
      });
    } catch (err) {
      console.warn('[agent-approval] Failed to post approval confirmation', {
        actionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return true;
}

export type OwnedExecutionOutcome =
  | { kind: 'succeeded'; result: unknown }
  | { kind: 'failed_terminal'; error: string; result: unknown }
  | { kind: 'reopened'; error: string; result: unknown }
  /** The claim moved while this request executed; nothing was written. */
  | { kind: 'superseded' };

/**
 * Execute an ordinary (non-resolver) approved action under the caller's
 * claim and record its outcome. Every write here is fenced on `token`.
 * The caller must hold the action's lease.
 */
export async function executeClaimedApproval(
  row: AgentActionRow,
  token: ClaimToken,
  hooks: ApprovalFinaliserHooks,
): Promise<OwnedExecutionOutcome> {
  // The executor receives the ORIGINAL proposer's user id, never the approver's.
  const execResult = await executeAction(
    row.id,
    row.action,
    row.params as any,
    row.org_id,
    row.user_id,
    { agentEmployeeId: row.agent_employee_id ?? undefined },
  );
  const owned = and(
    eq(agentActions.id, row.id),
    eq(agentActions.org_id, row.org_id),
    eq(agentActions.approval_status, 'approved'),
    ownsClaim(token),
  );

  if (execResult.success) {
    const [written] = await db
      .update(agentActions)
      .set({
        result: execResult.result as any,
        error: null,
        executed_at: sql`COALESCE(${agentActions.executed_at}, now())`,
      })
      .where(owned)
      .returning({ id: agentActions.id });
    if (!written) return { kind: 'superseded' };
    if (row.source === 'defty_capture') {
      await markWorkIntentConvertedForAction({
        actionId: row.id,
        orgId: row.org_id,
        actionParams: row.params,
        result: execResult.result,
        convertedBy: row.approved_by_user_id ?? row.user_id,
      });
    }
    await finalizeApprovalOutcome({ actionId: row.id, orgId: row.org_id, receipt: 'legacy', hooks });
    return { kind: 'succeeded', result: execResult.result };
  }

  const error = execResult.error ?? 'Action failed';
  if (isModuleTaskLinkWriteAction(row.action) || isModuleWriteActionName(row.action)) {
    // Idempotency keys are single-use terminal claims. A failed approved edge
    // mutation is never reopened after the executor scrubbed its raw key.
    const [written] = await db
      .update(agentActions)
      .set({ result: null, error, executed_at: new Date() })
      .where(owned)
      .returning({ id: agentActions.id });
    if (!written) return { kind: 'superseded' };
    if (row.source === 'defty_capture') {
      await markWorkIntentFailedForAction({
        actionId: row.id,
        orgId: row.org_id,
        actionParams: row.params,
        reason: error,
      });
    }
    await finalizeApprovalOutcome({ actionId: row.id, orgId: row.org_id, receipt: 'legacy', hooks });
    return { kind: 'failed_terminal', error, result: execResult.result };
  }

  // Leave a retryable failure pending with its proposed params intact.
  const preservedFailureResult = execResult.result
    && typeof execResult.result === 'object'
    && !Array.isArray(execResult.result)
    ? execResult.result as Record<string, unknown>
    : { upstream_result: execResult.result ?? null };
  const [reopened] = await db
    .update(agentActions)
    .set({
      approval_status: 'pending',
      approved_at: null,
      approved_by_user_id: null,
      executed_at: null,
      result: {
        ...preservedFailureResult,
        lifecycle_state: 'failed',
        failed_at: new Date().toISOString(),
        retryable: true,
      } as any,
      error,
    })
    .where(owned)
    .returning({ id: agentActions.id });
  if (!reopened) return { kind: 'superseded' };
  await markWorkIntentFailedForAction({
    actionId: row.id,
    orgId: row.org_id,
    actionParams: row.params,
    reason: error,
  });
  return { kind: 'reopened', error, result: execResult.result };
}

/** Claim a pending ordinary approval for `approverUserId`. */
export async function claimPendingApproval(row: AgentActionRow, approverUserId: string): Promise<ClaimToken | null> {
  const [claimed] = await db
    .update(agentActions)
    .set({
      approval_status: 'approved',
      approved_at: sql`clock_timestamp()`,
      approved_by_user_id: approverUserId,
      result: { lifecycle_state: 'executing', started_at: new Date().toISOString() } as any,
      error: null,
    })
    .where(and(
      eq(agentActions.id, row.id),
      eq(agentActions.org_id, row.org_id),
      eq(agentActions.approval_status, 'pending'),
    ))
    .returning({ token: claimTokenSql });
  return claimed?.token ?? null;
}

export type InterruptedRecovery =
  | { kind: 'not_interrupted' }
  | { kind: 'settled_failed' }
  | { kind: 'reexecuted'; outcome: OwnedExecutionOutcome }
  /** The claim changed between reading and recovering; nothing was done. */
  | { kind: 'raced' };

/**
 * Recover one ordinary approval whose executor is gone. The caller must hold
 * the action's lease and must have authorized the call.
 */
export async function recoverInterruptedApproval(
  row: AgentActionRow,
  hooks: ApprovalFinaliserHooks,
  receipt: ApprovalReceiptMode = 'legacy',
): Promise<InterruptedRecovery> {
  if (!isInterruptedApproval(row, receipt)) return { kind: 'not_interrupted' };
  const token = await currentClaimToken(row.id, row.org_id);
  if (!token) return { kind: 'raced' };
  if (receipt === 'legacy' && isReexecutableAfterInterruption(row.action)) {
    const next = await takeOverInterruptedApproval(row, token);
    if (!next) return { kind: 'raced' };
    return { kind: 'reexecuted', outcome: await executeClaimedApproval(row, next, hooks) };
  }
  if (!await settleInterruptedApproval(row, token)) return { kind: 'raced' };
  await finalizeApprovalOutcome({ actionId: row.id, orgId: row.org_id, receipt, hooks });
  return { kind: 'settled_failed' };
}

export type InterruptedApprovalSweepResult = { examined: number; recovered: number; live: number; poolBusy: boolean };

/** The sweep never queues behind long-running work for a connection. */
const SWEEP_ACQUIRE_TIMEOUT_MS = 250;

/**
 * Maintenance sweep. Selects approvals that recorded no outcome for a while
 * and recovers only those whose lease is free. Bounded per run; each row is
 * handled within its own org.
 */
export async function recoverInterruptedApprovals(options: {
  hooks?: ApprovalFinaliserHooks;
  isResolverAction: (action: string) => boolean;
  onResolverRecovered?: (actionId: string, actorUserId: string) => Promise<void>;
  batchSize?: number;
  minimumAgeMs?: number;
}): Promise<InterruptedApprovalSweepResult> {
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 20, 100));
  const minimumAgeMs = Math.max(0, options.minimumAgeMs ?? 2 * 60_000);
  // Releases recorded elsewhere, and module mutations the resolver resumes on
  // the next approve, are never swept.
  const skipped = [
    ...RELEASE_RECORDED_ELSEWHERE,
    ...[...RESOLVER_RESUMABLE_ACTIONS].filter((name) => options.isResolverAction(name)),
  ];
  const candidates = await db
    .select({ id: agentActions.id, org_id: agentActions.org_id })
    .from(agentActions)
    .where(and(
      eq(agentActions.approval_status, 'approved'),
      isNull(agentActions.executed_at),
      isNull(agentActions.app_run_id),
      sql`${agentActions.action} NOT IN (${sql.join(skipped.map((name) => sql`${name}`), sql`, `)})`,
      sql`(${agentActions.approved_by_user_id} IS NOT NULL OR ${agentActions.result}->>'lifecycle_state' = 'executing')`,
      sql`${agentActions.approved_at} < now() - (${minimumAgeMs} * interval '1 millisecond')`,
    ))
    .orderBy(agentActions.approved_at)
    .limit(batchSize);

  const result: InterruptedApprovalSweepResult = { examined: candidates.length, recovered: 0, live: 0, poolBusy: false };
  for (const candidate of candidates) {
    try {
      const held = await tryWithApprovalLease(candidate.id, { acquireTimeoutMs: SWEEP_ACQUIRE_TIMEOUT_MS }, async () => {
        const [row] = await db
          .select()
          .from(agentActions)
          .where(and(eq(agentActions.id, candidate.id), eq(agentActions.org_id, candidate.org_id)))
          .limit(1);
        if (!row) return false;
        const resolverOwned = options.isResolverAction(row.action);
        const recovery = await recoverInterruptedApproval(
          row,
          options.hooks ?? {},
          resolverOwned ? 'resolver' : 'legacy',
        );
        if (recovery.kind === 'settled_failed' && resolverOwned) {
          await options.onResolverRecovered?.(row.id, row.approved_by_user_id ?? row.user_id);
        }
        return recovery.kind === 'settled_failed' || recovery.kind === 'reexecuted';
      });
      if (!held.acquired && held.reason === 'pool_busy') {
        // Every advisory connection is busy: try again on the next run.
        result.poolBusy = true;
        break;
      }
      if (!held.acquired) result.live += 1;
      else if (held.value) result.recovered += 1;
    } catch (err) {
      console.warn('[agent-approval] interrupted approval recovery failed', {
        actionId: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

