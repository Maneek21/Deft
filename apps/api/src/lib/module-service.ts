import { createHash } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import {
  auditLog,
  agentActions,
  agentEmployees,
  moduleInstallations,
  moduleMutationReceipts,
  moduleRecords,
  moduleVersions,
} from '@deft/db/schema';
import {
  ModuleActorSchema,
  ModuleMutationResultSchema,
  ModuleRecordValidationError,
  digestModuleManifest,
  formatModuleRecordResourceId,
  parseDeftModuleManifest,
  parseModuleRecordData,
  projectModuleRecordSearch,
  validateModuleFieldValue,
  type DeftModuleManifestV1,
  type ModuleActor,
  type ModuleRecord,
  type ModuleRecordArchiveRequest,
  type ModuleRecordCreateRequest,
  type ModuleRecordData,
  type ModuleRecordSearchRequest,
  type ModuleRecordQueryRequest,
  type ModuleRecordUpdateRequest,
  type ModuleSearchHit,
  type ModuleSummary,
  type ModuleField,
  type ModuleMutationResult,
  type ModuleOperationName,
} from '@deft/shared/modules';
import { db } from './db.js';
import { getIO } from '../socket.js';
import { getBundledModule, listBundledModules } from './bundled-modules.js';
import { ModuleError } from './module-errors.js';
import { isAgentToolDisabled } from './agent-tool-policy.js';
import {
  markWorkIntentConvertedForAction,
  markWorkIntentsExpiredForActions,
} from './work-intents.js';

type AccessMode = 'read' | 'write';
type ModuleMutationOperation = 'create' | 'update' | 'archive';
export type ModuleMutationActionName =
  | 'module_record_create'
  | 'module_record_update'
  | 'module_record_archive';
export type ModuleDbExecutor = Pick<typeof db, 'select' | 'insert' | 'update' | 'execute'>;
type DbExecutor = ModuleDbExecutor;

type InstallationRow = typeof moduleInstallations.$inferSelect;
type VersionRow = typeof moduleVersions.$inferSelect;
type RecordRow = typeof moduleRecords.$inferSelect;

type InstallationVersionRow = {
  installation: InstallationRow;
  version: VersionRow;
};

export type ModuleInstallationView = {
  id: string;
  slug: string;
  module_id: string;
  source: string;
  enabled: boolean;
  agent_access: 'none' | 'read' | 'write';
  active_version_id: string;
  manifest_digest: string;
  manifest: DeftModuleManifestV1;
  created_at: string;
  updated_at: string;
};

export type BundledModuleView = {
  slug: string;
  module_id: string;
  name: string;
  description?: string;
  icon?: string;
  version: string;
  installed: boolean;
};

export type ModuleRecordPage = {
  records: ModuleRecord[];
  next_cursor: string | null;
};

function validatedActor(value: ModuleActor): ModuleActor {
  return ModuleActorSchema.parse(value);
}

function actorMetadata(actor: ModuleActor): { type: string; id: string } {
  return { type: actor.kind, id: actor.actor_id };
}

function isAdmin(actor: ModuleActor): boolean {
  return actor.kind === 'human' && (actor.role === 'owner' || actor.role === 'admin');
}

function assertBaseReadAccess(actor: ModuleActor): void {
  if ((actor.kind === 'human' || actor.kind === 'defty') && actor.role === 'guest') {
    throw new ModuleError('Guests cannot access workspace modules', 'MODULE_ACCESS_DENIED', 403);
  }
  if (
    actor.kind === 'human'
    && actor.source === 'mcp'
    && !actor.scopes.includes('read:modules')
  ) {
    throw new ModuleError('Missing MCP scope: read:modules', 'MODULE_SCOPE_REQUIRED', 403);
  }
}

function assertBaseWriteAccess(actor: ModuleActor): void {
  if ((actor.kind === 'human' || actor.kind === 'defty') && actor.role === 'guest') {
    throw new ModuleError('Guests cannot access workspace modules', 'MODULE_ACCESS_DENIED', 403);
  }
  if (
    actor.kind === 'human'
    && actor.source === 'mcp'
    && !actor.scopes.includes('write:modules')
  ) {
    throw new ModuleError('Missing MCP scope: write:modules', 'MODULE_SCOPE_REQUIRED', 403);
  }
}

function assertInstallationAccess(
  actor: ModuleActor,
  installation: InstallationRow,
  mode: AccessMode,
  options?: { allowDisabledForAdmin?: boolean },
): void {
  if (mode === 'write') assertBaseWriteAccess(actor);
  else assertBaseReadAccess(actor);

  if (!installation.is_enabled) {
    if (!(options?.allowDisabledForAdmin && isAdmin(actor))) {
      throw new ModuleError('Module is disabled', 'MODULE_DISABLED', 409);
    }
  }

  if (actor.kind === 'defty' || actor.kind === 'agent_employee') {
    if (installation.agent_access === 'none') {
      throw new ModuleError('Agent access is not enabled for this module', 'MODULE_ACCESS_DENIED', 403);
    }
    if (mode === 'write' && installation.agent_access !== 'write') {
      throw new ModuleError('Agent write access is not enabled for this module', 'MODULE_ACCESS_DENIED', 403);
    }
  }
}

function assertLifecycleAccess(actor: ModuleActor): void {
  assertBaseWriteAccess(actor);
  if (!isAdmin(actor)) {
    throw new ModuleError('Only workspace owners and admins can manage modules', 'MODULE_ACCESS_DENIED', 403);
  }
}

/**
 * Revalidate an employee actor under a row lock in the mutation transaction.
 * Adapter checks are intentionally insufficient here: an admin can pause,
 * delete, mark unhealthy, or disable a tool after adapter preflight but before
 * ModuleService reaches its write. Holding this row through commit gives that
 * policy change and the mutation a single, deterministic order.
 */
export async function assertAgentModuleMutationPolicyWithExecutor(
  executor: DbExecutor,
  actor: ModuleActor,
  operation: ModuleMutationActionName,
): Promise<{ trustLevel: 'conservative' | 'standard' | 'autonomous' } | null> {
  if (actor.kind !== 'agent_employee') return null;

  const [employee] = await executor
    .select({
      id: agentEmployees.id,
      org_id: agentEmployees.org_id,
      trust_level: agentEmployees.trust_level,
      disabled_tools: agentEmployees.disabled_tools,
      unhealthy: agentEmployees.unhealthy,
      unhealthy_reason: agentEmployees.unhealthy_reason,
      is_active: agentEmployees.is_active,
      is_deleted: agentEmployees.is_deleted,
      runtime_kind: agentEmployees.runtime_kind,
    })
    .from(agentEmployees)
    .where(eq(agentEmployees.id, actor.actor_id))
    .limit(1)
    .for('update');

  const operational = employee
    && employee.org_id === actor.org_id
    && employee.is_active
    && (!employee.is_deleted || employee.runtime_kind === 'defty_system');
  if (!operational) {
    throw new ModuleError(
      'Agent employee is inactive, deleted, or outside this organization',
      'MODULE_ACCESS_DENIED',
      403,
    );
  }
  if (employee.unhealthy) {
    throw new ModuleError(
      `Agent employee is unhealthy and cannot execute module writes${employee.unhealthy_reason ? `: ${employee.unhealthy_reason}` : ''}`,
      'MODULE_ACCESS_DENIED',
      403,
    );
  }

  if (isAgentToolDisabled(employee.disabled_tools, operation)) {
    throw new ModuleError(
      `Tool '${operation}' is disabled for this agent employee`,
      'MODULE_ACCESS_DENIED',
      403,
    );
  }
  return { trustLevel: employee.trust_level as 'conservative' | 'standard' | 'autonomous' };
}

function installationJoinCondition() {
  return and(
    eq(moduleVersions.org_id, moduleInstallations.org_id),
    eq(moduleVersions.installation_id, moduleInstallations.id),
    eq(moduleVersions.is_active, true),
  );
}

async function verifyManifest(version: VersionRow): Promise<DeftModuleManifestV1> {
  const manifest = parseDeftModuleManifest(version.manifest);
  const computed = await digestModuleManifest(manifest);
  if (computed !== version.manifest_digest) {
    throw new Error(`Module manifest digest mismatch for version ${version.id}`);
  }
  return manifest;
}

