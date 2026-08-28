import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db, withDbAdvisoryLock } from './db.js';
import {
  tasks,
  projects,
  messages,
  spaces,
  agentActions,
  taskActivity,
  taskComments,
  taskLabels,
  labels,
  taskRelationships,
  users,
  wikiPages,
  wikiLinks,
  wikiOpsLog,
  reminders,
  notes,
  canvases,
  crossReferences,
  agentEmployees,
} from '@deft/db/schema';
import { enqueue, QUEUE_NAMES } from './queues.js';
import { eq, and, sql, ilike, desc, inArray, or } from 'drizzle-orm';
import { getIO } from '../socket.js';
import { logAuditEvent } from './audit.js';
import { mcpClientManager } from '@deft/mcp';
import {
  getExecutableMcpConnection,
  getMCPToolsForAgent,
  mcpResultPayload,
  parseMCPToolName,
  toConnectionConfig,
} from './mcp-tools.js';
import { resolveAssigneeWithMatches } from './resolve-assignee.js';
import { detectBlocksCycle } from './task-dependency.js';
import { dispatchAgentEmployeeTask } from './dispatch-agent-task.js';
import { checkReplyStorm, STORM_THRESHOLD } from './storm-detector.js';
import { DEFTY_NAME } from './ensure-defty-membership.js';
import { resolveSpaceTarget } from './resolve-space-target.js';
import { createTaskBundle } from './task-bundle.js';
import { bulkUpdateTasks, BulkTaskUpdateError } from './task-bulk-update.js';
import {
  agentToolPolicyError,
  consumeAgentDailyActionBudget,
  getActiveAgentToolPolicy,
  isAgentToolDisabled,
} from './agent-tool-policy.js';
import { getApprovalTier, shouldAutoExecute } from './agent-approval.js';
import {
  MODULE_OPERATION_REQUEST_SCHEMAS,
  ModuleIdempotencyKeySchema,
  ModuleMutationResultSchema,
  ModuleRecordResourceIdSchema,
  parseModuleRecordResourceId,
  type ModuleActor,
  type ModuleMutationResult,
} from '@deft/shared/modules';
import {
  archiveModuleRecord,
  createModuleRecord,
  deftyModuleActor,
  employeeModuleActor,
  moduleIdempotencyDigest,
  moduleMutationInputDigest,
  preflightModuleMutation,
  preflightModuleMutationWithExecutor,
  type ModuleDbExecutor,
  recoverModuleMutationByAgentActionId,
  sanitizeModuleActionParamsForHistory,
  updateModuleRecord,
} from './module-service.js';
import {
  linkModuleRecordToTask,
  preflightModuleRecordTaskMutationWithExecutor,
  unlinkModuleRecordFromTask,
} from './module-task-links.js';
import { requireActiveOrgMembership } from './org-membership.js';
import { generateReceipt } from './receipts.js';
import { visibleTaskCondition } from './task-visibility.js';
import {
  employeeProjectAccessAllows,
  loadEmployeeProjectAccess,
} from './mcp-tools/employee-project-access.js';
import {
  MODULE_RECORD_BULK_CREATE_ACTION,
  ModuleRecordBulkCreateError,
  ModuleRecordBulkCreateParamsSchema,
  executeModuleRecordBulkCreate,
  isModuleRecordBulkCreateAction,
  preflightModuleRecordBulkCreate,
  sanitizeModuleBulkCreateParamsForHistory,
} from './module-record-bulk-create.js';
import {
  executeWorkspacePlanImport,
  WORKSPACE_PLAN_IMPORT_ACTION,
} from './workspace-plan-import.js';
import {
  DOCUMENT_SEND_ACTION,
  executeDocumentSend,
} from './document-send.js';

type ModuleEmployeeActionPolicy = {
  id: string;
  trustLevel: 'conservative' | 'standard' | 'autonomous';
  disabledTools: string[];
  unhealthy: boolean;
  unhealthyReason: string | null;
};

function assertModuleEmployeeActionPolicy(
  policy: ModuleEmployeeActionPolicy,
  action: ModuleGovernedRecordWriteAction,
): void {
  if (policy.unhealthy) {
    throw new Error(
      `Agent employee is unhealthy and cannot execute module writes${policy.unhealthyReason ? `: ${policy.unhealthyReason}` : ''}`,
    );
  }
  if (isAgentToolDisabled(policy.disabledTools, action)) {
    throw new Error(`Tool '${action}' is disabled for this agent employee`);
  }
}

function employeeModuleActionActor(
  policy: ModuleEmployeeActionPolicy,
  orgId: string,
  action: ModuleGovernedRecordWriteAction,
  actionId?: string,
) {
  assertModuleEmployeeActionPolicy(policy, action);
  return employeeModuleActor({
    orgId,
    employeeId: policy.id,
    trustLevel: policy.trustLevel,
    source: 'mcp',
    ...(actionId ? { actionId } : {}),
  });
}

async function buildModuleActionActor(
  action: ModuleGovernedRecordWriteAction,
  orgId: string,
  userId: string,
  actionId?: string,
  agentEmployeeId?: string,
) {
  if (agentEmployeeId) {
    const policy = await getActiveAgentToolPolicy(orgId, agentEmployeeId);
    if (!policy) {
      throw new Error('Agent employee is inactive, deleted, or outside this organization');
    }
    return employeeModuleActionActor({
      id: policy.employeeId,
      trustLevel: policy.trustLevel,
      disabledTools: policy.disabledTools,
      unhealthy: policy.unhealthy,
      unhealthyReason: policy.unhealthyReason,
    }, orgId, action, actionId);
  }
  const membership = await requireActiveOrgMembership(orgId, userId);
  return deftyModuleActor({
    orgId,
    userId,
    role: membership.role,
    ...(actionId ? { actionId } : {}),
  });
}

async function buildModuleTaskLinkActor(
  orgId: string,
  userId: string,
  agentEmployeeId?: string,
  actionId?: string,
): Promise<ModuleActor> {
  if (agentEmployeeId) {
    const policy = await getActiveAgentToolPolicy(orgId, agentEmployeeId);
    if (!policy) throw new Error('Agent employee is inactive, deleted, or outside this organization');
    return employeeModuleActor({
      orgId,
      employeeId: policy.employeeId,
      trustLevel: policy.trustLevel,
      source: 'runtime',
      ...(actionId ? { actionId } : {}),
    });
  }
  const membership = await requireActiveOrgMembership(orgId, userId);
  return deftyModuleActor({
    orgId,
    userId,
    role: membership.role,
    ...(actionId ? { actionId } : {}),
  });
}

async function buildModuleActionActorWithExecutor(
  executor: ModuleDbExecutor,
  action: ModuleGovernedRecordWriteAction,
  orgId: string,
  userId: string,
  actionId?: string,
  agentEmployeeId?: string,
) {
  if (!agentEmployeeId) {
    return buildModuleActionActor(action, orgId, userId, actionId);
  }

  let query = executor
    .select({
      id: agentEmployees.id,
      trust_level: agentEmployees.trust_level,
      disabled_tools: agentEmployees.disabled_tools,
      unhealthy: agentEmployees.unhealthy,
      unhealthy_reason: agentEmployees.unhealthy_reason,
    })
    .from(agentEmployees)
    .where(and(
      eq(agentEmployees.id, agentEmployeeId),
      eq(agentEmployees.org_id, orgId),
      eq(agentEmployees.is_active, true),
      or(
        eq(agentEmployees.is_deleted, false),
        eq(agentEmployees.runtime_kind, 'defty_system'),
      ),
    ))
    .limit(1);
  if ('for' in query) {
    query = (query as typeof query & { for: (strength: 'update') => typeof query }).for('update');
  }
  const [policy] = await query;
  if (!policy) {
    throw new Error('Agent employee is inactive, deleted, or outside this organization');
  }
  return employeeModuleActionActor({
    id: policy.id,
    trustLevel: policy.trust_level,
    disabledTools: policy.disabled_tools ?? [],
    unhealthy: policy.unhealthy,
    unhealthyReason: policy.unhealthy_reason,
  }, orgId, action, actionId);
}

const MODULE_WRITE_ACTIONS = new Set([
  'module_record_create',
  'module_record_update',
  'module_record_archive',
] as const);

type ModuleWriteAction = 'module_record_create' | 'module_record_update' | 'module_record_archive';
type ModuleGovernedRecordWriteAction = ModuleWriteAction | typeof MODULE_RECORD_BULK_CREATE_ACTION;

const MODULE_TASK_LINK_WRITE_ACTIONS = new Set([
  'module_record_task_link',
  'module_record_task_unlink',
] as const);

export type ModuleTaskLinkWriteAction =
  | 'module_record_task_link'
  | 'module_record_task_unlink';

export function isModuleWriteAction(action: string): action is ModuleWriteAction {
  return MODULE_WRITE_ACTIONS.has(action as ModuleWriteAction);
}

export function normalizeAgentModuleBulkCreateParams(
  action: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (!isModuleRecordBulkCreateAction(action)) return params;
  const {
    source_message_id: _sourceMessageId,
    proposal_node_id: _proposalNodeId,
    proposal_depends_on: _proposalDependsOn,
    ...canonical
  } = params;
  return ModuleRecordBulkCreateParamsSchema.parse(canonical) as Record<string, unknown>;
}

export async function preflightAgentModuleBulkCreateAction(
  action: string,
  params: Record<string, unknown>,
  orgId: string,
  userId: string,
  agentEmployeeId?: string,
): Promise<Record<string, unknown>> {
  if (!isModuleRecordBulkCreateAction(action)) return params;
  const normalized = normalizeAgentModuleBulkCreateParams(action, params);
  const actor = await buildModuleActionActor(
    MODULE_RECORD_BULK_CREATE_ACTION,
    orgId,
    userId,
    undefined,
    agentEmployeeId,
  );
  await preflightModuleRecordBulkCreate(actor, normalized);
  return normalized;
}

export function isModuleTaskLinkWriteAction(
  action: string,
): action is ModuleTaskLinkWriteAction {
  return MODULE_TASK_LINK_WRITE_ACTIONS.has(action as ModuleTaskLinkWriteAction);
}

/**
 * Agent orchestration adds message/graph provenance to ordinary action params.
 * Module tool schemas are deliberately strict, and their provenance already has
 * dedicated agent_actions columns, so keep it outside the canonical tool input.
 */
export function normalizeAgentModuleActionParams(
  action: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (!isModuleWriteAction(action)) return params;
  const {
    source_message_id: _sourceMessageId,
    proposal_node_id: _proposalNodeId,
    proposal_depends_on: _proposalDependsOn,
    ...canonical
  } = params;
  return MODULE_OPERATION_REQUEST_SCHEMAS[action].parse(canonical) as Record<string, unknown>;
}

function stableModuleActionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableModuleActionValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableModuleActionValue(item)]),
    );
  }
  return value;
}

function moduleTaskLinkCanonicalInput(value: Record<string, unknown>): {
  resource_id: string;
  task_identifier: string;
} {
  const resourceId = ModuleRecordResourceIdSchema.parse(value.resource_id);
  const taskIdentifier = z.string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Invalid task identifier')
    .parse(value.task_identifier);
  return { resource_id: resourceId, task_identifier: taskIdentifier };
}

