/**
 * Phase 6.5 — approval resolver.
 *
 * When Phase 4 write tools queue an action (trust-gated), the row lives in
 * `agent_actions` with `approval_status='pending'`. This module is the
 * consumer: it loads a pending row, verifies the approver, re-builds a
 * ToolContext from the row's employee, dispatches to the matching
 * `execute*` inner function from `mcp-tools/writes.ts` or
 * `mcp-tools/memory-update.ts`, and stamps the row with the outcome.
 *
 * Idempotency: if the row is already approved/rejected, the call is a
 * no-op that returns the current status. This protects against double-clicks
 * from the UI and race conditions between the approve button and an
 * eventual expiry cron.
 *
 * Permission model: the effective requester may approve or reject their own
 * proposed write. Org owners and admins may review any proposal. Internal
 * system flows must opt into the explicit `internal` bypass instead of
 * impersonating a human reviewer.
 *
 * Phase 7 hook point: the `generateReceipt({...})` call slots in right
 * after the inner executor returns (both on success and error paths).
 * Today we only mutate the `agent_actions` row; Phase 7 will also insert
 * into `action_receipts` with an HMAC signature.
 *
 * Trust elevation: the rebuilt ToolContext uses the employee's CURRENT
 * `trust_level`, NOT the user's permissions. This matters because the
 * inner `execute*` functions deliberately don't gate — the gating already
 * happened when the row was queued, and re-gating here would bounce
 * every conservative-trust employee's approved writes.
 */
import { eq, and, or, sql } from 'drizzle-orm';
import { db, withDbAdvisoryLock } from './db.js';
import {
  agentActions,
  agentChannelEvents,
  agentEmployees,
  messages,
  orgMembers,
} from '@deft/db/schema';
import type { ToolContext, ToolResult } from './mcp-tools/types.js';
import type { TrustLevel } from './agent-approval.js';
import {
  executeTaskCreate,
  executeTaskUpdate,
  executeMessagePost,
  executeSendMessage,
  type TaskCreateArgs,
  type TaskUpdateArgs,
  type MessagePostArgs,
  type SendMessageArgs,
} from './mcp-tools/writes.js';
import {
  executeMemoryUpdate,
  type MemoryUpdateArgs,
} from './mcp-tools/memory-update.js';
import {
  executeWikiCreate,
  executeWikiUpdate,
  type WikiCreateArgs,
  type WikiUpdateArgs,
} from './mcp-tools/wiki-create.js';
import { generateReceipt } from './receipts.js';
import { sanitizeModuleActionParamsForReceipt } from './receipt-params.js';
import {
  markWorkIntentConvertedForAction,
  markWorkIntentDismissedForAction,
  markWorkIntentFailedForAction,
  markWorkIntentsExpiredForActions,
} from './work-intents.js';
import {
  MCP_ACTION_KINDS,
  normalizeMcpApprovalAction,
} from './mcp-approval-actions.js';
import {
  executeAction as executeAgentAction,
  isModuleTaskLinkWriteAction,
  preflightAgentModuleAction,
  sanitizeModuleTaskLinkActionParamsForHistory,
} from './agent-actions.js';
import { ACTION_TOOLS } from './agent-tools.js';
import { isAgentToolDisabled } from './agent-tool-policy.js';
import {
  MODULE_OPERATION_DEFINITIONS,
  MODULE_OPERATION_NAMES,
} from '@deft/shared/modules';
import {
  employeeModuleActor,
  moduleIdempotencyDigest,
  moduleMutationInputDigest,
  recoverModuleMutationByAgentActionId,
  sanitizeModuleActionParamsForHistory,
} from './module-service.js';
import { resolveAttentionBySource } from './attention.js';
import { publishAgentChannelEvent } from './agent-channel.js';
export { MCP_ACTION_KINDS } from './mcp-approval-actions.js';
export { sanitizeModuleActionParamsForReceipt };

