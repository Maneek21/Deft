import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  formatModuleRecordResourceId,
  parseModuleRecordResourceId,
  projectModuleRecordSearch,
  type ModuleActor,
  type ModuleRecord,
} from '@deft/shared/modules';
import {
  crossReferences,
  auditLog,
  agentEmployees,
  moduleInstallations,
  moduleRecords,
  projects,
  tasks,
} from '@deft/db/schema';
import { db } from './db.js';
import {
  assertAgentModuleMutationPolicyWithExecutor,
  getModuleInstallation,
  getModuleRecord,
  listModuleInstallations,
  requireModuleInstallationWriteAccessWithExecutor,
  type ModuleAgentWriteActionName,
  type ModuleDbExecutor,
  type ModuleInstallationView,
} from './module-service.js';
import { ModuleError } from './module-errors.js';
import { visibleTaskCondition } from './task-visibility.js';

const MODULE_RECORD_SOURCE_TYPE = 'module_record';
const TASK_TARGET_TYPE = 'task';
const MAX_LINKS_PER_RESOURCE = 100;

export type TaskModuleRecordLink = {
  edge_id: string;
  resource_id: string;
  record_id: string;
  module_slug: string;
  module_name: string;
  collection_key: string;
  collection_name: string;
  title: string;
  url: string;
  created_at: string;
};

export type ModuleRecordTaskLink = {
  edge_id: string;
  task_id: string;
  title: string;
  identifier: string | null;
  status: string;
  priority: string;
  project_id: string;
  project_name: string;
  url: string;
  created_at: string;
};

export class ModuleTaskLinkError extends Error {
  constructor(
    message: string,
    readonly code: 'TASK_NOT_FOUND' | 'MODULE_TASK_LINK_NOT_FOUND',
    readonly status: 404 = 404,
  ) {
    super(message);
    this.name = 'ModuleTaskLinkError';
  }
}

type LinkableModuleRecord = Pick<
  ModuleRecord,
  'resource_id' | 'id' | 'installation_id' | 'module_id' | 'collection_key' | 'data'
>;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function recordTitle(record: LinkableModuleRecord, installation: ModuleInstallationView): string {
  try {
    const projected = projectModuleRecordSearch(
      installation.manifest,
      record.collection_key,
      record.data,
    );
    if (projected?.title) return projected.title;
  } catch {
    // A record validated against an older module version can briefly be read
    // while an upgrade is being reconciled. The stable fallback avoids making
    // a cross-reference unreadable because display projection failed.
  }
  const collection = installation.manifest.collections.find(
    (candidate) => candidate.key === record.collection_key,
  );
  return `${collection?.singular_name ?? collection?.name ?? 'Record'} ${record.id.slice(0, 8)}`;
}

function recordLinkView(
  edge: { id: string; created_at: Date | string },
  record: LinkableModuleRecord,
  installation: ModuleInstallationView,
): TaskModuleRecordLink | null {
  const collection = installation.manifest.collections.find(
    (candidate) => candidate.key === record.collection_key,
  );
  if (!collection) return null;
  return {
    edge_id: edge.id,
    resource_id: record.resource_id,
    record_id: record.id,
    module_slug: installation.slug,
    module_name: installation.manifest.name,
    collection_key: collection.key,
    collection_name: collection.name,
    title: recordTitle(record, installation),
    url: `/modules/${encodeURIComponent(installation.slug)}/${encodeURIComponent(collection.key)}/${encodeURIComponent(record.id)}`,
    created_at: iso(edge.created_at),
  };
}

type TaskLinkReadExecutor = Pick<typeof db, 'select'>;

async function requireVisibleTask(
  actor: ModuleActor,
  taskId: string,
  executor: TaskLinkReadExecutor = db,
  options?: { lock?: boolean },
) {
  const userId = await actorWorkspaceUserId(actor, executor);
  let query = executor
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(projects, and(
      eq(tasks.project_id, projects.id),
      eq(projects.org_id, actor.org_id),
    ))
    .where(and(
      eq(tasks.id, taskId),
      eq(tasks.org_id, actor.org_id),
      eq(tasks.is_deleted, false),
      eq(projects.is_deleted, false),
      visibleTaskCondition(userId),
    ))
    .limit(1);
  if (options?.lock && 'for' in query) {
    query = (query as typeof query & { for: (strength: 'update') => typeof query }).for('update');
  }
  const [task] = await query;
  if (!task) throw new ModuleTaskLinkError('Task not found', 'TASK_NOT_FOUND');
  return task;
}

