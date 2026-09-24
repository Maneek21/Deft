import { z } from 'zod';
import {
  RESOURCE_LIMITS,
  ResourceOpaqueIdSchema,
  ResourceProviderInstanceIdSchema,
  ResourceRefV1Schema,
  ResourceTypeSchema,
} from './resources.js';

/** Additive resource identities. V1 remains closed to Module and core Task. */
export const RESOURCE_V2_CONTRACT_VERSIONS = Object.freeze({
  ref: 'deft.resource_ref.v2',
  safe_projection: 'deft.resource_safe_projection.v2',
  resolve: 'deft.resource_resolve.v2',
} as const);

function coreRef<const TInstance extends string, const TType extends string>(
  providerInstanceId: TInstance,
  resourceType: TType,
) {
  return z.strictObject({
    schema_version: z.literal(RESOURCE_V2_CONTRACT_VERSIONS.ref),
    provider: z.strictObject({
      kind: z.literal('core'),
      provider_instance_id: z.literal(providerInstanceId),
    }),
    resource_type: z.literal(resourceType),
    resource_id: ResourceOpaqueIdSchema,
  });
}

export const MessageResourceRefV2Schema = coreRef('messages', 'message');
export const WikiPageResourceRefV2Schema = coreRef('wiki_pages', 'wiki_page');
export const NoteResourceRefV2Schema = coreRef('notes', 'note');
export const FileResourceRefV2Schema = coreRef('files', 'file');
export const CalendarEventResourceRefV2Schema = coreRef('calendar_events', 'calendar_event');
export const PersonResourceRefV2Schema = coreRef('people', 'person');
export const TeamResourceRefV2Schema = coreRef('teams', 'team');

/** The instance id is an opaque host-issued locator, never a provider URL. */
export const AppRuntimeResourceRefV2Schema = z.strictObject({
  schema_version: z.literal(RESOURCE_V2_CONTRACT_VERSIONS.ref),
  provider: z.strictObject({
    kind: z.literal('app_runtime'),
    provider_instance_id: ResourceProviderInstanceIdSchema,
  }),
  resource_type: ResourceTypeSchema,
  resource_id: ResourceOpaqueIdSchema,
});

export const ResourceRefV2Schema = z.union([
  MessageResourceRefV2Schema,
  WikiPageResourceRefV2Schema,
  NoteResourceRefV2Schema,
  FileResourceRefV2Schema,
  CalendarEventResourceRefV2Schema,
  PersonResourceRefV2Schema,
  TeamResourceRefV2Schema,
  AppRuntimeResourceRefV2Schema,
]);
export type ResourceRefV2 = z.infer<typeof ResourceRefV2Schema>;

/** Version chooses the parser; a v2 provider never acquires v1 semantics. */
export const AnyResourceRefSchema = z.union([ResourceRefV1Schema, ResourceRefV2Schema]);
export type AnyResourceRef = z.infer<typeof AnyResourceRefSchema>;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const OPAQUE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const SafeLabelSchema = z.string().min(1).max(RESOURCE_LIMITS.label_chars)
  .refine((value) => value === value.trim() && !CONTROL_CHARACTERS.test(value),
    'Resource label must be trimmed and contain no control characters');

const HostRelativeHrefSchema = z.string().max(RESOURCE_LIMITS.href_chars)
  .refine((value) => value.startsWith('/') && !value.startsWith('//')
    && !value.includes('\\') && !CONTROL_CHARACTERS.test(value),
  'Resource href must be a host-relative path without backslashes or control characters');

const RevisionSchema = z.string().min(1).max(RESOURCE_LIMITS.revision_chars)
  .regex(OPAQUE_REVISION, 'Resource revision contains unsupported characters');

/** This safe display projection is host-authored after live authorization. */
export const ResourceSafeProjectionV2Schema = z.strictObject({
  schema_version: z.literal(RESOURCE_V2_CONTRACT_VERSIONS.safe_projection),
  ref: ResourceRefV2Schema,
  label: SafeLabelSchema,
  href: HostRelativeHrefSchema.optional(),
  revision: RevisionSchema.optional(),
  updated_at: z.iso.datetime({ offset: true }).optional(),
});
export type ResourceSafeProjectionV2 = z.infer<typeof ResourceSafeProjectionV2Schema>;

const ResolveBase = {
  schema_version: z.literal(RESOURCE_V2_CONTRACT_VERSIONS.resolve),
  ref: ResourceRefV2Schema,
};

function sameRef(left: ResourceRefV2, right: ResourceRefV2): boolean {
  return left.schema_version === right.schema_version
    && left.provider.kind === right.provider.kind
    && left.provider.provider_instance_id === right.provider.provider_instance_id
    && left.resource_type === right.resource_type
    && left.resource_id === right.resource_id;
}

/** Unavailable states carry no stale label, snippet, body, or navigation. */
export const ResourceResolveResultV2Schema = z.discriminatedUnion('state', [
  z.strictObject({ ...ResolveBase, state: z.literal('available'),
    resource: ResourceSafeProjectionV2Schema }),
  z.strictObject({ ...ResolveBase, state: z.literal('unavailable') }),
  z.strictObject({ ...ResolveBase, state: z.literal('tombstoned') }),
  z.strictObject({ ...ResolveBase, state: z.literal('stale') }),
]).superRefine((result, ctx) => {
  if (result.state === 'available' && !sameRef(result.ref, result.resource.ref)) {
    ctx.addIssue({ code: 'custom', path: ['resource', 'ref'],
      message: 'Projection reference must match resolved reference' });
  }
});
export type ResourceResolveResultV2 = z.infer<typeof ResourceResolveResultV2Schema>;