const MODULE_MUTATION_ACTIONS: ReadonlySet<string> = new Set(
  MODULE_OPERATION_NAMES.filter(
    (operation) => MODULE_OPERATION_DEFINITIONS[operation].mode === 'write',
  ),
);

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function publishApprovalResolution(actionId: string, actorUserId: string): Promise<void> {
  try {
    const [row] = await db
      .select({
        id: agentActions.id,
        org_id: agentActions.org_id,
        agent_employee_id: agentActions.agent_employee_id,
        action: agentActions.action,
        params: agentActions.params,
        approval_status: agentActions.approval_status,
        executed_at: agentActions.executed_at,
        result: agentActions.result,
        error: agentActions.error,
        message_id: agentActions.message_id,
        channel_event_id: agentActions.channel_event_id,
      })
      .from(agentActions)
      .where(eq(agentActions.id, actionId))
      .limit(1);
    if (!row?.agent_employee_id || !['approved', 'rejected'].includes(row.approval_status)) return;

    const [employee] = await db
      .select({ runtime_kind: agentEmployees.runtime_kind })
      .from(agentEmployees)
      .where(and(
        eq(agentEmployees.id, row.agent_employee_id),
        eq(agentEmployees.org_id, row.org_id),
      ))
      .limit(1);
    if (!employee || employee.runtime_kind === 'defty_system') return;

    const params = recordValue(row.params);
    const taskId = typeof params.task_id === 'string' && params.task_id.trim()
      ? params.task_id.trim()
      : null;
    let sourceKind: string = taskId ? 'task' : 'approval';
    let sourceId: string = taskId ?? row.id;
    let spaceId: string | null = null;
    let threadId: string | null = null;
    if (row.channel_event_id) {
      const [origin] = await db
        .select({
          source_kind: agentChannelEvents.source_kind,
          source_id: agentChannelEvents.source_id,
          space_id: agentChannelEvents.space_id,
          thread_id: agentChannelEvents.thread_id,
        })
        .from(agentChannelEvents)
        .where(and(
          eq(agentChannelEvents.id, row.channel_event_id),
          eq(agentChannelEvents.org_id, row.org_id),
          eq(agentChannelEvents.agent_employee_id, row.agent_employee_id),
        ))
        .limit(1);
      if (origin) {
        sourceKind = origin.source_kind ?? sourceKind;
        sourceId = origin.source_id ?? sourceId;
        spaceId = origin.space_id;
        threadId = origin.thread_id;
      }
    }
    if (!spaceId && sourceKind !== 'task' && row.message_id) {
      const [sourceMessage] = await db
        .select({ id: messages.id, space_id: messages.space_id })
        .from(messages)
        .where(and(eq(messages.id, row.message_id), eq(messages.org_id, row.org_id)))
        .limit(1);
      spaceId = sourceMessage?.space_id ?? null;
      threadId = sourceMessage?.id ?? null;
    }

    await publishAgentChannelEvent({
      orgId: row.org_id,
      employeeId: row.agent_employee_id,
      kind: 'approval.resolved',
      sourceKind,
      sourceId,
      spaceId,
      threadId,
      actorUserId,
      idempotencyKey: `approval.resolved:${row.id}:${row.approval_status}`,
      payload: {
        action_id: row.id,
        action: row.action,
        decision: row.approval_status,
        summary: typeof params.summary === 'string' ? params.summary : null,
        task_id: taskId,
        execution_status: row.approval_status === 'rejected'
          ? 'not_executed'
          : row.executed_at
            ? row.error ? 'failed' : 'completed'
            : 'pending',
        reason: row.error ?? null,
      },
    });
  } catch (error) {
    console.error(`[agent-approval-resolver] failed to publish resolution for ${actionId}:`, error);
  }
}

function terminalModuleActionParams(
  action: string,
  paramsValue: unknown,
  ctx?: ToolContext | null,
): Record<string, unknown> | null {
  if (!MODULE_MUTATION_ACTIONS.has(action)) return null;
  const params = recordValue(paramsValue);
  const sanitized = sanitizeModuleActionParamsForHistory(action, params);
  if (typeof params.idempotency_key !== 'string') return sanitized;
  const inputDigest = moduleMutationInputDigest(
    action === 'module_record_create'
      ? 'create'
      : action === 'module_record_update'
        ? 'update'
        : 'archive',
    params,
  );
  if (!ctx) return { ...sanitized, input_digest: inputDigest };
  const actor = employeeModuleActor({
    orgId: ctx.org_id,
    employeeId: ctx.employee_id,
    trustLevel: ctx.trust_level,
    source: 'mcp',
  });
  return {
    ...sanitized,
    idempotency_digest: moduleIdempotencyDigest(actor, params.idempotency_key),
    input_digest: inputDigest,
  };
}

const TERMINAL_REVIEWER_USER_ID = 'terminal_reviewer_user_id';
const TERMINAL_ATTENTION_RESOLUTION = 'terminal_attention_resolution';

function terminalReviewerUserId(paramsValue: unknown): string | null {
  const value = recordValue(paramsValue)[TERMINAL_REVIEWER_USER_ID];
  return typeof value === 'string' && value.trim() ? value : null;
}

