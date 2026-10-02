import {
  APP_RESOURCE_SYNC_AUDIENCE,
  APP_RESOURCE_SYNC_CHANNEL_VERSION,
  ResourceSyncClaimRequestSchema,
  ResourceSyncStartRequestSchema,
  ResourceSyncHeartbeatRequestSchema,
  ResourceSyncResultRequestSchema,
  parseSyncDescriptor,
  parseSyncPage,
  parseSyncRequest,
  type SyncDescriptorV1,
  type SyncRequestV1,
} from '@deft/app-kit/experimental/resource-sync';
import {
  APP_RUN_CONTRACT_VERSIONS, AppRunRetainedProviderResultSchema,
  assertAppRunOutputWithinBudget,
} from '@deft/shared';

/** Candidate v2 only. The route/issuer must establish the sync session and
 * immutable reviewed binding before using these parsers; none issue authority. */
export { APP_RESOURCE_SYNC_AUDIENCE, APP_RESOURCE_SYNC_CHANNEL_VERSION };
export const AppResourceSyncClaimRequestSchema = ResourceSyncClaimRequestSchema;
export const AppResourceSyncStartRequestSchema = ResourceSyncStartRequestSchema;
export const AppResourceSyncHeartbeatRequestSchema = ResourceSyncHeartbeatRequestSchema;
export const AppResourceSyncResultRequestSchema = ResourceSyncResultRequestSchema;

export type ResourceSyncReviewedResultPin = Readonly<{
  descriptor: SyncDescriptorV1;
  starting_request: SyncRequestV1;
}>;

/** A callback cannot nominate the descriptor, cursor, owner, or binding. The
 * caller supplies host-loaded, reviewed pins from the locked Run/checkpoint. */
export function parseAppResourceSyncResult(value: unknown, pin: ResourceSyncReviewedResultPin) {
  const result = ResourceSyncResultRequestSchema.parse(value);
  if (result.status !== 'returned' || !result.provider_succeeded) return result;
  const descriptor = parseSyncDescriptor(pin.descriptor);
  const startingRequest = parseSyncRequest(pin.starting_request);
  const page = parseSyncPage(descriptor, startingRequest, result.page);
  const retained = AppRunRetainedProviderResultSchema.parse({
    schema_version: APP_RUN_CONTRACT_VERSIONS.provider_result,
    provider_succeeded: true,
    output: page,
  });
  assertAppRunOutputWithinBudget(retained);
  return { ...result, page };
}
