import { and, eq, inArray } from 'drizzle-orm';
import { projects, tasks } from '@deft/db/schema';
import {
  RESOURCE_CONTRACT_VERSIONS,
  RESOURCE_LIMITS,
  type ModuleResourceRefV1,
  type ResourceProviderAdapter,
  type ResourceResolveInput,
  type ResourceSafeProjectionV1,
  type TaskResourceRefV1,
} from '@deft/shared/resources';
import type {
  ModuleActor,
  ModuleRecord,
  ModuleRecordReference,
  ModuleRelationGroup,
} from '@deft/shared/modules';
import { db } from './db.js';
import {
  getModuleInstallation,
  getModuleRecord,
  listModuleRecordReferences,
} from './module-service.js';
import { isModuleError, type ModuleError } from './module-errors.js';
import {
  employeeProjectAccessAllows,
  loadEmployeeProjectAccess,
  type EmployeeProjectAccess,
} from './mcp-tools/employee-project-access.js';
import {
  ResourceAuthorizationError,
  ResourceAuthorizationService,
} from './resource-authorization.js';
import { visibleTaskCondition } from './task-visibility.js';

type ModuleOwner = Readonly<{
  getRecord: typeof getModuleRecord;
  getInstallation: typeof getModuleInstallation;
  listReferences: typeof listModuleRecordReferences;
}>;

type TaskProjectionRow = Readonly<{
  id: string;
  project_id: string;
  title: string;
  updated_at: Date;
}>;

type TaskOwner = Readonly<{
  getEmployeeAccess(input: Readonly<{
    org_id: string;
    employee_id: string;
  }>): Promise<EmployeeProjectAccess>;
  findVisible(input: Readonly<{
    org_id: string;
    task_id: string;
    user_id: string;
    project_ids: readonly string[] | null;
  }>): Promise<TaskProjectionRow | null>;
}>;

const defaultModuleOwner: ModuleOwner = {
  getRecord: getModuleRecord,
  getInstallation: getModuleInstallation,
  listReferences: listModuleRecordReferences,
};

const defaultTaskOwner: TaskOwner = {
  getEmployeeAccess: loadEmployeeProjectAccess,
  async findVisible(input) {
    const conditions = [
      eq(tasks.id, input.task_id),
      eq(tasks.org_id, input.org_id),
      eq(tasks.is_deleted, false),
      visibleTaskCondition(input.user_id)!,
    ];
    if (input.project_ids) {
      if (input.project_ids.length === 0) return null;
      conditions.push(inArray(tasks.project_id, [...input.project_ids]));
    }
    const [row] = await db
      .select({
        id: tasks.id,
        project_id: tasks.project_id,
        title: tasks.title,
        updated_at: tasks.updated_at,
      })
      .from(tasks)
      .innerJoin(projects, and(
        eq(projects.id, tasks.project_id),
        eq(projects.org_id, tasks.org_id),
      ))
      .where(and(...conditions))
      .limit(1);
    return row ?? null;
  },
};

function assertActorOrganization(actor: ModuleActor, orgId: string): void {
  if (actor.org_id !== orgId) {
    throw new ResourceAuthorizationError(
      'Resource authorization context is invalid',
      'RESOURCE_CONTEXT_INVALID',
      400,
    );
  }
}

function safeLabel(value: string, fallback: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const selected = normalized || fallback;
  return Array.from(selected).slice(0, RESOURCE_LIMITS.label_chars).join('');
}

function moduleError(error: ModuleError): ResourceAuthorizationError {
  switch (error.code) {
    case 'MODULE_ACCESS_DENIED':
    case 'MODULE_SCOPE_REQUIRED':
      return new ResourceAuthorizationError(
        'Resource access denied',
        'RESOURCE_ACCESS_DENIED',
        403,
      );
    case 'MODULE_DISABLED':
      return new ResourceAuthorizationError(
        'Resource is unavailable',
        'RESOURCE_UNAVAILABLE',
        409,
      );
    case 'MODULE_NOT_FOUND':
    case 'MODULE_RECORD_NOT_FOUND':
      return new ResourceAuthorizationError(
        'Resource not found',
        'RESOURCE_NOT_FOUND',
        404,
      );
    default:
      return new ResourceAuthorizationError(
        'Resource provider failed safely',
        'RESOURCE_PROVIDER_FAILURE',
        500,
      );
  }
}

function moduleHref(slug: string, collectionKey: string, recordId: string): string {
  return `/modules/${encodeURIComponent(slug)}/${encodeURIComponent(collectionKey)}/${encodeURIComponent(recordId)}`;
}

function moduleProjection(
  ref: ModuleResourceRefV1,
  record: ModuleRecord,
  reference: ModuleRecordReference,
  slug: string,
): ResourceSafeProjectionV1 {
  return {
    schema_version: RESOURCE_CONTRACT_VERSIONS.safe_projection,
    ref,
    label: safeLabel(reference.label, record.id),
    href: moduleHref(slug, record.collection_key, record.id),
    revision: String(record.revision),
    updated_at: record.updated_at,
  };
}

/**
 * Read-only Module adapter. ModuleService remains the owner of installation,
 * actor, record, manifest, and agent-access authorization.
 */
export class ModuleResourceProviderAdapter implements ResourceProviderAdapter<
  ModuleActor,
  ModuleResourceRefV1