function terminalAttentionResolution(
  paramsValue: unknown,
  fallback: string,
): string {
  const value = recordValue(paramsValue)[TERMINAL_ATTENTION_RESOLUTION];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function moduleProposer(row: typeof agentActions.$inferSelect): {
  proposer: 'defty' | 'employee';
  proposerId: string | null;
} {
  const isDefty = !row.agent_employee_id;
  return {
    proposer: isDefty ? 'defty' : 'employee',
    proposerId: isDefty ? row.user_id : row.agent_employee_id,
  };
}

async function repairRejectedModuleTerminalState(
  row: typeof agentActions.$inferSelect,
  options: { repairWorkIntent?: boolean } = {},
): Promise<void> {
  if (
    !MODULE_MUTATION_ACTIONS.has(row.action)
    && !isModuleTaskLinkWriteAction(row.action)
  ) return;
  const reviewerId = terminalReviewerUserId(row.params);
  const proposer = moduleProposer(row);
  const postcommit: Array<Promise<unknown>> = [
    generateReceipt({
      actionId: row.id,
      orgId: row.org_id,
      employeeId: row.agent_employee_id ?? null,
      proposer: proposer.proposer,
      proposerId: proposer.proposerId,
      // Legacy rejected rows may pre-date durable reviewer attribution. Do
      // not misattribute a retrying caller as the original reviewer.
      approverId: reviewerId,
      decision: 'rejected',
      decisionReason: row.error,
      actionName: row.action,
      actionParams: sanitizeModuleActionParamsForReceipt(row.action, row.params),
      resultJson: null,
    }),
    resolveAttentionBySource({
      orgId: row.org_id,
      sourceType: 'agent_action',
      sourceId: row.id,
      resolution: terminalAttentionResolution(row.params, 'rejected'),
      ...(reviewerId ? { actorUserId: reviewerId } : {}),
    }),
  ];
  if (options.repairWorkIntent !== false && reviewerId) {
    postcommit.push(markWorkIntentDismissedForAction({
      actionId: row.id,
      orgId: row.org_id,
      actionParams: row.params,
      dismissedBy: reviewerId,
      reason: row.error,
    }));
  }
  await Promise.all(postcommit);
}

async function repairExpiredModuleTerminalState(
  row: typeof agentActions.$inferSelect,
  options: { repairWorkIntent?: boolean } = {},
): Promise<void> {
  if (!MODULE_MUTATION_ACTIONS.has(row.action)) return;
  const proposer = moduleProposer(row);
  const postcommit: Array<Promise<unknown>> = [
    generateReceipt({
      actionId: row.id,
      orgId: row.org_id,
      employeeId: row.agent_employee_id ?? null,
      proposer: proposer.proposer,
      proposerId: proposer.proposerId,
      approverId: row.approved_by_user_id ?? null,
      decision: 'expired',
      decisionReason: row.error,
      actionName: row.action,
      actionParams: sanitizeModuleActionParamsForReceipt(row.action, row.params),
      resultJson: null,
    }),
    resolveAttentionBySource({
      orgId: row.org_id,
      sourceType: 'agent_action',
      sourceId: row.id,
      resolution: terminalAttentionResolution(row.params, 'expired'),
    }),
  ];
  if (options.repairWorkIntent !== false) {
    postcommit.push(markWorkIntentsExpiredForActions({
      orgId: row.org_id,
      actions: [{ id: row.id, params: row.params }],
      reason: row.error,
    }));
  }
  await Promise.all(postcommit);
}

async function ensureApprovedModuleReceipt(
  row: typeof agentActions.$inferSelect,
): Promise<void> {
  if (!MODULE_MUTATION_ACTIONS.has(row.action)) return;
  const approverId = row.approved_by_user_id ?? null;
  const decision = row.approved_by_user_id ? 'approved' : 'auto_executed';
  const isDefty = !row.agent_employee_id;
  await generateReceipt({
    actionId: row.id,
    orgId: row.org_id,
    employeeId: row.agent_employee_id ?? null,
    proposer: isDefty ? 'defty' : 'employee',
    proposerId: isDefty ? row.user_id : row.agent_employee_id,
    approverId,
    decision,
    decisionReason: row.error ? `execution failed: ${row.error}`.slice(0, 2_000) : null,
    actionName: row.action,
    actionParams: sanitizeModuleActionParamsForReceipt(row.action, row.params),
    resultJson: row.error ? null : row.result,
  });
}

async function expireModuleActionForEmployeePolicy(params: {
  row: typeof agentActions.$inferSelect;
  reason: string;
  ctx?: ToolContext | null;
}): Promise<boolean> {
  const terminalParams = terminalModuleActionParams(
    params.row.action,
    params.row.params,
    params.ctx,
  ) ?? sanitizeModuleActionParamsForHistory(params.row.action, params.row.params);
  terminalParams[TERMINAL_ATTENTION_RESOLUTION] = 'employee_policy_invalidated';
  const expired = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(agentActions)
      .set({
        approval_status: 'expired',
        error: params.reason.slice(0, 2_000),
        params: terminalParams,
        executed_at: new Date(),
      })
      .where(and(
        eq(agentActions.id, params.row.id),
        eq(agentActions.org_id, params.row.org_id),
        or(
          eq(agentActions.approval_status, 'pending'),
          and(
            eq(agentActions.approval_status, 'approved'),
            sql`${agentActions.executed_at} IS NULL`,
          ),
        ),
      ))
      .returning();
    if (!claimed) return null;
    // Keep the raw work_intent_id available only until its terminal state is
    // committed atomically with the scrubbed action row.
    await markWorkIntentsExpiredForActions({
      orgId: params.row.org_id,
      actions: [{ id: params.row.id, params: params.row.params }],
      reason: params.reason,
    }, tx);
    return claimed;
  });
  if (!expired) {
    const [terminal] = await db
      .select()
      .from(agentActions)
      .where(and(
        eq(agentActions.id, params.row.id),
        eq(agentActions.org_id, params.row.org_id),
      ))
      .limit(1);
    if (terminal?.approval_status === 'rejected') {
      await repairRejectedModuleTerminalState(terminal);
    } else if (terminal?.approval_status === 'expired') {
      await repairExpiredModuleTerminalState(terminal);
    }
    return false;
  }

  await Promise.all([
    generateReceipt({
      actionId: params.row.id,
      orgId: params.row.org_id,
      employeeId: params.row.agent_employee_id ?? null,
      proposer: params.row.agent_employee_id ? 'employee' : 'defty',
      proposerId: params.row.agent_employee_id ?? params.row.user_id,
      // If the process died after the human approval claim but before the
      // module mutation completed, preserve the reviewer who made that
      // decision even when a later policy change terminalizes the action.
      approverId: params.row.approved_by_user_id ?? null,
      decision: 'expired',
      decisionReason: params.reason,
      actionName: params.row.action,
      actionParams: sanitizeModuleActionParamsForReceipt(params.row.action, terminalParams),
      resultJson: null,
    }),
    resolveAttentionBySource({
      orgId: params.row.org_id,
      sourceType: 'agent_action',
      sourceId: params.row.id,
      resolution: 'employee_policy_invalidated',
    }),
  ]);
  return true;
}

export type ApprovalResolverError =
  | { status: 'error'; code: 'NOT_FOUND'; message: string }
  | { status: 'error'; code: 'FORBIDDEN'; message: string }
  | { status: 'error'; code: 'INVALID_STATE'; message: string }
  | { status: 'error'; code: 'UNSUPPORTED_ACTION'; message: string }
  | { status: 'error'; code: 'EMPLOYEE_MISSING'; message: string }
  | { status: 'error'; code: 'EXECUTE_FAILED'; message: string };

