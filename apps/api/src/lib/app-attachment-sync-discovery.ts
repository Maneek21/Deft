import { z } from 'zod';
import { SyncDescriptorV2Schema, SyncPageV2Schema, SyncRequestV2Schema, type SyncDescriptorV2 } from '@deft/app-kit';
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
