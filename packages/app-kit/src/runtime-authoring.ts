import { z } from 'zod';
import { parseAddressList } from './structured-address.js';
import { parseBasicRichtextHtml } from './safe-rich-text.js';
import { parseResourceRecordList } from './resource-record-list.js';

const key = z.string().min(1).max(48).regex(/^[a-z][a-z0-9_]*$/)
  .refine((value) => !['constructor', 'prototype', '__proto__'].includes(value));
const field = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('string'), maxLength: z.number().int().min(1).max(16_384),
    minLength: z.number().int().min(0).max(16_384).optional(), format: z.enum(['email', 'single_line', 'mailbox_list', 'safe_html', 'resource_record_list', 'opaque_account_reference']).optional(),
    maxItems: z.number().int().min(1).max(32).optional(),
    plainTextKey: key.optional(), resourceKey: key.optional(),
    title: z.string().min(1).max(80).regex(/^[^\u0000-\u001f\u007f<>]+$/).optional(), readOnly: z.boolean().optional() }).refine(
      value => value.format === 'mailbox_list' ? value.maxItems !== undefined && value.maxLength <= 2048
        : value.format === 'resource_record_list' ? value.maxItems !== undefined && value.maxItems <= 25 && value.maxLength <= 925
          : value.maxItems === undefined,
      { message: 'maxItems must match the reviewed list format', path: ['maxItems'] })
      .refine(value => value.format === 'safe_html' ? value.plainTextKey !== undefined : value.plainTextKey === undefined,
        { message: 'plainTextKey is required only for safe_html fields', path: ['plainTextKey'] })
      .refine(value => value.format === 'resource_record_list' ? value.resourceKey !== undefined : value.resourceKey === undefined,
        { message: 'resourceKey is required only for resource_record_list fields', path: ['resourceKey'] })
      .refine(value => value.format !== 'opaque_account_reference' || value.minLength === 1 && value.maxLength === 512,
        { message: 'Opaque account references require exact bounds 1 through 512', path: ['format'] }),
  z.strictObject({ type: z.literal('number'), minimum: z.number().finite(), maximum: z.number().finite() })
    .refine((value) => value.minimum <= value.maximum),
  z.strictObject({ type: z.literal('boolean') }),
]);

/** Closed first Runtime interface: bounded scalar objects, no refs or executable validators. */
export const RuntimeObjectSchema = z.strictObject({
  type: z.literal('object'),
  properties: z.record(key, field),
  required: z.array(key).max(32),
  additionalProperties: z.literal(false),
}).superRefine((value, ctx) => {
  for (const [name, definition] of Object.entries(value.properties)) if (definition.type === 'string' && (definition.minLength ?? 0) > definition.maxLength) {
    ctx.addIssue({code:'custom',path:['properties',name,'minLength'],message:'Minimum length exceeds maximum length'});
  }
  const plainKeys = new Set<string>();
  for (const [name, definition] of Object.entries(value.properties)) if (definition.type === 'string' && definition.format === 'safe_html') {
    const plainKey = definition.plainTextKey!, plain = value.properties[plainKey];
    if (name === plainKey || plainKeys.has(plainKey) || plain?.type !== 'string' || plain.format !== undefined
      || plain.readOnly !== true || (value.required.includes(name) && !value.required.includes(plainKey))) {
      ctx.addIssue({ code: 'custom', path: ['properties', name, 'plainTextKey'], message: 'Rich input must pair with a distinct declared read-only plain string' });
    }
    plainKeys.add(plainKey);
  }
  if (Object.keys(value.properties).length > 32 || new Set(value.required).size !== value.required.length
    || value.required.some((name) => !Object.hasOwn(value.properties, name))) {
    ctx.addIssue({ code: 'custom', message: 'Runtime object fields must be bounded, unique and declared' });
  }
});
export type RuntimeObjectContract = z.infer<typeof RuntimeObjectSchema>;

