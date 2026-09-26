import { z } from 'zod';
import { NativeActionSchema, NativeAuthoringShape, refineNativeAuthoring } from './native-authoring.js';
import { ResourceRuntimeRequirementSchema } from './resource-authoring.js';
import { SyncDescriptorV2Schema } from './resource-sync-attachments.js';

const requirementV3 = z.strictObject({
  key: ResourceRuntimeRequirementSchema.options[1].shape.key,
  protocol_version: z.literal('deft.app_runtime_channel.v3'),
});
export const AttachmentAuthoringShape = {
  ...NativeAuthoringShape,
  runtime_requirements: z.array(z.union([ResourceRuntimeRequirementSchema, requirementV3])).min(1).max(8),
  native_actions: z.array(NativeActionSchema).max(8),
  sync_descriptors: z.array(SyncDescriptorV2Schema).min(1).max(8),
};
export const AttachmentAuthoringSchema = z.strictObject(AttachmentAuthoringShape).superRefine((value, ctx) => {
  for (const [index, descriptor] of value.sync_descriptors.entries()) {
    if (!value.runtime_requirements.some(item => item.key === descriptor.runtime_requirement_key
      && item.protocol_version === 'deft.app_runtime_channel.v3')) {
      ctx.addIssue({ code: 'custom', path: ['sync_descriptors', index, 'runtime_requirement_key'],
        message: 'Attachment sync must reference a declared v3 Runtime requirement' });
    }
  }
  // Reuse declaration relationships only. This never parses a v2 host credential
  // or projects authority; the actual descriptor2 policy remains in value.
  refineNativeAuthoring({ ...value,
    runtime_requirements: value.runtime_requirements.map(item => item.protocol_version === 'deft.app_runtime_channel.v3'
      ? { ...item, protocol_version: 'deft.app_runtime_channel.v2' as const } : item),
    sync_descriptors: value.sync_descriptors.map(({ attachments: _attachments, ...item }) =>
      ({ ...item, schema_version: 'deft.app_sync_descriptor.v1' as const })),
  }, ctx);
});
export const AttachmentRequestedAuthoritySchema = z.strictObject({
  requirements: AttachmentAuthoringSchema,
  classification: z.strictObject({ authority_state: z.literal('requested_only'), executable: z.literal(false),
    provider_access: z.literal(false), review_required: z.literal(true) }),
});