> {
  readonly adapter_id = 'module' as const;

  constructor(private readonly owner: ModuleOwner = defaultModuleOwner) {}

  async resolve(
    input: ResourceResolveInput<ModuleActor, ModuleResourceRefV1>,
  ): Promise<ResourceSafeProjectionV1> {
    assertActorOrganization(input.context.actor, input.context.org_id);
    try {
      const record = await this.owner.getRecord(input.context.actor, input.ref.resource_id);
      if (
        record.installation_id !== input.ref.provider.provider_instance_id
        || record.collection_key !== input.ref.resource_type
      ) {
        throw new ResourceAuthorizationError(
          'Resource not found',
          'RESOURCE_NOT_FOUND',
          404,
        );
      }
      const installation = await this.owner.getInstallation(input.context.actor, {
        moduleId: record.module_id,
      });
      if (installation.id !== input.ref.provider.provider_instance_id) {
        throw new ResourceAuthorizationError(
          'Resource not found',
          'RESOURCE_NOT_FOUND',
          404,
        );
      }
      const references = await this.owner.listReferences(
        input.context.actor,
        installation.slug,
        input.ref.resource_type,
        [input.ref.resource_id],
      );
      const reference = references.find((candidate) => candidate.id === input.ref.resource_id);
      if (!reference) {
        throw new ResourceAuthorizationError(
          'Resource not found',
          'RESOURCE_NOT_FOUND',
          404,
        );
      }
      return moduleProjection(input.ref, record, reference, installation.slug);
    } catch (error) {
      if (error instanceof ResourceAuthorizationError) throw error;
      if (isModuleError(error)) throw moduleError(error);
      throw error;
    }
  }
}

async function taskActorBoundary(
  actor: ModuleActor,
  owner: TaskOwner,
): Promise<Readonly<{ user_id: string; project_ids: readonly string[] | null }>> {
  if (actor.kind === 'system') {
    throw new ResourceAuthorizationError(
      'Resource access denied',
      'RESOURCE_ACCESS_DENIED',
      403,
    );
  }
  if (actor.kind !== 'agent_employee') {
    return { user_id: actor.actor_id, project_ids: null };
  }
  const access = await owner.getEmployeeAccess({
    org_id: actor.org_id,
    employee_id: actor.actor_id,
  });
  if (!access.resolved) {
    throw new ResourceAuthorizationError(
      'Resource access denied',
      'RESOURCE_ACCESS_DENIED',
      403,
    );
  }
  return {
    user_id: access.userId,
    project_ids: access.unrestricted ? null : access.projectIds,
  };
}

/**
 * Read-only Task adapter. Task visibility and live employee project scope stay
 * in their existing owner seams; no Task mutation or relationship storage is
 * generalized here.
 */
export class TaskResourceProviderAdapter implements ResourceProviderAdapter<
  ModuleActor,
  TaskResourceRefV1
> {
  readonly adapter_id = 'core/tasks' as const;

  constructor(private readonly owner: TaskOwner = defaultTaskOwner) {}

  async resolve(
    input: ResourceResolveInput<ModuleActor, TaskResourceRefV1>,
  ): Promise<ResourceSafeProjectionV1> {
    assertActorOrganization(input.context.actor, input.context.org_id);
    const boundary = await taskActorBoundary(input.context.actor, this.owner);
    const task = await this.owner.findVisible({
      org_id: input.context.org_id,
      task_id: input.ref.resource_id,
      user_id: boundary.user_id,
      project_ids: boundary.project_ids,
    });
    if (!task) {
      throw new ResourceAuthorizationError(
        'Resource not found',
        'RESOURCE_NOT_FOUND',
        404,
      );
    }
    if (boundary.project_ids && !employeeProjectAccessAllows({
      resolved: true,
      userId: boundary.user_id,
      unrestricted: false,
      projectIds: [...boundary.project_ids],
    }, task.project_id)) {
      throw new ResourceAuthorizationError(
        'Resource not found',
        'RESOURCE_NOT_FOUND',
        404,
      );
    }
    return {
      schema_version: RESOURCE_CONTRACT_VERSIONS.safe_projection,
      ref: input.ref,
      label: safeLabel(task.title, task.id),
      href: `/tasks?task=${encodeURIComponent(task.id)}`,
      updated_at: task.updated_at.toISOString(),
    };
  }
}

export type ModuleV1ResourceRelationGroup = Readonly<{
  field_key: string;
  refs: ModuleResourceRefV1[];
}>;

/** Byte-preserving compatibility view over existing same-installation rows. */
export function projectModuleV1Relations(
  installationId: string,
  groups: readonly ModuleRelationGroup[],
): ModuleV1ResourceRelationGroup[] {
  return groups.map((group) => ({
    field_key: group.field_key,
    refs: group.records.map((record) => ({
      schema_version: RESOURCE_CONTRACT_VERSIONS.ref,
      provider: {
        kind: 'module',
        provider_instance_id: installationId,
      },
      resource_type: record.collection_key,
      resource_id: record.id,
    })),
  }));
}

export const moduleResourceProviderAdapter = new ModuleResourceProviderAdapter();
export const taskResourceProviderAdapter = new TaskResourceProviderAdapter();

export const resourceAuthorizationService = new ResourceAuthorizationService<ModuleActor>({
  module: moduleResourceProviderAdapter,
  tasks: taskResourceProviderAdapter,
});