export function parseRuntimeObjectInput(contract: RuntimeObjectContract, value: unknown): Record<string, string | number | boolean> {
  const schema = RuntimeObjectSchema.parse(contract);
  const shape: Record<string, z.ZodType> = Object.create(null);
  for (const [name, definition] of Object.entries(schema.properties)) {
    let validator: z.ZodType = definition.type === 'string' ? z.string().min(definition.minLength ?? 0).max(definition.maxLength)
      : definition.type === 'number' ? z.number().finite().min(definition.minimum).max(definition.maximum)
        : z.boolean();
    if (definition.type === 'string' && definition.format === 'opaque_account_reference') validator = z.string()
      .min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u);
    if (definition.type === 'string' && definition.format === 'email') validator = z.string().min(definition.minLength ?? 0).max(definition.maxLength).email();
    if (definition.type === 'string' && definition.format === 'single_line') validator = z.string()
      .min(definition.minLength ?? 0).max(definition.maxLength).regex(/^[^\r\n\0]*$/u);
    if (definition.type === 'string' && definition.format === 'mailbox_list') validator = z.string()
      .min(definition.minLength ?? 0).max(definition.maxLength).superRefine((text, ctx) => {
        try { parseAddressList(text, { maxItems: definition.maxItems, allowEmpty: (definition.minLength ?? 0) === 0 }); }
        catch { ctx.addIssue({ code: 'custom', message: 'Enter a valid bounded address list' }); }
      });
    if (definition.type === 'string' && definition.format === 'safe_html') validator = z.string()
      .min(definition.minLength ?? 0).max(definition.maxLength).superRefine((text, ctx) => {
        try { parseBasicRichtextHtml(text, { maxCharacters: definition.maxLength }); }
        catch { ctx.addIssue({ code: 'custom', message: 'Enter a canonical bounded rich-text document' }); }
      });
    if (definition.type === 'string' && definition.format === 'resource_record_list') validator = z.string()
      .min(definition.minLength ?? 0).max(definition.maxLength).superRefine((text, ctx) => {
        try { parseResourceRecordList(text, { maxItems: definition.maxItems, allowEmpty: (definition.minLength ?? 0) === 0 }); }
        catch { ctx.addIssue({ code: 'custom', message: 'Enter a distinct bounded record list' }); }
      });
    shape[name] = schema.required.includes(name) ? validator : validator.optional();
  }
  return z.strictObject(shape).superRefine((input, ctx) => {
    for (const [name, definition] of Object.entries(schema.properties)) if (definition.type === 'string' && definition.format === 'safe_html'
      && typeof input[name] === 'string' && input[name] !== '') {
      try { if (parseBasicRichtextHtml(input[name] as string).plainText !== input[definition.plainTextKey!])
        ctx.addIssue({ code: 'custom', path: [definition.plainTextKey!], message: 'Plain input must exactly match the rich-text document' }); }
      catch { /* The field validator reports malformed HTML. */ }
    }
  }).parse(value) as Record<string, string | number | boolean>;
}

export const RuntimeRequirementSchema = z.strictObject({
  key,
  protocol_version: z.literal('deft.app_runtime_channel.v1'),
});
export const RuntimePrivateCapabilitySchema = z.strictObject({
  key,
  version: z.literal('1'),
  input_schema: RuntimeObjectSchema,
  output_schema: RuntimeObjectSchema,
});
export const RuntimeActionSchema = z.strictObject({
  key: key.refine((value) => !/^(deft|core|system)(_|$)/.test(value), 'Action keys must not use a reserved host prefix'),
  label: z.string().min(1).max(80).regex(/^[^\u0000-\u001f\u007f<>]+$/),
  capability_key: key,
  runtime_requirement_key: key,
});
export const RuntimeAuthoringShape = {
  runtime_requirements: z.array(RuntimeRequirementSchema).min(1).max(8),
  private_capabilities: z.array(RuntimePrivateCapabilitySchema).min(1).max(8),
  runtime_actions: z.array(RuntimeActionSchema).min(1).max(16),
};
export const RuntimeAuthoringSchema = z.strictObject(RuntimeAuthoringShape).superRefine((value, ctx) => {
  for (const name of ['runtime_requirements', 'private_capabilities', 'runtime_actions'] as const) {
    if (new Set(value[name].map((item) => item.key)).size !== value[name].length) {
      ctx.addIssue({ code: 'custom', path: [name], message: 'Keys must be unique' });
    }
  }
  for (const [index, action] of value.runtime_actions.entries()) {
    if (!value.private_capabilities.some((item) => item.key === action.capability_key)
      || !value.runtime_requirements.some((item) => item.key === action.runtime_requirement_key)) {
      ctx.addIssue({ code: 'custom', path: ['runtime_actions', index], message: 'Action must reference declared capability and Runtime requirements' });
    }
  }
});

/** This policy is selected by the host; authors cannot weaken it. */
export const RUNTIME_ACTION_HOST_POLICY = Object.freeze({
  risk_class: 'external_write', review_requirement: 'always', review_scope: 'per_invocation',
  retry_class: 'unsafe_or_unknown', retention_class: 'standard',
} as const);

export const RuntimeRequestedAuthoritySchema = z.strictObject({
  requirements: RuntimeAuthoringSchema,
  classification: z.strictObject({
    authority_state: z.literal('requested_only'), executable: z.literal(false),
    provider_access: z.literal(false), review_required: z.literal(true),
  }),
});
