import { z } from 'zod';

const key = z.string().min(1).max(48).regex(/^[a-z][a-z0-9_]*$/)
  .refine((value) => !['constructor', 'prototype', '__proto__'].includes(value));
const field = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('string'), maxLength: z.number().int().min(1).max(16_384),
    minLength: z.number().int().min(0).max(16_384).optional(), format: z.literal('email').optional(),
    title: z.string().min(1).max(80).regex(/^[^\u0000-\u001f\u007f<>]+$/).optional(), readOnly: z.boolean().optional() }),
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
    if (definition.type === 'string' && definition.format === 'email') validator = z.string().min(definition.minLength ?? 0).max(definition.maxLength).email();
    shape[name] = schema.required.includes(name) ? validator : validator.optional();
  }
  return z.strictObject(shape).parse(value) as Record<string, string | number | boolean>;
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