async function actorWorkspaceUserId(
  actor: ModuleActor,
  executor: TaskLinkReadExecutor = db,
): Promise<string> {
  if (actor.kind === 'human' || actor.kind === 'defty') return actor.actor_id;
  if (actor.kind === 'agent_employee') {
    const [employee] = await executor
      .select({ user_id: agentEmployees.user_id })
      .from(agentEmployees)
      .where(and(
        eq(agentEmployees.id, actor.actor_id),
        eq(agentEmployees.org_id, actor.org_id),
        eq(agentEmployees.is_active, true),
        eq(agentEmployees.is_deleted, false),
      ))
      .limit(1);
    if (employee?.user_id) return employee.user_id;
  }
  throw new ModuleTaskLinkError('Task not found', 'TASK_NOT_FOUND');
}

async function requireModuleTaskWriteContext(
  executor: ModuleDbExecutor,
  actor: ModuleActor,
  taskId: string,
  recordId: string,
  operation: ModuleAgentWriteActionName,
): Promise<{
  createdByUserId: string;
  installation: ModuleInstallationView;
  record: LinkableModuleRecord;
  employeePolicy: { trustLevel: 'conservative' | 'standard' | 'autonomous' } | null;
}> {
  // Employee state and per-tool policy are linearized with the edge write.
  // Human and Defty actors are no-ops here and continue through the same
  // installation/task checks below.
  const employeePolicy = await assertAgentModuleMutationPolicyWithExecutor(
    executor,
    actor,
    operation,
  );

  // Preserve the native-task visibility boundary as the first resource
  // lookup. Callers cannot use a record identifier to learn anything when
  // the task itself is outside their organization or restricted from them.
  await requireVisibleTask(actor, taskId, executor, { lock: true });

  // Record installation identity is immutable. Read it without a lock first
  // so we can take locks in the canonical installation -> record order used
  // by ModuleService, then re-read the live record under lock.
  const [identity] = await executor
    .select({ installation_id: moduleRecords.installation_id })
    .from(moduleRecords)
    .where(and(
      eq(moduleRecords.id, recordId),
      eq(moduleRecords.org_id, actor.org_id),
      eq(moduleRecords.is_deleted, false),
    ))
    .limit(1);
  if (!identity) {
    throw new ModuleError('Module record not found', 'MODULE_RECORD_NOT_FOUND', 404);
  }

  const installation = await requireModuleInstallationWriteAccessWithExecutor(
    executor,
    actor,
    { installationId: identity.installation_id },
  );

  let recordQuery = executor
    .select({ record: moduleRecords })
    .from(moduleRecords)
    .where(and(
      eq(moduleRecords.id, recordId),
      eq(moduleRecords.org_id, actor.org_id),
      eq(moduleRecords.installation_id, installation.id),
      eq(moduleRecords.is_deleted, false),
    ))
    .limit(1);
  if ('for' in recordQuery) {
    recordQuery = (recordQuery as typeof recordQuery & {
      for: (strength: 'update') => typeof recordQuery;
    }).for('update');
  }
  const [lockedRecord] = await recordQuery;
  if (!lockedRecord) {
    throw new ModuleError('Module record not found', 'MODULE_RECORD_NOT_FOUND', 404);
  }

  const createdByUserId = await actorWorkspaceUserId(actor, executor);
  return {
    createdByUserId,
    installation,
    employeePolicy,
    record: {
      resource_id: formatModuleRecordResourceId(lockedRecord.record.id),
      id: lockedRecord.record.id,
      installation_id: lockedRecord.record.installation_id,
      module_id: installation.module_id,
      collection_key: lockedRecord.record.collection_key,
      data: lockedRecord.record.data as ModuleRecord['data'],
    },
  };
}

export async function preflightModuleRecordTaskMutationWithExecutor(
  executor: ModuleDbExecutor,
  actor: ModuleActor,
  taskId: string,
  resourceId: string,
  operation: ModuleAgentWriteActionName,
): Promise<{ trustLevel: 'conservative' | 'standard' | 'autonomous' } | null> {
  const context = await requireModuleTaskWriteContext(
    executor,
    actor,
    taskId,
    parseModuleRecordResourceId(resourceId),
    operation,
  );
  return context.employeePolicy;
}

