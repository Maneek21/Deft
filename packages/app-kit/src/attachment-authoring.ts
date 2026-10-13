import { z } from 'zod';
import { PrivateStateDeclarationsSchema } from './private-state.js';
import { NativeActionSchema, NativeAuthoringShape, refineNativeAuthoring } from './native-authoring.js';
import { ResourceRuntimeRequirementSchema } from './resource-authoring.js';
import { SyncDescriptorV2Schema } from './resource-sync-attachments.js';
import { OwnerConnectionPolicyDeclarationsSchema } from './owner-connection-policy.js';
import { ResourceContentDeclarationsSchema } from './resource-content-policy.js';
import { RecordStoreDeclarationsSchema } from './app-data.js';
import {AppIntegrationToolsDeclarationSchema} from './app-integration-tools.js';
import {appIntegrationSourceMappingIsDeclared} from './app-integration-source-mapping.js';

const requirementV3 = z.strictObject({
  key: ResourceRuntimeRequirementSchema.options[1].shape.key,
  protocol_version: z.literal('deft.app_runtime_channel.v3'),
});
export const AttachmentAuthoringShape = {
  ...NativeAuthoringShape,
  private_state: PrivateStateDeclarationsSchema.optional(),
  owner_connections: OwnerConnectionPolicyDeclarationsSchema.optional(),
  resource_content: ResourceContentDeclarationsSchema.optional(),
  record_stores: RecordStoreDeclarationsSchema.optional(),
  integration_tools:AppIntegrationToolsDeclarationSchema.optional(),
  runtime_requirements: z.array(z.union([ResourceRuntimeRequirementSchema, requirementV3])).min(1).max(8),
  native_actions: z.array(NativeActionSchema).max(8),
  sync_descriptors: z.array(SyncDescriptorV2Schema).min(1).max(8),
};
export const AttachmentAuthoringSchema = z.strictObject(AttachmentAuthoringShape).superRefine((value, ctx) => {
  for(const [index,tool] of (value.integration_tools??[]).entries()){
    if(!value.record_stores?.some(store=>store.key===tool.store_key&&store.resource_key===tool.resource_key&&store.runtime_requirement_key===tool.runtime_requirement_key)
      ||tool.action_key&&!value.runtime_actions.some(action=>action.key===tool.action_key))ctx.addIssue({code:'custom',path:['integration_tools',index],message:'Integration tool must map one signed store/resource/runtime and declared action'});
  }
  for (const [index, store] of (value.record_stores ?? []).entries()) {
    if (store.source_projection) {
      const descriptor = value.sync_descriptors.find(row => row.key === store.resource_key
        && row.key === store.source_projection!.sync_descriptor_key && row.requested_visibility === 'user_private'
        && row.runtime_requirement_key === store.runtime_requirement_key);
      if (!descriptor || !appIntegrationSourceMappingIsDeclared(store.source_projection, descriptor, value.experiences.map(row => row.key)))
        ctx.addIssue({code:'custom',path:['record_stores',index,'source_projection'],message:'Source mapping requires current signed bounded fields and declared navigation'});
    }
    if (!value.sync_descriptors.some(resource => resource.key === store.resource_key && resource.requested_visibility === 'user_private'
      && resource.runtime_requirement_key === store.runtime_requirement_key)
      || !value.owner_connections?.some(policy => policy.resource_key === store.resource_key && policy.provider_profile_key
        && policy.runtime_requirement_key === store.runtime_requirement_key)) {
      ctx.addIssue({code:'custom',path:['record_stores',index],message:'Record store requires its declared private resource and reviewed external profile'});
    }
  }
  for (const [index, content] of (value.resource_content ?? []).entries()) {
    if (!value.sync_descriptors.some(resource => resource.key === content.resource_key && resource.requested_visibility === 'user_private')) {
      ctx.addIssue({ code: 'custom', path: ['resource_content', index, 'resource_key'], message: 'Content policy must reference a declared user-private resource' });
    }
  }
  for (const [policyIndex, policy] of (value.owner_connections ?? []).entries()) {
    if (policy.runtime_requirement_key !== undefined && (!value.runtime_requirements.some(requirement =>
      requirement.key === policy.runtime_requirement_key && requirement.protocol_version === 'deft.app_runtime_channel.v3')
      || !value.sync_descriptors.some(resource => resource.key === policy.resource_key
        && resource.runtime_requirement_key === policy.runtime_requirement_key))) {
      ctx.addIssue({ code: 'custom', path: ['owner_connections', policyIndex, 'runtime_requirement_key'],
        message: 'Connection profile must reference the declared resource v3 Runtime requirement' });
    }
    if (!value.sync_descriptors.some(resource => resource.key === policy.resource_key
      && resource.requested_visibility === 'user_private')) {
      ctx.addIssue({ code: 'custom', path: ['owner_connections', policyIndex, 'resource_key'],
        message: 'Owner connection policy must reference a declared user-private resource' });
    }
    for (const [actionIndex, actionKey] of policy.action_keys.entries()) {
      if (!value.runtime_actions.some(action => action.key === actionKey)) {
        ctx.addIssue({ code: 'custom', path: ['owner_connections', policyIndex, 'action_keys', actionIndex],
          message: 'Owner connection policy must reference a declared Runtime action' });
      }
    }
  }
  const payloadActions = new Set<string>();
  for (const [stateIndex, state] of (value.private_state ?? []).entries()) {
    for (const [payloadIndex, payload] of (state.action_payloads ?? []).entries()) {
      if (!value.runtime_actions.some(action => action.key === payload.action_key)) {
        ctx.addIssue({ code: 'custom', path: ['private_state', stateIndex, 'action_payloads', payloadIndex, 'action_key'],
          message: 'Payload must reference a declared Runtime action' });
      }
      if (payloadActions.has(payload.action_key)) {
        ctx.addIssue({ code: 'custom', path: ['private_state', stateIndex, 'action_payloads', payloadIndex, 'action_key'],
          message: 'A Runtime action may have only one payload state' });
      }
      payloadActions.add(payload.action_key);
    }
  }
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
