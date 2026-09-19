import { MODULE_OPERATION_DESCRIPTIONS } from '../module-tool-descriptions.js';
import { executeModuleReadOperation, isModuleReadOperation } from '../module-read-operations.js';
import { loadAuthorizedAppDiscovery, type AppDiscoveryProjection } from '../app-discovery.js';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { agentActions, agentEmployees } from '@deft/db/schema';
import {
  MODULE_OPERATION_DEFINITIONS,
  MODULE_OPERATION_NAMES,
  MODULE_OPERATION_REQUEST_SCHEMAS,
  MODULE_OPERATION_RESULT_SCHEMAS,
  ModuleMutationResultSchema,
  getModuleOperationInputJsonSchema,
  moduleTaskOperationRequiredScopes,
  type ModuleActor,
  type ModuleOperationName,
  type ModuleSummary,
  type ModuleRecordArchiveRequest,
  type ModuleRecordCreateRequest,
  type ModuleRecordUpdateRequest,
} from '@deft/shared/modules';
import { db, withDbAdvisoryLock } from '../db.js';
import {
  archiveModuleRecord,
  assertAgentModuleMutationPolicyWithExecutor,
  createModuleRecord,
  employeeModuleActor,
  moduleIdempotencyDigest,
  moduleMutationInputDigest,
  preflightModuleMutationWithExecutor,
  sanitizeModuleActionParamsForHistory,
  updateModuleRecord,
} from '../module-service.js';
import { isModuleError } from '../module-errors.js';
import { asPseudoResult, getApprovalTier, shouldAutoExecute } from '../agent-approval.js';
import { generateReceipt } from '../receipts.js';
import { syncApprovalToAttention } from '../attention.js';
import {
  consumeAgentDailyActionBudget,
} from '../agent-tool-policy.js';
import { errorResult, textResult, type ToolContext, type ToolResult } from './types.js';
import {
  agentModuleActionClaimKey,
  agentModuleExecutionLockKey,
  executeActionDirect,
} from '../agent-actions.js';
import { isModuleTaskWriteOperation } from '../module-task-write-operation.js';
import { isModuleRecordBulkCreateAction } from '../module-record-bulk-create.js';


