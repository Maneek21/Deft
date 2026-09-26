import { z } from 'zod';
import { DeftExperienceReferenceSchema } from './experience.js';
import { RuntimeAuthoringShape, RuntimeAuthoringSchema } from './runtime-authoring.js';

const key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)
  .refine((value) => !['constructor', 'prototype'].includes(value));
export const PUBLIC_AVAILABILITY_SCALAR_TYPES = Object.freeze(['text', 'number', 'boolean', 'date', 'datetime', 'single_select']);
export const InstalledExperienceSchema = DeftExperienceReferenceSchema.extend({
  key, label: z.string().min(1).max(80).regex(/^[^\u0000-\u001f\u007f<>]+$/),
});
export const PublicAvailabilityPolicySchema = z.strictObject({
  schema_version: z.literal('deft.app_public_availability.v1'),
  fields: z.array(key).min(1).max(8).refine(fields => new Set(fields).size === fields.length),
  claim_deadline_field: key,
  page_size: z.number().int().min(1).max(10),
});
export const PublicActionDeclarationSchema = z.strictObject({
  key, action_key: key, module_id: z.string().min(1).max(128),
  collection_key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  input_mapping: z.record(key, z.enum(['claim.resource_id', 'claim.claim_id']))
    .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 32),
  availability: PublicAvailabilityPolicySchema.optional(),
});
export const InstalledAuthoringShape = {
  ...RuntimeAuthoringShape,
  experiences: z.array(InstalledExperienceSchema).max(1),
  public_actions: z.array(PublicActionDeclarationSchema).max(8),
};
export const InstalledAuthoringSchema = z.strictObject(InstalledAuthoringShape).superRefine((value, ctx) => {
  const runtime = RuntimeAuthoringSchema.safeParse({ runtime_requirements: value.runtime_requirements,
    private_capabilities: value.private_capabilities, runtime_actions: value.runtime_actions });
  if (!runtime.success) for (const issue of runtime.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  if (new Set(value.public_actions.map((item) => item.key)).size !== value.public_actions.length) {
    ctx.addIssue({ code: 'custom', path: ['public_actions'], message: 'Public action keys must be unique' });
  }
  for (const [index, declaration] of value.public_actions.entries()) {
    const action = value.runtime_actions.find((item) => item.key === declaration.action_key);
    const capability = value.private_capabilities.find((item) => item.key === action?.capability_key);
    if (!capability || capability.input_schema.required.some((field) => !Object.hasOwn(declaration.input_mapping, field))
      || Object.keys(declaration.input_mapping).some((field) => {
        const schema = capability.input_schema.properties[field];
        return !schema || schema.type !== 'string' || schema.maxLength < 36;
      })) ctx.addIssue({ code: 'custom', path: ['public_actions', index],
        message: 'Public input must map declared string fields from canonical claim identifiers and cover every required field' });
  }
});
export const InstalledRequestedAuthoritySchema = z.strictObject({
  requirements: InstalledAuthoringSchema,
  classification: z.strictObject({ authority_state: z.literal('requested_only'), executable: z.literal(false),
    provider_access: z.literal(false), review_required: z.literal(true) }),
});
