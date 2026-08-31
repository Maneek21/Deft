import { z } from 'zod';

/**
 * Transport-neutral identities for resources owned by Deft or an installed
 * Module. A ResourceRef never carries tenant authority; the authenticated host
 * supplies the organization separately at resolution time.
 */

export const RESOURCE_CONTRACT_VERSIONS = Object.freeze({
  ref: 'deft.resource_ref.v1',
  safe_projection: 'deft.resource_safe_projection.v1',
} as const);

export const RESOURCE_LIMITS = Object.freeze({
  organization_id_chars: 128,
  provider_instance_id_chars: 128,
  resource_type_chars: 64,
  resource_id_chars: 256,
  label_chars: 200,
  href_chars: 2_048,
  revision_chars: 128,
} as const);

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function exactIdentity(max: number, label: string, pattern = OPAQUE_ID_PATTERN) {
  return z
    .string()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`)
    .refine((value) => value === value.trim(), `${label} must not have surrounding whitespace`)
    .refine((value) => !CONTROL_CHARACTERS.test(value), `${label} must not contain control characters`)
    .regex(pattern, `${label} contains unsupported characters`);
}

export const ResourceHostOrganizationIdSchema = exactIdentity(
  RESOURCE_LIMITS.organization_id_chars,
  'Organization id',
);

export const ResourceProviderInstanceIdSchema = exactIdentity(
  RESOURCE_LIMITS.provider_instance_id_chars,
  'Provider instance id',
);

export const ResourceTypeSchema = exactIdentity(
  RESOURCE_LIMITS.resource_type_chars,
  'Resource type',
  RESOURCE_TYPE_PATTERN,
);

export const ResourceOpaqueIdSchema = exactIdentity(
  RESOURCE_LIMITS.resource_id_chars,
  'Resource id',
);

export const ModuleResourceProviderSchema = z.strictObject({
  kind: z.literal('module'),
  provider_instance_id: ResourceProviderInstanceIdSchema,
});

export const CoreTaskResourceProviderSchema = z.strictObject({
  kind: z.literal('core'),
  provider_instance_id: z.literal('tasks'),
});

export const ModuleResourceRefV1Schema = z.strictObject({
  schema_version: z.literal(RESOURCE_CONTRACT_VERSIONS.ref),
  provider: ModuleResourceProviderSchema,
  resource_type: ResourceTypeSchema,
  resource_id: ResourceOpaqueIdSchema,
});

export const TaskResourceRefV1Schema = z.strictObject({
  schema_version: z.literal(RESOURCE_CONTRACT_VERSIONS.ref),
  provider: CoreTaskResourceProviderSchema,
  resource_type: z.literal('task'),
  resource_id: ResourceOpaqueIdSchema,
});

export const ResourceRefV1Schema = z.union([
  ModuleResourceRefV1Schema,
  TaskResourceRefV1Schema,
]);

export type ModuleResourceRefV1 = z.infer<typeof ModuleResourceRefV1Schema>;
export type TaskResourceRefV1 = z.infer<typeof TaskResourceRefV1Schema>;
export type ResourceRefV1 = z.infer<typeof ResourceRefV1Schema>;

const ResourceSafeLabelSchema = z
  .string()
  .trim()
  .min(1, 'Resource label is required')
  .max(RESOURCE_LIMITS.label_chars)
  .refine((value) => !CONTROL_CHARACTERS.test(value), 'Resource label must not contain control characters');

const ResourceInternalHrefSchema = z
  .string()
  .max(RESOURCE_LIMITS.href_chars)
  .refine(
    (value) => value.startsWith('/') && !value.startsWith('//') && !CONTROL_CHARACTERS.test(value),
    'Resource href must be a safe host-relative path',
  );

export const ResourceSafeProjectionV1Schema = z.strictObject({
  schema_version: z.literal(RESOURCE_CONTRACT_VERSIONS.safe_projection),
  ref: ResourceRefV1Schema,
  label: ResourceSafeLabelSchema,
  href: ResourceInternalHrefSchema.optional(),
  revision: exactIdentity(RESOURCE_LIMITS.revision_chars, 'Resource revision').optional(),
  updated_at: z.string().datetime({ offset: true }).optional(),
});

export type ResourceSafeProjectionV1 = z.infer<typeof ResourceSafeProjectionV1Schema>;

export const ResourceAuthorizationErrorCodeSchema = z.enum([
  'RESOURCE_CONTEXT_INVALID',
  'RESOURCE_REF_INVALID',
  'RESOURCE_PROVIDER_UNSUPPORTED',
  'RESOURCE_PROVIDER_UNAVAILABLE',
  'RESOURCE_ACCESS_DENIED',
  'RESOURCE_NOT_FOUND',
  'RESOURCE_UNAVAILABLE',
  'RESOURCE_OPERATION_UNSUPPORTED',
  'RESOURCE_PROVIDER_FAILURE',
]);

export type ResourceAuthorizationErrorCode = z.infer<
  typeof ResourceAuthorizationErrorCodeSchema
>;

export type ResourceAuthorizationContext<TActor> = Readonly<{
  org_id: string;
  actor: TActor;
}>;

export type ResourceResolveInput<
  TActor,
  TRef extends ResourceRefV1 = ResourceRefV1,
> = Readonly<{
  context: ResourceAuthorizationContext<TActor>;
  ref: TRef;
}>;

/**
 * The initial adapter contract exposes only the behavior Phase 4 can prove.
 * Mutation, search, and relation ports are added with their owning loops rather
 * than freezing speculative payloads here.
 */
export interface ResourceProviderAdapter<
  TActor,
  TRef extends ResourceRefV1 = ResourceRefV1,
> {
  readonly adapter_id: 'module' | 'core/tasks';
  resolve(input: ResourceResolveInput<TActor, TRef>): Promise<ResourceSafeProjectionV1>;
}
