import { createCapabilityProviderDiscoverySnapshot } from '@deft/shared';
import { parseSyncDescriptor, type SyncDescriptorV1 } from '@deft/app-kit/experimental/resource-sync';

type JsonSchema = Record<string, unknown>;

function scalarField(value: SyncDescriptorV1['record_schema']['properties'][string]): JsonSchema {
  if (value.type === 'string') return { type: 'string', maxLength: value.maxLength };
  if (value.type === 'number') return { type: 'number', minimum: value.minimum, maximum: value.maximum };
  return { type: 'boolean' };
}

const opaqueId = { type: 'string', minLength: 1, maxLength: 256,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' } as const;
const revision = { type: 'string', minLength: 1, maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' } as const;
const cursor = { anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 2_048 }] } as const;

/** Safe discovery only. The Kit parser remains the execution authority for
 * UTF-8 bytes, combined item counts, duplicate IDs and cursor progression. */
export function resourceSyncDiscoverySchemas(rawDescriptor: SyncDescriptorV1): Readonly<{
  input_schema: JsonSchema; output_schema: JsonSchema;
}> {
  const descriptor = parseSyncDescriptor(rawDescriptor);
  const recordProperties = Object.fromEntries(Object.entries(descriptor.record_schema.properties)
    .map(([key, value]) => [key, scalarField(value)]));
  const data = { type: 'object', properties: recordProperties,
    required: descriptor.record_schema.required, additionalProperties: false };
  const upsert = { type: 'object', properties: { id: opaqueId, revision, data },
    required: ['id', 'revision', 'data'], additionalProperties: false };
  const tombstone = { type: 'object', properties: { id: opaqueId, revision },
    required: ['id', 'revision'], additionalProperties: false };
  return Object.freeze({
    input_schema: { type: 'object', properties: {
      schema_version: { const: 'deft.app_sync_request.v1' }, cursor,
      max_items: { type: 'integer', minimum: 1, maximum: 100 },
    }, required: ['schema_version', 'cursor', 'max_items'], additionalProperties: false },
    output_schema: { type: 'object', properties: {
      schema_version: { const: 'deft.app_sync_page.v1' },
      upserts: { type: 'array', maxItems: 100, items: upsert },
      tombstones: { type: 'array', maxItems: 100, items: tombstone },
      next_cursor: cursor, has_more: { type: 'boolean' },
    }, required: ['schema_version', 'upserts', 'tombstones', 'next_cursor', 'has_more'],
    additionalProperties: false },
  });
}

export async function createResourceSyncDiscoverySnapshot(input: Readonly<{
  org_id: string; registration_id: string; descriptor: SyncDescriptorV1; captured_at: Date;
}>) {
  const descriptor = parseSyncDescriptor(input.descriptor);
  const provider = { org_id: input.org_id, provider_kind: 'app_runtime' as const,
    provider_instance_id: input.registration_id };
  return createCapabilityProviderDiscoverySnapshot({
    adapter_contract_version: 'deft.app_runtime_channel.v2', provider,
    captured_at: input.captured_at.toISOString(),
    operations: [{ identity: { provider, operation_name: `sync_${descriptor.key}` },
      title: `Sync ${descriptor.key}`, description: '',
      ...resourceSyncDiscoverySchemas(descriptor) }],
  });
}