/**
 * Resolve module-record backlinks for a task without trusting denormalized
 * labels. Module lifecycle and actor access are revalidated on every read.
 */
export async function listTaskModuleRecordLinks(
  actor: ModuleActor,
  taskId: string,
): Promise<TaskModuleRecordLink[]> {
  await requireVisibleTask(actor, taskId);

  // This is also the base access check: guests are rejected and agent actors
  // only receive installations explicitly enabled for their access level.
  const installations = await listModuleInstallations(actor);
  const installationById = new Map(installations.map((item) => [item.id, item]));

  const edges = await db
    .select({
      id: crossReferences.id,
      source_id: crossReferences.source_id,
      created_at: crossReferences.created_at,
    })
    .from(crossReferences)
    .where(and(
      eq(crossReferences.org_id, actor.org_id),
      eq(crossReferences.source_type, MODULE_RECORD_SOURCE_TYPE),
      eq(crossReferences.target_type, TASK_TARGET_TYPE),
      eq(crossReferences.target_id, taskId),
    ))
    .orderBy(asc(crossReferences.created_at))
    .limit(MAX_LINKS_PER_RESOURCE);

  const edgeByRecordId = new Map<string, (typeof edges)[number]>();
  for (const edge of edges) {
    try {
      edgeByRecordId.set(parseModuleRecordResourceId(edge.source_id), edge);
    } catch {
      // Only canonical module_record:<id> edges belong to this integration.
    }
  }
  const recordIds = [...edgeByRecordId.keys()];
  if (recordIds.length === 0) return [];

  const rows = await db
    .select({ record: moduleRecords })
    .from(moduleRecords)
    .innerJoin(moduleInstallations, and(
      eq(moduleInstallations.org_id, moduleRecords.org_id),
      eq(moduleInstallations.id, moduleRecords.installation_id),
      eq(moduleInstallations.is_enabled, true),
      eq(moduleInstallations.is_deleted, false),
      actor.kind === 'defty' || actor.kind === 'agent_employee'
        ? inArray(moduleInstallations.agent_access, ['read', 'write'])
        : undefined,
    ))
    .where(and(
      eq(moduleRecords.org_id, actor.org_id),
      eq(moduleRecords.is_deleted, false),
      inArray(moduleRecords.id, recordIds),
    ));

  const links: TaskModuleRecordLink[] = [];
  for (const { record: row } of rows) {
    const installation = installationById.get(row.installation_id);
    const edge = edgeByRecordId.get(row.id);
    if (!installation || !edge) continue;
    const record: LinkableModuleRecord = {
      resource_id: formatModuleRecordResourceId(row.id),
      id: row.id,
      installation_id: row.installation_id,
      module_id: installation.module_id,
      collection_key: row.collection_key,
      data: row.data as ModuleRecord['data'],
    };
    const link = recordLinkView(edge, record, installation);
    if (link) links.push(link);
  }
  return links.sort((left, right) => left.created_at.localeCompare(right.created_at));
}

export async function listModuleRecordTaskLinks(
  actor: ModuleActor,
  slug: string,
  recordId: string,
): Promise<ModuleRecordTaskLink[]> {
  const installation = await getModuleInstallation(actor, { slug });
  const record = await getModuleRecord(actor, recordId);
  if (record.installation_id !== installation.id) {
    throw new ModuleTaskLinkError('Module record not found', 'MODULE_TASK_LINK_NOT_FOUND');
  }

  const resourceId = formatModuleRecordResourceId(record.id);
  const userId = await actorWorkspaceUserId(actor);
  const rows = await db
    .select({
      edge_id: crossReferences.id,
      task_id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      number: tasks.number,
      project_id: projects.id,
      project_name: projects.name,
      project_prefix: projects.prefix,
      created_at: crossReferences.created_at,
    })
    .from(crossReferences)
    .innerJoin(tasks, and(
      eq(crossReferences.target_type, TASK_TARGET_TYPE),
      eq(crossReferences.target_id, tasks.id),
      eq(tasks.org_id, actor.org_id),
      eq(tasks.is_deleted, false),
    ))
    .innerJoin(projects, and(
      eq(tasks.project_id, projects.id),
      eq(projects.org_id, actor.org_id),
      eq(projects.is_deleted, false),
    ))
    .where(and(
      eq(crossReferences.org_id, actor.org_id),
      eq(crossReferences.source_type, MODULE_RECORD_SOURCE_TYPE),
      eq(crossReferences.source_id, resourceId),
      visibleTaskCondition(userId),
    ))
    .orderBy(asc(crossReferences.created_at))
    .limit(MAX_LINKS_PER_RESOURCE);

  return rows.map((row) => {
    const identifier = row.project_prefix && row.number != null
      ? `${row.project_prefix}-${row.number}`
      : null;
    return {
      edge_id: row.edge_id,
      task_id: row.task_id,
      title: row.title,
      identifier,
      status: row.status,
      priority: row.priority,
      project_id: row.project_id,
      project_name: row.project_name,
      url: `/tasks?task=${encodeURIComponent(identifier ?? row.task_id)}`,
      created_at: iso(row.created_at),
    };
  });
}