export type ApprovalResolverSuccess =
  | { status: 'approved'; message?: string; result?: unknown }
  | { status: 'rejected'; message?: string };

export type ApprovalResolverResult =
  | ApprovalResolverSuccess
  | ApprovalResolverError;

function actionRequesterId(row: { user_id: string; params: unknown }): string {
  if (row.params && typeof row.params === 'object' && !Array.isArray(row.params)) {
    const params = row.params as Record<string, unknown>;
    const sourceUserId = params.source_user_id ?? params.origin_user_id;
    if (typeof sourceUserId === 'string' && sourceUserId.trim()) return sourceUserId;
  }
  return row.user_id;
}

/**
 * Returns the active org membership used by the reviewer policy.
 */
async function loadReviewMembership(
  userId: string,
  orgId: string,
): Promise<{ role: string } | null> {
  const [row] = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(
      and(
        eq(orgMembers.user_id, userId),
        eq(orgMembers.org_id, orgId),
        eq(orgMembers.is_active, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Look up the employee row for a queued action so we can rebuild ctx. */
async function loadEmployeeForAction(employeeId: string) {
  const [row] = await db
    .select({
      id: agentEmployees.id,
      org_id: agentEmployees.org_id,
      slug: agentEmployees.slug,
      trust_level: agentEmployees.trust_level,
      disabled_tools: agentEmployees.disabled_tools,
      unhealthy: agentEmployees.unhealthy,
      unhealthy_reason: agentEmployees.unhealthy_reason,
      is_active: agentEmployees.is_active,
      is_deleted: agentEmployees.is_deleted,
      runtime_kind: agentEmployees.runtime_kind,
    })
    .from(agentEmployees)
    .where(eq(agentEmployees.id, employeeId))
    .limit(1);
  return row ?? null;
}

function buildCtxFromEmployee(emp: {
  id: string;
  org_id: string;
  slug: string;
  trust_level: string;
  disabled_tools: string[] | null;
  unhealthy: boolean;
  unhealthy_reason: string | null;
  is_active: boolean;
  is_deleted: boolean;
  runtime_kind: string;
}): ToolContext {
  return {
    org_id: emp.org_id,
    employee_id: emp.id,
    employee_slug: emp.slug,
    trust_level: emp.trust_level as TrustLevel,
  };
}

async function dispatchAction(
  actionName: string,
  params: Record<string, unknown>,
  ctx: ToolContext,
  actionId?: string,
  dispatchOpts?: { sourceReaderUserId?: string | null; requesterUserId?: string },
): Promise<ToolResult> {
  // Phase 7 — skipReceipt=true: the approval resolver owns receipt
  // generation for approved actions (it knows the approver_id). The inner
  // executors only emit receipts in the auto-exec path.
  const opts = {
    skipReceipt: true,
    actionId,
    sourceReaderUserId: dispatchOpts?.sourceReaderUserId ?? null,
  } as const;

  // Outbound connector tools use the same execution boundary as the web
  // approval surface. That boundary rechecks the employee, assignment,
  // connection allowlist, per-tool disable, and transport policy at the
  // instant of execution.
  if (actionName.startsWith('mcp__')) {
    if (!actionId) {
      return {
        content: [{ type: 'text', text: 'Outbound MCP approval is missing an action id' }],
        isError: true,
      };
    }
    const executed = await executeAgentAction(
      actionId,
      actionName,
      params,
      ctx.org_id,
      dispatchOpts?.requesterUserId ?? ctx.employee_id,
      { agentEmployeeId: ctx.employee_id },
    );
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(executed.success ? executed.result : {
          error: executed.error ?? 'MCP tool execution failed',
          result: executed.result,
        }),
      }],
      isError: !executed.success,
    };
  }

  // Dedicated module tools validate + preflight before queueing. Keep these
  // out of normalizeMcpApprovalAction (and therefore out of the generic
  // request_human_approval tool), while still resolving them through this
  // signed approval boundary.
  if (MODULE_MUTATION_ACTIONS.has(actionName)) {
    if (!actionId) {
      return {
        content: [{
          type: 'text',
          text: `${actionName} approval is missing an action id`,
        }],
        isError: true,
      };
    }
    const executed = await executeAgentAction(
      actionId,
      actionName,
      params,
      ctx.org_id,
      dispatchOpts?.requesterUserId ?? ctx.employee_id,
      { agentEmployeeId: ctx.employee_id },
    );
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(executed.success ? executed.result : {
          error: executed.error ?? 'Module mutation execution failed',
          result: executed.result,
        }),
      }],
      isError: !executed.success,
    };
  }

  const normalized = normalizeMcpApprovalAction(
    actionName,
    params,
    ctx.employee_slug,
  );
  if (!normalized.ok) {
    return {
      content: [{ type: 'text', text: normalized.error }],
      isError: true,
    };
  }

  switch (normalized.action) {
    case 'task_create':
      return executeTaskCreate(
        normalized.params as unknown as TaskCreateArgs,
        ctx,
        opts,
      );
    case 'task_update':
      return executeTaskUpdate(
        normalized.params as unknown as TaskUpdateArgs,
        ctx,
        opts,
      );
    case 'message_post':
      return executeMessagePost(
        normalized.params as unknown as MessagePostArgs,
        ctx,
        opts,
      );
    case 'send_message': {
      const p = normalized.params as unknown as SendMessageArgs & {
        resolved_space_id?: string;
        parent_id?: string | null;
      };
      const target = (p.target ?? {}) as Partial<{ space_id: string }>;
      const spaceId =
        p.resolved_space_id ??
        target.space_id;
      if (!spaceId) {
        return {
          content: [{
            type: 'text',
            text: 'send_message approval is missing resolved_space_id',
          }],
          isError: true,
        };
      }
      return executeSendMessage(
        {
          orgId: ctx.org_id,
          spaceId,
          content: p.content,
          parentId: p.parent_id ?? null,
          ctx,
        },
        opts,
      );
    }
    case 'memory_update':
      return executeMemoryUpdate(
        normalized.params as unknown as MemoryUpdateArgs,
        ctx,
        opts,
      );
    case 'wiki_create':
      return executeWikiCreate(
        normalized.params as unknown as WikiCreateArgs,
        ctx,
        opts,
      );
    case 'wiki_update':
      return executeWikiUpdate(
        normalized.params as unknown as WikiUpdateArgs,
        ctx,
        opts,
      );
  }
}