async function findInstallation(
  executor: DbExecutor,
  actor: ModuleActor,
  identifier: { slug?: string; moduleId?: string; installationId?: string },
  mode: AccessMode,
  options?: { allowDisabledForAdmin?: boolean; lock?: boolean },
): Promise<InstallationVersionRow> {
  const identityConditions: SQL[] = [];
  if (identifier.slug) identityConditions.push(eq(moduleInstallations.slug, identifier.slug));
  if (identifier.moduleId) identityConditions.push(eq(moduleInstallations.module_id, identifier.moduleId));
  if (identifier.installationId) identityConditions.push(eq(moduleInstallations.id, identifier.installationId));
  if (identityConditions.length !== 1) throw new Error('Exactly one module identifier is required');

  let query = executor
    .select({ installation: moduleInstallations, version: moduleVersions })
    .from(moduleInstallations)
    .innerJoin(moduleVersions, installationJoinCondition())
    .where(and(
      eq(moduleInstallations.org_id, actor.org_id),
      eq(moduleInstallations.is_deleted, false),
      identityConditions[0],
    ))
    .limit(1);

  if (options?.lock && 'for' in query) {
    query = (query as typeof query & { for: (strength: 'update') => typeof query }).for('update');
  }
  const [row] = await query;
  if (!row) throw new ModuleError('Module not found', 'MODULE_NOT_FOUND', 404);
  assertInstallationAccess(actor, row.installation, mode, options);
  await verifyManifest(row.version);
  return row;
}

function toIso(value: Date): string {
  return value.toISOString();
}

function toInstallationView(
  row: InstallationVersionRow,
  manifest: DeftModuleManifestV1,
): ModuleInstallationView {
  return {
    id: row.installation.id,
    slug: row.installation.slug,
    module_id: row.installation.module_id,
    source: row.installation.source,
    enabled: row.installation.is_enabled,
    agent_access: row.installation.agent_access,
    active_version_id: row.version.id,
    manifest_digest: row.version.manifest_digest,
    manifest,
    created_at: toIso(row.installation.created_at),
    updated_at: toIso(row.installation.updated_at),
  };
}

