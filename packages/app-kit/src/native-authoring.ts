import { z } from 'zod';
import { InstalledExperienceSchema, PublicActionDeclarationSchema, PublicAvailabilityPolicySchema } from './installed-authoring.js';
import { ResourceRuntimeRequirementSchema } from './resource-authoring.js';
import { RuntimeActionSchema, RuntimePrivateCapabilitySchema } from './runtime-authoring.js';
import { SyncDescriptorV1Schema } from './resource-sync.js';

const key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)
  .refine(value => !['constructor', 'prototype', '__proto__'].includes(value));
const operation = z.enum(['calendar.events.create.v1', 'calendar.events.cancel.v1']);
export type NativeCalendarOperation = z.infer<typeof operation>;

function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function sameJson(value: unknown, expected: unknown): boolean {
  if (value === expected) return true;
  if (Array.isArray(expected)) return Array.isArray(value) && value.length === expected.length
    && expected.every((item, index) => sameJson(value[index], item));
  if (!expected || typeof expected !== 'object' || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const a = Object.keys(value), b = Object.keys(expected);
  return a.length === b.length && b.every(name => Object.hasOwn(value, name)
    && sameJson((value as Record<string, unknown>)[name], (expected as Record<string, unknown>)[name]));
}
const calendarRefJson = {
  type: 'object', additionalProperties: false, required: ['schema_version', 'provider', 'resource_type', 'resource_id'],
  properties: {
    schema_version: { const: 'deft.resource_ref.v2' },
    provider: { type: 'object', additionalProperties: false, required: ['kind', 'provider_instance_id'],
      properties: { kind: { const: 'core' }, provider_instance_id: { const: 'calendar_events' } } },
    resource_type: { const: 'calendar_event' }, resource_id: { type: 'string', minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' },
  },
} as const;
const result = (schema: string, status: string) => ({
  type: 'object', additionalProperties: false, required: ['schema_version', 'event_ref', 'status'],
  properties: { schema_version: { const: schema }, event_ref: calendarRefJson, status: { const: status } },
});

/** Host-certified declarations. These select an interface, never authority or executable validators. */
export const NATIVE_CALENDAR_CONTRACTS = immutable({
  'calendar.events.create.v1': {
    input_schema: {
      type: 'object', additionalProperties: false, required: ['title', 'start', 'end'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        start: { type: 'string', format: 'date-time' }, end: { type: 'string', format: 'date-time' },
        description: { type: 'string', maxLength: 4096 }, location: { type: 'string', maxLength: 512 },
        attendees: { type: 'array', maxItems: 20, items: {
          type: 'object', additionalProperties: false, required: ['email'],
          properties: { email: { type: 'string', format: 'email', maxLength: 320 }, displayName: { type: 'string', maxLength: 120 } },
        } },
      },
    },
    output_schema: result('deft.native_calendar_create_result.v1', 'created'),
  },
  'calendar.events.cancel.v1': {
    input_schema: { type: 'object', additionalProperties: false, required: ['create_run_id', 'event_ref'],
      properties: { create_run_id: { type: 'string', format: 'uuid' }, event_ref: calendarRefJson } },
    output_schema: result('deft.native_calendar_cancel_result.v1', 'cancelled'),
  },
});
type CertifiedInput = typeof NATIVE_CALENDAR_CONTRACTS[NativeCalendarOperation]['input_schema'];
type CertifiedOutput = typeof NATIVE_CALENDAR_CONTRACTS[NativeCalendarOperation]['output_schema'];
const certified = <T>(select: (contract: typeof NATIVE_CALENDAR_CONTRACTS[NativeCalendarOperation]) => T) =>
  z.custom<T>(value => Object.values(NATIVE_CALENDAR_CONTRACTS).some(contract => sameJson(value, select(contract))),
    'Native schemas must exactly match a host-certified Calendar interface');
export const NativePrivateCapabilitySchema = z.strictObject({
  key, version: z.literal('1'), input_schema: certified<CertifiedInput>(contract => contract.input_schema),
  output_schema: certified<CertifiedOutput>(contract => contract.output_schema),
});
export const NativeActionSchema = z.strictObject({
  key: key.refine(value => !/^(deft|core|system)(_|$)/.test(value)),
  label: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f<>]+$/), capability_key: key, operation,
});
export const NATIVE_ACTION_HOST_POLICY = immutable({
  risk_class: 'internal_write', review_requirement: 'always', review_scope: 'per_invocation',
  retry_class: 'idempotent_with_key', retention_class: 'standard', automation_allowed: false,
} as const);