export async function linkModuleRecordToTask(
  actor: ModuleActor,
  taskId: string,
  resourceId: string,
): Promise<{ link: TaskModuleRecordLink; created: boolean }> {
  const recordId = parseModuleRecordResourceId(resourceId);
  const { inserted, edge, record, installation } = await db.transaction(async (tx) => {
    const context = await requireModuleTaskWriteContext(
      tx,
      actor,
      taskId,
      recordId,
      'module_record_task_link',
    );
    const inserted = await tx
      .insert(crossReferences)
      .values({
        org_id: actor.org_id,
        source_type: MODULE_RECORD_SOURCE_TYPE,
        source_id: context.record.resource_id,
        target_type: TASK_TARGET_TYPE,
        target_id: taskId,
        context: null,
        created_by: context.createdByUserId,
      })
      .onConflictDoNothing()
      .returning({ id: crossReferences.id, created_at: crossReferences.created_at });

    const edge = inserted[0] ?? (await tx
      .select({ id: crossReferences.id, created_at: crossReferences.created_at })
      .from(crossReferences)
      .where(and(
        eq(crossReferences.org_id, actor.org_id),
        eq(crossReferences.source_type, MODULE_RECORD_SOURCE_TYPE),
        eq(crossReferences.source_id, context.record.resource_id),
        eq(crossReferences.target_type, TASK_TARGET_TYPE),
        eq(crossReferences.target_id, taskId),
      ))
      .limit(1))[0];
    if (inserted[0]) {
      await tx.insert(auditLog).values({
        org_id: actor.org_id,
        actor_type: actor.kind,
        actor_id: actor.actor_id,
        action: 'module_record.task_linked',
        entity_type: 'module_record',
        entity_id: context.record.resource_id,
        before_state: null,
        after_state: { task_id: taskId },
        metadata: { edge_id: inserted[0].id },
      });
    }
    return { inserted, edge, record: context.record, installation: context.installation };
  });
  if (!edge) throw new Error('Module task link was not persisted');

  const link = recordLinkView(edge, record, installation);
  if (!link) throw new Error('Module task link collection is missing');
  return { link, created: inserted.length > 0 };
}

export async function unlinkModuleRecordFromTask(
  actor: ModuleActor,
  taskId: string,
  recordId: string,
): Promise<{ removed: boolean }> {
  const deleted = await db.transaction(async (tx) => {
    // Requiring write access to an active record is intentional:
    // disabled/deleted/read-only modules are not mutation or existence
    // oracles. Re-enable or grant write access before managing hidden links.
    const { record } = await requireModuleTaskWriteContext(
      tx,
      actor,
      taskId,
      recordId,
      'module_record_task_unlink',
    );
    const deleted = await tx
      .delete(crossReferences)
      .where(and(
        eq(crossReferences.org_id, actor.org_id),
        eq(crossReferences.source_type, MODULE_RECORD_SOURCE_TYPE),
        eq(crossReferences.source_id, record.resource_id),
        eq(crossReferences.target_type, TASK_TARGET_TYPE),
        eq(crossReferences.target_id, taskId),
      ))
      .returning({ id: crossReferences.id });
    if (deleted[0]) {
      await tx.insert(auditLog).values({
        org_id: actor.org_id,
        actor_type: actor.kind,
        actor_id: actor.actor_id,
        action: 'module_record.task_unlinked',
        entity_type: 'module_record',
        entity_id: record.resource_id,
        before_state: { task_id: taskId },
        after_state: null,
        metadata: { edge_id: deleted[0].id },
      });
    }
    return deleted;
  });
  // Natural edge uniqueness makes unlink retry-safe: a replay after a lost
  // response succeeds without emitting a second audit event.
  return { removed: deleted.length > 0 };
}
