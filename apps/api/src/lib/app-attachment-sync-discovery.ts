import { z } from 'zod';
import { SyncDescriptorV2Schema, SyncPageV2Schema, SyncRequestV2Schema, type SyncDescriptorV2 } from '@deft/app-kit/core';
import { createCapabilityProviderDiscoverySnapshot } from '@deft/shared';

/** Safe declaration snapshot; parser/retained owner policy remain enforcement. */
export async function createAttachmentSyncDiscoverySnapshot(input: {
  org_id: string; registration_id: string; descriptor: SyncDescriptorV2; captured_at: Date;
}) {
  const descriptor = SyncDescriptorV2Schema.parse(input.descriptor);
  // Zod may attach non-enumerable generator metadata. The discovery carrier
  // accepts only plain JSON; materialize generated schemas before hashing.
  const schemaJson = (schema: z.ZodType): Record<string, unknown> => JSON.parse(JSON.stringify(
    z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' })));
  const provider = { org_id: input.org_id, provider_kind: 'app_runtime' as const, provider_instance_id: input.registration_id };
  return createCapabilityProviderDiscoverySnapshot({ adapter_contract_version: 'deft.app_runtime_channel.v3', provider,
    captured_at: input.captured_at.toISOString(), operations: [{ identity: { provider, operation_name: `sync_${descriptor.key}` },
      title: `Sync ${descriptor.key}`, description: '',
      input_schema: schemaJson(SyncRequestV2Schema),
      output_schema: schemaJson(SyncPageV2Schema) }],
  });
}

/** Exact reviewed discovery shape before preview58 added PDF. Only private
 * Sync administrative closure uses this reconstruction; it grants no delivery. */
export async function createLegacyPrePdfAttachmentSyncDiscoverySnapshot(input: Parameters<typeof createAttachmentSyncDiscoverySnapshot>[0]) {
  const current = await createAttachmentSyncDiscoverySnapshot(input);
  const operation = current.operations[0]!;
  const schema = structuredClone(operation.input_schema) as {
    properties: { attachments: { properties: { allowed_media_types: { items: { enum: string[] }; maxItems: number } } } };
  };
  const media = schema.properties.attachments.properties.allowed_media_types;
  if (media.maxItems !== 8 || media.items.enum.length !== 8 || media.items.enum[7] !== 'application/pdf') {
    throw new Error('Legacy private Sync discovery shape unavailable');
  }
  media.items.enum.pop(); media.maxItems = 7;
  return createCapabilityProviderDiscoverySnapshot({ adapter_contract_version: current.adapter_contract_version,
    provider: current.provider, captured_at: current.captured_at, operations: [{
      identity: operation.identity, title: operation.title, description: operation.description,
      input_schema: schema, output_schema: operation.output_schema,
    }] });
}