const calendarRef = z.strictObject({
  schema_version: z.literal('deft.resource_ref.v2'),
  provider: z.strictObject({ kind: z.literal('core'), provider_instance_id: z.literal('calendar_events') }),
  resource_type: z.literal('calendar_event'), resource_id: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
});
const createInput = z.strictObject({
  title: z.string().min(1).max(200), start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }),
  description: z.string().max(4096).optional(), location: z.string().max(512).optional(),
  attendees: z.array(z.strictObject({ email: z.email().max(320), displayName: z.string().max(120).optional() })).max(20).optional(),
}).refine(value => Date.parse(value.end) > Date.parse(value.start), 'Calendar end must follow start');
const cancelInput = z.strictObject({ create_run_id: z.uuid(), event_ref: calendarRef });
export type NativeCalendarCreateInput = z.infer<typeof createInput>;
export type NativeCalendarCancelInput = z.infer<typeof cancelInput>;
export function parseNativeCalendarInput(name: 'calendar.events.create.v1', value: unknown): NativeCalendarCreateInput;
export function parseNativeCalendarInput(name: 'calendar.events.cancel.v1', value: unknown): NativeCalendarCancelInput;
export function parseNativeCalendarInput(name: NativeCalendarOperation, value: unknown): NativeCalendarCreateInput | NativeCalendarCancelInput;
export function parseNativeCalendarInput(name: NativeCalendarOperation, value: unknown): NativeCalendarCreateInput | NativeCalendarCancelInput {
  operation.parse(name);
  const parsed = name === 'calendar.events.create.v1' ? createInput.parse(value) : cancelInput.parse(value);
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > 8192) throw new TypeError('Native Calendar input exceeds 8192 bytes');
  return parsed;
}
export function parseNativeCalendarResult(name: NativeCalendarOperation, value: unknown) {
  operation.parse(name);
  return name === 'calendar.events.create.v1'
    ? z.strictObject({ schema_version: z.literal('deft.native_calendar_create_result.v1'), event_ref: calendarRef, status: z.literal('created') }).parse(value)
    : z.strictObject({ schema_version: z.literal('deft.native_calendar_cancel_result.v1'), event_ref: calendarRef, status: z.literal('cancelled') }).parse(value);
}