function moduleTaskLinkInputDigest(value: Record<string, unknown>): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(stableModuleActionValue(moduleTaskLinkCanonicalInput(value))))
    .digest('hex')}`;
}

export function normalizeAgentModuleTaskLinkParams(
  action: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (!isModuleTaskLinkWriteAction(action)) return params;
  const canonical = moduleTaskLinkCanonicalInput(params);
  const idempotencyKey = ModuleIdempotencyKeySchema.parse(
    typeof params.idempotency_key === 'string' ? params.idempotency_key.trim() : params.idempotency_key,
  );
  return { ...canonical, idempotency_key: idempotencyKey };
}

export function sanitizeModuleTaskLinkActionParamsForHistory(
  value: unknown,
): Record<string, unknown> {
  const params = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const sanitized: Record<string, unknown> = {};
  for (const key of ['resource_id', 'task_identifier', 'idempotency_digest', 'input_digest']) {
    if (typeof params[key] === 'string') sanitized[key] = params[key];
  }
  return sanitized;
}

function terminalModuleTaskLinkActionParams(
  action: ModuleTaskLinkWriteAction,
  value: Record<string, unknown>,
  orgId: string,
  userId: string,
  agentEmployeeId?: string,
): Record<string, unknown> {
  const input = normalizeAgentModuleTaskLinkParams(action, value);
  const actor = agentModuleDigestActor(orgId, userId, agentEmployeeId);
  return {
    ...sanitizeModuleTaskLinkActionParamsForHistory(input),
    idempotency_digest: moduleIdempotencyDigest(actor, input.idempotency_key as string),
    input_digest: moduleTaskLinkInputDigest(input),
  };
}

export function sameModuleActionInput(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableModuleActionValue(left)) === JSON.stringify(stableModuleActionValue(right));
}

export function agentModuleActionClaimKey(
  orgId: string,
  action: string,
  idempotencyDigest: string,
): string {
  return `agent-action:${orgId}:${action}:${idempotencyDigest}`;
}

export function agentModuleExecutionLockKey(
  orgId: string,
  action: string,
  idempotencyDigest: string,
): string {
  return `agent-module-execution:${orgId}:${action}:${idempotencyDigest}`;
}

/** Reject invalid or unauthorized module proposals before agent_actions stores
 * their parameters. The actual executor repeats the checks after approval. */
export async function preflightAgentModuleAction(
  action: string,
  params: Record<string, unknown>,
  orgId: string,
  userId: string,
  agentEmployeeId?: string,
): Promise<Record<string, unknown>> {
  if (isModuleTaskLinkWriteAction(action)) {
    return normalizeAgentModuleTaskLinkParams(action, params);
  }
  if (!isModuleWriteAction(action)) {
    return params;
  }
  const normalized = normalizeAgentModuleActionParams(action, params);
  const actor = await buildModuleActionActor(action, orgId, userId, undefined, agentEmployeeId);
  if (action === 'module_record_create') {
    const input = MODULE_OPERATION_REQUEST_SCHEMAS.module_record_create.parse(normalized);
    await preflightModuleMutation(actor, action, input);
    return normalized;
  }
  if (action === 'module_record_update') {
    const input = MODULE_OPERATION_REQUEST_SCHEMAS.module_record_update.parse(normalized);
    await preflightModuleMutation(actor, action, input);
    return normalized;
  }
  const input = MODULE_OPERATION_REQUEST_SCHEMAS.module_record_archive.parse(normalized);
  await preflightModuleMutation(actor, 'module_record_archive', input);
  return normalized;
}

export async function preflightAgentModuleActionWithExecutor(
  executor: ModuleDbExecutor,
  action: string,
  params: Record<string, unknown>,
  orgId: string,
  userId: string,
  agentEmployeeId?: string,
): Promise<Record<string, unknown>> {
  if (isModuleTaskLinkWriteAction(action)) {
    return normalizeAgentModuleTaskLinkParams(action, params);
  }
  if (!isModuleWriteAction(action)) return params;
  const normalized = normalizeAgentModuleActionParams(action, params);
  const actor = await buildModuleActionActorWithExecutor(
    executor,
    action,
    orgId,
    userId,
    undefined,
    agentEmployeeId,
  );
  const input = MODULE_OPERATION_REQUEST_SCHEMAS[action].parse(normalized);
  await preflightModuleMutationWithExecutor(executor, actor, action, input, true);
  return normalized;
}

export async function agentModuleActionIdempotencyDigest(
  action: string,
  params: Record<string, unknown>,
  orgId: string,
  userId: string,
  agentEmployeeId?: string,
): Promise<string | null> {
  if (
    (!isModuleWriteAction(action) && !isModuleTaskLinkWriteAction(action))
    || typeof params.idempotency_key !== 'string'
  ) return null;
  const actor = agentModuleDigestActor(orgId, userId, agentEmployeeId);
  return moduleIdempotencyDigest(actor, params.idempotency_key);
}

/** Build only the stable actor identity used by the idempotency digest. This
 * deliberately does not consult live employee or membership policy: retries
 * must still be able to find and reconcile an action whose mutation already
 * committed before the principal was paused or downgraded. New inserts are
 * separately preflighted immediately before persistence. */
function agentModuleDigestActor(
  orgId: string,
  userId: string,
  agentEmployeeId?: string,
): ModuleActor {
  return agentEmployeeId
    ? employeeModuleActor({
      orgId,
      employeeId: agentEmployeeId,
      trustLevel: 'conservative',
      source: 'mcp',
    })
    : deftyModuleActor({ orgId, userId, role: 'member' });
}

export async function claimModuleAgentAction(params: {
  action: ModuleWriteAction;
  input: Record<string, unknown>;
  orgId: string;
  userId: string;
  agentEmployeeId?: string;
  values: typeof agentActions.$inferInsert;
}): Promise<{ action: typeof agentActions.$inferSelect; reused: boolean }> {
  const idempotencyKey = params.input.idempotency_key;
  if (typeof idempotencyKey !== 'string') {
    throw new Error('Module mutations require an idempotency key');
  }
  const actor = agentModuleDigestActor(params.orgId, params.userId, params.agentEmployeeId);
  const idempotencyDigest = moduleIdempotencyDigest(actor, idempotencyKey);

  return db.transaction(async (tx) => {
    const lockKey = agentModuleActionClaimKey(params.orgId, params.action, idempotencyDigest);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const actorScope = params.agentEmployeeId
      ? eq(agentActions.agent_employee_id, params.agentEmployeeId)
      : and(
        eq(agentActions.user_id, params.userId),
        sql`${agentActions.agent_employee_id} IS NULL`,
      );
    const [existing] = await tx
      .select()
      .from(agentActions)
      .where(and(
        eq(agentActions.org_id, params.orgId),
        eq(agentActions.action, params.action),
        actorScope,
        inArray(agentActions.approval_status, ['pending', 'approved']),
        or(
          sql`${agentActions.params}->>'idempotency_key' = ${idempotencyKey}`,
          sql`${agentActions.params}->>'idempotency_digest' = ${idempotencyDigest}`,
        ),
      ))
      .orderBy(desc(agentActions.created_at))
      .limit(1);
    if (existing) {
      const existingParams = existing.params && typeof existing.params === 'object'
        ? existing.params as Record<string, unknown>
        : {};
      if (
        existingParams.idempotency_key === idempotencyKey
        && !sameModuleActionInput(existingParams, params.input)
      ) {
        throw new Error('Idempotency key was already used for a different module mutation');
      }
      const expectedInputDigest = moduleMutationInputDigest(
        params.action === 'module_record_create' ? 'create'
          : params.action === 'module_record_update' ? 'update'
            : 'archive',
        params.input,
      );
      if (
        existingParams.idempotency_digest === idempotencyDigest
        && typeof existingParams.input_digest === 'string'
        && existingParams.input_digest !== expectedInputDigest
      ) {
        throw new Error('Idempotency key was already used for a different module mutation');
      }
      return { action: existing, reused: true };
    }


    // Only a genuinely new action reaches this point. Validate live module,
    // membership, employee-health and access policy before raw proposal values
    // are ever inserted. Existing retries skip this check only so they can
    // reconcile already-committed truth; they never perform a new mutation
    // without the executor's own policy check.
    const liveActor = await buildModuleActionActorWithExecutor(
      tx,
      params.action,
      params.orgId,
      params.userId,
      undefined,
      params.agentEmployeeId,
    );
    const mutationOperation = params.action === 'module_record_create'
      ? 'module_record_create'
      : params.action === 'module_record_update'
        ? 'module_record_update'
        : 'module_record_archive';
    const mutationInput = MODULE_OPERATION_REQUEST_SCHEMAS[params.action].parse(params.input);
    await preflightModuleMutationWithExecutor(
      tx,
      liveActor,
      mutationOperation,
      mutationInput,
      true,
    );

    // The employee row lock above is also the approval-policy linearization
    // point for a new direct action. Discovery may have seen Standard before
    // an admin downgraded the employee to Conservative. Recompute under the
    // lock and queue the same review payload when live trust no longer permits
    // auto-execution. A plan action keeps its already-reviewed provenance, and
    // existing pending rows returned above are never auto-promoted on upgrade.
    const approvalTier = params.values.approval_tier === 'auto'
      || params.values.approval_tier === 'quick'
      || params.values.approval_tier === 'full'
      ? params.values.approval_tier
      : getApprovalTier(params.action);
    const liveTrustRequiresReview = liveActor.kind === 'agent_employee'
      && params.values.approval_status === 'approved'
      && params.values.source !== 'plan'
      && !shouldAutoExecute(
        params.action,
        liveActor.trust_level,
        params.input,
        approvalTier,
      );
    const liveActionValues = liveTrustRequiresReview
      ? {
        ...params.values,
        approval_status: 'pending' as const,
        approved_at: null,
      }
      : params.values;

    let persistedParams = params.input;
    if (liveActionValues.approval_status === 'approved') {
      const terminalParams = sanitizeModuleActionParamsForHistory(params.action, params.input);
      terminalParams.idempotency_digest = idempotencyDigest;
      terminalParams.input_digest = moduleMutationInputDigest(
        params.action === 'module_record_create' ? 'create'
          : params.action === 'module_record_update' ? 'update'
            : 'archive',
        params.input,
      );
      persistedParams = terminalParams;
    }

    const [inserted] = await tx
      .insert(agentActions)
      .values({
        ...liveActionValues,
        org_id: params.orgId,
        user_id: params.userId,
        action: params.action,
        // Pending proposals retain their review payload. Direct approved
        // actions have the live input in memory already, so persist only a
        // digest-bearing terminal envelope from the first durable write. A
        // process death before execution therefore cannot strand module data
        // or a raw idempotency key in broad action history.
        params: persistedParams,
        ...(params.agentEmployeeId ? { agent_employee_id: params.agentEmployeeId } : {}),
      })
      .returning();
    if (!inserted) throw new Error('Failed to create module action log');
    return { action: inserted, reused: false };
  });
}

/**
 * Claim one durable action for a module-record/task edge mutation. The edge
 * itself is naturally unique, while this claim prevents a lost-response retry
 * from consuming another agent budget slot or creating another approval card
 * and signed receipt.
 */
export async function claimModuleTaskLinkAgentAction(params: {
  action: ModuleTaskLinkWriteAction;
  input: Record<string, unknown>;
  orgId: string;
  userId: string;
  agentEmployeeId?: string;
  values: typeof agentActions.$inferInsert;
}): Promise<{ action: typeof agentActions.$inferSelect; reused: boolean }> {
  const input = normalizeAgentModuleTaskLinkParams(params.action, params.input);
  const idempotencyKey = input.idempotency_key as string;
  const actor = agentModuleDigestActor(params.orgId, params.userId, params.agentEmployeeId);
  const idempotencyDigest = moduleIdempotencyDigest(actor, idempotencyKey);
  const inputDigest = moduleTaskLinkInputDigest(input);
  const liveActor = await buildModuleTaskLinkActor(
    params.orgId,
    params.userId,
    params.agentEmployeeId,
  );

  return db.transaction(async (tx) => {
    const lockKey = agentModuleActionClaimKey(params.orgId, params.action, idempotencyDigest);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const actorScope = params.agentEmployeeId
      ? eq(agentActions.agent_employee_id, params.agentEmployeeId)
      : and(
        eq(agentActions.user_id, params.userId),
        sql`${agentActions.agent_employee_id} IS NULL`,
      );
    const [existing] = await tx
      .select()
      .from(agentActions)
      .where(and(
        eq(agentActions.org_id, params.orgId),
        eq(agentActions.action, params.action),
        actorScope,
        inArray(agentActions.approval_status, ['pending', 'approved']),
        or(
          sql`${agentActions.params}->>'idempotency_key' = ${idempotencyKey}`,
          sql`${agentActions.params}->>'idempotency_digest' = ${idempotencyDigest}`,
        ),
      ))
      .orderBy(desc(agentActions.created_at))
      .limit(1);
    if (existing) {
      const existingParams = existing.params && typeof existing.params === 'object'
        ? existing.params as Record<string, unknown>
        : {};
      const existingInputDigest = typeof existingParams.input_digest === 'string'
        ? existingParams.input_digest
        : moduleTaskLinkInputDigest(existingParams);
      if (existingInputDigest !== inputDigest) {
        throw new Error('Idempotency key was already used for a different module task-link mutation');
      }
      return { action: existing, reused: true };
    }

    const taskId = await resolveTaskIdentifier(input.task_identifier as string, params.orgId, tx);
    if (!taskId) throw new Error('Task not found');
    const employeePolicy = await preflightModuleRecordTaskMutationWithExecutor(
      tx,
      liveActor,
      taskId,
      input.resource_id as string,
      params.action,
    );

    const approvalTier = params.values.approval_tier === 'auto'
      || params.values.approval_tier === 'quick'
      || params.values.approval_tier === 'full'
      ? params.values.approval_tier
      : getApprovalTier(params.action);
    const liveTrustRequiresReview = employeePolicy !== null
      && params.values.approval_status === 'approved'
      && params.values.source !== 'plan'
      && !shouldAutoExecute(
        params.action,
        employeePolicy.trustLevel,
        input,
        approvalTier,
      );
    const liveActionValues = liveTrustRequiresReview
      ? {
        ...params.values,
        approval_status: 'pending' as const,
        approved_at: null,
      }
      : params.values;

    const persistedParams = liveActionValues.approval_status === 'approved'
      ? {
        ...sanitizeModuleTaskLinkActionParamsForHistory(input),
        idempotency_digest: idempotencyDigest,
        input_digest: inputDigest,
      }
      : input;
    const [inserted] = await tx
      .insert(agentActions)
      .values({
        ...liveActionValues,
        org_id: params.orgId,
        user_id: params.userId,
        action: params.action,
        params: persistedParams,
        ...(params.agentEmployeeId ? { agent_employee_id: params.agentEmployeeId } : {}),
      })
      .returning();
    if (!inserted) throw new Error('Failed to create module task-link action log');
    return { action: inserted, reused: false };
  });
}

function toModuleMutationResult(
  operationResult: { mutation: ModuleMutationResult },
): ModuleMutationResult {
  return ModuleMutationResultSchema.parse(operationResult.mutation);
}

async function terminalizeModuleActionFailure(params: {
  actionId: string;
  action: ModuleWriteAction;
  actionParams: Record<string, unknown>;
  orgId: string;
  userId: string;
  agentEmployeeId?: string;
  error: string;
}): Promise<void> {
  const terminalParams = sanitizeModuleActionParamsForHistory(params.action, params.actionParams);
  if (typeof params.actionParams.idempotency_key === 'string') {
    const actor = agentModuleDigestActor(
      params.orgId,
      params.userId,
      params.agentEmployeeId,
    );
    terminalParams.idempotency_digest = moduleIdempotencyDigest(
      actor,
      params.actionParams.idempotency_key,
    );
    terminalParams.input_digest = moduleMutationInputDigest(
      params.action === 'module_record_create' ? 'create'
        : params.action === 'module_record_update' ? 'update'
          : 'archive',
      params.actionParams,
    );
  }
  await db
    .update(agentActions)
    .set({
      result: null,
      after_state: null,
      error: params.error.slice(0, 2_000),
      params: terminalParams,
      executed_at: new Date(),
    })
    .where(and(
      eq(agentActions.id, params.actionId),
      eq(agentActions.org_id, params.orgId),
      eq(agentActions.approval_status, 'approved'),
      sql`${agentActions.executed_at} IS NULL`,
    ));
}

async function persistModuleMutationAction(
  actionId: string,
  action: 'module_record_create' | 'module_record_update' | 'module_record_archive',
  params: Record<string, unknown>,
  actor: ModuleActor,
  result: ModuleMutationResult,
): Promise<void> {
  // Deliberately persist only the shared minimal mutation result. Record data
  // belongs in module_records and must not be duplicated into broad action
  // history or signed receipts.
  const terminalParams = sanitizeModuleActionParamsForHistory(action, params);
  if (typeof params.idempotency_key === 'string') {
    terminalParams.idempotency_digest = moduleIdempotencyDigest(actor, params.idempotency_key);
    terminalParams.input_digest = moduleMutationInputDigest(
      action === 'module_record_create' ? 'create'
        : action === 'module_record_update' ? 'update'
          : 'archive',
      params,
    );
  }
  try {
    await db
      .update(agentActions)
      .set({
        result,
        error: null,
        params: terminalParams,
        after_state: {
          resource_id: result.resource_id,
          record_id: result.record_id,
          installation_id: result.installation_id,
          module_id: result.module_id,
          collection_key: result.collection_key,
          manifest_digest: result.manifest_digest,
          revision: result.revision,
          archived: result.archived,
          changed_fields: result.changed_fields,
          replayed: result.replayed,
        },
        executed_at: new Date(),
      })
      .where(and(
        eq(agentActions.id, actionId),
        eq(agentActions.org_id, actor.org_id),
        eq(agentActions.approval_status, 'approved'),
      ));
  } catch (error) {
    // ModuleService has already committed the record, audit row, and durable
    // mutation receipt. Never reinterpret a failure to stamp the broad action
    // history as a failed mutation. The same-key retry can recover the exact
    // PII-free outcome through module_mutation_receipts.agent_action_id.
    console.error('[agent-actions] module mutation committed but action history stamp failed', {
      actionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Resolve a task identifier (either "PREFIX-N" shorthand or a raw uuid) to
 * the internal task uuid for the given org. Returns null if not found.
 */
async function resolveTaskIdentifier(
  identifier: string,
  orgId: string,
  executor: Pick<typeof db, 'select'> = db,
): Promise<string | null> {
  const m = identifier.match(/^([A-Z]+)-(\d+)$/);
  if (m) {
    const [proj] = await executor
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.org_id, orgId), eq(projects.prefix, m[1]!)))
      .limit(1);
    if (!proj) return null;
    const [t] = await executor
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.project_id, proj.id), eq(tasks.number, parseInt(m[2]!))))
      .limit(1);
    return t?.id ?? null;
  }
  // Assume raw uuid — verify it exists in this org
  const [t] = await executor
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, identifier), eq(tasks.org_id, orgId)))
    .limit(1);
  return t?.id ?? null;
}

const EMPLOYEE_TASK_WRITE_ACTIONS = new Set([
  'create_task',
  'update_task_status',
  'close_task',
  'reopen_task',
  'bulk_update_tasks',
  'assign_task',
  'comment_on_task',
  'set_due_date',
  'set_priority',
  'add_label',
  'add_dependency',
  'remove_dependency',
  'module_record_task_link',
  'module_record_task_unlink',
  'link_decision_to_tasks',
]);

function taskIdentifiersForEmployeeWrite(
  action: string,
  params: Record<string, any>,
): string[] {
  if (action === 'bulk_update_tasks') {
    return Array.isArray(params.task_identifiers)
      ? params.task_identifiers.filter((value: unknown): value is string => typeof value === 'string')
      : [];
  }
  if (action === 'add_dependency' || action === 'remove_dependency') {
    return [params.source_task_identifier, params.target_task_identifier]
      .filter((value): value is string => typeof value === 'string');
  }
  if (action === 'link_decision_to_tasks') {
    return Array.isArray(params.task_ids)
      ? params.task_ids.filter((value: unknown): value is string => typeof value === 'string')
      : [];
  }
  if (action === 'update_task_status' && typeof params.resolved_task_id === 'string') {
    return [params.resolved_task_id];
  }
  return typeof params.task_identifier === 'string' ? [params.task_identifier] : [];
}

/**
 * Enforce the employee's current task boundary at the shared execution seam.
 * This deliberately runs both before direct action persistence and again when
 * an existing/approved action executes, so a queued action cannot outlive a
 * project-scope narrowing. Restricted-task visibility is evaluated as the
 * employee's shadow user, not as the human who may approve the action.
 */
async function employeeTaskWriteScopeError(
  action: string,
  params: Record<string, any>,
  orgId: string,
  agentEmployeeId: string | null,
): Promise<string | null> {
  if (!agentEmployeeId || !EMPLOYEE_TASK_WRITE_ACTIONS.has(action)) return null;

  const access = await loadEmployeeProjectAccess({
    org_id: orgId,
    employee_id: agentEmployeeId,
  });
  if (!access.resolved) {
    return 'Agent employee is inactive, deleted, or outside this organization';
  }

  if (action === 'create_task') {
    const requestedProjectId = typeof params.resolved_project_id === 'string'
      ? params.resolved_project_id.trim()
      : '';
    const projectName = typeof params.project_name === 'string' ? params.project_name : '';
    const projectQuery = requestedProjectId
      ? db
        .select({ id: projects.id })
        .from(projects)
        .where(and(
          eq(projects.org_id, orgId),
          eq(projects.id, requestedProjectId),
          eq(projects.is_archived, false),
          eq(projects.is_deleted, false),
        ))
        .limit(1)
      : db
        .select({ id: projects.id })
        .from(projects)
        .where(and(
          eq(projects.org_id, orgId),
          ilike(projects.name, `%${projectName}%`),
          eq(projects.is_archived, false),
          eq(projects.is_deleted, false),
        ))
        .limit(1);
    const [project] = await projectQuery;
    if (!project || !employeeProjectAccessAllows(access, project.id)) return 'Project not found';
    // Pin name-based resolution so the write uses the exact project checked.
    params.resolved_project_id = project.id;
    return null;
  }

  const identifiers = [...new Set(
    taskIdentifiersForEmployeeWrite(action, params)
      .map((identifier) => identifier.trim())
      .filter(Boolean),
  )];
  if (identifiers.length === 0) return 'Task not found';

  const resolvedTaskIds = await Promise.all(
    identifiers.map((identifier) => resolveTaskIdentifier(identifier, orgId)),
  );
  if (resolvedTaskIds.some((taskId) => !taskId)) return 'Task not found';
  const taskIds = [...new Set(resolvedTaskIds as string[])];
  const scopedTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(projects, and(
      eq(projects.id, tasks.project_id),
      eq(projects.org_id, orgId),
    ))
    .where(and(
      eq(tasks.org_id, orgId),
      eq(tasks.is_deleted, false),
      eq(projects.is_deleted, false),
      inArray(tasks.id, taskIds),
      visibleTaskCondition(access.userId),
      ...(access.unrestricted ? [] : [inArray(tasks.project_id, access.projectIds)]),
    ));

  return scopedTasks.length === taskIds.length ? null : 'Task not found';
}

async function terminalizeModuleTaskLinkActionFailure(
  actionId: string,
  action: ModuleTaskLinkWriteAction,
  params: Record<string, unknown>,
  orgId: string,
  userId: string,
  agentEmployeeId: string | undefined,
  error: string,
): Promise<void> {
  const terminalParams = sanitizeModuleTaskLinkActionParamsForHistory(params);
  if (typeof params.idempotency_key === 'string' && params.idempotency_key.trim()) {
    const actor = agentModuleDigestActor(orgId, userId, agentEmployeeId);
    terminalParams.idempotency_digest = moduleIdempotencyDigest(
      actor,
      params.idempotency_key.trim(),
    );
    try {
      terminalParams.input_digest = moduleTaskLinkInputDigest(params);
    } catch {
      // Invalid request shapes are still terminalized without retaining the
      // raw retry key. There is no canonical input digest to assert for them.
    }
  }
  await db
    .update(agentActions)
    .set({
      error: error.slice(0, 2_000),
      result: null,
      params: terminalParams,
      executed_at: new Date(),
    })
    .where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, orgId)));
}

export async function executeAction(
  actionId: string,
  action: string,
  params: Record<string, any>,
  orgId: string,
  userId: string,
  options?: {
    /**
     * Task 3.3 — when set, every task_activity row written by this call
     * is attributed back to the specific agent employee that acted.
     */
    agentEmployeeId?: string;
  },
): Promise<{ success: boolean; result: any; error?: string }> {
  const agentEmployeeId = options?.agentEmployeeId ?? null;
  try {
    const taskScopeError = await employeeTaskWriteScopeError(
      action,
      params,
      orgId,
      agentEmployeeId,
    );
    if (taskScopeError) return { success: false, result: null, error: taskScopeError };

    const policyError = await agentToolPolicyError(orgId, agentEmployeeId, action);
    if (policyError) {
      if (isModuleWriteAction(action)) {
        await terminalizeModuleActionFailure({
          actionId,
          action,
          actionParams: params,
          orgId,
          userId,
          ...(agentEmployeeId ? { agentEmployeeId } : {}),
          error: policyError,
        });
      } else if (isModuleTaskLinkWriteAction(action)) {
        await terminalizeModuleTaskLinkActionFailure(
          actionId,
          action,
          params,
          orgId,
          userId,
          agentEmployeeId ?? undefined,
          policyError,
        );
      }
      return { success: false, result: null, error: policyError };
    }
    if (agentEmployeeId) {
      const budget = await consumeAgentDailyActionBudget(
        orgId,
        agentEmployeeId,
        {
          requireHealthy: isModuleWriteAction(action)
            || isModuleRecordBulkCreateAction(action)
            || isModuleTaskLinkWriteAction(action)
            || action === WORKSPACE_PLAN_IMPORT_ACTION
            || action === DOCUMENT_SEND_ACTION,
        },
      );
      if (!budget.allowed) {
        if (isModuleWriteAction(action)) {
          await terminalizeModuleActionFailure({
            actionId,
            action,
            actionParams: params,
            orgId,
            userId,
            agentEmployeeId,
            error: budget.error,
          });
        } else if (isModuleTaskLinkWriteAction(action)) {
          await terminalizeModuleTaskLinkActionFailure(
            actionId,
            action,
            params,
            orgId,
            userId,
            agentEmployeeId,
            budget.error,
          );
        } else {
          await db.update(agentActions).set({ error: budget.error }).where(eq(agentActions.id, actionId));
        }
        return { success: false, result: null, error: budget.error };
      }
    }

    // MCP tool execution — handle before the native action switch
    if (action.startsWith('mcp__')) {
      const { connectionSlug, toolName } = parseMCPToolName(action);
      const resolved = await getExecutableMcpConnection(orgId, connectionSlug, toolName, agentEmployeeId);
      if (!resolved.connection) {
        return { success: false, result: null, error: resolved.error };
      }
      const config = toConnectionConfig(resolved.connection);
      const mcpResult = await mcpClientManager.executeTool(config, toolName, params);
      const resultPayload = mcpResultPayload(mcpResult);
      if (!mcpResult.success) {
        const error = mcpResult.error || 'MCP tool error';
        await db.update(agentActions).set({
          result: resultPayload as any,
          error,
        }).where(eq(agentActions.id, actionId));
        return { success: false, result: resultPayload, error };
      }
      // Update the action record with result
      await db.update(agentActions).set({
        executed_at: new Date(),
        result: resultPayload as any,
      }).where(eq(agentActions.id, actionId));
      return { success: true, result: resultPayload };
    }

    // Task 3.5 — close_task / reopen_task are thin wrappers over
    // update_task_status. Normalize to the canonical action here so the
    // existing case below handles the DB write, activity row, audit log,
    // and chat broadcast without duplication.
    if (action === 'close_task') {
      action = 'update_task_status';
      params = { task_identifier: params.task_identifier, new_status: 'done' };
    } else if (action === 'reopen_task') {
      action = 'update_task_status';
      params = { task_identifier: params.task_identifier, new_status: 'todo' };
    }

    switch (action) {
      case DOCUMENT_SEND_ACTION: {
        let documentActorUserId = userId;
        if (!agentEmployeeId) {
          const [proposalAuthor] = await db.select({ user_id: messages.user_id })
            .from(agentActions)
            .innerJoin(messages, and(
              eq(messages.id, agentActions.message_id),
              eq(messages.org_id, agentActions.org_id),
            ))
            .where(and(
              eq(agentActions.id, actionId),
              eq(agentActions.org_id, orgId),
            ))
            .limit(1);
          documentActorUserId = proposalAuthor?.user_id ?? userId;
        }
        const result = await executeDocumentSend({
          actionId,
          actionParams: params,
          orgId,
          actorUserId: documentActorUserId,
          ...(agentEmployeeId ? { employeeId: agentEmployeeId } : {}),
        });
        return { success: true, result };
      }

      case WORKSPACE_PLAN_IMPORT_ACTION: {
        const result = await executeWorkspacePlanImport({
          actionId,
          actionParams: params,
          orgId,
          userId,
          ...(agentEmployeeId ? { agentEmployeeId } : {}),
        });
        return { success: true, result };
      }

      case 'module_record_task_link': {
        const input = normalizeAgentModuleTaskLinkParams(action, params);
        const resourceId = ModuleRecordResourceIdSchema.parse(input.resource_id);
        const taskIdentifier = input.task_identifier as string;
        const taskId = await resolveTaskIdentifier(taskIdentifier, orgId);
        if (!taskId) throw new Error('Task not found');
        const actor = await buildModuleTaskLinkActor(
          orgId,
          userId,
          agentEmployeeId ?? undefined,
          actionId,
        );
        const linked = await linkModuleRecordToTask(actor, taskId, resourceId);
        // Keep broad agent history/receipts free of projected module values.
        // The human REST response may render the rich link, while Defty only
        // needs stable identities and the idempotent mutation outcome.
        const result = {
          resource_id: resourceId,
          task_id: taskId,
          edge_id: linked.link.edge_id,
          created: linked.created,
        };
        await db.update(agentActions).set({
          result,
          error: null,
          params: terminalModuleTaskLinkActionParams(
            action,
            input,
            orgId,
            userId,
            agentEmployeeId ?? undefined,
          ),
          executed_at: new Date(),
        }).where(eq(agentActions.id, actionId));
        return { success: true, result };
      }

      case 'module_record_task_unlink': {
        const input = normalizeAgentModuleTaskLinkParams(action, params);
        const resourceId = ModuleRecordResourceIdSchema.parse(input.resource_id);
        const taskIdentifier = input.task_identifier as string;
        const taskId = await resolveTaskIdentifier(taskIdentifier, orgId);
        if (!taskId) throw new Error('Task not found');
        const actor = await buildModuleTaskLinkActor(
          orgId,
          userId,
          agentEmployeeId ?? undefined,
          actionId,
        );
        const unlinked = await unlinkModuleRecordFromTask(
          actor,
          taskId,
          parseModuleRecordResourceId(resourceId),
        );
        const result = { resource_id: resourceId, task_id: taskId, ...unlinked };
        await db.update(agentActions).set({
          result,
          error: null,
          params: terminalModuleTaskLinkActionParams(
            action,
            input,
            orgId,
            userId,
            agentEmployeeId ?? undefined,
          ),
          executed_at: new Date(),
        }).where(eq(agentActions.id, actionId));
        return { success: true, result };
      }

      case 'module_record_create': {
        const input = MODULE_OPERATION_REQUEST_SCHEMAS.module_record_create.parse({
          ...params,
          idempotency_key: params.idempotency_key ?? `agent-action:${actionId}`,
        });
        const actor = await buildModuleActionActor(
          action,
          orgId,
          userId,
          actionId,
          agentEmployeeId ?? undefined,
        );
        const created = await createModuleRecord(actor, input);
        const result = toModuleMutationResult(created);
        await persistModuleMutationAction(actionId, 'module_record_create', params, actor, result);
        return { success: true, result };
      }

      case 'module_record_bulk_create': {
        const input = ModuleRecordBulkCreateParamsSchema.parse(
          normalizeAgentModuleBulkCreateParams(action, params),
        );
        // Child mutations deliberately omit agent_action_id: one parent action
        // owns many independently idempotent module receipts.
        const actor = await buildModuleActionActor(
          MODULE_RECORD_BULK_CREATE_ACTION,
          orgId,
          userId,
          undefined,
          agentEmployeeId ?? undefined,
        );
        const result = await executeModuleRecordBulkCreate(actor, input);
        await db.update(agentActions).set({
          result,
          error: null,
          params: sanitizeModuleBulkCreateParamsForHistory(input),
          after_state: result,
          executed_at: new Date(),
        }).where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, orgId)));
        return { success: true, result };
      }

      case 'module_record_update': {
        const input = MODULE_OPERATION_REQUEST_SCHEMAS.module_record_update.parse({
          ...params,
          idempotency_key: params.idempotency_key ?? `agent-action:${actionId}`,
        });
        const actor = await buildModuleActionActor(
          action,
          orgId,
          userId,
          actionId,
          agentEmployeeId ?? undefined,
        );
        const updated = await updateModuleRecord(actor, input);
        const result = toModuleMutationResult(updated);
        await persistModuleMutationAction(actionId, 'module_record_update', params, actor, result);
        return { success: true, result };
      }

      case 'module_record_archive': {
        const input = MODULE_OPERATION_REQUEST_SCHEMAS.module_record_archive.parse({
          ...params,
          idempotency_key: params.idempotency_key ?? `agent-action:${actionId}`,
        });
        const actor = await buildModuleActionActor(
          action,
          orgId,
          userId,
          actionId,
          agentEmployeeId ?? undefined,
        );
        const archived = await archiveModuleRecord(actor, input);
        const result = toModuleMutationResult(archived);
        await persistModuleMutationAction(actionId, 'module_record_archive', params, actor, result);
        return { success: true, result };
      }

      case 'create_task': {
        const projectQuery = typeof params.resolved_project_id === 'string' && params.resolved_project_id.trim()
          ? db
            .select()
            .from(projects)
            .where(and(eq(projects.org_id, orgId), eq(projects.id, params.resolved_project_id)))
            .limit(1)
          : db
            .select()
            .from(projects)
            .where(and(eq(projects.org_id, orgId), ilike(projects.name, `%${params.project_name}%`)))
            .limit(1);
        const [project] = await projectQuery;
        if (!project) return { success: false, result: null, error: 'Project not found' };

        let assigneeId: string | null = null;
        if (params.assignee_name) {
          const resolved = await resolveAssigneeWithMatches(params.assignee_name, orgId);
          if (!resolved.ok) {
            if (resolved.ambiguous) {
              return {
                success: false,
                result: null,
                error: `Ambiguous name "${params.assignee_name}". Matches: ${resolved.matches.map((m) => m.name).join(', ')}`,
              };
            }
            // Non-ambiguous miss: leave assignee null (matches legacy behavior).
          } else {
            assigneeId = resolved.value.id;
          }
        }

        // Smart priority detection if not explicitly set
        let priority = params.priority || 'p2';
        if (!params.priority) {
          const lowerContent = (params.description || params.title || '').toLowerCase();
          if (lowerContent.match(/\b(urgent|asap|critical|blocker|emergency|p0)\b/)) {
            priority = 'p0';
          } else if (lowerContent.match(/\b(important|high priority|p1|needs attention|blocking)\b/)) {
            priority = 'p1';
          } else if (lowerContent.match(/\b(low priority|nice to have|when possible|p3|minor)\b/)) {
            priority = 'p3';
          }
        }

        const bundle = await createTaskBundle({
          orgId,
          projectId: project.id,
          projectPrefix: project.prefix,
          projectName: project.name,
          createdBy: userId,
          title: params.title,
          description: params.description,
          priority,
          assigneeId,
          dueDate: params.due_date ?? null,
          startDate: params.start_date ?? null,
          estimation: params.estimation ?? null,
          sourceMessageId: params.source_message_id || null,
          actionId,
          actingAgentEmployeeId: agentEmployeeId,
          subtasks: Array.isArray(params.subtasks) ? params.subtasks : null,
        });
        const task = bundle.parent;

        await db
          .update(agentActions)
          .set({
            result: {
              task_id: task.id,
              number: task.number,
              prefix: project.prefix,
              subtasks: bundle.subtasks,
            },
            before_state: null,
            after_state: {
              id: task.id,
              title: task.title,
              status: task.status,
              priority: task.priority,
              assignee_id: task.assignee_id,
              project_id: task.project_id,
              number: task.number,
              subtasks: bundle.subtasks,
            },
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        const io = getIO();
        if (io) {
          for (const createdTask of bundle.allTasks) {
            io.to(`org:${orgId}`).emit('task:created', {
              ...createdTask,
              project_id: project.id,
              project_prefix: project.prefix,
              project_name: project.name,
            });
          }
        }

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'create_task',
          entityType: 'task',
          entityId: task.id,
          beforeState: null,
          afterState: {
            id: task.id,
            title: task.title,
            status: task.status,
            priority: task.priority,
            assignee_id: task.assignee_id,
            subtasks: bundle.subtasks,
          },
          metadata: { action_id: actionId, project: project.prefix, subtask_count: bundle.subtasks.length },
        });

        // If an assignee is an agent employee, wake them up to work the task.
        for (const createdTask of bundle.allTasks.filter((row) => row.assignee_id)) {
          await dispatchAgentEmployeeTask({
            taskId: createdTask.id,
            orgId,
            assigneeUserId: createdTask.assignee_id!,
            assignedBy: userId,
          });
        }

        return {
          success: true,
          result: {
            task_id: task.id,
            identifier: task.identifier,
            title: params.title,
            subtasks: bundle.subtasks,
          },
        };
      }

      case 'update_task_status': {
        let taskId = typeof params.resolved_task_id === 'string' && params.resolved_task_id.trim()
          ? params.resolved_task_id
          : params.task_identifier as string;
        const m = typeof params.resolved_task_id === 'string' && params.resolved_task_id.trim()
          ? null
          : taskId.match(/^([A-Z]+)-(\d+)$/);
        if (m) {
          const [proj] = await db
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.org_id, orgId), eq(projects.prefix, m[1]!)))
            .limit(1);
          if (proj) {
            const [f] = await db
              .select({ id: tasks.id })
              .from(tasks)
              .where(and(eq(tasks.project_id, proj.id), eq(tasks.number, parseInt(m[2]!))))
              .limit(1);
            if (f) taskId = f.id;
          }
        }

        const [existing] = await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.org_id, orgId)))
          .limit(1);
        if (!existing) return { success: false, result: null, error: 'Task not found' };

        const oldStatus = existing.status;
        await db.update(tasks).set({ status: params.new_status }).where(eq(tasks.id, taskId));

        await db.insert(taskActivity).values({
          org_id: orgId,
          task_id: taskId,
          user_id: userId,
          action: 'status_changed',
          field: 'status',
          old_value: oldStatus,
          new_value: params.new_status,
          agent_action_id: actionId,
          acting_agent_employee_id: agentEmployeeId,
        });

        await db
          .update(agentActions)
          .set({
            result: { task_id: taskId },
            before_state: { status: oldStatus, task_id: taskId },
            after_state: { status: params.new_status, task_id: taskId },
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        // Post system message in linked spaces
        try {
          const { projectSpaces, messages: msgTable, users: usersTable } = await import('@deft/db/schema');
          const linkedSpaces = await db.select({ space_id: projectSpaces.space_id })
            .from(projectSpaces)
            .where(eq(projectSpaces.project_id, existing.project_id));

          if (linkedSpaces.length > 0) {
            // Get project prefix
            const [proj] = await db.select({ prefix: projects.prefix }).from(projects)
              .where(eq(projects.id, existing.project_id)).limit(1);
            const [actor] = await db.select({ name: usersTable.name }).from(usersTable)
              .where(eq(usersTable.id, userId)).limit(1);

            const statusLabels: Record<string, string> = {
              backlog: 'Backlog', todo: 'To Do', in_progress: 'In Progress',
              in_review: 'In Review', done: 'Done', cancelled: 'Cancelled',
            };
            const content = `\u2713 Deft moved ${proj?.prefix || ''}-${existing.number} to ${statusLabels[params.new_status] || params.new_status}`;

            for (const ls of linkedSpaces) {
              const [msg] = await db.insert(msgTable).values({
                org_id: orgId,
                space_id: ls.space_id,
                user_id: userId,
                content,
              }).returning();

              const io = getIO();
              if (io && msg) {
                io.to(`space:${ls.space_id}`).emit('message:new', {
                  ...msg, user_name: actor?.name || DEFTY_NAME, user_avatar: null,
                });
              }
            }
          }
        } catch (err) {
          console.error('Failed to post status change in chat:', err);
        }

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'update_task_status',
          entityType: 'task',
          entityId: taskId,
          beforeState: { status: oldStatus },
          afterState: { status: params.new_status },
          metadata: { action_id: actionId },
        });

        return {
          success: true,
          result: { task_id: taskId, old_status: oldStatus, new_status: params.new_status },
        };
      }

      case 'bulk_update_tasks': {
        const identifiers = Array.isArray(params.task_identifiers)
          ? [...new Set(params.task_identifiers.filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0))]
          : [];
        if (identifiers.length < 2 || identifiers.length > 50) {
          return { success: false, result: null, error: 'Bulk task updates require 2-50 exact task identifiers' };
        }
        const taskIds: string[] = [];
        for (const identifier of identifiers) {
          const taskId = await resolveTaskIdentifier(identifier, orgId);
          if (!taskId) return { success: false, result: null, error: `Task not found: ${identifier}` };
          taskIds.push(taskId);
        }

        const requested = params.updates && typeof params.updates === 'object' ? params.updates : {};
        const updates: Record<string, unknown> = {};
        for (const field of ['status', 'priority', 'due_date', 'start_date', 'estimation']) {
          if (requested[field] !== undefined) updates[field] = requested[field];
        }
        if (typeof requested.assignee_name === 'string') {
          const resolved = await resolveAssigneeWithMatches(requested.assignee_name, orgId);
          if (!resolved.ok) {
            const suffix = resolved.ambiguous ? ` Matches: ${resolved.matches.map((match) => match.name).join(', ')}` : '';
            return { success: false, result: null, error: `Could not resolve assignee "${requested.assignee_name}".${suffix}` };
          }
          updates.assignee_id = resolved.value.id;
        }

        for (const [namesField, idsField] of [['add_label_names', 'add_label_ids'], ['remove_label_names', 'remove_label_ids']] as const) {
          if (!Array.isArray(requested[namesField])) continue;
          const names = [...new Set(requested[namesField].filter((value: unknown): value is string => typeof value === 'string' && value.trim().length > 0))];
          const ids: string[] = [];
          for (const name of names) {
            const matches = await db.select({ id: labels.id, name: labels.name }).from(labels)
              .where(and(eq(labels.org_id, orgId), sql`lower(${labels.name}) = lower(${name})`));
            if (matches.length !== 1) return { success: false, result: null, error: `Label must match exactly once: ${name}` };
            ids.push(matches[0]!.id);
          }
          updates[idsField] = ids;
        }

        try {
          const result = await bulkUpdateTasks({ task_ids: taskIds, updates } as any, {
            orgId,
            userId,
            agentActionId: actionId,
            agentEmployeeId,
          });
          await db.update(agentActions).set({
            result: { ...result, task_identifiers: identifiers },
            before_state: { task_ids: taskIds },
            after_state: { task_ids: result.updated_ids, fields: result.fields },
            executed_at: new Date(),
          }).where(eq(agentActions.id, actionId));
          await logAuditEvent({
            orgId,
            actorType: 'agent',
            actorId: userId,
            action: 'bulk_update_tasks',
            entityType: 'task_batch',
            entityId: actionId,
            beforeState: { task_ids: taskIds },
            afterState: { task_ids: result.updated_ids, updates },
            metadata: { action_id: actionId, agent_employee_id: agentEmployeeId },
          });
          return { success: true, result: { ...result, task_identifiers: identifiers } };
        } catch (err) {
          if (err instanceof BulkTaskUpdateError) return { success: false, result: null, error: `${err.code}: ${err.message}` };
          throw err;
        }
      }

      case 'assign_task': {
        let taskId = params.task_identifier as string;
        const m = taskId.match(/^([A-Z]+)-(\d+)$/);
        if (m) {
          const [proj] = await db
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.org_id, orgId), eq(projects.prefix, m[1]!)))
            .limit(1);
          if (proj) {
            const [f] = await db
              .select({ id: tasks.id })
              .from(tasks)
              .where(and(eq(tasks.project_id, proj.id), eq(tasks.number, parseInt(m[2]!))))
              .limit(1);
            if (f) taskId = f.id;
          }
        }

        const [existing] = await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.org_id, orgId)))
          .limit(1);
        if (!existing) return { success: false, result: null, error: 'Task not found' };

        const resolved = await resolveAssigneeWithMatches(params.assignee_name, orgId);
        if (!resolved.ok) {
          if (resolved.ambiguous) {
            return {
              success: false,
              result: null,
              error: `Ambiguous name "${params.assignee_name}". Matches: ${resolved.matches.map((m) => m.name).join(', ')}`,
            };
          }
          return { success: false, result: null, error: `User "${params.assignee_name}" not found in this org` };
        }
        const newAssigneeId = resolved.value.id;
        const newAssigneeName = resolved.value.name;

        const oldAssigneeId = existing.assignee_id;

        await db.update(tasks).set({ assignee_id: newAssigneeId }).where(eq(tasks.id, taskId));

        // Resolve names for activity log
        let oldAssigneeName: string | null = null;
        if (oldAssigneeId) {
          const [oldUser] = await db.select({ name: users.name }).from(users)
            .where(eq(users.id, oldAssigneeId)).limit(1);
          oldAssigneeName = oldUser?.name || null;
        }

        await db.insert(taskActivity).values({
          org_id: orgId,
          task_id: taskId,
          user_id: userId,
          action: 'field_changed',
          field: 'assignee',
          old_value: oldAssigneeName,
          new_value: newAssigneeName,
          agent_action_id: actionId,
          acting_agent_employee_id: agentEmployeeId,
        });

        await db
          .update(agentActions)
          .set({
            result: { task_id: taskId, assignee_id: newAssigneeId },
            before_state: { assignee_id: oldAssigneeId, task_id: taskId },
            after_state: { assignee_id: newAssigneeId, task_id: taskId },
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        const io = getIO();
        if (io) {
          io.to(`org:${orgId}`).emit('task:updated', {
            id: taskId,
            assignee_id: newAssigneeId,
            assignee_name: newAssigneeName,
          });
        }

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'assign_task',
          entityType: 'task',
          entityId: taskId,
          beforeState: { assignee_id: oldAssigneeId },
          afterState: { assignee_id: newAssigneeId },
          metadata: { action_id: actionId, assignee_name: newAssigneeName },
        });

        // If new assignee is an agent employee, wake them up to work the task.
        if (newAssigneeId && newAssigneeId !== oldAssigneeId) {
          await dispatchAgentEmployeeTask({
            taskId,
            orgId,
            assigneeUserId: newAssigneeId,
            assignedBy: userId,
          });
        }

        return {
          success: true,
          result: {
            task_id: taskId,
            old_assignee: oldAssigneeName,
            new_assignee: newAssigneeName,
          },
        };
      }

      case 'post_message': {
        const resolvedSpace = await resolveSpaceTarget(orgId, {
          spaceId: params.space_id ?? params.resolved_space_id,
          spaceName: params.space_name,
        });
        if (resolvedSpace.status !== 'resolved') {
          return { success: false, result: null, error: resolvedSpace.message };
        }
        const space = resolvedSpace.space;

        const [msg] = await db
          .insert(messages)
          .values({
            org_id: orgId,
            space_id: space.id,
            user_id: userId,
            content: params.content,
          })
          .returning();

        await db
          .update(agentActions)
          .set({
            result: { message_id: msg!.id, space_id: space.id },
            before_state: null,
            after_state: {
              message_id: msg!.id,
              space_id: space.id,
              content: params.content,
            },
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        const io = getIO();
        if (io) {
          io.to(`space:${space.id}`).emit('message:new', {
            ...msg,
            user_name: DEFTY_NAME,
            user_avatar: null,
          });
        }

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'post_message',
          entityType: 'message',
          entityId: msg!.id,
          beforeState: null,
          afterState: { message_id: msg!.id, space_id: space.id, content: params.content },
          metadata: { action_id: actionId, space_name: space.name },
        });

        return { success: true, result: { message_id: msg!.id, space: space.name } };
      }

      case 'add_knowledge': {
        const [space] = await db
          .select()
          .from(spaces)
          .where(and(eq(spaces.org_id, orgId), ilike(spaces.name, `%${params.space_name}%`)))
          .limit(1);
        if (!space) return { success: false, result: null, error: `Space "${params.space_name}" not found` };

        // Map legacy 4-type knowledge to wiki's 7-type taxonomy.
        const legacyToWiki: Record<string, string> = {
          decision: 'decision',
          resource: 'resource',
          action_item: 'procedure',
          note: 'fact',
        };
        const wikiType = (legacyToWiki[params.type as string] || 'fact') as
          'concept' | 'entity' | 'decision' | 'resource' | 'procedure' | 'preference' | 'fact';

        const title = params.title as string;
        const baseSlug = title.toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '')
          .replace(/\s+/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 80) || 'knowledge';

        const [existingSlug] = await db.select({ id: wikiPages.id })
          .from(wikiPages)
          .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.slug, baseSlug)))
          .limit(1);
        const slug = existingSlug ? `${baseSlug}-${Date.now().toString(36)}` : baseSlug;

        const [entry] = await db
          .insert(wikiPages)
          .values({
            org_id: orgId,
            scope: 'space',
            space_id: space.id,
            user_id: userId,
            type: wikiType,
            title,
            slug,
            content: (params.content as string) || title,
            confidence: 1.0,
          })
          .returning();

        await db
          .update(agentActions)
          .set({
            result: { knowledge_id: entry!.id, title, space: space.name },
            before_state: null,
            after_state: { id: entry!.id, type: wikiType, title, space_id: space.id },
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'add_knowledge',
          entityType: 'knowledge',
          entityId: entry!.id,
          beforeState: null,
          afterState: { type: wikiType, title, space: space.name },
          metadata: { action_id: actionId },
        });

        return { success: true, result: { knowledge_id: entry!.id, title, space: space.name } };
      }

      case 'wiki_write': {
        const { slug: existingSlug, title, content, type: pageType, summary, related_slugs } = params;

        if (existingSlug) {
          const [existing] = await db
            .select()
            .from(wikiPages)
            .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.slug, existingSlug), eq(wikiPages.is_deleted, false)))
            .limit(1);
          if (!existing) return { success: false, result: null, error: `Wiki page "${existingSlug}" not found` };

          const updates: Record<string, any> = {};
          if (title) updates.title = title;
          if (summary) updates.summary = summary;
          if (pageType) updates.type = pageType;
          if (content && content !== existing.content) {
            updates.content = content;
            updates.previous_content = existing.content;
            updates.version = existing.version + 1;
          }

          if (Object.keys(updates).length > 0) {
            await db.update(wikiPages).set(updates).where(eq(wikiPages.id, existing.id));
          }

          if (related_slugs && related_slugs.length > 0) {
            await db.delete(wikiLinks).where(eq(wikiLinks.source_page_id, existing.id));
            const targets = await db
              .select({ id: wikiPages.id })
              .from(wikiPages)
              .where(and(eq(wikiPages.org_id, orgId), inArray(wikiPages.slug, related_slugs)));
            for (const t of targets) {
              if (t.id !== existing.id) {
                await db.insert(wikiLinks).values({ org_id: orgId, source_page_id: existing.id, target_page_id: t.id }).onConflictDoNothing();
              }
            }
          }

          await db.insert(wikiOpsLog).values({
            org_id: orgId,
            operation: 'update',
            page_id: existing.id,
            details: { updated_fields: Object.keys(updates), by_agent: true },
            performed_by: userId,
          });

          await db
            .update(agentActions)
            .set({
              result: { slug: existingSlug, action: 'updated' },
              before_state: { content: existing.content, version: existing.version },
              after_state: { content: content || existing.content, version: (existing.version || 0) + 1 },
              executed_at: new Date(),
            })
            .where(eq(agentActions.id, actionId));

          await logAuditEvent({
            orgId,
            actorType: 'agent',
            actorId: userId,
            action: 'wiki_write',
            entityType: 'wiki_page',
            entityId: existing.id,
            beforeState: { content: existing.content },
            afterState: { content: content || existing.content },
            metadata: { action_id: actionId, slug: existingSlug },
          });

          return { success: true, result: { slug: existingSlug, action: 'updated' } };
        } else {
          if (!title || !content || !pageType) {
            return { success: false, result: null, error: 'title, content, and type are required for new wiki pages' };
          }

          const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

          const [page] = await db
            .insert(wikiPages)
            .values({
              org_id: orgId,
              scope: 'org',
              type: pageType,
              title,
              slug,
              summary: summary || null,
              content,
              confidence: 0.7,
              version: 1,
            })
            .returning();

          await db.insert(wikiOpsLog).values({
            org_id: orgId,
            operation: 'create',
            page_id: page!.id,
            details: { type: pageType, by_agent: true },
            performed_by: userId,
          });

          await db
            .update(agentActions)
            .set({
              result: { slug, page_id: page!.id, action: 'created' },
              before_state: null,
              after_state: { id: page!.id, title, slug, type: pageType },
              executed_at: new Date(),
            })
            .where(eq(agentActions.id, actionId));

          await logAuditEvent({
            orgId,
            actorType: 'agent',
            actorId: userId,
            action: 'wiki_write',
            entityType: 'wiki_page',
            entityId: page!.id,
            beforeState: null,
            afterState: { title, slug, type: pageType },
            metadata: { action_id: actionId },
          });

          return { success: true, result: { slug, page_id: page!.id, action: 'created' } };
        }
      }

      case 'comment_on_task': {
        // Task 3.4 — add a comment to a task.
        const taskId = await resolveTaskIdentifier(params.task_identifier, orgId);
        if (!taskId) return { success: false, result: null, error: 'Task not found' };

        const content = typeof params.content === 'string' ? params.content.trim() : '';
        if (!content) {
          return { success: false, result: null, error: 'Comment content is required' };
        }

        const [comment] = await db
          .insert(taskComments)
          .values({
            org_id: orgId,
            task_id: taskId,
            user_id: userId,
            content,
          })
          .returning();

        await db.insert(taskActivity).values({
          org_id: orgId,
          task_id: taskId,
          user_id: userId,
          action: 'commented',
          agent_action_id: actionId,
          acting_agent_employee_id: agentEmployeeId,
        });

        await db
          .update(agentActions)
          .set({
            result: { comment_id: comment!.id, task_id: taskId },
            before_state: null,
            after_state: { comment_id: comment!.id, content },
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        const io = getIO();
        if (io) {
          io.to(`org:${orgId}`).emit('task:updated', {
            id: taskId,
            comment_added: { id: comment!.id, content, user_id: userId },
          });
        }

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'comment_on_task',
          entityType: 'task',
          entityId: taskId,
          beforeState: null,
          afterState: { comment_id: comment!.id },
          metadata: { action_id: actionId },
        });

        return { success: true, result: { comment_id: comment!.id, task_id: taskId } };
      }

      case 'set_due_date': {
        // Task 3.4 — set/clear task due_date.
        const taskId = await resolveTaskIdentifier(params.task_identifier, orgId);
        if (!taskId) return { success: false, result: null, error: 'Task not found' };

        const [existing] = await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.org_id, orgId)))
          .limit(1);
        if (!existing) return { success: false, result: null, error: 'Task not found' };

        const oldDue = existing.due_date;
        let newDue: Date | null = null;
        if (params.due_date) {
          const parsed = new Date(params.due_date);
          if (isNaN(parsed.getTime())) {
            return { success: false, result: null, error: `Invalid due_date: ${params.due_date}` };
          }
          newDue = parsed;
        }

        await db.update(tasks).set({ due_date: newDue }).where(eq(tasks.id, taskId));

        await db.insert(taskActivity).values({
          org_id: orgId,
          task_id: taskId,
          user_id: userId,
          action: 'field_changed',
          field: 'due_date',
          old_value: oldDue ? oldDue.toISOString() : null,
          new_value: newDue ? newDue.toISOString() : null,
          agent_action_id: actionId,
          acting_agent_employee_id: agentEmployeeId,
        });

        await db
          .update(agentActions)
          .set({
            result: { task_id: taskId, due_date: newDue },
            before_state: { due_date: oldDue },
            after_state: { due_date: newDue },
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        const io = getIO();
        if (io) {
          io.to(`org:${orgId}`).emit('task:updated', {
            id: taskId,
            due_date: newDue,
          });
        }

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'set_due_date',
          entityType: 'task',
          entityId: taskId,
          beforeState: { due_date: oldDue },
          afterState: { due_date: newDue },
          metadata: { action_id: actionId },
        });

        return { success: true, result: { task_id: taskId, due_date: newDue } };
      }

      case 'set_priority': {
        // Task 3.4 — change task priority (p0..p3).
        const taskId = await resolveTaskIdentifier(params.task_identifier, orgId);
        if (!taskId) return { success: false, result: null, error: 'Task not found' };

        const priority = params.priority;
        if (!['p0', 'p1', 'p2', 'p3'].includes(priority)) {
          return { success: false, result: null, error: `Invalid priority: ${priority}` };
        }

        const [existing] = await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, taskId), eq(tasks.org_id, orgId)))
          .limit(1);
        if (!existing) return { success: false, result: null, error: 'Task not found' };

        const oldPriority = existing.priority;
        await db.update(tasks).set({ priority }).where(eq(tasks.id, taskId));

        await db.insert(taskActivity).values({
          org_id: orgId,
          task_id: taskId,
          user_id: userId,
          action: 'priority_changed',
          field: 'priority',
          old_value: oldPriority,
          new_value: priority,
          agent_action_id: actionId,
          acting_agent_employee_id: agentEmployeeId,
        });

        await db
          .update(agentActions)
          .set({
            result: { task_id: taskId, priority },
            before_state: { priority: oldPriority },
            after_state: { priority },
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        const io = getIO();
        if (io) {
          io.to(`org:${orgId}`).emit('task:updated', {
            id: taskId,
            priority,
          });
        }

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'set_priority',
          entityType: 'task',
          entityId: taskId,
          beforeState: { priority: oldPriority },
          afterState: { priority },
          metadata: { action_id: actionId },
        });

        return { success: true, result: { task_id: taskId, old_priority: oldPriority, new_priority: priority } };
      }

      case 'add_label': {
        // Task 3.4 — attach a label to a task. Label is resolved by name in
        // this org; if it doesn't exist yet we create it with a default color.
        const taskId = await resolveTaskIdentifier(params.task_identifier, orgId);
        if (!taskId) return { success: false, result: null, error: 'Task not found' };

        const labelName = typeof params.label_name === 'string' ? params.label_name.trim() : '';
        if (!labelName) {
          return { success: false, result: null, error: 'label_name is required' };
        }

        let [label] = await db
          .select()
          .from(labels)
          .where(and(eq(labels.org_id, orgId), ilike(labels.name, labelName)))
          .limit(1);

        if (!label) {
          const color = typeof params.color === 'string' ? params.color : '#94a3b8';
          [label] = await db
            .insert(labels)
            .values({ org_id: orgId, name: labelName, color })
            .returning();
        }

        // task_labels uses composite PK (task_id, label_id); swallow duplicate.
        try {
          await db.insert(taskLabels).values({ task_id: taskId, label_id: label!.id });
        } catch (err: any) {
          if (err?.code !== '23505') throw err;
        }

        await db.insert(taskActivity).values({
          org_id: orgId,
          task_id: taskId,
          user_id: userId,
          action: 'field_changed',
          field: 'label',
          new_value: label!.name,
          agent_action_id: actionId,
          acting_agent_employee_id: agentEmployeeId,
        });

        await db
          .update(agentActions)
          .set({
            result: { task_id: taskId, label_id: label!.id, label_name: label!.name },
            before_state: null,
            after_state: { label_id: label!.id, name: label!.name },
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        const io = getIO();
        if (io) {
          io.to(`org:${orgId}`).emit('task:updated', {
            id: taskId,
            label_added: { id: label!.id, name: label!.name, color: label!.color },
          });
        }

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'add_label',
          entityType: 'task',
          entityId: taskId,
          beforeState: null,
          afterState: { label_id: label!.id, name: label!.name },
          metadata: { action_id: actionId },
        });

        return {
          success: true,
          result: { task_id: taskId, label_id: label!.id, label_name: label!.name },
        };
      }

      case 'add_dependency': {
        // Task 3.6 — add a task_relationships row with cycle guard.
        const sourceId = await resolveTaskIdentifier(params.source_task_identifier, orgId);
        const targetId = await resolveTaskIdentifier(params.target_task_identifier, orgId);
        if (!sourceId) return { success: false, result: null, error: 'Source task not found' };
        if (!targetId) return { success: false, result: null, error: 'Target task not found' };
        if (sourceId === targetId) {
          return { success: false, result: null, error: 'Cannot create dependency to self' };
        }

        const type = params.type;
        if (!['blocks', 'blocked_by', 'relates_to', 'duplicates'].includes(type)) {
          return { success: false, result: null, error: `Invalid type: ${type}` };
        }

        // Normalize blocked_by -> blocks by flipping direction.
        let srcId = sourceId;
        let tgtId = targetId;
        let normalizedType: 'blocks' | 'blocked_by' | 'relates_to' | 'duplicates' = type;
        if (type === 'blocked_by') {
          srcId = targetId;
          tgtId = sourceId;
          normalizedType = 'blocks';
        }

        // Cycle guard applies only to blocks edges (orderings).
        if (normalizedType === 'blocks') {
          const cycle = await detectBlocksCycle(srcId, tgtId, orgId);
          if (cycle) {
            return {
              success: false,
              result: null,
              error: 'Would create a circular dependency (cycle detected)',
            };
          }
        }

        try {
          const [rel] = await db
            .insert(taskRelationships)
            .values({ source_task_id: srcId, target_task_id: tgtId, type: normalizedType })
            .returning();

          await db
            .update(agentActions)
            .set({
              result: { relationship_id: rel!.id, source_task_id: srcId, target_task_id: tgtId, type: normalizedType },
              before_state: null,
              after_state: { id: rel!.id, source_task_id: srcId, target_task_id: tgtId, type: normalizedType },
              executed_at: new Date(),
            })
            .where(eq(agentActions.id, actionId));

          const io = getIO();
          if (io) {
            io.to(`org:${orgId}`).emit('task:updated', {
              id: srcId,
              dependency_added: { target: tgtId, type: normalizedType },
            });
          }

          await logAuditEvent({
            orgId,
            actorType: 'agent',
            actorId: userId,
            action: 'add_dependency',
            entityType: 'task',
            entityId: srcId,
            beforeState: null,
            afterState: { target: tgtId, type: normalizedType },
            metadata: { action_id: actionId },
          });

          return {
            success: true,
            result: { relationship_id: rel!.id, source_task_id: srcId, target_task_id: tgtId, type: normalizedType },
          };
        } catch (err: any) {
          if (err?.code === '23505') {
            return { success: false, result: null, error: 'Dependency already exists' };
          }
          throw err;
        }
      }

      case 'remove_dependency': {
        // Task 3.6 — delete a task_relationships row (no cycle check needed).
        const sourceId = await resolveTaskIdentifier(params.source_task_identifier, orgId);
        const targetId = await resolveTaskIdentifier(params.target_task_identifier, orgId);
        if (!sourceId) return { success: false, result: null, error: 'Source task not found' };
        if (!targetId) return { success: false, result: null, error: 'Target task not found' };

        const type = params.type;
        if (!['blocks', 'blocked_by', 'relates_to', 'duplicates'].includes(type)) {
          return { success: false, result: null, error: `Invalid type: ${type}` };
        }

        let srcId = sourceId;
        let tgtId = targetId;
        let normalizedType: 'blocks' | 'blocked_by' | 'relates_to' | 'duplicates' = type;
        if (type === 'blocked_by') {
          srcId = targetId;
          tgtId = sourceId;
          normalizedType = 'blocks';
        }

        const deleted = await db
          .delete(taskRelationships)
          .where(
            and(
              eq(taskRelationships.source_task_id, srcId),
              eq(taskRelationships.target_task_id, tgtId),
              eq(taskRelationships.type, normalizedType),
            ),
          )
          .returning();

        if (deleted.length === 0) {
          return { success: false, result: null, error: 'Dependency not found' };
        }

        await db
          .update(agentActions)
          .set({
            result: { source_task_id: srcId, target_task_id: tgtId, type: normalizedType, removed: true },
            before_state: { source_task_id: srcId, target_task_id: tgtId, type: normalizedType },
            after_state: null,
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        const io = getIO();
        if (io) {
          io.to(`org:${orgId}`).emit('task:updated', {
            id: srcId,
            dependency_removed: { target: tgtId, type: normalizedType },
          });
        }

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'remove_dependency',
          entityType: 'task',
          entityId: srcId,
          beforeState: { target: tgtId, type: normalizedType },
          afterState: null,
          metadata: { action_id: actionId },
        });

        return {
          success: true,
          result: { source_task_id: srcId, target_task_id: tgtId, type: normalizedType, removed: true },
        };
      }

      case 'create_reminder': {
        // Block 0.5 — insert a reminder row, enqueue a durable scheduled
        // job that fires a notification at remind_at. Handler is idempotent
        // and the Postgres queue persists across restarts.
        const content =
          typeof params.content === 'string' ? params.content.trim() : '';
        const remindAtRaw = params.remind_at;
        if (!content) {
          return { success: false, result: null, error: 'content is required' };
        }
        if (typeof remindAtRaw !== 'string' || !remindAtRaw) {
          return { success: false, result: null, error: 'remind_at is required (ISO datetime)' };
        }
        const remindAt = new Date(remindAtRaw);
        if (isNaN(remindAt.getTime()) || remindAt.getTime() <= Date.now()) {
          return {
            success: false,
            result: null,
            error: 'remind_at must be a valid future ISO datetime',
          };
        }

        const inserted = await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(reminders)
            .values({
              org_id: orgId,
              user_id: userId,
              message: content,
              remind_at: remindAt,
            })
            .returning();

          if (!created) throw new Error('Failed to create reminder');

          await enqueue(
            QUEUE_NAMES.SCHEDULED_JOBS,
            'reminder-fire',
            { reminderId: created.id },
            {
              delay: Math.max(0, remindAt.getTime() - Date.now()),
              orgId,
              dedupeKey: `reminder:${created.id}`,
              executor: tx,
            },
          );

          return created;
        });

        await db
          .update(agentActions)
          .set({
            result: { reminder_id: inserted.id, fire_at: remindAt.toISOString() },
            before_state: null,
            after_state: { reminder_id: inserted.id, content, fire_at: remindAt.toISOString() },
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'create_reminder',
          entityType: 'reminder',
          entityId: inserted.id,
          beforeState: null,
          afterState: { content, fire_at: remindAt.toISOString() },
          metadata: { action_id: actionId },
        });

        return {
          success: true,
          result: {
            reminder_id: inserted.id,
            fire_at: remindAt.toISOString(),
          },
        };
      }

      case 'link_decision_to_tasks': {
        // Block 2.6 — create cross-reference edges decision→task.
        const decisionId = typeof params.decision_id === 'string' ? params.decision_id : '';
        const taskIds = Array.isArray(params.task_ids) ? params.task_ids.filter((x: any) => typeof x === 'string') : [];
        const context = typeof params.context === 'string' ? params.context : null;
        if (!decisionId) return { success: false, result: null, error: 'decision_id is required' };
        if (taskIds.length === 0) return { success: false, result: null, error: 'task_ids must be a non-empty array' };

        const [decision] = await db
          .select({ id: wikiPages.id })
          .from(wikiPages)
          .where(and(
            eq(wikiPages.id, decisionId),
            eq(wikiPages.org_id, orgId),
            eq(wikiPages.type, 'decision'),
            eq(wikiPages.is_deleted, false),
          ))
          .limit(1);
        if (!decision) return { success: false, result: null, error: 'Decision not found' };

        // Filter taskIds to ones that exist in this org
        const { inArray } = await import('drizzle-orm');
        const validTasks = await db
          .select({ id: tasks.id })
          .from(tasks)
          .where(and(inArray(tasks.id, taskIds), eq(tasks.org_id, orgId)));
        const validTaskIdSet = new Set(validTasks.map((t) => t.id));

        const linked: string[] = [];
        for (const taskId of taskIds) {
          if (!validTaskIdSet.has(taskId)) continue;
          // Skip duplicates silently.
          const [existing] = await db
            .select({ id: crossReferences.id })
            .from(crossReferences)
            .where(and(
              eq(crossReferences.org_id, orgId),
              eq(crossReferences.source_type, 'decision'),
              eq(crossReferences.source_id, decisionId),
              eq(crossReferences.target_type, 'task'),
              eq(crossReferences.target_id, taskId),
            ))
            .limit(1);
          if (existing) { linked.push(taskId); continue; }
          await db.insert(crossReferences).values({
            org_id: orgId,
            source_type: 'decision',
            source_id: decisionId,
            target_type: 'task',
            target_id: taskId,
            context,
            created_by: userId,
          });
          linked.push(taskId);
        }

        await db
          .update(agentActions)
          .set({
            result: { decision_id: decisionId, linked_task_ids: linked } as any,
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        return {
          success: true,
          result: {
            decision_id: decisionId,
            linked_task_ids: linked,
            skipped: taskIds.filter((t: string) => !validTaskIdSet.has(t)),
          },
        };
      }

      case 'mark_decision_implemented': {
        // Block 2.6 — flag a wiki decision page as implemented via tag.
        // The legacy `decisions.implemented_at` column was retired with the
        // table drop (2026-05-12); we use the `implemented` tag + updated_at
        // as the durable record.
        const decisionId = typeof params.decision_id === 'string' ? params.decision_id : '';
        if (!decisionId) return { success: false, result: null, error: 'decision_id is required' };

        const [decision] = await db
          .select({ id: wikiPages.id, tags: wikiPages.tags, updated_at: wikiPages.updated_at })
          .from(wikiPages)
          .where(and(
            eq(wikiPages.id, decisionId),
            eq(wikiPages.org_id, orgId),
            eq(wikiPages.type, 'decision'),
            eq(wikiPages.is_deleted, false),
          ))
          .limit(1);
        if (!decision) return { success: false, result: null, error: 'Decision not found' };

        const currentTags: string[] = decision.tags ?? [];
        if (currentTags.includes('implemented')) {
          return {
            success: true,
            result: { decision_id: decisionId, implemented_at: decision.updated_at, already_implemented: true },
          };
        }

        const now = new Date();
        await db
          .update(wikiPages)
          .set({ tags: [...currentTags, 'implemented'], updated_at: now })
          .where(eq(wikiPages.id, decisionId));

        await db
          .update(agentActions)
          .set({
            result: { decision_id: decisionId, implemented_at: now } as any,
            executed_at: now,
          })
          .where(eq(agentActions.id, actionId));

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'mark_decision_implemented',
          entityType: 'decision',
          entityId: decisionId,
          beforeState: null,
          afterState: { implemented_at: now.toISOString() } as any,
          metadata: { action_id: actionId },
        });

        return { success: true, result: { decision_id: decisionId, implemented_at: now } };
      }

      case 'read_canvas': {
        // Block 2.3 — read a space's shared canvas by space_name.
        const spaceName = typeof params.space_name === 'string' ? params.space_name.trim() : '';
        if (!spaceName) return { success: false, result: null, error: 'space_name is required' };

        const [space] = await db
          .select({ id: spaces.id, name: spaces.name })
          .from(spaces)
          .where(and(eq(spaces.org_id, orgId), ilike(spaces.name, spaceName)))
          .limit(1);
        if (!space) return { success: false, result: null, error: `Space "${spaceName}" not found` };

        const [canvas] = await db
          .select({ id: canvases.id, title: canvases.title, content: canvases.content, updated_at: canvases.updated_at })
          .from(canvases)
          .where(eq(canvases.space_id, space.id))
          .limit(1);

        if (!canvas) {
          return { success: true, result: { space: space.name, canvas: null, exists: false } };
        }

        return {
          success: true,
          result: {
            space: space.name,
            canvas: {
              id: canvas.id,
              title: canvas.title,
              content: canvas.content,
              updated_at: canvas.updated_at,
            },
            exists: true,
          },
        };
      }

      case 'write_canvas': {
        // Block 2.3 — upsert the canvas row for a space.
        const spaceName = typeof params.space_name === 'string' ? params.space_name.trim() : '';
        const content = params.content;
        const title = typeof params.title === 'string' ? params.title.trim() : undefined;
        if (!spaceName) return { success: false, result: null, error: 'space_name is required' };
        if (content === undefined || content === null) {
          return { success: false, result: null, error: 'content is required' };
        }

        const [space] = await db
          .select({ id: spaces.id, name: spaces.name })
          .from(spaces)
          .where(and(eq(spaces.org_id, orgId), ilike(spaces.name, spaceName)))
          .limit(1);
        if (!space) return { success: false, result: null, error: `Space "${spaceName}" not found` };

        const jsonContent: any = typeof content === 'string' ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: content }] }] } : content;

        const [existing] = await db
          .select({ id: canvases.id })
          .from(canvases)
          .where(eq(canvases.space_id, space.id))
          .limit(1);

        let resultRow;
        if (existing) {
          const [updated] = await db
            .update(canvases)
            .set({
              content: jsonContent,
              last_edited_by: userId,
              last_edited_at: new Date(),
              ...(title ? { title } : {}),
            })
            .where(eq(canvases.id, existing.id))
            .returning();
          resultRow = updated;
        } else {
          const [inserted] = await db
            .insert(canvases)
            .values({
              org_id: orgId,
              space_id: space.id,
              title: title ?? 'Canvas',
              content: jsonContent,
              last_edited_by: userId,
              last_edited_at: new Date(),
            })
            .returning();
          resultRow = inserted;
        }

        await db
          .update(agentActions)
          .set({
            result: { canvas_id: resultRow!.id, space: space.name } as any,
            after_state: { canvas_id: resultRow!.id, space_id: space.id, title: resultRow!.title } as any,
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'write_canvas',
          entityType: 'canvas',
          entityId: resultRow!.id,
          beforeState: null,
          afterState: { space_id: space.id, title: resultRow!.title } as any,
          metadata: { action_id: actionId, space_name: space.name },
        });

        return { success: true, result: { canvas_id: resultRow!.id, space: space.name, title: resultRow!.title } };
      }

      case 'post_thread_reply': {
        // Block 2.2 — reply to an existing message in its thread.
        const parentId = typeof params.parent_message_id === 'string' ? params.parent_message_id : '';
        const content = typeof params.content === 'string' ? params.content.trim() : '';
        if (!parentId) return { success: false, result: null, error: 'parent_message_id is required' };
        if (!content) return { success: false, result: null, error: 'content is required' };

        const [parent] = await db
          .select({ id: messages.id, space_id: messages.space_id, org_id: messages.org_id })
          .from(messages)
          .where(and(eq(messages.id, parentId), eq(messages.org_id, orgId), eq(messages.is_deleted, false)))
          .limit(1);
        if (!parent) {
          return { success: false, result: null, error: 'Parent message not found in this org' };
        }

        // Phase 6 — reply-storm guard.
        const storm = await checkReplyStorm(userId, parent.id);
        if (storm.tripped) {
          return {
            success: false,
            result: null,
            error: `STORM_DETECTED: agent exceeded ${STORM_THRESHOLD} replies in this thread within the rate-limit window; backing off`,
          };
        }

        const [msg] = await db
          .insert(messages)
          .values({
            org_id: orgId,
            space_id: parent.space_id,
            user_id: userId,
            content,
            parent_id: parent.id,
          })
          .returning();

        await db
          .update(agentActions)
          .set({
            result: { message_id: msg!.id, parent_id: parent.id, space_id: parent.space_id } as any,
            after_state: { message_id: msg!.id, parent_id: parent.id, content } as any,
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        const io = getIO();
        if (io) {
          io.to(`space:${parent.space_id}`).emit('message:new', {
            ...msg,
            user_name: DEFTY_NAME,
            user_avatar: null,
          });
        }

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'post_thread_reply',
          entityType: 'message',
          entityId: msg!.id,
          beforeState: null,
          afterState: { message_id: msg!.id, parent_id: parent.id, space_id: parent.space_id } as any,
          metadata: { action_id: actionId },
        });

        return { success: true, result: { message_id: msg!.id, parent_id: parent.id } };
      }

      case 'search_notes': {
        // Block 2.1 — search across user's own notes + org-visible notes.
        const query = typeof params.query === 'string' ? params.query.trim() : '';
        const scope = ['mine', 'org', 'all'].includes(params.scope) ? params.scope : 'all';
        const limit = Math.min(Math.max(Number(params.limit) || 10, 1), 50);
        if (!query) {
          return { success: false, result: null, error: 'query is required' };
        }
        const pattern = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
        const scopeClause =
          scope === 'mine'
            ? eq(notes.user_id, userId)
            : scope === 'org'
              ? eq(notes.visibility, 'org')
              : sql`(${notes.user_id} = ${userId} OR ${notes.visibility} = 'org')`;
        const rows = await db
          .select({
            id: notes.id,
            title: notes.title,
            visibility: notes.visibility,
            updated_at: notes.updated_at,
            snippet: sql<string>`substring(coalesce(${notes.content}, '') from 1 for 240)`,
          })
          .from(notes)
          .where(
            and(
              eq(notes.org_id, orgId),
              eq(notes.is_deleted, false),
              scopeClause,
              sql`(${notes.title} ILIKE ${pattern} OR coalesce(${notes.content}, '') ILIKE ${pattern})`,
            ),
          )
          .orderBy(desc(notes.updated_at))
          .limit(limit);
        return { success: true, result: { notes: rows, count: rows.length } };
      }

      case 'read_note': {
        const noteId = typeof params.note_id === 'string' ? params.note_id : '';
        if (!noteId) return { success: false, result: null, error: 'note_id is required' };
        const [row] = await db
          .select()
          .from(notes)
          .where(
            and(
              eq(notes.id, noteId),
              eq(notes.org_id, orgId),
              eq(notes.is_deleted, false),
              sql`(${notes.user_id} = ${userId} OR ${notes.visibility} = 'org')`,
            ),
          )
          .limit(1);
        if (!row) {
          return { success: false, result: null, error: 'Note not found or not visible to caller' };
        }
        return {
          success: true,
          result: {
            id: row.id,
            title: row.title,
            content: row.content ?? '',
            visibility: row.visibility,
            updated_at: row.updated_at,
          },
        };
      }

      case 'create_note': {
        const title = typeof params.title === 'string' ? params.title.trim() : '';
        const content = typeof params.content === 'string' ? params.content : '';
        const visibility = ['private', 'org', 'space'].includes(params.visibility)
          ? params.visibility
          : 'private';
        const spaceId =
          typeof params.visibility_space_id === 'string' ? params.visibility_space_id : null;
        if (!title) {
          return { success: false, result: null, error: 'title is required' };
        }
        if (visibility === 'space' && !spaceId) {
          return { success: false, result: null, error: 'visibility_space_id is required when visibility=space' };
        }

        const [inserted] = await db
          .insert(notes)
          .values({
            org_id: orgId,
            user_id: userId,
            title,
            content,
            visibility,
            visibility_space_id: visibility === 'space' ? spaceId : null,
          })
          .returning();

        await db
          .update(agentActions)
          .set({
            result: { note_id: inserted!.id, title: inserted!.title } as any,
            after_state: { note_id: inserted!.id, title, visibility } as any,
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'create_note',
          entityType: 'note',
          entityId: inserted!.id,
          beforeState: null,
          afterState: { title, visibility } as any,
          metadata: { action_id: actionId },
        });

        return { success: true, result: { note_id: inserted!.id, title: inserted!.title } };
      }

      case 'note_to_wiki': {
        const noteId = typeof params.note_id === 'string' ? params.note_id : '';
        const pageType = ['concept', 'entity', 'decision', 'resource', 'procedure', 'preference', 'fact'].includes(
          params.type,
        )
          ? params.type
          : 'fact';
        if (!noteId) return { success: false, result: null, error: 'note_id is required' };

        const [note] = await db
          .select()
          .from(notes)
          .where(
            and(
              eq(notes.id, noteId),
              eq(notes.org_id, orgId),
              eq(notes.is_deleted, false),
              sql`(${notes.user_id} = ${userId} OR ${notes.visibility} = 'org')`,
            ),
          )
          .limit(1);
        if (!note) {
          return { success: false, result: null, error: 'Note not found or not visible to caller' };
        }

        // Build a unique slug from the title.
        const baseSlug = note.title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'untitled-note';
        let slug = baseSlug;
        let suffix = 1;
        // Collision loop (bounded)
        while (suffix < 50) {
          const [collision] = await db
            .select({ id: wikiPages.id })
            .from(wikiPages)
            .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.slug, slug)))
            .limit(1);
          if (!collision) break;
          suffix += 1;
          slug = `${baseSlug}-${suffix}`;
        }

        const [page] = await db
          .insert(wikiPages)
          .values({
            org_id: orgId,
            scope: 'org',
            user_id: userId,
            type: pageType as any,
            title: note.title,
            slug,
            content: note.content ?? '',
            confidence: 0.8,
          })
          .returning();

        await db
          .update(agentActions)
          .set({
            result: { wiki_page_id: page!.id, slug: page!.slug } as any,
            after_state: { wiki_page_id: page!.id, source_note_id: noteId } as any,
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'note_to_wiki',
          entityType: 'wiki_page',
          entityId: page!.id,
          beforeState: null,
          afterState: { title: note.title, slug, source_note_id: noteId } as any,
          metadata: { action_id: actionId },
        });

        return { success: true, result: { wiki_page_id: page!.id, slug: page!.slug, title: page!.title } };
      }

      default:
        return { success: false, result: null, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    const partialBulkResult = err instanceof ModuleRecordBulkCreateError ? err.progress : null;
    if (isModuleWriteAction(action)) {
      await terminalizeModuleActionFailure({
        actionId,
        action,
        actionParams: params,
        orgId,
        userId,
        ...(agentEmployeeId ? { agentEmployeeId } : {}),
        error: msg,
      });
    } else if (isModuleTaskLinkWriteAction(action)) {
      await terminalizeModuleTaskLinkActionFailure(
        actionId,
        action,
        params,
        orgId,
        userId,
        agentEmployeeId ?? undefined,
        msg,
      );
    } else {
      await db.update(agentActions).set({ error: msg }).where(eq(agentActions.id, actionId));
    }
    return { success: false, result: partialBulkResult, error: msg };
  }
}

/**
 * Create an action record and execute it immediately (for auto-approved actions).
 * Unlike executeAction(), this creates the agentActions row as already approved.
 */
type ExecuteActionDirectOptions = {
  agentEmployeeId?: string;
  source?: string;
  mcpConnectionId?: string;
  planId?: string;
  planStepId?: string;
  messageId?: string;
  toolUseId?: string;
};

type ExecuteActionDirectResult = {
  actionId: string;
  success: boolean;
  result: any;
  error?: string;
  requiresApproval?: boolean;
  approvalTier?: 'auto' | 'quick' | 'full';
};

export async function executeActionDirect(
  action: string,
  params: Record<string, any>,
  orgId: string,
  userId: string,
  conversationId: string | null,
  approvalTier: 'auto' | 'quick' | 'full',
  options?: ExecuteActionDirectOptions,
): Promise<ExecuteActionDirectResult> {
  if (isModuleTaskLinkWriteAction(action)) {
    params = normalizeAgentModuleTaskLinkParams(action, params) as Record<string, any>;
  }
  if (
    (isModuleWriteAction(action) || isModuleTaskLinkWriteAction(action))
    && typeof params.idempotency_key === 'string'
  ) {
    const actor = agentModuleDigestActor(orgId, userId, options?.agentEmployeeId);
    const lockDigest = moduleIdempotencyDigest(actor, params.idempotency_key);
    return withDbAdvisoryLock(
      agentModuleExecutionLockKey(orgId, action, lockDigest),
      () => executeActionDirectLocked(
        action,
        params,
        orgId,
        userId,
        conversationId,
        approvalTier,
        options,
      ),
    );
  }
  return executeActionDirectLocked(
    action,
    params,
    orgId,
    userId,
    conversationId,
    approvalTier,
    options,
  );
}

async function executeActionDirectLocked(
  action: string,
  params: Record<string, any>,
  orgId: string,
  userId: string,
  conversationId: string | null,
  approvalTier: 'auto' | 'quick' | 'full',
  options?: ExecuteActionDirectOptions,
): Promise<ExecuteActionDirectResult> {
  // This is the common safety net for every direct execution path (streaming,
  // background runner, plans, and MCP). Invalid/disabled module writes must not
  // create even a pending agent_actions row containing record values.
  params = normalizeAgentModuleActionParams(action, params) as Record<string, any>;
  params = normalizeAgentModuleBulkCreateParams(action, params) as Record<string, any>;
  params = normalizeAgentModuleTaskLinkParams(action, params) as Record<string, any>;

  const taskScopeError = await employeeTaskWriteScopeError(
    action,
    params,
    orgId,
    options?.agentEmployeeId ?? null,
  );
  if (taskScopeError) throw new Error(taskScopeError);

  let effectiveApprovalTier = approvalTier;
  let effectiveMcpConnectionId = options?.mcpConnectionId;
  let requiresFreshApproval = false;
  let executionBlockedError: string | null = null;

  // Re-resolve outbound MCP policy immediately before an auto/direct write.
  // Discovery can precede execution by an entire model turn (or by a saved
  // plan), so a connection owner may have raised the tier in the meantime.
  // In that race, persist a pending action at the stricter current tier and
  // do not execute it under the stale, weaker decision.
  if (action.startsWith('mcp__')) {
    const currentTool = (await getMCPToolsForAgent(orgId, options?.agentEmployeeId))
      .find((tool) => tool.name === action);
    if (!currentTool) {
      effectiveApprovalTier = 'full';
      executionBlockedError = `MCP tool '${action}' is unavailable, disabled, or could not be classified safely`;
    } else {
      const tierRank = { auto: 0, quick: 1, full: 2 } as const;
      effectiveMcpConnectionId = currentTool.connectionId;
      if (tierRank[currentTool.approvalTierMapped] > tierRank[approvalTier]) {
        effectiveApprovalTier = currentTool.approvalTierMapped;
        requiresFreshApproval = true;
      }
    }
  }

  if (options?.agentEmployeeId && options.source !== 'plan') {
    const employeePolicy = await getActiveAgentToolPolicy(orgId, options.agentEmployeeId);
    if (
      !employeePolicy
      || !shouldAutoExecute(action, employeePolicy.trustLevel, params, effectiveApprovalTier)
    ) {
      effectiveApprovalTier = employeePolicy ? effectiveApprovalTier : 'full';
      requiresFreshApproval = true;
    }
  }

  const actionValues = {
    org_id: orgId,
    user_id: userId,
    conversation_id: conversationId,
    action,
    params,
    approval_tier: effectiveApprovalTier,
    approval_status: requiresFreshApproval ? 'pending' as const : 'approved' as const,
    approved_at: requiresFreshApproval ? null : new Date(),
    ...(options?.agentEmployeeId ? { agent_employee_id: options.agentEmployeeId } : {}),
    ...(options?.source ? { source: options.source } : {}),
    ...(effectiveMcpConnectionId ? { mcp_connection_id: effectiveMcpConnectionId } : {}),
    ...(options?.planId ? { plan_id: options.planId } : {}),
    ...(options?.planStepId ? { plan_step_id: options.planStepId } : {}),
    ...(options?.messageId ? { message_id: options.messageId } : {}),
    ...(options?.toolUseId ? { tool_use_id: options.toolUseId } : {}),
  };

  let actionRecord: typeof agentActions.$inferSelect;
  let reusedModuleAction = false;
  let reusedModuleTaskLinkAction = false;
  if (isModuleWriteAction(action)) {
    const claimed = await claimModuleAgentAction({
      action,
      input: params,
      orgId,
      userId,
      ...(options?.agentEmployeeId ? { agentEmployeeId: options.agentEmployeeId } : {}),
      values: actionValues,
    });
    actionRecord = claimed.action;
    reusedModuleAction = claimed.reused;
  } else if (isModuleTaskLinkWriteAction(action)) {
    const claimed = await claimModuleTaskLinkAgentAction({
      action,
      input: params,
      orgId,
      userId,
      ...(options?.agentEmployeeId ? { agentEmployeeId: options.agentEmployeeId } : {}),
      values: actionValues,
    });
    actionRecord = claimed.action;
    reusedModuleTaskLinkAction = claimed.reused;
  } else {
    const [inserted] = await db.insert(agentActions).values(actionValues).returning();
    if (!inserted) throw new Error('Failed to create action log');
    actionRecord = inserted;
  }

  if (isModuleWriteAction(action) && actionRecord.approval_status === 'pending') {
    const error = reusedModuleAction
      ? actionRecord.error ?? 'Action already requires human approval'
      : `Approval policy changed to '${actionRecord.approval_tier}'; action queued for fresh review`;
    if (!reusedModuleAction) {
      await db
        .update(agentActions)
        .set({ error })
        .where(and(eq(agentActions.id, actionRecord.id), eq(agentActions.org_id, orgId)));
      try {
        const { syncApprovalToAttention } = await import('./attention.js');
        await syncApprovalToAttention(actionRecord);
      } catch (syncError) {
        console.warn('[agent-actions] Failed to surface re-gated module action in attention inbox', {
          actionId: actionRecord.id,
          error: syncError instanceof Error ? syncError.message : String(syncError),
        });
      }
    }
    return {
      actionId: actionRecord.id,
      success: false,
      result: null,
      error,
      requiresApproval: true,
      approvalTier: actionRecord.approval_tier,
    };
  }
  if (isModuleTaskLinkWriteAction(action) && actionRecord.approval_status === 'pending') {
    const error = reusedModuleTaskLinkAction
      ? actionRecord.error ?? 'Action already requires human approval'
      : `Approval policy changed to '${actionRecord.approval_tier}'; action queued for fresh review`;
    if (!reusedModuleTaskLinkAction) {
      await db
        .update(agentActions)
        .set({ error })
        .where(and(eq(agentActions.id, actionRecord.id), eq(agentActions.org_id, orgId)));
      try {
        const { syncApprovalToAttention } = await import('./attention.js');
        await syncApprovalToAttention(actionRecord);
      } catch (syncError) {
        console.warn('[agent-actions] Failed to surface re-gated module task-link action', {
          actionId: actionRecord.id,
          error: syncError instanceof Error ? syncError.message : String(syncError),
        });
      }
    }
    return {
      actionId: actionRecord.id,
      success: false,
      result: null,
      error,
      requiresApproval: true,
      approvalTier: actionRecord.approval_tier,
    };
  }
  if (reusedModuleAction && actionRecord.approval_status === 'approved') {
    requiresFreshApproval = false;
    effectiveApprovalTier = actionRecord.approval_tier;
    const receiptDecision = actionRecord.approved_by_user_id ? 'approved' : 'auto_executed';
    if (actionRecord.executed_at) {
      const storedMutation = ModuleMutationResultSchema.safeParse(actionRecord.result);
      const replayResult = storedMutation.success
        ? { ...storedMutation.data, replayed: true }
        : actionRecord.result;
      await generateReceipt({
        actionId: actionRecord.id,
        orgId,
        employeeId: options?.agentEmployeeId ?? null,
        proposer: options?.agentEmployeeId ? 'employee' : 'defty',
        proposerId: options?.agentEmployeeId ?? userId,
        approverId: actionRecord.approved_by_user_id ?? null,
        decision: receiptDecision,
        actionName: action,
        actionParams: sanitizeModuleActionParamsForHistory(action, params),
        resultJson: actionRecord.error ? null : actionRecord.result,
        ...(actionRecord.error
          ? { decisionReason: `execution failed: ${actionRecord.error}`.slice(0, 2_000) }
          : {}),
      });
      return {
        actionId: actionRecord.id,
        success: !actionRecord.error,
        result: replayResult,
        ...(actionRecord.error ? { error: actionRecord.error } : {}),
      };
    }


    const committed = await recoverModuleMutationByAgentActionId(orgId, actionRecord.id);
    if (committed) {
      const terminalParams = {
        ...sanitizeModuleActionParamsForHistory(action, params),
        idempotency_digest: committed.idempotencyDigest,
        input_digest: committed.inputDigest,
      };
      const [recoveredAction] = await db
        .update(agentActions)
        .set({
          result: committed.mutation,
          after_state: committed.mutation,
          error: null,
          params: terminalParams,
          executed_at: new Date(),
        })
        .where(and(
          eq(agentActions.id, actionRecord.id),
          eq(agentActions.org_id, orgId),
          eq(agentActions.approval_status, 'approved'),
          sql`${agentActions.executed_at} IS NULL`,
        ))
        .returning();
      const terminalAction = recoveredAction ?? actionRecord;
      await generateReceipt({
        actionId: actionRecord.id,
        orgId,
        employeeId: options?.agentEmployeeId ?? null,
        proposer: options?.agentEmployeeId ? 'employee' : 'defty',
        proposerId: options?.agentEmployeeId ?? userId,
        approverId: terminalAction.approved_by_user_id ?? null,
        decision: terminalAction.approved_by_user_id ? 'approved' : 'auto_executed',
        actionName: action,
        actionParams: terminalParams,
        resultJson: committed.mutation,
      });
      return {
        actionId: actionRecord.id,
        success: true,
        result: committed.mutation,
      };
    }
  }
  if (reusedModuleTaskLinkAction && actionRecord.approval_status === 'approved') {
    requiresFreshApproval = false;
    effectiveApprovalTier = actionRecord.approval_tier;
    if (actionRecord.executed_at) {
      const receiptDecision = actionRecord.approved_by_user_id ? 'approved' : 'auto_executed';
      await generateReceipt({
        actionId: actionRecord.id,
        orgId,
        employeeId: options?.agentEmployeeId ?? null,
        proposer: options?.agentEmployeeId ? 'employee' : 'defty',
        proposerId: options?.agentEmployeeId ?? userId,
        approverId: actionRecord.approved_by_user_id ?? null,
        decision: receiptDecision,
        actionName: action,
        actionParams: sanitizeModuleTaskLinkActionParamsForHistory(actionRecord.params),
        resultJson: actionRecord.error ? null : actionRecord.result,
        ...(actionRecord.error
          ? { decisionReason: `execution failed: ${actionRecord.error}`.slice(0, 2_000) }
          : {}),
      });
      return {
        actionId: actionRecord.id,
        success: !actionRecord.error,
        result: actionRecord.result,
        ...(actionRecord.error ? { error: actionRecord.error } : {}),
      };
    }
  }

  if (executionBlockedError) {
    await db.update(agentActions).set({ error: executionBlockedError }).where(eq(agentActions.id, actionRecord.id));
    return { actionId: actionRecord.id, success: false, result: null, error: executionBlockedError };
  }

  if (requiresFreshApproval) {
    const error = `Approval policy changed to '${effectiveApprovalTier}'; action queued for fresh review`;
    await db.update(agentActions).set({ error }).where(eq(agentActions.id, actionRecord.id));
    try {
      const { syncApprovalToAttention } = await import('./attention.js');
      await syncApprovalToAttention(actionRecord);
    } catch (syncError) {
      console.warn('[agent-actions] Failed to surface re-gated action in attention inbox', {
        actionId: actionRecord.id,
        error: syncError instanceof Error ? syncError.message : String(syncError),
      });
    }
    return {
      actionId: actionRecord.id,
      success: false,
      result: null,
      error,
      requiresApproval: true,
      approvalTier: effectiveApprovalTier,
    };
  }

  const result = await executeAction(actionRecord.id, action, params, orgId, userId, {
    agentEmployeeId: options?.agentEmployeeId,
  });

  if (isModuleWriteAction(action)) {
    const [terminalAction] = await db
      .select({
        approval_status: agentActions.approval_status,
        approved_by_user_id: agentActions.approved_by_user_id,
        error: agentActions.error,
      })
      .from(agentActions)
      .where(and(eq(agentActions.id, actionRecord.id), eq(agentActions.org_id, orgId)))
      .limit(1);
    if (!terminalAction || terminalAction.approval_status !== 'approved') {
      return {
        actionId: actionRecord.id,
        success: false,
        result: null,
        error: terminalAction?.error ?? 'Module action was terminalized before execution completed',
      };
    }
    const reviewedBy = terminalAction.approved_by_user_id ?? null;
    await generateReceipt({
      actionId: actionRecord.id,
      orgId,
      employeeId: options?.agentEmployeeId ?? null,
      proposer: options?.agentEmployeeId ? 'employee' : 'defty',
      proposerId: options?.agentEmployeeId ?? userId,
      approverId: reviewedBy,
      decision: reviewedBy ? 'approved' : 'auto_executed',
      decisionReason: result.success ? null : `execution failed: ${result.error ?? 'unknown'}`.slice(0, 2_000),
      actionName: action,
      actionParams: sanitizeModuleActionParamsForHistory(action, params),
      resultJson: result.success ? result.result : null,
    });
  }
  if (isModuleTaskLinkWriteAction(action)) {
    const [terminalAction] = await db
      .select({
        approval_status: agentActions.approval_status,
        approved_by_user_id: agentActions.approved_by_user_id,
        params: agentActions.params,
        error: agentActions.error,
      })
      .from(agentActions)
      .where(and(eq(agentActions.id, actionRecord.id), eq(agentActions.org_id, orgId)))
      .limit(1);
    if (!terminalAction || terminalAction.approval_status !== 'approved') {
      return {
        actionId: actionRecord.id,
        success: false,
        result: null,
        error: terminalAction?.error ?? 'Module task-link action was terminalized before execution completed',
      };
    }
    const reviewedBy = terminalAction.approved_by_user_id ?? null;
    await generateReceipt({
      actionId: actionRecord.id,
      orgId,
      employeeId: options?.agentEmployeeId ?? null,
      proposer: options?.agentEmployeeId ? 'employee' : 'defty',
      proposerId: options?.agentEmployeeId ?? userId,
      approverId: reviewedBy,
      decision: reviewedBy ? 'approved' : 'auto_executed',
      decisionReason: result.success ? null : `execution failed: ${result.error ?? 'unknown'}`.slice(0, 2_000),
      actionName: action,
      actionParams: sanitizeModuleTaskLinkActionParamsForHistory(terminalAction.params),
      resultJson: result.success ? result.result : null,
    });
  }

  return { actionId: actionRecord.id, ...result };
}