/**
 * Approve a pending action. Idempotent: already-approved actions return
 * the stored result; already-rejected actions return the current status.
 *
 * Permission: the requester or an org owner/admin may review an action.
 */
export async function approveAction(
  actionId: string,
  approverUserId: string,
  options: { internal?: boolean } = {},
): Promise<ApprovalResolverResult> {
  const result = await withDbAdvisoryLock(
    `agent-approval:${actionId}`,
    () => approveActionLocked(actionId, approverUserId, options),
  );
  if (result.status === 'approved' || result.status === 'rejected' || result.code === 'EXECUTE_FAILED') {
    await publishApprovalResolution(actionId, approverUserId);
  }
  return result;
}

async function approveActionLocked(
  actionId: string,
  approverUserId: string,
  options: { internal?: boolean },
): Promise<ApprovalResolverResult> {
  // Pre-checks read immutable fields so they are safe to run before the
  // atomic claim. If any pre-check fails we return without ever flipping
  // the row.
  const [row] = await db
    .select()
    .from(agentActions)
    .where(eq(agentActions.id, actionId))
    .limit(1);

  if (!row) {
    return {
      status: 'error',
      code: 'NOT_FOUND',
      message: `agent_actions row ${actionId} not found`,
    };
  }

  const isModuleMutation = MODULE_MUTATION_ACTIONS.has(row.action);
  const isModuleTaskLink = isModuleTaskLinkWriteAction(row.action);

  // Authorize before returning or repairing any durable terminal state. A
  // terminal retry may create missing receipts/attention artifacts, so it is
  // not a side-effect-free read and must not be reachable cross-org.
  const membership = await loadReviewMembership(approverUserId, row.org_id);
  const canReview = options.internal || (
    membership !== null && (
      actionRequesterId(row) === approverUserId ||
      membership.role === 'owner' ||
      membership.role === 'admin'
    )
  );
  if (!canReview) {
    return {
      status: 'error',
      code: 'FORBIDDEN',
      message: 'only the requester or an org owner/admin may approve this action',
    };
  }

  const resumesApprovedModule = isModuleMutation
    && row.approval_status === 'approved'
    && row.executed_at === null;

  // A module mutation is durable/idempotent, so approved-but-unexecuted rows
  // are safe to resume after a process crash. Completed approvals also retry
  // receipt generation, which is itself idempotent.
  if (row.approval_status === 'approved' && !resumesApprovedModule) {
    if (isModuleMutation || isModuleTaskLink) await ensureApprovedModuleReceipt(row);
    return {
      status: 'approved',
      message: 'already approved',
      result: row.result ?? undefined,
    };
  }
  if (row.approval_status === 'rejected') {
    if (isModuleMutation) await repairRejectedModuleTerminalState(row);
    return {
      status: 'rejected',
      message: 'already rejected',
    };
  }
  if (row.approval_status === 'expired') {
    if (isModuleMutation) await repairExpiredModuleTerminalState(row);
    return {
      status: 'error',
      code: 'NOT_FOUND',
      message: `action ${actionId} has expired`,
    };
  }
  if (row.approval_status !== 'pending' && !resumesApprovedModule) {
    return {
      status: 'error',
      code: 'INVALID_STATE',
      message: `action ${actionId} is not pending`,
    };
  }

  if (!MCP_ACTION_KINDS.has(row.action) && !row.action.startsWith('mcp__') && !ACTION_TOOLS.has(row.action)) {
    return {
      status: 'error',
      code: 'UNSUPPORTED_ACTION',
      message: `approval resolver does not handle action kind "${row.action}"`,
    };
  }

  const requiresEmployee = row.action.startsWith('mcp__') || (
    MCP_ACTION_KINDS.has(row.action) && !isModuleMutation
  );
  if (!row.agent_employee_id && requiresEmployee) {
    return {
      status: 'error',
      code: 'EMPLOYEE_MISSING',
      message: 'queued MCP action has no agent_employee_id',
    };
  }

  if (resumesApprovedModule) {
    const committed = await recoverModuleMutationByAgentActionId(row.org_id, row.id);
    if (committed) {
      const recoveredParams = {
        ...sanitizeModuleActionParamsForHistory(row.action, row.params),
        idempotency_digest: committed.idempotencyDigest,
        input_digest: committed.inputDigest,
      };
      const recoveredRow = await db.transaction(async (tx) => {
        const [stamped] = await tx
          .update(agentActions)
          .set({
            executed_at: new Date(),
            result: committed.mutation,
            after_state: committed.mutation,
            error: null,
            params: recoveredParams,
          })
          .where(and(
            eq(agentActions.id, row.id),
            eq(agentActions.org_id, row.org_id),
            eq(agentActions.approval_status, 'approved'),
            sql`${agentActions.executed_at} IS NULL`,
          ))
          .returning();
        if (!stamped) return null;
        // The terminal action payload is scrubbed, so use the original
        // proposal params while atomically closing its linked WorkIntent.
        await markWorkIntentConvertedForAction({
          actionId: row.id,
          orgId: row.org_id,
          actionParams: row.params,
          result: committed.mutation,
          convertedBy: row.approved_by_user_id ?? approverUserId,
        }, tx);
        return stamped;
      });
      if (recoveredRow) {
        await ensureApprovedModuleReceipt(recoveredRow);
        return { status: 'approved', result: committed.mutation };
      }
    }
  }

  const emp = row.agent_employee_id ? await loadEmployeeForAction(row.agent_employee_id) : null;
  if (row.agent_employee_id && !emp) {
    if (isModuleMutation) {
      const reason = 'Agent employee no longer exists; module action expired before approval';
      await expireModuleActionForEmployeePolicy({ row, reason });
      return { status: 'error', code: 'INVALID_STATE', message: reason };
    }
    return {
      status: 'error',
      code: 'EMPLOYEE_MISSING',
      message: `agent_employee ${row.agent_employee_id} not found`,
    };
  }
  if (emp && emp.org_id !== row.org_id) {
    return {
      status: 'error',
      code: 'FORBIDDEN',
      message: 'agent employee does not belong to the action org',
    };
  }

  const ctx = emp ? buildCtxFromEmployee(emp) : null;
  const employeeOperational = emp
    ? emp.is_active && (!emp.is_deleted || emp.runtime_kind === 'defty_system')
    : false;
  if (emp && !employeeOperational) {
    if (isModuleMutation) {
      const reason = 'Agent employee was paused or deleted; module action expired before approval';
      await expireModuleActionForEmployeePolicy({ row, reason, ctx });
      return { status: 'error', code: 'INVALID_STATE', message: reason };
    }
    return {
      status: 'error',
      code: 'EMPLOYEE_MISSING',
      message: `agent_employee ${row.agent_employee_id} is inactive or deleted`,
    };
  }

  if (emp?.unhealthy && isModuleMutation) {
    const reason = `Agent employee became unhealthy before approval${emp.unhealthy_reason ? `: ${emp.unhealthy_reason}` : ''}`;
    await expireModuleActionForEmployeePolicy({ row, reason, ctx });
    return { status: 'error', code: 'INVALID_STATE', message: reason };
  }

  if (emp && isAgentToolDisabled(emp.disabled_tools, row.action)) {
    if (isModuleMutation) {
      const reason = `Tool '${row.action}' was disabled before approval`;
      await expireModuleActionForEmployeePolicy({ row, reason, ctx });
      return { status: 'error', code: 'INVALID_STATE', message: reason };
    }
    return {
      status: 'error',
      code: 'FORBIDDEN',
      message: `tool '${row.action}' is disabled for this agent employee`,
    };
  }

  if (isModuleMutation) {
    try {
      await preflightAgentModuleAction(
        row.action,
        recordValue(row.params),
        row.org_id,
        row.user_id,
        row.agent_employee_id ?? undefined,
      );
    } catch (error) {
      const reason = `Module action no longer passes execution policy: ${
        error instanceof Error ? error.message : String(error)
      }`;
      await expireModuleActionForEmployeePolicy({ row, reason, ctx });
      return { status: 'error', code: 'INVALID_STATE', message: reason };
    }
  }

  // Phase 12 review fix — atomic claim. Two concurrent callers could both
  // pass the `status === 'pending'` read above; the UPDATE … WHERE … AND
  // approval_status = 'pending' only succeeds for one of them. If this
  // returns zero rows, we lost the race and return the idempotent result.
  if (!resumesApprovedModule) {
    const claimed = await db.execute(
      sql`UPDATE agent_actions
             SET approval_status = 'approved',
                 approved_at = NOW(),
                 approved_by_user_id = ${approverUserId}
           WHERE id = ${actionId} AND approval_status = 'pending'
           RETURNING id`,
    );
    const claimedRows =
      (claimed as { rows?: any[] }).rows ?? (claimed as unknown as any[]);
    if (claimedRows.length === 0) {
      const [winner] = await db
        .select()
        .from(agentActions)
        .where(eq(agentActions.id, actionId))
        .limit(1);
      if (winner?.approval_status === 'approved') {
        if (isModuleMutation && winner.executed_at === null) {
          return {
            status: 'error',
            code: 'INVALID_STATE',
            message: `action ${actionId} approval changed while it was being claimed; retry to resume`,
          };
        }
        if (isModuleMutation || isModuleTaskLink) await ensureApprovedModuleReceipt(winner);
        return {
          status: 'approved',
          message: 'already approved (lost race)',
          result: winner.result ?? undefined,
        };
      }
      if (winner?.approval_status === 'rejected') {
        if (isModuleMutation) await repairRejectedModuleTerminalState(winner);
        return { status: 'rejected', message: 'already rejected (lost race)' };
      }
      if (winner?.approval_status === 'expired') {
        if (isModuleMutation) await repairExpiredModuleTerminalState(winner);
        return {
          status: 'error',
          code: 'NOT_FOUND',
          message: `action ${actionId} has expired`,
        };
      }
      return {
        status: 'error',
        code: 'INVALID_STATE',
        message: `action ${actionId} is no longer pending`,
      };
    }
  }

  let toolResult: ToolResult;
  let caughtError: Error | null = null;
  try {
    const actionParams = (row.params ?? {}) as Record<string, unknown>;
    const sourceReaderUserId =
      row.source === 'defty_capture'
        ? typeof actionParams.source_user_id === 'string'
          ? actionParams.source_user_id
          : typeof actionParams.origin_user_id === 'string'
            ? actionParams.origin_user_id
            : null
        : null;
    if (
      ACTION_TOOLS.has(row.action)
      && (!MCP_ACTION_KINDS.has(row.action) || (isModuleMutation && !ctx))
    ) {
      const executed = await executeAgentAction(
        row.id,
        row.action,
        actionParams,
        row.org_id,
        row.user_id,
        { agentEmployeeId: row.agent_employee_id ?? undefined },
      );
      toolResult = {
        content: [{
          type: 'text',
          text: JSON.stringify(executed.success ? executed.result : {
            error: executed.error ?? 'Action execution failed',
            result: executed.result,
          }),
        }],
        isError: !executed.success,
      };
    } else {
      toolResult = await dispatchAction(
        row.action,
        actionParams,
        ctx!,
        row.id,
        { sourceReaderUserId, requesterUserId: row.user_id },
      );
    }
  } catch (err) {
    caughtError = err instanceof Error ? err : new Error(String(err));
    toolResult = {
      content: [{ type: 'text', text: caughtError.message }],
      isError: true,
    };
  }

  const isError = toolResult.isError === true;
  const resultText = toolResult.content?.[0]?.text ?? '';
  let parsedResult: unknown = resultText;
  try {
    parsedResult = JSON.parse(resultText);
  } catch {
    // leave as string
  }

  // Stamp exec outcome on the row. approval_status is already 'approved'
  // from the atomic claim; we only touch executed_at + result/error here.
  const now = new Date();
  const terminalParams = terminalModuleActionParams(row.action, row.params, ctx);
  const stampedAction = await db.transaction(async (tx) => {
    const [stamped] = await tx
      .update(agentActions)
      .set({
        executed_at: now,
        result: (isError ? null : parsedResult) as any,
        error: isError ? String(resultText).slice(0, 2000) : null,
        ...(terminalParams ? { params: terminalParams } : {}),
      })
      .where(and(
        eq(agentActions.id, actionId),
        eq(agentActions.org_id, row.org_id),
        eq(agentActions.approval_status, 'approved'),
      ))
      .returning({ id: agentActions.id });
    if (!stamped) return null;
    if (isError) {
      await markWorkIntentFailedForAction({
        actionId: row.id,
        orgId: row.org_id,
        actionParams: row.params,
        reason: resultText || caughtError?.message || 'execution failed',
      }, tx);
    } else {
      await markWorkIntentConvertedForAction({
        actionId: row.id,
        orgId: row.org_id,
        actionParams: row.params,
        result: parsedResult,
        convertedBy: row.approved_by_user_id ?? approverUserId,
      }, tx);
    }
    return stamped;
  });

  // Installation disable/write-revoke may have terminalized this action while
  // the executor was waiting for the same installation lock. In that case the
  // lifecycle decision won: do not overwrite its history, emit a contradictory
  // approval receipt, or change the linked WorkIntent a second time.
  if (!stampedAction) {
    const [terminal] = await db
      .select({ approval_status: agentActions.approval_status, error: agentActions.error })
      .from(agentActions)
      .where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, row.org_id)))
      .limit(1);
    return {
      status: 'error',
      code: 'INVALID_STATE',
      message: terminal?.error ?? `action ${actionId} was terminalized while execution was in progress`,
    };
  }

  // Invalidate platform_context cache for the employee so the next turn
  // sees the new state. executeTaskCreate etc. already do this, but we
  // call it again in case the exec failed before that point.
  try {
    const { invalidatePlatformContextCacheFor } = await import(
      './mcp-tools/context.js'
    );
    if (ctx) invalidatePlatformContextCacheFor(ctx.employee_id);
  } catch {
    // best-effort
  }

  // ── Phase 7 — signed approval receipt ────────────────────────────────
  // The approval decision itself is audit-recorded regardless of whether
  // the inner executor succeeded. decision_reason captures the failure
  // message so a compliance officer can read "approved but execution
  // failed: X" instead of silently losing the decision.
  const isDeftyCapture = row.source === 'defty_capture';
  const isDeftyModuleAction = isModuleMutation && !row.agent_employee_id;
  const isDeftyProposer = isDeftyCapture || isDeftyModuleAction;
  await generateReceipt({
    actionId: row.id,
    orgId: row.org_id,
    employeeId: ctx?.employee_id ?? null,
    proposer: isDeftyProposer ? 'defty' : 'employee',
    proposerId: isDeftyProposer ? row.user_id : ctx?.employee_id ?? null,
    approverId: row.approved_by_user_id ?? approverUserId,
    decision: 'approved',
    decisionReason: isError
      ? `execution failed: ${resultText || caughtError?.message || 'unknown'}`.slice(0, 2000)
      : null,
    actionName: row.action,
    actionParams: sanitizeModuleActionParamsForReceipt(row.action, row.params),
    resultJson: isError ? null : parsedResult,
  });

  if (isError) {
    return {
      status: 'error',
      code: 'EXECUTE_FAILED',
      message: resultText || caughtError?.message || 'execution failed',
    };
  }

  return {
    status: 'approved',
    result: parsedResult,
  };
}