export const NativePublicInputSourceSchema = z.union([
  z.strictObject({ source: z.literal('claim.resource_id') }),
  z.strictObject({ source: z.literal('claim.claim_id') }),
  z.strictObject({ source: z.literal('record.field'), field_key: key }),
]);
export const NativePublicActionDeclarationSchema = z.strictObject({
  key, action_key: key, module_id: z.string().min(1).max(128), collection_key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  input_mapping: z.record(key, NativePublicInputSourceSchema).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 8),
  availability: PublicAvailabilityPolicySchema.optional(),
});
export type NativePublicActionDeclaration = z.infer<typeof NativePublicActionDeclarationSchema>;
export const NativeAuthoringShape = {
  runtime_requirements: z.array(ResourceRuntimeRequirementSchema).max(8),
  private_capabilities: z.array(z.union([RuntimePrivateCapabilitySchema, NativePrivateCapabilitySchema])).max(16),
  runtime_actions: z.array(RuntimeActionSchema).max(16), native_actions: z.array(NativeActionSchema).min(1).max(8),
  sync_descriptors: z.array(SyncDescriptorV1Schema).max(8), experiences: z.array(InstalledExperienceSchema).max(1),
  public_actions: z.array(z.union([PublicActionDeclarationSchema, NativePublicActionDeclarationSchema])).max(8),
};
/** Shared declaration relationships; shape/version admission stays in each parser. */
export function refineNativeAuthoring(value: z.infer<z.ZodObject<typeof NativeAuthoringShape>>, ctx: z.RefinementCtx) {
  const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  for (const name of Object.keys(NativeAuthoringShape) as (keyof typeof NativeAuthoringShape)[]) {
    if (new Set(value[name].map(item => item.key)).size !== value[name].length) fail([name], 'Keys must be unique');
  }
  const actionKeys = [...value.runtime_actions, ...value.native_actions, ...value.sync_descriptors].map(item => item.key);
  if (new Set(actionKeys).size !== actionKeys.length) fail(['native_actions'], 'Native, Runtime and sync keys must not overlap');
  const capabilities = new Map(value.private_capabilities.map(item => [item.key, item]));
  const requirements = new Map(value.runtime_requirements.map(item => [item.key, item]));
  for (const [index, action] of value.native_actions.entries()) {
    const capability = capabilities.get(action.capability_key);
    const contract = NATIVE_CALENDAR_CONTRACTS[action.operation];
    if (!capability || !sameJson(capability.input_schema, contract.input_schema)
      || !sameJson(capability.output_schema, contract.output_schema)) {
      fail(['native_actions', index], 'Native action requires its exact certified input/output pair');
    }
  }
  for (const [index, action] of value.runtime_actions.entries()) {
    if (!RuntimePrivateCapabilitySchema.safeParse(capabilities.get(action.capability_key)).success
      || requirements.get(action.runtime_requirement_key)?.protocol_version !== 'deft.app_runtime_channel.v1') {
      fail(['runtime_actions', index], 'Runtime action requires a scalar capability and v1 Runtime requirement');
    }
  }
  for (const [index, descriptor] of value.sync_descriptors.entries()) {
    if (requirements.get(descriptor.runtime_requirement_key)?.protocol_version !== 'deft.app_runtime_channel.v2'
      || capabilities.has(descriptor.key)) fail(['sync_descriptors', index], 'Sync requires v2 and a separate capability key');
  }
  for (const [index, declaration] of value.public_actions.entries()) {
    const native = value.native_actions.find(action => action.key === declaration.action_key);
    if (native) {
      const mapping = NativePublicActionDeclarationSchema.safeParse(declaration);
      const input = NATIVE_CALENDAR_CONTRACTS[native.operation].input_schema;
      if (!mapping.success || input.required.some(field => !Object.hasOwn(declaration.input_mapping, field))
        || Object.keys(declaration.input_mapping).some(field => !Object.hasOwn(input.properties, field)
          || (input.properties as Record<string, { type: string }>)[field]?.type !== 'string')) {
        fail(['public_actions', index], 'Native public inputs require closed scalar mappings covering every required field');
      }
    } else {
      const runtime = value.runtime_actions.find(action => action.key === declaration.action_key);
      const capability = RuntimePrivateCapabilitySchema.safeParse(capabilities.get(runtime?.capability_key ?? ''));
      if (!PublicActionDeclarationSchema.safeParse(declaration).success || !capability.success
        || capability.data.input_schema.required.some(field => !Object.hasOwn(declaration.input_mapping, field))
        || Object.keys(declaration.input_mapping).some(field => {
          if (!capability.success) return true;
          const schema = capability.data.input_schema.properties[field];
          return !schema || schema.type !== 'string' || schema.maxLength < 36;
        })) fail(['public_actions', index], 'Runtime public inputs retain canonical claim string mappings');
    }
  }
}
export const NativeAuthoringSchema = z.strictObject(NativeAuthoringShape).superRefine(refineNativeAuthoring);
export const NativeRequestedAuthoritySchema = z.strictObject({
  requirements: NativeAuthoringSchema,
  classification: z.strictObject({ authority_state: z.literal('requested_only'), executable: z.literal(false),
    provider_access: z.literal(false), review_required: z.literal(true) }),
});