function operationInputSchema(operation: ModuleOperationName): Record<string, unknown> {
  const schema = getModuleOperationInputJsonSchema(operation, {
    require_write_idempotency: true,
  });
  const properties = {
    ...((schema.properties as Record<string, unknown> | undefined) ?? {}),
    caller_employee_slug: {
      type: 'string',
      description: 'Slug of the agent employee making this call.',
    },
  };
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [],
  );
  required.add('caller_employee_slug');
  return {
    ...schema,
    type: 'object',
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

/**
 * A fixed host-owned catalog generated from the shared module operation
 * vocabulary. Installing a manifest never adds executable MCP tools.
 */
export const MODULE_MCP_TOOL_SCHEMAS: Array<Record<string, unknown>> =
  MODULE_OPERATION_NAMES.map((name) => ({
    name,
    description: MODULE_OPERATION_DESCRIPTIONS[name],
    annotations: {
      readOnlyHint: MODULE_OPERATION_DEFINITIONS[name].mode === 'read',
      destructiveHint: MODULE_OPERATION_DEFINITIONS[name].destructive,
    },
    inputSchema: operationInputSchema(name),
  }));

function withoutCallerSlug(args: Record<string, unknown>): Record<string, unknown> {
  const { caller_employee_slug: _callerEmployeeSlug, ...operationArgs } = args;
  return operationArgs;
}

export function parseModuleOperationArgs(
  operation: ModuleOperationName,
  args: Record<string, unknown>,
): unknown {
  return MODULE_OPERATION_REQUEST_SCHEMAS[operation].parse(withoutCallerSlug(args));
}

export async function executeModuleOperationForActor(
  operation: ModuleOperationName,
  actor: ModuleActor,
  input: unknown,
): Promise<unknown> {
  if (isModuleReadOperation(operation)) return (await executeModuleReadOperation(actor, operation, input)).result;
  if (isModuleTaskWriteOperation(operation)) throw new Error('Task-link writes require the principal-specific governed adapter');
  switch (operation) {
    case 'module_record_create': {
      const parsed = MODULE_OPERATION_REQUEST_SCHEMAS.module_record_create.parse(input);
      const result = await createModuleRecord(actor, parsed);
      return ModuleMutationResultSchema.parse(result.mutation);
    }
    case 'module_record_update': {
      const parsed = MODULE_OPERATION_REQUEST_SCHEMAS.module_record_update.parse(input);
      const result = await updateModuleRecord(actor, parsed);
      return ModuleMutationResultSchema.parse(result.mutation);
    }
    case 'module_record_archive': {
      const parsed = MODULE_OPERATION_REQUEST_SCHEMAS.module_record_archive.parse(input);
      const result = await archiveModuleRecord(actor, parsed);
      return ModuleMutationResultSchema.parse(result.mutation);
    }
  }
}

type ModuleAppDiscoveryLoader = (
  actor: ModuleActor,
  modules: readonly ModuleSummary[],
) => Promise<AppDiscoveryProjection>;

/** Preserve the strict Module result and sources blocks; App discovery is an
 * additive versioned block because it is an API-local context contract. */
export async function projectModuleMcpReadResult(
  operation: ModuleOperationName,
  actor: ModuleActor,
  read: Awaited<ReturnType<typeof executeModuleReadOperation>>,
  loadApps: ModuleAppDiscoveryLoader = loadAuthorizedAppDiscovery,
): Promise<ToolResult> {
  const output = textResult(read.result);
  output.content.push({ type: 'text', text: JSON.stringify({ schema_version: 'deft.module_sources.v1', sources: read.citations }) });
  if (operation !== 'module_list') return output;

  const modules = (read.result as { modules: ModuleSummary[] }).modules;
  const missingAppScope = (actor.kind === 'human' || actor.kind === 'agent_employee')
    && actor.source === 'mcp'
    && !actor.scopes.includes('read:apps');
  let discovery: AppDiscoveryProjection | Readonly<{
    installed_apps: readonly [];
    app_discovery: Readonly<{
      status: 'unavailable';
      code: 'SCOPE_REQUIRED' | 'LOOKUP_FAILED';
      message: string;
    }>;
  }>;
  if (missingAppScope) {
    discovery = {
      installed_apps: [],
      app_discovery: {
        status: 'unavailable',
        code: 'SCOPE_REQUIRED',
        message: 'App discovery requires read:apps. Do not infer that no Apps are installed.',
      },
    };
  } else {
    try {
      discovery = await loadApps(actor, modules);
    } catch {
      discovery = {
        installed_apps: [],
        app_discovery: {
          status: 'unavailable',
          code: 'LOOKUP_FAILED',
          message: 'App discovery failed. Retry module_list before describing installed Apps.',
        },
      };
    }
  }
  output.content.push({
    type: 'text',
    text: JSON.stringify({ schema_version: 'deft.app_discovery.v1', ...discovery }),
  });
  return output;
}

export async function executeModuleMcpOperationForActor(operation: ModuleOperationName, actor: ModuleActor, input: unknown): Promise<ToolResult> {
  if (!isModuleReadOperation(operation)) return textResult(await executeModuleOperationForActor(operation, actor, input));
  return projectModuleMcpReadResult(
    operation,
    actor,
    await executeModuleReadOperation(actor, operation, input),
  );
}

export function moduleOperationErrorResult(operation: ModuleOperationName, error: unknown): ToolResult {
  if (error instanceof z.ZodError) {
    return errorResult(JSON.stringify({
      error: 'Invalid module operation input',
      code: 'MODULE_VALIDATION_ERROR',
      issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    }));
  }
  if (isModuleError(error)) {
    return errorResult(JSON.stringify({
      error: error.message,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    }));
  }
  const message = error instanceof Error ? error.message : String(error);
  return errorResult(`${operation} failed: ${message}`);
}

type ActionClaimExecutor = Pick<typeof db, 'select' | 'insert' | 'execute'>;

async function employeeShadowUserId(
  executor: ActionClaimExecutor,
  ctx: ToolContext,
): Promise<string | null> {
  const [employee] = await executor
    .select({ user_id: agentEmployees.user_id })
    .from(agentEmployees)
    .where(and(
      eq(agentEmployees.id, ctx.employee_id),
      eq(agentEmployees.org_id, ctx.org_id),
      eq(agentEmployees.is_active, true),
      eq(agentEmployees.is_deleted, false),
    ))
    .limit(1);
  return employee?.user_id ?? null;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function comparableModuleInput(operation: ModuleOperationName, value: unknown): unknown {
  if (operation !== 'module_record_create' || !value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  const relations = input.relations;
  if (
    relations
    && typeof relations === 'object'
    && Object.keys(relations as Record<string, unknown>).length > 0
  ) return value;
  const { relations: _relations, ...legacyCompatible } = input;
  return legacyCompatible;
}

function sameInput(
  operation: ModuleOperationName,
  left: unknown,
  right: unknown,
): boolean {
  return JSON.stringify(stableValue(comparableModuleInput(operation, left)))
    === JSON.stringify(stableValue(comparableModuleInput(operation, right)));
}

type PriorEmployeeMutation =
  | { kind: 'result'; result: ToolResult }
  | {
    kind: 'completed_approved';
    action_id: string;
    result: z.infer<typeof ModuleMutationResultSchema>;
    decision: 'approved' | 'auto_executed';
    approver_id: string | null;
  }
  | {
    kind: 'completed_failed';
    action_id: string;
    error: string;
    decision: 'approved' | 'auto_executed';
    approver_id: string | null;
  }
  | {
    kind: 'retry_approved';
    action_id: string;
    decision: 'approved' | 'auto_executed';
    approver_id: string | null;
  }
  | null;

async function priorEmployeeMutation(
  executor: ActionClaimExecutor,
  operation: ModuleOperationName,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<PriorEmployeeMutation> {
  const idempotencyKey = typeof input.idempotency_key === 'string'
    ? input.idempotency_key
    : null;
  if (!idempotencyKey) return null;
  const actor = employeeModuleActor({
    orgId: ctx.org_id,
    employeeId: ctx.employee_id,
    trustLevel: ctx.trust_level,
    source: 'mcp',
  });
  const idempotencyDigest = moduleIdempotencyDigest(actor, idempotencyKey);
  const [existing] = await executor
    .select({
      id: agentActions.id,
      params: agentActions.params,
      result: agentActions.result,
      error: agentActions.error,
      executed_at: agentActions.executed_at,
      approved_by_user_id: agentActions.approved_by_user_id,
      approval_status: agentActions.approval_status,
    })
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, ctx.org_id),
      eq(agentActions.agent_employee_id, ctx.employee_id),
      eq(agentActions.action, operation),
      inArray(agentActions.approval_status, ['pending', 'approved']),
      or(
        sql`${agentActions.params}->>'idempotency_key' = ${idempotencyKey}`,
        sql`${agentActions.params}->>'idempotency_digest' = ${idempotencyDigest}`,
      ),
    ))
    .orderBy(desc(agentActions.created_at))
    .limit(1);
  if (!existing) return null;
  const storedParams = existing.params && typeof existing.params === 'object'
    ? existing.params as Record<string, unknown>
    : {};
  const isTerminalHistory = storedParams.idempotency_digest === idempotencyDigest;
  const expectedInputDigest = moduleMutationInputDigest(
    operation === 'module_record_create' ? 'create'
      : operation === 'module_record_update' ? 'update'
        : 'archive',
    input,
  );
  if (
    isTerminalHistory
    && typeof storedParams.input_digest === 'string'
    && storedParams.input_digest !== expectedInputDigest
  ) {
    return {
      kind: 'result',
      result: errorResult(JSON.stringify({
        error: 'Idempotency key was already used for a different module mutation',
        code: 'MODULE_IDEMPOTENCY_CONFLICT',
      })),
    };
  }
  if (!isTerminalHistory && !sameInput(operation, existing.params, input)) {
    return {
      kind: 'result',
      result: errorResult(JSON.stringify({
        error: 'Idempotency key was already used for a different module mutation',
        code: 'MODULE_IDEMPOTENCY_CONFLICT',
      })),
    };
  }
  const completed = ModuleMutationResultSchema.safeParse(existing.result);
  if (completed.success && existing.approval_status === 'approved') {
    const approverId = existing.approved_by_user_id
      ?? (typeof storedParams.approval_actor_id === 'string'
        ? storedParams.approval_actor_id
        : null);
    return {
      kind: 'completed_approved',
      action_id: existing.id,
      result: completed.data,
      decision: approverId ? 'approved' : 'auto_executed',
      approver_id: approverId,
    };
  }
  if (existing.approval_status === 'approved') {
    if (existing.error || existing.executed_at) {
      const approverId = existing.approved_by_user_id
        ?? (typeof storedParams.approval_actor_id === 'string'
          ? storedParams.approval_actor_id
          : null);
      return {
        kind: 'completed_failed',
        action_id: existing.id,
        error: existing.error ?? 'The prior module mutation finished without a valid result',
        decision: approverId ? 'approved' : 'auto_executed',
        approver_id: approverId,
      };
    }
    // Only an approved action with no terminal outcome is crash-resumable.
    // Re-enter ModuleService with the same durable idempotency key so its
    // replay ledger can return a mutation committed before the process died.
    return {
      kind: 'retry_approved',
      action_id: existing.id,
      decision: existing.approved_by_user_id ? 'approved' : 'auto_executed',
      approver_id: existing.approved_by_user_id,
    };
  }
  return {
    kind: 'result',
    result: asPseudoResult(
      existing.id,
      'Action already requires human approval. The existing proposal remains pending review.',
    ),
  };
}

async function lockEmployeeMutationClaim(
  executor: ActionClaimExecutor,
  operation: ModuleOperationName,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<void> {
  const idempotencyKey = String(input.idempotency_key);
  const actor = employeeModuleActor({
    orgId: ctx.org_id,
    employeeId: ctx.employee_id,
    trustLevel: ctx.trust_level,
    source: 'mcp',
  });
  const digest = moduleIdempotencyDigest(actor, idempotencyKey);
  const lockKey = agentModuleActionClaimKey(ctx.org_id, operation, digest);
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
}

async function queueModuleMutation(
  operation: ModuleOperationName,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const claimed = await db.transaction(async (tx) => {
    await lockEmployeeMutationClaim(tx, operation, input, ctx);
    const prior = await priorEmployeeMutation(tx, operation, input, ctx);
    if (prior) return prior;
    const proposalActor = employeeModuleActor({
      orgId: ctx.org_id,
      employeeId: ctx.employee_id,
      trustLevel: ctx.trust_level,
      source: 'mcp',
    });
    await assertAgentModuleMutationPolicyWithExecutor(
      tx,
      proposalActor,
      operation as 'module_record_create' | 'module_record_update' | 'module_record_archive',
    );
    const shadowUserId = await employeeShadowUserId(tx, ctx);
    if (!shadowUserId) {
      return { kind: 'result', result: errorResult('Module mutation caller is not an active agent employee') } as const;
    }
    await preflightModuleMutationWithExecutor(
      tx,
      proposalActor,
      operation as 'module_record_create' | 'module_record_update' | 'module_record_archive',
      input as ModuleRecordCreateRequest | ModuleRecordUpdateRequest | ModuleRecordArchiveRequest,
      true,
    );
    const [action] = await tx
      .insert(agentActions)
      .values({
        org_id: ctx.org_id,
        user_id: shadowUserId,
        agent_employee_id: ctx.employee_id,
        channel_event_id: ctx.channel_event_id,
        runtime_request_key: ctx.runtime_request_key,
        source: 'mcp',
        action: operation,
        params: input,
        approval_tier: getApprovalTier(operation),
        approval_status: 'pending',
      })
      .returning();
    if (!action) {
      return { kind: 'result', result: errorResult('Failed to queue module mutation for review') } as const;
    }
    return { kind: 'pending' as const, action };
  });
  if (claimed.kind === 'retry_approved') {
    return executeDirectModuleMutation(operation, input, ctx);
  }
  if (claimed.kind === 'completed_approved') {
    await ensureCompletedEmployeeMutationReceipt(operation, input, ctx, claimed);
    return textResult({ ...claimed.result, replayed: true });
  }
  if (claimed.kind === 'completed_failed') {
    await ensureFailedEmployeeMutationReceipt(operation, input, ctx, claimed);
    return errorResult(claimed.error);
  }
  if (claimed.kind === 'pending') {
    await syncApprovalToAttention(claimed.action, { deliver: false });
    return asPseudoResult(
      claimed.action.id,
      'Action requires human approval and will execute asynchronously if approved.',
    );
  }
  return claimed.result;
}

function mutationReceiptParams(
  operation: ModuleOperationName,
  input: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeModuleActionParamsForHistory(operation, input);
}

async function ensureCompletedEmployeeMutationReceipt(
  operation: ModuleOperationName,
  input: Record<string, unknown>,
  ctx: ToolContext,
  completed: Extract<PriorEmployeeMutation, { kind: 'completed_approved' }>,
): Promise<void> {
  await generateReceipt({
    actionId: completed.action_id,
    orgId: ctx.org_id,
    employeeId: ctx.employee_id,
    proposer: 'employee',
    proposerId: ctx.employee_id,
    approverId: completed.approver_id,
    decision: completed.decision,
    actionName: operation,
    actionParams: mutationReceiptParams(operation, input),
    resultJson: completed.result,
  });
}

async function ensureFailedEmployeeMutationReceipt(
  operation: ModuleOperationName,
  input: Record<string, unknown>,
  ctx: ToolContext,
  failed: Extract<PriorEmployeeMutation, { kind: 'completed_failed' }>,
): Promise<void> {
  await generateReceipt({
    actionId: failed.action_id,
    orgId: ctx.org_id,
    employeeId: ctx.employee_id,
    proposer: 'employee',
    proposerId: ctx.employee_id,
    approverId: failed.approver_id,
    decision: failed.decision,
    decisionReason: `execution failed: ${failed.error}`.slice(0, 2_000),
    actionName: operation,
    actionParams: mutationReceiptParams(operation, input),
    resultJson: null,
  });
}

async function concurrentTerminalActionResult(
  actionId: string,
  operation: ModuleOperationName,
  input: Record<string, unknown>,
  ctx: ToolContext,
  fallbackError: string,
): Promise<ToolResult> {
  const [current] = await db
    .select({
      approval_status: agentActions.approval_status,
      approved_by_user_id: agentActions.approved_by_user_id,
      executed_at: agentActions.executed_at,
      result: agentActions.result,
      error: agentActions.error,
    })
    .from(agentActions)
    .where(and(
      eq(agentActions.id, actionId),
      eq(agentActions.org_id, ctx.org_id),
    ))
    .limit(1);
  if (!current) return errorResult('Module action no longer exists');
  if (current.approval_status === 'expired' || current.approval_status === 'rejected') {
    return errorResult(current.error ?? `Module action is ${current.approval_status}`);
  }
  if (current.approval_status === 'approved' && current.executed_at) {
    const approverId = current.approved_by_user_id ?? null;
    const completed = ModuleMutationResultSchema.safeParse(current.result);
    if (completed.success) {
      await ensureCompletedEmployeeMutationReceipt(operation, input, ctx, {
        kind: 'completed_approved',
        action_id: actionId,
        result: completed.data,
        decision: approverId ? 'approved' : 'auto_executed',
        approver_id: approverId,
      });
      return textResult({ ...completed.data, replayed: true });
    }
    if (current.error) {
      await ensureFailedEmployeeMutationReceipt(operation, input, ctx, {
        kind: 'completed_failed',
        action_id: actionId,
        error: current.error,
        decision: approverId ? 'approved' : 'auto_executed',
        approver_id: approverId,
      });
      return errorResult(current.error);
    }
  }
  return errorResult(fallbackError);
}

function terminalMutationParams(
  operation: ModuleOperationName,
  input: Record<string, unknown>,
  actor: ReturnType<typeof employeeModuleActor>,
): Record<string, unknown> {
  const sanitized = sanitizeModuleActionParamsForHistory(operation, input);
  return typeof input.idempotency_key === 'string'
    ? {
      ...sanitized,
      idempotency_digest: moduleIdempotencyDigest(actor, input.idempotency_key),
      input_digest: moduleMutationInputDigest(
        operation === 'module_record_create' ? 'create'
          : operation === 'module_record_update' ? 'update'
            : 'archive',
        input,
      ),
    }
    : sanitized;
}

async function executeDirectModuleMutation(
  operation: ModuleOperationName,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const lockActor = employeeModuleActor({
    orgId: ctx.org_id,
    employeeId: ctx.employee_id,
    trustLevel: ctx.trust_level,
    source: 'mcp',
  });
  const rawKey = String(input.idempotency_key);
  const scopedDigest = moduleIdempotencyDigest(lockActor, rawKey);
  return withDbAdvisoryLock(
    agentModuleExecutionLockKey(ctx.org_id, operation, scopedDigest),
    () => executeDirectModuleMutationLocked(operation, input, ctx),
  );
}

async function executeDirectModuleMutationLocked(
  operation: ModuleOperationName,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const actor = employeeModuleActor({
    orgId: ctx.org_id,
    employeeId: ctx.employee_id,
    trustLevel: ctx.trust_level,
    source: 'mcp',
  });
  const terminalParams = terminalMutationParams(operation, input, actor);
  const claim = await db.transaction(async (tx) => {
    await lockEmployeeMutationClaim(tx, operation, input, ctx);
    const prior = await priorEmployeeMutation(tx, operation, input, ctx);
    if (
      prior?.kind === 'result'
      || prior?.kind === 'completed_approved'
      || prior?.kind === 'completed_failed'
    ) return prior;
    if (prior?.kind === 'retry_approved') {
      return {
        kind: 'claimed' as const,
        action_id: prior.action_id,
        approved_retry: true,
        decision: prior.decision,
        approver_id: prior.approver_id,
      };
    }
    const livePolicy = await assertAgentModuleMutationPolicyWithExecutor(
      tx,
      actor,
      operation as 'module_record_create' | 'module_record_update' | 'module_record_archive',
    );
    const shadowUserId = await employeeShadowUserId(tx, ctx);
    if (!shadowUserId) {
      return { kind: 'result' as const, result: errorResult('Module mutation caller is not an active agent employee') };
    }
    await preflightModuleMutationWithExecutor(
      tx,
      actor,
      operation as 'module_record_create' | 'module_record_update' | 'module_record_archive',
      input as ModuleRecordCreateRequest | ModuleRecordUpdateRequest | ModuleRecordArchiveRequest,
      true,
    );
    const autoExecute = shouldAutoExecute(
      operation,
      livePolicy?.trustLevel ?? ctx.trust_level,
      input,
    );
    const [action] = await tx
      .insert(agentActions)
      .values({
        org_id: ctx.org_id,
        user_id: shadowUserId,
        agent_employee_id: ctx.employee_id,
        channel_event_id: ctx.channel_event_id,
        runtime_request_key: ctx.runtime_request_key,
        source: 'mcp',
        action: operation,
        params: autoExecute ? terminalParams : input,
        approval_tier: getApprovalTier(operation),
        approval_status: autoExecute ? 'approved' : 'pending',
        ...(autoExecute ? { approved_at: new Date() } : {}),
      })
      .returning();
    if (!action) {
      return { kind: 'result' as const, result: errorResult('Failed to create module action log') };
    }
    if (!autoExecute) return { kind: 'pending' as const, action };
    return {
      kind: 'claimed' as const,
      action_id: action.id,
      approved_retry: false,
      decision: 'auto_executed' as const,
      approver_id: null,
    };
  });
  if (claim.kind === 'result') return claim.result;
  if (claim.kind === 'completed_approved') {
    await ensureCompletedEmployeeMutationReceipt(operation, input, ctx, claim);
    return textResult({ ...claim.result, replayed: true });
  }
  if (claim.kind === 'completed_failed') {
    await ensureFailedEmployeeMutationReceipt(operation, input, ctx, claim);
    return errorResult(claim.error);
  }
  if (claim.kind === 'pending') {
    await syncApprovalToAttention(claim.action, { deliver: false });
    return asPseudoResult(
      claim.action.id,
      'Action requires human approval and will execute asynchronously if approved.',
    );
  }
  const actionId = claim.action_id;
  const isApprovedRetry = claim.approved_retry;
  const receiptDecision = claim.decision;
  const receiptApproverId = claim.approver_id;

  if (!isApprovedRetry) {
    const budget = await consumeAgentDailyActionBudget(
      ctx.org_id,
      ctx.employee_id,
      { requireHealthy: true },
    );
    if (!budget.allowed) {
      const [terminalized] = await db
        .update(agentActions)
        .set({
          error: budget.error.slice(0, 2_000),
          params: terminalParams,
          executed_at: new Date(),
        })
        .where(and(
          eq(agentActions.id, actionId),
          eq(agentActions.org_id, ctx.org_id),
          eq(agentActions.approval_status, 'approved'),
          sql`${agentActions.executed_at} IS NULL`,
        ))
        .returning({ id: agentActions.id });
      if (!terminalized) {
        return concurrentTerminalActionResult(
          actionId,
          operation,
          input,
          ctx,
          budget.error,
        );
      }
      await generateReceipt({
        actionId,
        orgId: ctx.org_id,
        employeeId: ctx.employee_id,
        proposer: 'employee',
        proposerId: ctx.employee_id,
        approverId: receiptApproverId,
        decision: receiptDecision,
        decisionReason: `execution denied: ${budget.error}`.slice(0, 2_000),
        actionName: operation,
        actionParams: mutationReceiptParams(operation, input),
        resultJson: null,
      });
      return errorResult(budget.error);
    }
  }

  const executionActor = employeeModuleActor({
    orgId: ctx.org_id,
    employeeId: ctx.employee_id,
    trustLevel: ctx.trust_level,
    source: 'mcp',
    actionId,
  });
  let result: z.infer<typeof ModuleMutationResultSchema>;
  try {
    result = ModuleMutationResultSchema.parse(
      await executeModuleOperationForActor(operation, executionActor, input),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const [terminalized] = await db
      .update(agentActions)
      .set({
        error: message.slice(0, 2_000),
        params: terminalParams,
        result: null,
        executed_at: new Date(),
      })
      .where(and(
        eq(agentActions.id, actionId),
        eq(agentActions.org_id, ctx.org_id),
        eq(agentActions.approval_status, 'approved'),
        sql`${agentActions.executed_at} IS NULL`,
      ))
      .returning({ id: agentActions.id });
    if (!terminalized) {
      return concurrentTerminalActionResult(
        actionId,
        operation,
        input,
        ctx,
        message,
      );
    }
    await generateReceipt({
      actionId,
      orgId: ctx.org_id,
      employeeId: ctx.employee_id,
      proposer: 'employee',
      proposerId: ctx.employee_id,
      approverId: receiptApproverId,
      decision: receiptDecision,
      decisionReason: `execution failed: ${message}`.slice(0, 2_000),
      actionName: operation,
      actionParams: mutationReceiptParams(operation, input),
      resultJson: null,
    });
    throw error;
  }

  // Persisting the action outcome is intentionally outside the execution
  // catch. If this stamp fails after ModuleService committed, the approved
  // row stays resumable and the next same-key call recovers the durable
  // ModuleService receipt instead of recording a false terminal failure.
  const [stamped] = await db
    .update(agentActions)
    .set({
      result,
      params: terminalParams,
      after_state: result,
      executed_at: new Date(),
      error: null,
    })
    .where(and(
      eq(agentActions.id, actionId),
      eq(agentActions.org_id, ctx.org_id),
      eq(agentActions.approval_status, 'approved'),
      sql`${agentActions.executed_at} IS NULL`,
    ))
    .returning({ id: agentActions.id });
  if (!stamped) {
    return concurrentTerminalActionResult(
      actionId,
      operation,
      input,
      ctx,
      'Module action changed state before its result could be recorded',
    );
  }
  await generateReceipt({
    actionId,
    orgId: ctx.org_id,
    employeeId: ctx.employee_id,
    proposer: 'employee',
    proposerId: ctx.employee_id,
    approverId: receiptApproverId,
    decision: receiptDecision,
    actionName: operation,
    actionParams: mutationReceiptParams(operation, input),
    resultJson: result,
  });
  return textResult(result);
}

async function employeeModuleOperation(
  operation: ModuleOperationName,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const taskScopes = moduleTaskOperationRequiredScopes(operation);
    if (taskScopes && ctx.scopes !== undefined && !taskScopes.every((scope) => ctx.scopes!.includes(scope))) {
      return errorResult(`Missing MCP scope: ${taskScopes.join(' and ')}`);
    }
    if (
      MODULE_OPERATION_DEFINITIONS[operation].mode === 'write'
      && ctx.scopes !== undefined
      && !ctx.scopes.includes('write:modules')
    ) {
      return errorResult('Missing MCP scope: write:modules');
    }
    const input = parseModuleOperationArgs(operation, args) as Record<string, unknown>;
    if (
      MODULE_OPERATION_DEFINITIONS[operation].mode === 'write'
      && (typeof input.idempotency_key !== 'string' || !input.idempotency_key.trim())
    ) {
      return errorResult(`${operation} requires idempotency_key for retry-safe MCP writes`);
    }
    const actor = employeeModuleActor({
      orgId: ctx.org_id,
      employeeId: ctx.employee_id,
      trustLevel: ctx.trust_level,
      source: 'mcp',
      scopes: ctx.scopes ?? ['read:modules', 'read:apps'],
    });
    if (isModuleTaskWriteOperation(operation)) {
      const userId = await employeeShadowUserId(db, ctx);
      if (!userId) return errorResult('Task-link caller is not an active agent employee');
      const execution = await executeActionDirect(operation, input, ctx.org_id, userId, null, getApprovalTier(operation), {
        agentEmployeeId: ctx.employee_id, source: 'mcp',
        channelEventId: ctx.channel_event_id, runtimeRequestKey: ctx.runtime_request_key,
      });
      if (execution.requiresApproval) return asPseudoResult(execution.actionId, 'Action requires human approval. The link has not been changed.');
      if (!execution.success) return errorResult(execution.error ?? 'Task-link mutation failed');
      return textResult(MODULE_OPERATION_RESULT_SCHEMAS[operation].parse(execution.result));
    }
    if (isModuleRecordBulkCreateAction(operation)) {
      const userId = await employeeShadowUserId(db, ctx);
      if (!userId) return errorResult('Bulk-create caller is not an active agent employee');
      const execution = await executeActionDirect(operation, input, ctx.org_id, userId, null, 'full', {
        agentEmployeeId: ctx.employee_id, source: 'mcp',
        channelEventId: ctx.channel_event_id, runtimeRequestKey: ctx.runtime_request_key,
      });
      if (execution.requiresApproval) {
        return asPseudoResult(execution.actionId, 'Bulk create requires human approval. No records have been created.');
      }
      if (!execution.success) return errorResult(execution.error ?? 'Bulk-create proposal failed');
      return textResult(MODULE_OPERATION_RESULT_SCHEMAS.module_record_bulk_create.parse(execution.result));
    }
    if (MODULE_OPERATION_DEFINITIONS[operation].mode === 'read') {
      return await executeModuleMcpOperationForActor(operation, actor, input);
    }
    if (!shouldAutoExecute(operation, ctx.trust_level, input)) {
      return await queueModuleMutation(operation, input, ctx);
    }
    return await executeDirectModuleMutation(operation, input, ctx);
  } catch (error) {
    return moduleOperationErrorResult(operation, error);
  }
}

export const MODULE_MCP_READ_TOOLS: Record<string, (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>> =
  Object.fromEntries(
    MODULE_OPERATION_NAMES
      .filter((name) => MODULE_OPERATION_DEFINITIONS[name].mode === 'read')
      .map((name) => [
        name,
        (args: Record<string, unknown>, ctx: ToolContext) => employeeModuleOperation(name, args, ctx),
      ]),
  );

export const MODULE_MCP_WRITE_TOOLS: Record<string, (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>> =
  Object.fromEntries(
    MODULE_OPERATION_NAMES
      .filter((name) => MODULE_OPERATION_DEFINITIONS[name].mode === 'write')
      .map((name) => [
        name,
        (args: Record<string, unknown>, ctx: ToolContext) => employeeModuleOperation(name, args, ctx),
      ]),
  );
