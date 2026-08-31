import {
  ResourceHostOrganizationIdSchema,
  ResourceRefV1Schema,
  ResourceSafeProjectionV1Schema,
  type ModuleResourceRefV1,
  type ResourceAuthorizationContext,
  type ResourceAuthorizationErrorCode,
  type ResourceProviderAdapter,
  type ResourceRefV1,
  type ResourceSafeProjectionV1,
  type TaskResourceRefV1,
} from '@deft/shared/resources';

export type ResourceAuthorizationStatus = 400 | 403 | 404 | 409 | 500;

export class ResourceAuthorizationError extends Error {
  constructor(
    message: string,
    readonly code: ResourceAuthorizationErrorCode,
    readonly status: ResourceAuthorizationStatus,
  ) {
    super(message);
    this.name = 'ResourceAuthorizationError';
  }
}

export function isResourceAuthorizationError(
  error: unknown,
): error is ResourceAuthorizationError {
  return error instanceof ResourceAuthorizationError;
}

export type ResourceProviderAdapters<TActor> = Readonly<{
  module?: ResourceProviderAdapter<TActor, ModuleResourceRefV1>;
  tasks?: ResourceProviderAdapter<TActor, TaskResourceRefV1>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUnsupportedProviderCombination(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.provider)) return false;
  const kind = value.provider.kind;
  if (kind !== 'module' && kind !== 'core') return typeof kind === 'string';
  if (kind === 'core') {
    return value.provider.provider_instance_id !== 'tasks' || value.resource_type !== 'task';
  }
  return false;
}

function parseRef(value: unknown): ResourceRefV1 {
  const parsed = ResourceRefV1Schema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (isUnsupportedProviderCombination(value)) {
    throw new ResourceAuthorizationError(
      'Resource provider is not supported',
      'RESOURCE_PROVIDER_UNSUPPORTED',
      404,
    );
  }
  throw new ResourceAuthorizationError('Resource reference is invalid', 'RESOURCE_REF_INVALID', 400);
}

function sameRef(left: ResourceRefV1, right: ResourceRefV1): boolean {
  return (
    left.schema_version === right.schema_version
    && left.provider.kind === right.provider.kind
    && left.provider.provider_instance_id === right.provider.provider_instance_id
    && left.resource_type === right.resource_type
    && left.resource_id === right.resource_id
  );
}

function isModuleRef(ref: ResourceRefV1): ref is ModuleResourceRefV1 {
  return ref.provider.kind === 'module';
}

/**
 * The only cross-provider resource resolution seam. Its adapter slots are a
 * closed code-owned object: adding a provider requires a reviewed source and
 * shared-contract change, never a database row or App manifest string.
 */
export class ResourceAuthorizationService<TActor> {
  private readonly adapters: ResourceProviderAdapters<TActor>;

  constructor(adapters: ResourceProviderAdapters<TActor> = {}) {
    const keys = Object.keys(adapters);
    if (keys.some((key) => key !== 'module' && key !== 'tasks')) {
      throw new Error('Unsupported ResourceAuthorizationService adapter slot');
    }
    if (adapters.module && adapters.module.adapter_id !== 'module') {
      throw new Error('Module resource adapter has the wrong adapter id');
    }
    if (adapters.tasks && adapters.tasks.adapter_id !== 'core/tasks') {
      throw new Error('Task resource adapter has the wrong adapter id');
    }
    this.adapters = Object.freeze({ ...adapters });
  }

  async resolve(
    contextValue: ResourceAuthorizationContext<TActor>,
    refValue: unknown,
  ): Promise<ResourceSafeProjectionV1> {
    const org = ResourceHostOrganizationIdSchema.safeParse(contextValue?.org_id);
    if (!org.success || contextValue?.actor === null || contextValue?.actor === undefined) {
      throw new ResourceAuthorizationError(
        'Resource authorization context is invalid',
        'RESOURCE_CONTEXT_INVALID',
        400,
      );
    }

    const ref = parseRef(refValue);
    const adapter = isModuleRef(ref)
      ? this.adapters.module
      : this.adapters.tasks;
    if (!adapter) {
      throw new ResourceAuthorizationError(
        'Resource provider is unavailable',
        'RESOURCE_PROVIDER_UNAVAILABLE',
        404,
      );
    }

    try {
      let projectionValue: ResourceSafeProjectionV1;
      if (isModuleRef(ref)) {
        projectionValue = await this.adapters.module!.resolve({
            context: { org_id: org.data, actor: contextValue.actor },
            ref,
          });
      } else {
        projectionValue = await this.adapters.tasks!.resolve({
            context: { org_id: org.data, actor: contextValue.actor },
            ref,
          });
      }
      const projection = ResourceSafeProjectionV1Schema.safeParse(projectionValue);
      if (!projection.success || !sameRef(ref, projection.data.ref)) {
        throw new ResourceAuthorizationError(
          'Resource provider returned an invalid safe projection',
          'RESOURCE_PROVIDER_FAILURE',
          500,
        );
      }
      return projection.data;
    } catch (error) {
      if (isResourceAuthorizationError(error)) throw error;
      throw new ResourceAuthorizationError(
        'Resource provider failed safely',
        'RESOURCE_PROVIDER_FAILURE',
        500,
      );
    }
  }
}

export const resourceAuthorizationService = new ResourceAuthorizationService<never>();
