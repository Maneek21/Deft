import { z } from 'zod';
import { InstalledExperienceSchema, PublicActionDeclarationSchema } from './installed-authoring.js';
import { RuntimeActionSchema, RuntimePrivateCapabilitySchema, RuntimeRequirementSchema } from './runtime-authoring.js';
import { SyncDescriptorV1Schema } from './resource-sync.js';

const key = z.string().min(1).max(48).regex(/^[a-z][a-z0-9_]*$/)
  .refine((value) => !['constructor', 'prototype', '__proto__'].includes(value));

export const ResourceRuntimeRequirementSchema = z.union([
  RuntimeRequirementSchema,
  z.strictObject({ key, protocol_version: z.literal('deft.app_runtime_channel.v2') }),
]);

/** Authoring only. A v2 requirement asks for a private sync binding; it does
 * not select a provider, issue a grant, or grant installed Experience access. */
export const ResourceAuthoringShape = {
  runtime_requirements: z.array(ResourceRuntimeRequirementSchema).min(1).max(8),
  private_capabilities: z.array(RuntimePrivateCapabilitySchema).max(8),
  runtime_actions: z.array(RuntimeActionSchema).max(16),
  sync_descriptors: z.array(SyncDescriptorV1Schema).min(1).max(8),
  experiences: z.array(InstalledExperienceSchema).max(1),
  public_actions: z.array(PublicActionDeclarationSchema).max(8),
};

export const ResourceAuthoringSchema = z.strictObject(ResourceAuthoringShape).superRefine((value, ctx) => {
  for (const name of ['runtime_requirements', 'private_capabilities', 'runtime_actions',
    'sync_descriptors', 'experiences', 'public_actions'] as const) {
    if (new Set(value[name].map((item) => item.key)).size !== value[name].length) {
      ctx.addIssue({ code: 'custom', path: [name], message: 'Keys must be unique' });
    }
  }
  const requirementByKey = new Map(value.runtime_requirements.map((item) => [item.key, item]));
  const descriptorKeys = new Set(value.sync_descriptors.map((item) => item.key));
  const capabilityKeys = new Set(value.private_capabilities.map((item) => item.key));
  for (const [index, action] of value.runtime_actions.entries()) {
    if (!capabilityKeys.has(action.capability_key)
      || requirementByKey.get(action.runtime_requirement_key)?.protocol_version !== 'deft.app_runtime_channel.v1') {
      ctx.addIssue({ code: 'custom', path: ['runtime_actions', index],
        message: 'Runtime action must reference a declared capability and v1 Runtime requirement' });
    }
    if (descriptorKeys.has(action.key)) ctx.addIssue({ code: 'custom', path: ['runtime_actions', index, 'key'],
      message: 'Action and sync descriptor keys must not overlap' });
  }
  for (const [index, descriptor] of value.sync_descriptors.entries()) {
    if (requirementByKey.get(descriptor.runtime_requirement_key)?.protocol_version !== 'deft.app_runtime_channel.v2') {
      ctx.addIssue({ code: 'custom', path: ['sync_descriptors', index, 'runtime_requirement_key'],
        message: 'Sync descriptor must reference a declared v2 Runtime requirement' });
    }
    if (capabilityKeys.has(descriptor.key)) ctx.addIssue({ code: 'custom', path: ['sync_descriptors', index, 'key'],
      message: 'Sync descriptor and action capability keys must not overlap' });
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

export const ResourceRequestedAuthoritySchema = z.strictObject({
  requirements: ResourceAuthoringSchema,
  classification: z.strictObject({ authority_state: z.literal('requested_only'), executable: z.literal(false),
    provider_access: z.literal(false), review_required: z.literal(true) }),
});