function recordDigest(data: ModuleRecordData): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(stableValue(data))).digest('hex')}`;
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

export function moduleMutationInputDigest(
  operation: ModuleMutationOperation,
  value: Record<string, unknown>,
): string {
  const { idempotency_key: _idempotencyKey, ...withoutKey } = value;
  const canonical = operation === 'update'
    ? {
      ...withoutKey,
      patch: withoutKey.patch ?? {},
      unset_fields: withoutKey.unset_fields ?? [],
    }
    : withoutKey;
  return `sha256:${createHash('sha256').update(JSON.stringify(stableValue(canonical))).digest('hex')}`;
}

export function moduleIdempotencyDigest(actorValue: ModuleActor, rawKey: string): string {
  const actor = validatedActor(actorValue);
  return `sha256:${createHash('sha256')
    .update(`${actor.org_id}\u0000${actor.kind}\u0000${actor.actor_id}\u0000${rawKey}`)
    .digest('hex')}`;
}

function toRecord(
  row: RecordRow,
  installation: InstallationRow,
  version: VersionRow,
): ModuleRecord {
  return {
    resource_id: formatModuleRecordResourceId(row.id),
    id: row.id,
    installation_id: installation.id,
    module_id: installation.module_id,
    collection_key: row.collection_key,
    manifest_digest: version.manifest_digest,
    data: row.data as ModuleRecordData,
    revision: row.revision,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    archived_at: row.deleted_at ? toIso(row.deleted_at) : null,
  };
}

export function toModuleMutationResult(
  record: ModuleRecord,
  options: { replayed: boolean; changedFields: string[] },
): ModuleMutationResult {
  return {
    resource_id: record.resource_id,
    record_id: record.id,
    installation_id: record.installation_id,
    module_id: record.module_id,
    collection_key: record.collection_key,
    manifest_digest: record.manifest_digest,
    revision: record.revision,
    archived: record.archived_at !== null,
    changed_fields: [...new Set(options.changedFields)].sort(),
    replayed: options.replayed,
  };
}

async function insertAudit(
  executor: DbExecutor,
  actor: ModuleActor,
  values: {
    action: string;
    entityType: 'module_installation' | 'module_record';
    entityId: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const identity = actorMetadata(actor);
  const actorProvenance = {
    source: actor.source,
    ...('action_id' in actor && actor.action_id ? { action_id: actor.action_id } : {}),
    ...('conversation_id' in actor && actor.conversation_id
      ? { conversation_id: actor.conversation_id }
      : {}),
  };
  await executor.insert(auditLog).values({
    org_id: actor.org_id,
    actor_type: identity.type,
    actor_id: identity.id,
    action: values.action,
    entity_type: values.entityType,
    entity_id: values.entityId,
    before_state: values.before ?? null,
    after_state: values.after ?? null,
    metadata: { ...actorProvenance, ...(values.metadata ?? {}) },
  });
}

function emitModuleChange(orgId: string, payload: Record<string, unknown>): void {
  getIO()?.to(`org-members:${orgId}`).emit('module:changed', payload);
}

function emitRecordChange(orgId: string, payload: Record<string, unknown>): void {
  getIO()?.to(`org-members:${orgId}`).emit('module:record:changed', payload);
}

async function invalidateModuleCatalogCaches(orgId: string): Promise<void> {
  try {
    const employees = await db
      .select({ id: agentEmployees.id })
      .from(agentEmployees)
      .where(and(
        eq(agentEmployees.org_id, orgId),
        eq(agentEmployees.is_deleted, false),
      ));
    const { invalidatePlatformContextCacheFor } = await import('./mcp-tools/context.js');
    for (const employee of employees) invalidatePlatformContextCacheFor(employee.id);
  } catch (error) {
    console.warn('[modules] failed to invalidate agent catalog caches:', error);
  }
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown };
    if (!Number.isInteger(parsed.offset) || Number(parsed.offset) < 0 || Number(parsed.offset) > 1_000_000) {
      throw new Error('invalid offset');
    }
    return Number(parsed.offset);
  } catch {
    throw new ModuleError('Invalid module cursor', 'MODULE_VALIDATION_ERROR', 400);
  }
}

function validationError(error: ModuleRecordValidationError): ModuleError {
  return new ModuleError(
    'Module record data is invalid',
    'MODULE_VALIDATION_ERROR',
    400,
    { issues: error.issues },
  );
}

async function acquireMutationKeyLock(
  executor: DbExecutor,
  actor: ModuleActor,
  operation: ModuleMutationOperation,
  idempotencyKey: string,
): Promise<void> {
  const lockKey = `${operation}:${moduleIdempotencyDigest(actor, idempotencyKey)}`;
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}

async function acquireModuleInstallLocks(
  executor: DbExecutor,
  orgId: string,
  moduleId: string,
  slug: string,
): Promise<void> {
  const lockKeys = [
    `module-install:id:${orgId}:${moduleId}`,
    `module-install:slug:${orgId}:${slug}`,
  ].sort();
  for (const lockKey of lockKeys) {
    await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
  }
}

async function findMutationReplay(
  executor: DbExecutor,
  actor: ModuleActor,
  operation: ModuleMutationOperation,
  idempotencyKey: string,
  inputDigest: string,
  expectedInstallationId?: string,
): Promise<ModuleMutationResult | null> {
  const [receipt] = await executor
    .select()
    .from(moduleMutationReceipts)
    .where(and(
      eq(moduleMutationReceipts.org_id, actor.org_id),
      eq(moduleMutationReceipts.actor_type, actor.kind),
      eq(moduleMutationReceipts.actor_id, actor.actor_id),
      eq(moduleMutationReceipts.operation, operation),
      eq(moduleMutationReceipts.idempotency_key, moduleIdempotencyDigest(actor, idempotencyKey)),
    ))
    .limit(1);
  if (!receipt) return null;
  if (receipt.input_digest !== inputDigest) {
    throw new ModuleError(
      'Idempotency key was already used for a different module mutation',
      'MODULE_IDEMPOTENCY_CONFLICT',
      409,
    );
  }
  if (expectedInstallationId && receipt.installation_id !== expectedInstallationId) {
    throw new ModuleError('Module record not found', 'MODULE_RECORD_NOT_FOUND', 404);
  }

  const [record] = await executor
    .select({
      id: moduleRecords.id,
      installation_id: moduleRecords.installation_id,
      collection_key: moduleRecords.collection_key,
    })
    .from(moduleRecords)
    .where(and(
      eq(moduleRecords.id, receipt.record_id),
      eq(moduleRecords.org_id, actor.org_id),
      eq(moduleRecords.installation_id, receipt.installation_id),
    ))
    .limit(1);
  if (!record) throw new Error(`Mutation receipt ${receipt.id} references a missing record`);
  const installation = await findInstallation(
    executor,
    actor,
    { installationId: receipt.installation_id },
    'write',
    { lock: true },
  );
  return {
    resource_id: formatModuleRecordResourceId(record.id),
    record_id: record.id,
    installation_id: record.installation_id,
    module_id: installation.installation.module_id,
    collection_key: record.collection_key,
    manifest_digest: receipt.result_manifest_digest as ModuleMutationResult['manifest_digest'],
    revision: receipt.result_revision,
    archived: receipt.result_archived,
    changed_fields: receipt.changed_fields,
    replayed: true,
  };
}

async function assertMutationIdempotencyAvailable(
  executor: DbExecutor,
  actor: ModuleActor,
  operation: ModuleMutationOperation,
  input: { idempotency_key?: string },
): Promise<void> {
  if (!input.idempotency_key) return;
  const [receipt] = await executor
    .select({ input_digest: moduleMutationReceipts.input_digest })
    .from(moduleMutationReceipts)
    .where(and(
      eq(moduleMutationReceipts.org_id, actor.org_id),
      eq(moduleMutationReceipts.actor_type, actor.kind),
      eq(moduleMutationReceipts.actor_id, actor.actor_id),
      eq(moduleMutationReceipts.operation, operation),
      eq(
        moduleMutationReceipts.idempotency_key,
        moduleIdempotencyDigest(actor, input.idempotency_key),
      ),
    ))
    .limit(1);
  if (receipt && receipt.input_digest !== moduleMutationInputDigest(operation, input as Record<string, unknown>)) {
    throw new ModuleError(
      'Idempotency key was already used for a different module mutation',
      'MODULE_IDEMPOTENCY_CONFLICT',
      409,
    );
  }
}

async function insertMutationReceipt(
  executor: DbExecutor,
  actor: ModuleActor,
  values: {
    operation: ModuleMutationOperation;
    idempotencyKey?: string;
    inputDigest?: string;
    record: ModuleRecord;
    changedFields: string[];
  },
): Promise<void> {
  if (!values.idempotencyKey || !values.inputDigest) return;
  await executor.insert(moduleMutationReceipts).values({
    org_id: actor.org_id,
    installation_id: values.record.installation_id,
    agent_action_id: 'action_id' in actor ? (actor.action_id ?? null) : null,
    actor_type: actor.kind,
    actor_id: actor.actor_id,
    operation: values.operation,
    idempotency_key: moduleIdempotencyDigest(actor, values.idempotencyKey),
    input_digest: values.inputDigest,
    record_id: values.record.id,
    result_revision: values.record.revision,
    result_manifest_digest: values.record.manifest_digest,
    result_archived: values.record.archived_at !== null,
    changed_fields: [...new Set(values.changedFields)].sort(),
  });
}

/**
 * Recover a mutation that committed atomically in ModuleService even if the
 * process died before its broader agent_actions row was stamped. This lookup
 * deliberately bypasses current module/employee policy: it never performs a
 * write, and only reports an already-committed PII-free outcome.
 */
type RecoveredModuleMutation = {
  mutation: ModuleMutationResult;
  idempotencyDigest: string;
  inputDigest: string;
};

async function recoverModuleMutationByAgentActionIdWith(
  executor: DbExecutor,
  orgId: string,
  actionId: string,
): Promise<RecoveredModuleMutation | null> {
  const [row] = await executor
    .select({
      receipt: moduleMutationReceipts,
      module_id: moduleInstallations.module_id,
      collection_key: moduleRecords.collection_key,
    })
    .from(moduleMutationReceipts)
    .innerJoin(moduleRecords, and(
      eq(moduleRecords.org_id, moduleMutationReceipts.org_id),
      eq(moduleRecords.installation_id, moduleMutationReceipts.installation_id),
      eq(moduleRecords.id, moduleMutationReceipts.record_id),
    ))
    .innerJoin(moduleInstallations, and(
      eq(moduleInstallations.org_id, moduleMutationReceipts.org_id),
      eq(moduleInstallations.id, moduleMutationReceipts.installation_id),
    ))
    .where(and(
      eq(moduleMutationReceipts.org_id, orgId),
      eq(moduleMutationReceipts.agent_action_id, actionId),
    ))
    .limit(1);
  if (!row) return null;
  return {
    mutation: ModuleMutationResultSchema.parse({
      resource_id: formatModuleRecordResourceId(row.receipt.record_id),
      record_id: row.receipt.record_id,
      installation_id: row.receipt.installation_id,
      module_id: row.module_id,
      collection_key: row.collection_key,
      manifest_digest: row.receipt.result_manifest_digest,
      revision: row.receipt.result_revision,
      archived: row.receipt.result_archived,
      changed_fields: row.receipt.changed_fields,
      replayed: true,
    }),
    idempotencyDigest: row.receipt.idempotency_key,
    inputDigest: row.receipt.input_digest,
  };
}

export async function recoverModuleMutationByAgentActionId(
  orgId: string,
  actionId: string,
): Promise<RecoveredModuleMutation | null> {
  return recoverModuleMutationByAgentActionIdWith(db, orgId, actionId);
}

function parseRecordData(
  manifest: DeftModuleManifestV1,
  collectionKey: string,
  data: unknown,
): ModuleRecordData {
  try {
    return parseModuleRecordData(manifest, collectionKey, data);
  } catch (error) {
    if (error instanceof ModuleRecordValidationError) throw validationError(error);
    throw error;
  }
}

function assertExpectedManifest(version: VersionRow, expected: string): void {
  if (version.manifest_digest !== expected) {
    throw new ModuleError(
      'The module schema changed. Refresh and review the current schema before writing.',
      'MODULE_MANIFEST_STALE',
      409,
      { current_manifest_digest: version.manifest_digest },
    );
  }
}

export function sanitizeModuleActionParamsForHistory(
  action: string,
  value: unknown,
): Record<string, unknown> {
  const params = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const scrubbed: Record<string, unknown> = {};
  for (const key of ['module_id', 'collection_key', 'record_id', 'expected_manifest_digest']) {
    if (typeof params[key] === 'string') scrubbed[key] = params[key];
  }
  if (typeof params.expected_revision === 'number') {
    scrubbed.expected_revision = params.expected_revision;
  }
  const changedFields = new Set<string>();
  if (action === 'module_record_create' && params.data && typeof params.data === 'object') {
    Object.keys(params.data as Record<string, unknown>).forEach((key) => changedFields.add(key));
  }
  if (action === 'module_record_update') {
    if (params.patch && typeof params.patch === 'object') {
      Object.keys(params.patch as Record<string, unknown>).forEach((key) => changedFields.add(key));
    }
    if (Array.isArray(params.unset_fields)) {
      params.unset_fields
        .filter((key): key is string => typeof key === 'string')
        .forEach((key) => changedFields.add(key));
    }
  }
  scrubbed.changed_fields = [...changedFields].sort();
  return scrubbed;
}

async function expirePendingModuleActions(
  executor: DbExecutor,
  orgId: string,
  installation: InstallationRow,
  reason: string,
): Promise<Array<{
  id: string;
  action: string;
  params: Record<string, unknown>;
  userId: string;
  employeeId: string | null;
  approverId: string | null;
  decision: 'approved' | 'auto_executed' | 'expired';
  result: ModuleMutationResult | null;
  reason: string;
}>> {
  const pending = await executor
    .select({
      id: agentActions.id,
      action: agentActions.action,
      params: agentActions.params,
      user_id: agentActions.user_id,
      agent_employee_id: agentActions.agent_employee_id,
      approval_status: agentActions.approval_status,
      approved_by_user_id: agentActions.approved_by_user_id,
    })
    .from(agentActions)
    .where(and(
      eq(agentActions.org_id, orgId),
      or(
        eq(agentActions.approval_status, 'pending'),
        and(
          eq(agentActions.approval_status, 'approved'),
          sql`${agentActions.executed_at} IS NULL`,
        ),
      ),
      inArray(agentActions.action, [
        'module_record_create',
        'module_record_update',
        'module_record_archive',
      ]),
    ));
  if (pending.length === 0) return [];

  const targetRecordIds = pending
    .map((action) => {
      const params = action.params as Record<string, unknown>;
      return typeof params.record_id === 'string' ? params.record_id : null;
    })
    .filter((id): id is string => id !== null);
  const ownedRecordIds = targetRecordIds.length > 0
    ? new Set((await executor
      .select({ id: moduleRecords.id })
      .from(moduleRecords)
      .where(and(
        eq(moduleRecords.org_id, orgId),
        eq(moduleRecords.installation_id, installation.id),
        inArray(moduleRecords.id, targetRecordIds),
      ))).map((record) => record.id))
    : new Set<string>();

  const expiredActions: Array<{
    id: string;
    action: string;
    params: Record<string, unknown>;
    userId: string;
    employeeId: string | null;
    approverId: string | null;
    decision: 'approved' | 'auto_executed' | 'expired';
    result: ModuleMutationResult | null;
    reason: string;
  }> = [];
  for (const action of pending) {
    const params = action.params as Record<string, unknown>;
    const belongsToInstallation = action.action === 'module_record_create'
      ? params.module_id === installation.module_id
      : typeof params.record_id === 'string' && ownedRecordIds.has(params.record_id);
    if (!belongsToInstallation) continue;
    const terminalParams = sanitizeModuleActionParamsForHistory(action.action, params);
    if (typeof params.idempotency_key === 'string') {
      const digestActor = action.agent_employee_id
        ? employeeModuleActor({
          orgId,
          employeeId: action.agent_employee_id,
          trustLevel: 'conservative',
          source: 'mcp',
        })
        : deftyModuleActor({
          orgId,
          userId: action.user_id,
          role: 'member',
        });
      terminalParams.idempotency_digest = moduleIdempotencyDigest(digestActor, params.idempotency_key);
      terminalParams.input_digest = moduleMutationInputDigest(
        action.action === 'module_record_create' ? 'create'
          : action.action === 'module_record_update' ? 'update'
            : 'archive',
        params,
      );
    }

    // A module mutation and installation lifecycle change both hold the same
    // installation row lock. At this point an approved/unexecuted action is
    // therefore unambiguous: either its transaction committed a durable
    // mutation receipt, or it did not. Reconcile the former truthfully and
    // expire the latter without retaining proposal values.
    if (action.approval_status === 'approved') {
      const committed = await recoverModuleMutationByAgentActionIdWith(
        executor,
        orgId,
        action.id,
      );
      if (committed) {
        terminalParams.idempotency_digest = committed.idempotencyDigest;
        terminalParams.input_digest = committed.inputDigest;
        const [recovered] = await executor
          .update(agentActions)
          .set({
            result: committed.mutation,
            after_state: committed.mutation,
            error: null,
            params: terminalParams,
            executed_at: new Date(),
          })
          .where(and(
            eq(agentActions.id, action.id),
            eq(agentActions.org_id, orgId),
            eq(agentActions.approval_status, 'approved'),
            sql`${agentActions.executed_at} IS NULL`,
          ))
          .returning({ id: agentActions.id });
        if (recovered) {
          await markWorkIntentConvertedForAction({
            actionId: recovered.id,
            orgId,
            actionParams: params,
            result: committed.mutation,
            convertedBy: action.approved_by_user_id ?? action.user_id,
          }, executor);
          expiredActions.push({
            id: recovered.id,
            action: action.action,
            params: terminalParams,
            userId: action.user_id,
            employeeId: action.agent_employee_id,
            approverId: action.approved_by_user_id,
            decision: action.approved_by_user_id ? 'approved' : 'auto_executed',
            result: committed.mutation,
            reason: 'Recovered an already-committed module mutation during access revocation',
          });
        }
        continue;
      }
    }
    const [expired] = await executor
      .update(agentActions)
      .set({
        approval_status: 'expired',
        error: reason,
        params: terminalParams,
        executed_at: new Date(),
      })
      .where(and(
        eq(agentActions.id, action.id),
        eq(agentActions.org_id, orgId),
        or(
          eq(agentActions.approval_status, 'pending'),
          and(
            eq(agentActions.approval_status, 'approved'),
            sql`${agentActions.executed_at} IS NULL`,
          ),
        ),
      ))
      .returning({ id: agentActions.id });
    if (expired) {
      await markWorkIntentsExpiredForActions({
        orgId,
        actions: [{ id: expired.id, params }],
        reason,
      }, executor);
      expiredActions.push({
        id: expired.id,
        action: action.action,
        params: terminalParams,
        userId: action.user_id,
        employeeId: action.agent_employee_id,
        approverId: action.approved_by_user_id,
        decision: 'expired',
        result: null,
        reason,
      });
    }
  }
  return expiredActions;
}

export function humanModuleActor(input: {
  orgId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
  source?: 'ui' | 'rest' | 'mcp';
  scopes?: string[];
}): ModuleActor {
  return ModuleActorSchema.parse({
    kind: 'human',
    org_id: input.orgId,
    actor_id: input.userId,
    role: input.role,
    source: input.source ?? 'rest',
    scopes: input.scopes ?? [],
  });
}

export function deftyModuleActor(input: {
  orgId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
  conversationId?: string;
  actionId?: string;
}): ModuleActor {
  return ModuleActorSchema.parse({
    kind: 'defty',
    org_id: input.orgId,
    actor_id: input.userId,
    role: input.role,
    source: 'defty',
    ...(input.conversationId ? { conversation_id: input.conversationId } : {}),
    ...(input.actionId ? { action_id: input.actionId } : {}),
  });
}

export function employeeModuleActor(input: {
  orgId: string;
  employeeId: string;
  trustLevel: 'conservative' | 'standard' | 'autonomous';
  source?: 'mcp' | 'runtime';
  scopes?: string[];
  actionId?: string;
}): ModuleActor {
  return ModuleActorSchema.parse({
    kind: 'agent_employee',
    org_id: input.orgId,
    actor_id: input.employeeId,
    trust_level: input.trustLevel,
    source: input.source ?? 'mcp',
    scopes: input.scopes ?? [],
    ...(input.actionId ? { action_id: input.actionId } : {}),
  });
}

export async function listModuleInstallations(
  actorValue: ModuleActor,
  options?: { includeDisabled?: boolean },
): Promise<ModuleInstallationView[]> {
  const actor = validatedActor(actorValue);
  assertBaseReadAccess(actor);
  const includeDisabled = options?.includeDisabled === true && isAdmin(actor);

  const conditions: SQL[] = [
    eq(moduleInstallations.org_id, actor.org_id),
    eq(moduleInstallations.is_deleted, false),
  ];
  if (!includeDisabled) conditions.push(eq(moduleInstallations.is_enabled, true));
  if (actor.kind === 'defty' || actor.kind === 'agent_employee') {
    conditions.push(inArray(moduleInstallations.agent_access, ['read', 'write']));
  }

  const rows = await db
    .select({ installation: moduleInstallations, version: moduleVersions })
    .from(moduleInstallations)
    .innerJoin(moduleVersions, installationJoinCondition())
    .where(and(...conditions))
    .orderBy(asc(moduleInstallations.slug));

  return Promise.all(rows.map(async (row) => toInstallationView(row, await verifyManifest(row.version))));
}

export async function listModuleSummaries(actorValue: ModuleActor): Promise<ModuleSummary[]> {
  const actor = validatedActor(actorValue);
  const rows = await listModuleInstallations(actor);
  return rows.map((row) => ({
    installation_id: row.id,
    module_id: row.module_id,
    slug: row.slug,
    version: row.manifest.version,
    manifest_digest: row.manifest_digest,
    name: row.manifest.name,
    ...(row.manifest.description ? { description: row.manifest.description } : {}),
    ...(row.manifest.icon ? { icon: row.manifest.icon } : {}),
    enabled: row.enabled,
    collections: row.manifest.collections.map((collection) => ({
      key: collection.key,
      name: collection.name,
      ...(collection.singular_name ? { singular_name: collection.singular_name } : {}),
    })),
  }));
}

export async function listBundledModuleViews(actorValue: ModuleActor): Promise<BundledModuleView[]> {
  const actor = validatedActor(actorValue);
  assertBaseReadAccess(actor);
  const installed = await db
    .select({ module_id: moduleInstallations.module_id })
    .from(moduleInstallations)
    .where(and(
      eq(moduleInstallations.org_id, actor.org_id),
      eq(moduleInstallations.is_deleted, false),
    ));
  const installedIds = new Set(installed.map((row) => row.module_id));
  return listBundledModules().map((manifest) => ({
    slug: manifest.slug,
    module_id: manifest.id,
    name: manifest.name,
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(manifest.icon ? { icon: manifest.icon } : {}),
    version: manifest.version,
    installed: installedIds.has(manifest.id),
  }));
}

export async function getModuleInstallation(
  actorValue: ModuleActor,
  identifier: { slug?: string; moduleId?: string },
  options?: { allowDisabledForAdmin?: boolean },
): Promise<ModuleInstallationView> {
  const actor = validatedActor(actorValue);
  const row = await findInstallation(db, actor, identifier, 'read', options);
  return toInstallationView(row, await verifyManifest(row.version));
}

export async function getModuleSchema(
  actorValue: ModuleActor,
  moduleId: string,
): Promise<{
  installation_id: string;
  enabled: boolean;
  manifest_digest: string;
  manifest: DeftModuleManifestV1;
}> {
  const actor = validatedActor(actorValue);
  const row = await findInstallation(db, actor, { moduleId }, 'read');
  return {
    installation_id: row.installation.id,
    enabled: row.installation.is_enabled,
    manifest_digest: row.version.manifest_digest,
    manifest: await verifyManifest(row.version),
  };
}

export async function installBundledModule(
  actorValue: ModuleActor,
  slug: string,
): Promise<ModuleInstallationView> {
  const actor = validatedActor(actorValue);
  assertLifecycleAccess(actor);
  const manifest = getBundledModule(slug);
  if (!manifest) throw new ModuleError('Bundled module not found', 'MODULE_NOT_FOUND', 404);
  const digest = await digestModuleManifest(manifest);
  const identity = actorMetadata(actor);

  const created = await db.transaction(async (tx) => {
    await acquireModuleInstallLocks(tx, actor.org_id, manifest.id, manifest.slug);
    const [existing] = await tx
      .select({ id: moduleInstallations.id })
      .from(moduleInstallations)
      .where(and(
        eq(moduleInstallations.org_id, actor.org_id),
        or(eq(moduleInstallations.module_id, manifest.id), eq(moduleInstallations.slug, manifest.slug)),
        eq(moduleInstallations.is_deleted, false),
      ))
      .limit(1);
    if (existing) {
      throw new ModuleError('Module is already installed', 'MODULE_ALREADY_INSTALLED', 409);
    }

    const [installation] = await tx.insert(moduleInstallations).values({
      org_id: actor.org_id,
      module_id: manifest.id,
      slug: manifest.slug,
      source: 'bundled',
      is_enabled: true,
      disabled_at: null,
      agent_access: 'none',
      installed_by_user_id: actor.kind === 'human' ? actor.actor_id : null,
      installed_by_actor_type: identity.type,
      installed_by_actor_id: identity.id,
      updated_by_actor_type: identity.type,
      updated_by_actor_id: identity.id,
    }).returning();
    if (!installation) throw new Error('Module installation insert returned no row');

    const now = new Date();
    const [version] = await tx.insert(moduleVersions).values({
      org_id: actor.org_id,
      installation_id: installation.id,
      version: manifest.version,
      manifest,
      manifest_digest: digest,
      is_active: true,
      activated_at: now,
      created_by_actor_type: identity.type,
      created_by_actor_id: identity.id,
    }).returning();
    if (!version) throw new Error('Module version insert returned no row');

    await insertAudit(tx, actor, {
      action: 'module.install',
      entityType: 'module_installation',
      entityId: installation.id,
      after: {
        module_id: manifest.id,
        slug: manifest.slug,
        version: manifest.version,
        manifest_digest: digest,
        enabled: true,
        agent_access: 'none',
      },
    });
    return { installation, version };
  });

  emitModuleChange(actor.org_id, {
    change: 'installed',
    installation_id: created.installation.id,
    module_id: created.installation.module_id,
    slug: created.installation.slug,
    active_version_id: created.version.id,
    manifest_digest: created.version.manifest_digest,
  });
  await invalidateModuleCatalogCaches(actor.org_id);
  return toInstallationView(created, manifest);
}

export async function updateModuleInstallation(
  actorValue: ModuleActor,
  slug: string,
  changes: { enabled?: boolean; agent_access?: 'none' | 'read' | 'write' },
): Promise<ModuleInstallationView> {
  const actor = validatedActor(actorValue);
  assertLifecycleAccess(actor);
  if (changes.enabled === undefined && changes.agent_access === undefined) {
    throw new ModuleError('No module setting was provided', 'MODULE_VALIDATION_ERROR', 400);
  }
  const identity = actorMetadata(actor);

  const updated = await db.transaction(async (tx) => {
    const row = await findInstallation(
      tx,
      actor,
      { slug },
      'read',
      { allowDisabledForAdmin: true, lock: true },
    );
    const nextEnabled = changes.enabled ?? row.installation.is_enabled;
    const nextAgentAccess = changes.agent_access ?? row.installation.agent_access;
    const [installation] = await tx
      .update(moduleInstallations)
      .set({
        is_enabled: nextEnabled,
        disabled_at: nextEnabled ? null : (row.installation.disabled_at ?? new Date()),
        agent_access: nextAgentAccess,
        updated_by_actor_type: identity.type,
        updated_by_actor_id: identity.id,
      })
      .where(and(
        eq(moduleInstallations.id, row.installation.id),
        eq(moduleInstallations.org_id, actor.org_id),
      ))
      .returning();
    if (!installation) throw new Error('Module update returned no row');

    await insertAudit(tx, actor, {
      action: 'module.configure',
      entityType: 'module_installation',
      entityId: installation.id,
      before: {
        enabled: row.installation.is_enabled,
        agent_access: row.installation.agent_access,
      },
      after: { enabled: nextEnabled, agent_access: nextAgentAccess },
      metadata: { changed_fields: Object.keys(changes).sort() },
    });
    const disabledNow = row.installation.is_enabled && !nextEnabled;
    const agentWriteAccessRevoked = row.installation.agent_access === 'write'
      && nextAgentAccess !== 'write';
    const expiredActions = disabledNow || agentWriteAccessRevoked
      ? await expirePendingModuleActions(
        tx,
        actor.org_id,
        installation,
        disabledNow
          ? 'Module was disabled before this action was reviewed'
          : 'Module write access was revoked before this action was reviewed',
      )
      : [];
    return { installation, version: row.version, expiredActions };
  });

  const manifest = await verifyManifest(updated.version);
  emitModuleChange(actor.org_id, {
    change: 'configured',
    installation_id: updated.installation.id,
    module_id: updated.installation.module_id,
    slug: updated.installation.slug,
    enabled: updated.installation.is_enabled,
    agent_access: updated.installation.agent_access,
    active_version_id: updated.version.id,
    manifest_digest: updated.version.manifest_digest,
  });
  await invalidateModuleCatalogCaches(actor.org_id);
  if (updated.expiredActions.length > 0) {
    const { resolveAttentionBySource } = await import('./attention.js');
    const { generateReceipt } = await import('./receipts.js');
    const lifecycleActorUserId = actor.kind === 'human' ? actor.actor_id : undefined;
    await Promise.all(updated.expiredActions.flatMap((expired) => [
      resolveAttentionBySource({
        orgId: actor.org_id,
        sourceType: 'agent_action',
        sourceId: expired.id,
        resolution: 'module_access_revoked',
        actorUserId: lifecycleActorUserId,
      }),
      generateReceipt({
        actionId: expired.id,
        orgId: actor.org_id,
        employeeId: expired.employeeId,
        proposer: expired.employeeId ? 'employee' : 'defty',
        proposerId: expired.employeeId ?? expired.userId,
        approverId: expired.decision === 'approved'
          ? expired.approverId
          : expired.decision === 'auto_executed'
            ? null
            : lifecycleActorUserId ?? null,
        decision: expired.decision,
        decisionReason: expired.reason,
        actionName: expired.action,
        actionParams: expired.params,
        resultJson: expired.result,
      }),
    ]));
  }
  return toInstallationView(updated, manifest);
}

/**
 * Validate an agent proposal against the same live module boundary used at
 * execution time, without inserting an action, audit row, or module record.
 * Execution still repeats every check to close the approval-time TOCTOU gap.
 */
export async function preflightModuleMutation(
  actorValue: ModuleActor,
  operation: Extract<
    ModuleOperationName,
    'module_record_create' | 'module_record_update' | 'module_record_archive'
  >,
  input: ModuleRecordCreateRequest | ModuleRecordUpdateRequest | ModuleRecordArchiveRequest,
): Promise<void> {
  return preflightModuleMutationWithExecutor(db, actorValue, operation, input, false);
}

/** Transaction-aware proposal validation. When `lockInstallation` is true,
 * the caller must keep the transaction open through the corresponding action
 * insert. This gives install disable/write-revoke the same serialization point
 * as record mutations and prevents a proposal from appearing after a revoke
 * scan has completed. */
export async function preflightModuleMutationWithExecutor(
  executor: ModuleDbExecutor,
  actorValue: ModuleActor,
  operation: Extract<
    ModuleOperationName,
    'module_record_create' | 'module_record_update' | 'module_record_archive'
  >,
  input: ModuleRecordCreateRequest | ModuleRecordUpdateRequest | ModuleRecordArchiveRequest,
  lockInstallation = true,
): Promise<void> {
  const actor = validatedActor(actorValue);
  if (operation === 'module_record_create') {
    const createInput = input as ModuleRecordCreateRequest;
    const installation = await findInstallation(
      executor,
      actor,
      { moduleId: createInput.module_id },
      'write',
      { lock: lockInstallation },
    );
    assertExpectedManifest(installation.version, createInput.expected_manifest_digest);
    const manifest = await verifyManifest(installation.version);
    parseRecordData(manifest, createInput.collection_key, createInput.data);
    await assertMutationIdempotencyAvailable(executor, actor, 'create', createInput);
    return;
  }

  const recordInput = input as ModuleRecordUpdateRequest | ModuleRecordArchiveRequest;
  const [current] = await executor
    .select()
    .from(moduleRecords)
    .where(and(
      eq(moduleRecords.id, recordInput.record_id),
      eq(moduleRecords.org_id, actor.org_id),
      eq(moduleRecords.is_deleted, false),
    ))
    .limit(1);
  if (!current) throw new ModuleError('Module record not found', 'MODULE_RECORD_NOT_FOUND', 404);

  const installation = await findInstallation(
    executor,
    actor,
    { installationId: current.installation_id },
    'write',
    { lock: lockInstallation },
  );
  assertExpectedManifest(installation.version, recordInput.expected_manifest_digest);
  if (current.revision !== recordInput.expected_revision) {
    throw new ModuleError(
      'Module record changed since it was read',
      'MODULE_REVISION_CONFLICT',
      409,
      { current_revision: current.revision },
    );
  }

  if (operation === 'module_record_update') {
    const updateInput = input as ModuleRecordUpdateRequest;
    const merged: Record<string, unknown> = {
      ...(current.data as Record<string, unknown>),
      ...updateInput.patch,
    };
    for (const field of updateInput.unset_fields) delete merged[field];
    const manifest = await verifyManifest(installation.version);
    parseRecordData(manifest, current.collection_key, merged);
  }
  await assertMutationIdempotencyAvailable(
    executor,
    actor,
    operation === 'module_record_update' ? 'update' : 'archive',
    recordInput,
  );
}

export async function createModuleRecord(
  actorValue: ModuleActor,
  input: ModuleRecordCreateRequest,
): Promise<{ record: ModuleRecord | null; replayed: boolean; mutation: ModuleMutationResult }> {
  const actor = validatedActor(actorValue);
  const identity = actorMetadata(actor);
  const inputDigest = moduleMutationInputDigest('create', input as Record<string, unknown>);

  const outcome = await db.transaction(async (tx) => {
    await acquireMutationKeyLock(tx, actor, 'create', input.idempotency_key);
    const replay = await findMutationReplay(
      tx,
      actor,
      'create',
      input.idempotency_key,
      inputDigest,
    );
    if (replay) return { record: null, mutation: replay };
    await assertAgentModuleMutationPolicyWithExecutor(tx, actor, 'module_record_create');

    const installation = await findInstallation(
      tx,
      actor,
      { moduleId: input.module_id },
      'write',
      { lock: true },
    );
    assertExpectedManifest(installation.version, input.expected_manifest_digest);
    const manifest = await verifyManifest(installation.version);
    const data = parseRecordData(manifest, input.collection_key, input.data);

    let projection: ReturnType<typeof projectModuleRecordSearch>;
    try {
      projection = projectModuleRecordSearch(manifest, input.collection_key, data);
    } catch (error) {
      if (error instanceof ModuleRecordValidationError) throw validationError(error);
      throw error;
    }
    const [created] = await tx.insert(moduleRecords).values({
      org_id: actor.org_id,
      installation_id: installation.installation.id,
      collection_key: input.collection_key,
      validated_version_id: installation.version.id,
      data,
      revision: 1,
      create_idempotency_key: moduleIdempotencyDigest(actor, input.idempotency_key),
      search_title: projection?.title ?? '',
      search_subtitle: projection?.subtitle ?? null,
      search_text: projection?.text ?? '',
      created_by_actor_type: identity.type,
      created_by_actor_id: identity.id,
      updated_by_actor_type: identity.type,
      updated_by_actor_id: identity.id,
    }).returning();
    if (!created) throw new Error('Module record insert returned no row');

    const record = toRecord(created, installation.installation, installation.version);
    const changedFields = Object.keys(data).sort();
    await insertAudit(tx, actor, {
      action: 'module_record.create',
      entityType: 'module_record',
      entityId: record.resource_id,
      after: {
        installation_id: installation.installation.id,
        collection_key: created.collection_key,
        revision: created.revision,
        manifest_digest: installation.version.manifest_digest,
        data_digest: recordDigest(data),
      },
      metadata: { changed_fields: changedFields },
    });
    await insertMutationReceipt(tx, actor, {
      operation: 'create',
      idempotencyKey: input.idempotency_key,
      inputDigest,
      record,
      changedFields,
    });
    return {
      record,
      mutation: toModuleMutationResult(record, { replayed: false, changedFields }),
    };
  });

  if (outcome.record) {
    emitRecordChange(actor.org_id, {
      change: 'created',
      installation_id: outcome.record.installation_id,
      module_id: outcome.record.module_id,
      record_id: outcome.record.id,
      collection_key: outcome.record.collection_key,
      revision: outcome.record.revision,
    });
  }
  return { ...outcome, replayed: outcome.mutation.replayed };
}

export async function updateModuleRecord(
  actorValue: ModuleActor,
  input: ModuleRecordUpdateRequest,
  options?: { expectedInstallationId?: string },
): Promise<{ record: ModuleRecord | null; replayed: boolean; mutation: ModuleMutationResult }> {
  const actor = validatedActor(actorValue);
  const identity = actorMetadata(actor);
  const unsetFields = input.unset_fields;
  const inputDigest = input.idempotency_key
    ? moduleMutationInputDigest('update', input as Record<string, unknown>)
    : undefined;

  const outcome = await db.transaction(async (tx) => {
    if (input.idempotency_key && inputDigest) {
      await acquireMutationKeyLock(tx, actor, 'update', input.idempotency_key);
      const replay = await findMutationReplay(
        tx,
        actor,
        'update',
        input.idempotency_key,
        inputDigest,
        options?.expectedInstallationId,
      );
      if (replay) return { record: null, mutation: replay };
    }
    await assertAgentModuleMutationPolicyWithExecutor(tx, actor, 'module_record_update');
    const [current] = await tx
      .select()
      .from(moduleRecords)
      .where(and(
        eq(moduleRecords.id, input.record_id),
        eq(moduleRecords.org_id, actor.org_id),
        eq(moduleRecords.is_deleted, false),
      ))
      .limit(1)
      .for('update');
    if (!current) throw new ModuleError('Module record not found', 'MODULE_RECORD_NOT_FOUND', 404);
    if (options?.expectedInstallationId && current.installation_id !== options.expectedInstallationId) {
      throw new ModuleError('Module record not found', 'MODULE_RECORD_NOT_FOUND', 404);
    }

    const installation = await findInstallation(
      tx,
      actor,
      { installationId: current.installation_id },
      'write',
      { lock: true },
    );
    assertExpectedManifest(installation.version, input.expected_manifest_digest);
    if (current.revision !== input.expected_revision) {
      throw new ModuleError(
        'Module record changed since it was read',
        'MODULE_REVISION_CONFLICT',
        409,
        { current_revision: current.revision },
      );
    }

    const merged: Record<string, unknown> = { ...(current.data as Record<string, unknown>), ...input.patch };
    for (const field of unsetFields) delete merged[field];
    const manifest = await verifyManifest(installation.version);
    const data = parseRecordData(manifest, current.collection_key, merged);
    let projection: ReturnType<typeof projectModuleRecordSearch>;
    try {
      projection = projectModuleRecordSearch(manifest, current.collection_key, data);
    } catch (error) {
      if (error instanceof ModuleRecordValidationError) throw validationError(error);
      throw error;
    }

    const [next] = await tx
      .update(moduleRecords)
      .set({
        data,
        validated_version_id: installation.version.id,
        revision: sql`${moduleRecords.revision} + 1`,
        search_title: projection?.title ?? '',
        search_subtitle: projection?.subtitle ?? null,
        search_text: projection?.text ?? '',
        updated_by_actor_type: identity.type,
        updated_by_actor_id: identity.id,
      })
      .where(and(
        eq(moduleRecords.id, current.id),
        eq(moduleRecords.org_id, actor.org_id),
        eq(moduleRecords.installation_id, installation.installation.id),
        eq(moduleRecords.revision, input.expected_revision),
        eq(moduleRecords.is_deleted, false),
      ))
      .returning();
    if (!next) {
      throw new ModuleError('Module record changed since it was read', 'MODULE_REVISION_CONFLICT', 409);
    }

    const changedFields = [...new Set([...Object.keys(input.patch), ...unsetFields])].sort();
    const record = toRecord(next, installation.installation, installation.version);
    await insertAudit(tx, actor, {
      action: 'module_record.update',
      entityType: 'module_record',
      entityId: record.resource_id,
      before: { revision: current.revision, data_digest: recordDigest(current.data as ModuleRecordData) },
      after: {
        revision: next.revision,
        manifest_digest: installation.version.manifest_digest,
        data_digest: recordDigest(data),
      },
      metadata: { changed_fields: changedFields, unset_fields: [...unsetFields].sort() },
    });
    await insertMutationReceipt(tx, actor, {
      operation: 'update',
      idempotencyKey: input.idempotency_key,
      inputDigest,
      record,
      changedFields,
    });
    return {
      record,
      mutation: toModuleMutationResult(record, { replayed: false, changedFields }),
    };
  });

  if (outcome.record) {
    emitRecordChange(actor.org_id, {
      change: 'updated',
      installation_id: outcome.record.installation_id,
      module_id: outcome.record.module_id,
      record_id: outcome.record.id,
      collection_key: outcome.record.collection_key,
      revision: outcome.record.revision,
    });
  }
  return { ...outcome, replayed: outcome.mutation.replayed };
}

export async function archiveModuleRecord(
  actorValue: ModuleActor,
  input: ModuleRecordArchiveRequest,
  options?: { expectedInstallationId?: string },
): Promise<{ record: ModuleRecord | null; replayed: boolean; mutation: ModuleMutationResult }> {
  const actor = validatedActor(actorValue);
  const identity = actorMetadata(actor);
  const inputDigest = input.idempotency_key
    ? moduleMutationInputDigest('archive', input as Record<string, unknown>)
    : undefined;

  const outcome = await db.transaction(async (tx) => {
    if (input.idempotency_key && inputDigest) {
      await acquireMutationKeyLock(tx, actor, 'archive', input.idempotency_key);
      const replay = await findMutationReplay(
        tx,
        actor,
        'archive',
        input.idempotency_key,
        inputDigest,
        options?.expectedInstallationId,
      );
      if (replay) return { record: null, mutation: replay };
    }
    await assertAgentModuleMutationPolicyWithExecutor(tx, actor, 'module_record_archive');
    const [current] = await tx
      .select()
      .from(moduleRecords)
      .where(and(
        eq(moduleRecords.id, input.record_id),
        eq(moduleRecords.org_id, actor.org_id),
      ))
      .limit(1)
      .for('update');
    if (!current) throw new ModuleError('Module record not found', 'MODULE_RECORD_NOT_FOUND', 404);
    if (options?.expectedInstallationId && current.installation_id !== options.expectedInstallationId) {
      throw new ModuleError('Module record not found', 'MODULE_RECORD_NOT_FOUND', 404);
    }
    if (current.is_deleted) throw new ModuleError('Module record not found', 'MODULE_RECORD_NOT_FOUND', 404);

    const installation = await findInstallation(
      tx,
      actor,
      { installationId: current.installation_id },
      'write',
      { lock: true },
    );
    assertExpectedManifest(installation.version, input.expected_manifest_digest);
    if (current.revision !== input.expected_revision) {
      throw new ModuleError(
        'Module record changed since it was read',
        'MODULE_REVISION_CONFLICT',
        409,
        { current_revision: current.revision },
      );
    }

    const now = new Date();
    const [next] = await tx
      .update(moduleRecords)
      .set({
        is_deleted: true,
        deleted_at: now,
        deleted_by_actor_type: identity.type,
        deleted_by_actor_id: identity.id,
        updated_by_actor_type: identity.type,
        updated_by_actor_id: identity.id,
        revision: sql`${moduleRecords.revision} + 1`,
      })
      .where(and(
        eq(moduleRecords.id, current.id),
        eq(moduleRecords.org_id, actor.org_id),
        eq(moduleRecords.installation_id, installation.installation.id),
        eq(moduleRecords.revision, input.expected_revision),
        eq(moduleRecords.is_deleted, false),
      ))
      .returning();
    if (!next) {
      throw new ModuleError('Module record changed since it was read', 'MODULE_REVISION_CONFLICT', 409);
    }

    const record = toRecord(next, installation.installation, installation.version);
    await insertAudit(tx, actor, {
      action: 'module_record.archive',
      entityType: 'module_record',
      entityId: record.resource_id,
      before: { revision: current.revision, archived: false },
      after: { revision: next.revision, archived: true, manifest_digest: installation.version.manifest_digest },
      metadata: { destructive: true },
    });
    await insertMutationReceipt(tx, actor, {
      operation: 'archive',
      idempotencyKey: input.idempotency_key,
      inputDigest,
      record,
      changedFields: [],
    });
    return {
      record,
      mutation: toModuleMutationResult(record, { replayed: false, changedFields: [] }),
    };
  });

  if (outcome.record) {
    emitRecordChange(actor.org_id, {
      change: 'archived',
      installation_id: outcome.record.installation_id,
      module_id: outcome.record.module_id,
      record_id: outcome.record.id,
      collection_key: outcome.record.collection_key,
      revision: outcome.record.revision,
    });
  }
  return { ...outcome, replayed: outcome.mutation.replayed };
}

export async function getModuleRecord(
  actorValue: ModuleActor,
  recordId: string,
): Promise<ModuleRecord> {
  const actor = validatedActor(actorValue);
  const [row] = await db
    .select()
    .from(moduleRecords)
    .where(and(
      eq(moduleRecords.id, recordId),
      eq(moduleRecords.org_id, actor.org_id),
      eq(moduleRecords.is_deleted, false),
    ))
    .limit(1);
  if (!row) throw new ModuleError('Module record not found', 'MODULE_RECORD_NOT_FOUND', 404);
  const installation = await findInstallation(
    db,
    actor,
    { installationId: row.installation_id },
    'read',
  );
  const [validatedVersion] = await db
    .select()
    .from(moduleVersions)
    .where(and(
      eq(moduleVersions.id, row.validated_version_id),
      eq(moduleVersions.org_id, actor.org_id),
      eq(moduleVersions.installation_id, installation.installation.id),
    ))
    .limit(1);
  if (!validatedVersion) throw new Error(`Validated module version ${row.validated_version_id} is missing`);
  await verifyManifest(validatedVersion);
  return toRecord(row, installation.installation, validatedVersion);
}

function collectionFor(
  manifest: DeftModuleManifestV1,
  collectionKey: string,
): DeftModuleManifestV1['collections'][number] {
  const collection = manifest.collections.find((candidate) => candidate.key === collectionKey);
  if (!collection) {
    throw new ModuleError(
      `Unknown module collection: ${collectionKey}`,
      'MODULE_VALIDATION_ERROR',
      400,
    );
  }
  return collection;
}

function fieldFor(
  manifest: DeftModuleManifestV1,
  collectionKey: string,
  fieldKey: string,
): ModuleField {
  const field = collectionFor(manifest, collectionKey).fields.find((candidate) => candidate.key === fieldKey);
  if (!field) {
    throw new ModuleError(
      `Unknown module field: ${fieldKey}`,
      'MODULE_VALIDATION_ERROR',
      400,
    );
  }
  return field;
}

function jsonText(fieldKey: string): SQL<string> {
  return sql<string>`${moduleRecords.data} ->> ${fieldKey}`;
}

function jsonValue(fieldKey: string): SQL<unknown> {
  return sql`${moduleRecords.data} -> ${fieldKey}`;
}

function moduleValidationError(message: string): never {
  throw new ModuleError(message, 'MODULE_VALIDATION_ERROR', 400);
}

function assertValidModuleFilterValue(
  field: ModuleField,
  value: unknown,
  operator: ModuleRecordQueryRequest['filters'][number]['operator'],
): void {
  const issue = validateModuleFieldValue(field, value);
  if (issue) moduleValidationError(`${operator} value for ${field.key}: ${issue.message}`);
}

function assertModuleFilterCompatibility(
  field: ModuleField,
  filter: ModuleRecordQueryRequest['filters'][number],
): void {
  if (filter.operator === 'eq' || filter.operator === 'neq') {
    assertValidModuleFilterValue(field, filter.value, filter.operator);
    return;
  }

  if (filter.operator === 'contains') {
    if (typeof filter.value !== 'string') {
      moduleValidationError('contains requires a string value');
    }
    if (field.type === 'multi_select') {
      if (!field.options.some((option) => option.value === filter.value)) {
        moduleValidationError(`contains value for ${field.key} must match a declared option`);
      }
      return;
    }
    if (!['text', 'long_text', 'email', 'url'].includes(field.type)) {
      moduleValidationError('contains is only valid for text or multi-select fields');
    }
    return;
  }

  if (filter.operator === 'in') {
    if (!Array.isArray(filter.value) || !filter.value.every((item) => typeof item === 'string')) {
      moduleValidationError('in requires an array of string values');
    }
    if (!['text', 'long_text', 'email', 'url', 'date', 'datetime', 'single_select', 'multi_select'].includes(field.type)) {
      moduleValidationError('in is not valid for this field type');
    }
    for (const item of filter.value) {
      if (field.type === 'multi_select') {
        if (!field.options.some((option) => option.value === item)) {
          moduleValidationError(`in value for ${field.key} must match a declared option`);
        }
      } else {
        assertValidModuleFilterValue(field, item, filter.operator);
      }
    }
    return;
  }

  if (!['number', 'date', 'datetime'].includes(field.type)) {
    moduleValidationError(`${filter.operator} is only valid for number/date fields`);
  }
  assertValidModuleFilterValue(field, filter.value, filter.operator);
}

function typedModuleFieldExpression(field: ModuleField): SQL {
  const textExpression = jsonText(field.key);
  switch (field.type) {
    case 'number': return sql`(${textExpression})::double precision`;
    case 'boolean': return sql`(${textExpression})::boolean`;
    case 'date': return sql`(${textExpression})::date`;
    case 'datetime': return sql`(${textExpression})::timestamptz`;
    default: return textExpression;
  }
}

function typedModuleFilterValue(field: ModuleField, value: string | number | boolean): SQL {
  switch (field.type) {
    case 'number': return sql`${value}::double precision`;
    case 'boolean': return sql`${value}::boolean`;
    case 'date': return sql`${value}::date`;
    case 'datetime': return sql`${value}::timestamptz`;
    default: return sql`${value}`;
  }
}

export function escapeModuleLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function literalModuleIlike(expression: SQLWrapper, value: string): SQL {
  return sql`${expression} ILIKE ${`%${escapeModuleLikeLiteral(value)}%`} ESCAPE '\\'`;
}

function moduleFilterCondition(
  manifest: DeftModuleManifestV1,
  collectionKey: string,
  filter: ModuleRecordQueryRequest['filters'][number],
): SQL {
  const field = fieldFor(manifest, collectionKey, filter.field);
  assertModuleFilterCompatibility(field, filter);
  const valueExpression = jsonValue(field.key);

  if (filter.operator === 'eq' || filter.operator === 'neq') {
    const comparison = field.type === 'multi_select'
      ? sql`${valueExpression} = ${JSON.stringify(filter.value)}::jsonb`
      : sql`${typedModuleFieldExpression(field)} = ${typedModuleFilterValue(
          field,
          filter.value as string | number | boolean,
        )}`;
    return filter.operator === 'eq' ? comparison : sql`NOT (${comparison})`;
  }

  if (filter.operator === 'contains') {
    if (field.type === 'multi_select') {
      return sql`${valueExpression} @> jsonb_build_array(${filter.value as string})`;
    }
    return literalModuleIlike(jsonText(field.key), filter.value as string);
  }

  if (filter.operator === 'in') {
    const values = filter.value as string[];
    if (values.length === 0) return sql`false`;
    if (field.type === 'multi_select') {
      return or(...values.map((item) => sql`${valueExpression} @> jsonb_build_array(${item})`))!;
    }
    return sql`${typedModuleFieldExpression(field)} IN (${sql.join(
      values.map((item) => typedModuleFilterValue(field, item)),
      sql`, `,
    )})`;
  }

  const left = typedModuleFieldExpression(field);
  const right = typedModuleFilterValue(field, filter.value as string | number);
  switch (filter.operator) {
    case 'gt': return sql`${left} > ${right}`;
    case 'gte': return sql`${left} >= ${right}`;
    case 'lt': return sql`${left} < ${right}`;
    case 'lte': return sql`${left} <= ${right}`;
    default: throw new ModuleError('Unsupported module query operator', 'MODULE_VALIDATION_ERROR', 400);
  }
}

function moduleSortExpression(
  manifest: DeftModuleManifestV1,
  collectionKey: string,
  sort: ModuleRecordQueryRequest['sort'],
): SQL {
  if (!sort || sort.field === 'updated_at') return sql`${moduleRecords.updated_at}`;
  if (sort.field === 'created_at') return sql`${moduleRecords.created_at}`;
  const field = fieldFor(manifest, collectionKey, sort.field);
  if (field.type === 'multi_select') {
    throw new ModuleError('Cannot sort by a multi-select field', 'MODULE_VALIDATION_ERROR', 400);
  }
  return typedModuleFieldExpression(field);
}

export const _moduleQueryCompilerForTest = Object.freeze({
  filterCondition: moduleFilterCondition,
  sortExpression: moduleSortExpression,
});

export async function queryModuleRecords(
  actorValue: ModuleActor,
  input: ModuleRecordQueryRequest,
): Promise<ModuleRecordPage> {
  const actor = validatedActor(actorValue);
  const installation = await findInstallation(db, actor, { moduleId: input.module_id }, 'read');
  const manifest = await verifyManifest(installation.version);
  collectionFor(manifest, input.collection_key);
  const offset = decodeCursor(input.cursor);
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const conditions: SQL[] = [
    eq(moduleRecords.org_id, actor.org_id),
    eq(moduleRecords.installation_id, installation.installation.id),
    eq(moduleRecords.collection_key, input.collection_key),
    eq(moduleRecords.is_deleted, false),
    ...input.filters.map((filter) => moduleFilterCondition(manifest, input.collection_key, filter)),
  ];
  const sortExpression = moduleSortExpression(manifest, input.collection_key, input.sort);
  const sortDirection = input.sort?.direction ?? 'desc';

  const rows = await db
    .select({ record: moduleRecords, version: moduleVersions })
    .from(moduleRecords)
    .innerJoin(moduleVersions, and(
      eq(moduleVersions.org_id, moduleRecords.org_id),
      eq(moduleVersions.installation_id, moduleRecords.installation_id),
      eq(moduleVersions.id, moduleRecords.validated_version_id),
    ))
    .where(and(...conditions))
    .orderBy(
      sortDirection === 'asc' ? asc(sortExpression) : desc(sortExpression),
      sortDirection === 'asc' ? asc(moduleRecords.id) : desc(moduleRecords.id),
    )
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  await Promise.all([...new Map(selected.map((row) => [row.version.id, row.version])).values()].map(verifyManifest));
  return {
    records: selected.map((row) => toRecord(row.record, installation.installation, row.version)),
    next_cursor: hasMore ? encodeCursor(offset + limit) : null,
  };
}

export async function listModuleRecords(
  actorValue: ModuleActor,
  input: {
    module_id: string;
    collection_key: string;
    limit?: number;
    cursor?: string;
  },
): Promise<ModuleRecordPage> {
  return queryModuleRecords(actorValue, {
    module_id: input.module_id,
    collection_key: input.collection_key,
    filters: [],
    limit: input.limit ?? 25,
    ...(input.cursor ? { cursor: input.cursor } : {}),
  });
}

export async function searchModuleRecords(
  actorValue: ModuleActor,
  input: ModuleRecordSearchRequest,
): Promise<{ items: ModuleSearchHit[]; next_cursor: string | null }> {
  const actor = validatedActor(actorValue);
  assertBaseReadAccess(actor);
  const offset = decodeCursor(input.cursor);
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const titleContains = literalModuleIlike(moduleRecords.search_title, input.query);
  const subtitleContains = literalModuleIlike(moduleRecords.search_subtitle, input.query);
  const tsQuery = sql`websearch_to_tsquery('simple'::regconfig, ${input.query})`;
  const rank = sql<number>`GREATEST(
    ts_rank_cd(${moduleRecords.search_vector}, ${tsQuery}),
    CASE WHEN ${titleContains} THEN 0.75 ELSE 0 END,
    CASE WHEN ${subtitleContains} THEN 0.55 ELSE 0 END
  )`;
  const conditions: SQL[] = [
    eq(moduleRecords.org_id, actor.org_id),
    eq(moduleRecords.is_deleted, false),
    eq(moduleInstallations.is_deleted, false),
    eq(moduleInstallations.is_enabled, true),
    or(
      sql`${moduleRecords.search_vector} @@ ${tsQuery}`,
      titleContains,
      subtitleContains,
    )!,
  ];
  if (input.module_id) conditions.push(eq(moduleInstallations.module_id, input.module_id));
  if (input.collection_key) conditions.push(eq(moduleRecords.collection_key, input.collection_key));
  if (actor.kind === 'defty' || actor.kind === 'agent_employee') {
    conditions.push(inArray(moduleInstallations.agent_access, ['read', 'write']));
  }

  const rows = await db
    .select({
      record: moduleRecords,
      installation: moduleInstallations,
      version: moduleVersions,
      score: rank,
    })
    .from(moduleRecords)
    .innerJoin(moduleInstallations, and(
      eq(moduleInstallations.org_id, moduleRecords.org_id),
      eq(moduleInstallations.id, moduleRecords.installation_id),
    ))
    .innerJoin(moduleVersions, installationJoinCondition())
    .where(and(...conditions))
    .orderBy(desc(rank), desc(moduleRecords.updated_at), desc(moduleRecords.id))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  const manifests = new Map<string, DeftModuleManifestV1>();
  for (const row of selected) {
    if (!manifests.has(row.version.id)) manifests.set(row.version.id, await verifyManifest(row.version));
  }

  const items: ModuleSearchHit[] = [];
  for (const row of selected) {
    const manifest = manifests.get(row.version.id)!;
    const collection = manifest.collections.find((candidate) => candidate.key === row.record.collection_key);
    if (!collection?.search) continue;
    const snippet = row.record.search_text
      ? row.record.search_text.slice(0, 280)
      : row.record.search_subtitle;
    items.push({
      resource_id: formatModuleRecordResourceId(row.record.id),
      record_id: row.record.id,
      module_id: row.installation.module_id,
      module_slug: row.installation.slug,
      module_name: manifest.name,
      collection_key: collection.key,
      collection_name: collection.name,
      title: row.record.search_title,
      subtitle: row.record.search_subtitle,
      snippet: snippet || null,
      url: `/modules/${encodeURIComponent(row.installation.slug)}/${encodeURIComponent(collection.key)}/${encodeURIComponent(row.record.id)}`,
      score: Number(row.score),
      updated_at: toIso(row.record.updated_at),
    });
  }

  return {
    items,
    next_cursor: hasMore ? encodeCursor(offset + limit) : null,
  };
}