/**
 * Reject a pending action. Idempotent.
 *
 * Permission: rejecter must be a member of the action's org.
 * Schema has no `rejected_at` column — we use `updated_at` (auto-managed)
 * plus stash the reason in the `error` column so the UI can surface it.
 */
export async function rejectAction(
  actionId: string,
  rejecterUserId: string,
  reason?: string,
): Promise<ApprovalResolverResult> {
  const result = await rejectActionOnce(actionId, rejecterUserId, reason);
  if (result.status === 'approved' || result.status === 'rejected') {
    await publishApprovalResolution(actionId, rejecterUserId);
  }
  return result;
}

async function rejectActionOnce(
  actionId: string,
  rejecterUserId: string,
  reason?: string,
): Promise<ApprovalResolverResult> {
  const [row] = await db
    .select()
    .from(agentActions)
    .where(eq(agentActions.id, actionId))
    .limit(1);

  if (!row) {
    return {
      status: 'error',
      code: 'NOT_FOUND',
      message: `agent_actions row ${actionId} not found`,
    };
  }

  const isModuleMutation = MODULE_MUTATION_ACTIONS.has(row.action);
  const isModuleTaskLink = isModuleTaskLinkWriteAction(row.action);

  // Terminal-state repair can write receipts and attention state. Apply the
  // same reviewer boundary before any early return or repair side effect.
  const membership = await loadReviewMembership(rejecterUserId, row.org_id);
  const canReview = membership !== null && (
    actionRequesterId(row) === rejecterUserId ||
    membership.role === 'owner' ||
    membership.role === 'admin'
  );
  if (!canReview) {
    return {
      status: 'error',
      code: 'FORBIDDEN',
      message: 'only the requester or an org owner/admin may reject this action',
    };
  }

  if (row.approval_status === 'rejected') {
    if (isModuleMutation) await repairRejectedModuleTerminalState(row);
    return { status: 'rejected', message: 'already rejected' };
  }
  if (row.approval_status === 'approved') {
    return {
      status: 'approved',
      message: 'already approved — cannot reject after approval',
      result: row.result ?? undefined,
    };
  }
  if (row.approval_status === 'expired') {
    if (isModuleMutation) await repairExpiredModuleTerminalState(row);
    return {
      status: 'error',
      code: 'NOT_FOUND',
      message: `action ${actionId} has expired`,
    };
  }

  if (row.agent_employee_id) {
    const emp = await loadEmployeeForAction(row.agent_employee_id);
    if (!emp || emp.org_id !== row.org_id) {
      return {
        status: 'error',
        code: 'FORBIDDEN',
        message: 'agent employee does not belong to the action org',
      };
    }
  }

  const rejectionReason = reason ? reason.slice(0, 2_000) : null;
  const rejectedParams = isModuleMutation
    ? {
      ...sanitizeModuleActionParamsForHistory(row.action, row.params),
      [TERMINAL_REVIEWER_USER_ID]: rejecterUserId,
      [TERMINAL_ATTENTION_RESOLUTION]: 'rejected',
    }
    : isModuleTaskLink
      ? sanitizeModuleTaskLinkActionParamsForHistory(row.params)
      : null;
  const updated = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(agentActions)
      .set({
        approval_status: 'rejected',
        error: rejectionReason,
        ...(rejectedParams ? { params: rejectedParams } : {}),
      })
      .where(and(
        eq(agentActions.id, actionId),
        eq(agentActions.approval_status, 'pending'),
      ))
      .returning();
    if (!claimed) return null;
    // The module row is scrubbed by this same commit, so the WorkIntent must
    // consume the original proposal params inside the transaction.
    await markWorkIntentDismissedForAction({
      actionId: row.id,
      orgId: row.org_id,
      actionParams: row.params,
      dismissedBy: rejecterUserId,
      reason: rejectionReason,
    }, tx);
    return claimed;
  });

  if (!updated) {
    const [winner] = await db
      .select()
      .from(agentActions)
      .where(eq(agentActions.id, actionId))
      .limit(1);
    if (winner?.approval_status === 'approved') {
      return {
        status: 'approved',
        message: 'already approved — cannot reject after approval',
        result: winner.result ?? undefined,
      };
    }
    if (winner?.approval_status === 'rejected') {
      if (isModuleMutation) await repairRejectedModuleTerminalState(winner);
      return { status: 'rejected', message: 'already rejected' };
    }
    if (winner?.approval_status === 'expired') {
      if (isModuleMutation) await repairExpiredModuleTerminalState(winner);
      return {
        status: 'error',
        code: 'NOT_FOUND',
        message: `action ${actionId} has expired`,
      };
    }
    return {
      status: 'error',
      code: 'INVALID_STATE',
      message: `action ${actionId} is no longer pending`,
    };
  }

  // Receipts and Attention are post-commit and independently idempotent. A
  // retry of a terminal module row repairs either artifact after a crash.
  if (isModuleMutation) {
    await repairRejectedModuleTerminalState(updated, { repairWorkIntent: false });
  } else {
    const isDeftyCapture = row.source === 'defty_capture';
    await Promise.all([
      generateReceipt({
        actionId: row.id,
        orgId: row.org_id,
        employeeId: row.agent_employee_id ?? null,
        proposer: isDeftyCapture ? 'defty' : 'employee',
        proposerId: isDeftyCapture ? row.user_id : row.agent_employee_id ?? null,
        approverId: rejecterUserId,
        decision: 'rejected',
        decisionReason: rejectionReason,
        actionName: row.action,
        actionParams: sanitizeModuleActionParamsForReceipt(row.action, row.params),
        resultJson: null,
      }),
      resolveAttentionBySource({
        orgId: row.org_id,
        sourceType: 'agent_action',
        sourceId: row.id,
        resolution: 'rejected',
        actorUserId: rejecterUserId,
      }),
    ]);
  }

  return { status: 'rejected', message: reason };
}
