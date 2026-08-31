import { z } from 'zod';

/**
 * Transport-neutral identities for resources owned by Deft or an installed
 * Module. A ResourceRef never carries tenant authority; the authenticated host
 * supplies the organization separately at resolution time.
 */

export const RESOURCE_CONTRACT_VERSIONS = Object.freeze({
  ref: 'deft.resource_ref.v1',
  safe_projection: 'deft.resource_safe_projection.v1',
  relation: 'deft.resource_relation.v1',
} as const);

export const RESOURCE_LIMITS = Object.freeze({
  organization_id_chars: 128,
  provider_instance_id_chars: 128,
  resource_type_chars: 64,
  resource_id_chars: 256,
  label_chars: 200,
  href_chars: 2_048,
  revision_chars: 128,
  refs_per_relation: 100,
  relation_key_chars: 48,
  idempotency_key_chars: 128,
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

export function resourceRefIdentity(ref: ResourceRefV1): string {
  return [
    ref.provider.kind,
    ref.provider.provider_instance_id,
    ref.resource_type,
    ref.resource_id,
  ].join('\u0000');
}

const ResourceRelationKeySchema = z
  .string()
  .min(1)
  .max(RESOURCE_LIMITS.relation_key_chars)
  .regex(/^[a-z][a-z0-9_]*$/, 'Relation key must be lowercase snake_case');

const ResourceRelationIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(RESOURCE_LIMITS.idempotency_key_chars)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'Idempotency key contains unsupported characters');

export const ResourceRelationReplaceInputV1Schema = z
  .strictObject({
    schema_version: z.literal(RESOURCE_CONTRACT_VERSIONS.relation),
    source: ResourceRefV1Schema,
    relation_key: ResourceRelationKeySchema,
    refs: z.array(ResourceRefV1Schema).max(RESOURCE_LIMITS.refs_per_relation),
    expected_revision: z.number().int().nonnegative(),
    idempotency_key: ResourceRelationIdempotencyKeySchema,
  })
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    input.refs.forEach((ref, index) => {
      const identity = resourceRefIdentity(ref);
      if (seen.has(identity)) {
        ctx.addIssue({ code: 'custom', path: ['refs', index], message: 'Resource references must be unique' });
      }
      seen.add(identity);
    });
  });

export const ResourceRelationReplaceResultV1Schema = z.strictObject({
  schema_version: z.literal(RESOURCE_CONTRACT_VERSIONS.relation),
  source: ResourceRefV1Schema,
  relation_key: ResourceRelationKeySchema,
  revision: z.number().int().positive(),
  refs: z.array(ResourceRefV1Schema).max(RESOURCE_LIMITS.refs_per_relation),
  replayed: z.boolean(),
});

export const ResourceRelationListInputV1Schema = z.strictObject({
  schema_version: z.literal(RESOURCE_CONTRACT_VERSIONS.relation),
  source: ResourceRefV1Schema,
  relation_key: ResourceRelationKeySchema,
});

export const ResourceRelationResolvedItemV1Schema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('available'),
    ref: ResourceRefV1Schema,
    resource: ResourceSafeProjectionV1Schema,
  }),
  z.strictObject({
    state: z.literal('unavailable'),
    ref: ResourceRefV1Schema,
  }),
]);

export const ResourceRelationListResultV1Schema = z.strictObject({
  schema_version: z.literal(RESOURCE_CONTRACT_VERSIONS.relation),
  source: ResourceRefV1Schema,
  relation_key: ResourceRelationKeySchema,
  revision: z.number().int().nonnegative(),
  items: z.array(ResourceRelationResolvedItemV1Schema).max(RESOURCE_LIMITS.refs_per_relation),
});

export type ResourceRelationReplaceInputV1 = z.infer<typeof ResourceRelationReplaceInputV1Schema>;
export type ResourceRelationReplaceResultV1 = z.infer<typeof ResourceRelationReplaceResultV1Schema>;
export type ResourceRelationListInputV1 = z.infer<typeof ResourceRelationListInputV1Schema>;
export type ResourceRelationListResultV1 = z.infer<typeof ResourceRelationListResultV1Schema>;

export const ResourceRelationErrorCodeSchema = z.enum([
  'RESOURCE_RELATION_INVALID',
  'RESOURCE_RELATION_ACCESS_DENIED',
  'RESOURCE_RELATION_NOT_FOUND',
  'RESOURCE_RELATION_REVISION_CONFLICT',
  'RESOURCE_RELATION_IDEMPOTENCY_CONFLICT',
  'RESOURCE_RELATION_TARGET_MISMATCH',
  'RESOURCE_RELATION_OPERATION_UNSUPPORTED',
  'RESOURCE_RELATION_FAILURE',
]);

export type ResourceRelationErrorCode = z.infer<typeof ResourceRelationErrorCodeSchema>;

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
