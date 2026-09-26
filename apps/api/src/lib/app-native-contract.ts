import { z } from 'zod';
import { AppDigestSchema, NATIVE_CALENDAR_CONTRACTS, NATIVE_ACTION_HOST_POLICY, type DeftAppManifestV6 } from '@deft/app-kit';
import { AppRunNativeOperationIdentitySchema, CapabilityJsonObjectSchema } from '@deft/shared';
import { digestAppGrantValue } from './app-grant-service.js';

export const APP_NATIVE_CALENDAR_ADAPTER = 'deft.native.calendar.v1' as const;
export const NativeCalendarTargetSchema = z.strictObject({
  schema_version: z.literal('deft.app_native_target.v1'), provider_kind: z.literal('native'),
  adapter_contract_version: z.literal(APP_NATIVE_CALENDAR_ADAPTER),
  operation_name: z.enum(['calendar.events.create.v1', 'calendar.events.cancel.v1']), calendar_owner_user_id: z.uuid(),
});
const pins = {
  expected_app_version_id: z.uuid(), expected_package_digest: AppDigestSchema, expected_grant_snapshot_digest: AppDigestSchema,
  expected_lifecycle_epoch: z.number().int().nonnegative(), expected_grant_epoch: z.number().int().positive(),
};
export const NativeBindingStageSchema = z.strictObject({
  schema_version: z.literal('deft.app_native_binding_stage.v1'), installation_id: z.uuid(),
  action_key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/), target: NativeCalendarTargetSchema, ...pins,
});
export const NativeOwnerReviewRequestSchema = z.strictObject({
  schema_version: z.literal('deft.app_native_owner_review_request.v1'), binding_id: z.uuid(),
  expected_proposal_digest: AppDigestSchema, expected_stage_manager_authorization_version: z.number().int().positive(),
  expected_owner_authorization_version: z.number().int().positive(), ...pins,
});
export const NativeOwnerAcceptSchema = NativeOwnerReviewRequestSchema.extend({
  expected_review_digest: AppDigestSchema, accept_host_policy: z.literal(true),
});

const provider = AppRunNativeOperationIdentitySchema.shape.provider;
export const NativeProviderSnapshotSchema = z.strictObject({
  schema_version: z.literal('deft.native_provider_snapshot.v1'), adapter_contract_version: z.literal(APP_NATIVE_CALENDAR_ADAPTER),
  provider, captured_at: z.iso.datetime({ offset: true }),
  operations: z.array(z.strictObject({
    identity: AppRunNativeOperationIdentitySchema, title: z.string().max(200), description: z.string().max(4000),
    input_schema: CapabilityJsonObjectSchema, output_schema: CapabilityJsonObjectSchema,
    schema_digest: AppDigestSchema, description_digest: AppDigestSchema,
  })).length(2), snapshot_digest: AppDigestSchema,
});
export type NativeProviderSnapshot = z.infer<typeof NativeProviderSnapshotSchema>;
export function buildNativeProviderSnapshot(input: { org_id: string; owner_user_id: string; captured_at: string }) {
  const owner = z.uuid().parse(input.owner_user_id);
  const identity = provider.parse({ org_id: input.org_id, provider_kind: 'native', provider_instance_id: `calendar:${owner}` });
  const captured = z.iso.datetime({ offset: true }).parse(input.captured_at);
  const operations = (['calendar.events.create.v1', 'calendar.events.cancel.v1'] as const).map(name => {
    const contract = NATIVE_CALENDAR_CONTRACTS[name];
    const title = name === 'calendar.events.create.v1' ? 'Create native Calendar event' : 'Cancel App-created Calendar event';
    const description = name === 'calendar.events.create.v1'
      ? 'Create one event in the consenting owner Calendar. Attendees are stored; no invitation is sent.'
      : 'Cancel only a retained event created by a succeeded native create Run of this exact App version and owner.';
    return { identity: { provider: identity, operation_name: name }, title, description,
      input_schema: contract.input_schema, output_schema: contract.output_schema,
      schema_digest: digestAppGrantValue({ input_schema: contract.input_schema, output_schema: contract.output_schema }),
      description_digest: digestAppGrantValue({ title, description }) };
  });
  const snapshot = { schema_version: 'deft.native_provider_snapshot.v1' as const,
    adapter_contract_version: APP_NATIVE_CALENDAR_ADAPTER, provider: identity, captured_at: captured, operations };
  return NativeProviderSnapshotSchema.parse({ ...snapshot, snapshot_digest: digestAppGrantValue(snapshot) });
}
export function parseNativeProviderSnapshot(value: unknown) {
  const parsed = NativeProviderSnapshotSchema.parse(value);
  const expected = buildNativeProviderSnapshot({ org_id: parsed.provider.org_id,
    owner_user_id: parsed.provider.provider_instance_id.slice('calendar:'.length), captured_at: parsed.captured_at });
  if (digestAppGrantValue(parsed) !== digestAppGrantValue(expected)) throw new TypeError('Native provider snapshot is not host-certified');
  return parsed;
}
export function nativeActionDescriptors(manifest: DeftAppManifestV6) {
  return manifest.native_actions.map(action => {
    const contract = NATIVE_CALENDAR_CONTRACTS[action.operation];
    return { ...action, ...contract, contract_digest: digestAppGrantValue({ operation: action.operation, ...contract }),
      host_policy: NATIVE_ACTION_HOST_POLICY };
  });
}
