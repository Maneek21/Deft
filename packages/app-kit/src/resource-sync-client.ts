import { ResourceSyncSessionCredentialSchema, type ResourceSyncSessionCredential } from './resource-sync-transport-contract.js';
import { createResourceSyncTransport, ResourceSyncClientError } from './resource-sync-transport.js';
import { z } from 'zod';
import {
  parseSyncPage, SyncDescriptorV1Schema, SyncPageV1Schema, SyncRequestV1Schema,
  type SyncDescriptorV1, type SyncPageV1, type SyncRequestV1,
} from './resource-sync.js';

/** Candidate sync-only transport. V1 action sessions and SDK remain unchanged. */
export const APP_RESOURCE_SYNC_CHANNEL_VERSION = 'deft.app_runtime_channel.v2' as const;
export const APP_RESOURCE_SYNC_AUDIENCE = 'app_resource_sync' as const;
const version = z.literal(APP_RESOURCE_SYNC_CHANNEL_VERSION);
const audience = z.literal(APP_RESOURCE_SYNC_AUDIENCE);
const uuid = z.uuid();
const epoch = z.number().int().min(0).max(2_147_483_647);
const sequence = z.number().int().positive().max(2_147_483_647);
const token = z.string().min(32).max(512).regex(/^[A-Za-z0-9_-]+$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const instant = z.iso.datetime({ offset: true });

export { ResourceSyncSessionCredentialSchema, type ResourceSyncSessionCredential } from './resource-sync-transport-contract.js';
const requestBase = { schema_version: version, audience, session_id: uuid, session_token: token };
const attemptRequest = { ...requestBase, run_id: uuid, attempt_id: uuid,
  claim_token: uuid, sequence };
export const ResourceSyncClaimRequestSchema = z.strictObject({ ...requestBase, max_claims: z.literal(1) });
export const ResourceSyncStartRequestSchema = z.strictObject(attemptRequest);
export const ResourceSyncHeartbeatRequestSchema = z.strictObject(attemptRequest);

const successOutcome = z.strictObject({ status: z.literal('returned'),
  provider_succeeded: z.literal(true), page: SyncPageV1Schema });
const failedOutcome = z.strictObject({ status: z.literal('returned'),
  provider_succeeded: z.literal(false), error_code: z.literal('APP_RUN_PROVIDER_ERROR') });
const unavailableOutcome = z.strictObject({ status: z.literal('not_attempted'),
  error_code: z.enum(['APP_RUN_PROVIDER_UNAVAILABLE', 'APP_RUN_PROVIDER_TIMEOUT']) });
const indeterminateOutcome = z.strictObject({ status: z.literal('indeterminate') });
export const ResourceSyncOutcomeSchema = z.union([
  successOutcome, failedOutcome, unavailableOutcome, indeterminateOutcome,
]);
export const ResourceSyncResultRequestSchema = z.union([
  successOutcome.extend(attemptRequest), failedOutcome.extend(attemptRequest),
  unavailableOutcome.extend(attemptRequest), indeterminateOutcome.extend(attemptRequest),
]);
export type ResourceSyncResultRequest = z.infer<typeof ResourceSyncResultRequestSchema>;

export const ResourceSyncClaimSchema = z.strictObject({
  schema_version: version, audience, work_kind: z.literal('sync_page'),
  org_id: uuid, app_installation_id: uuid, app_version_id: uuid,
  grant_snapshot_id: uuid, lifecycle_epoch: epoch, grant_epoch: epoch,
  runtime_registration_id: uuid, resource_binding_id: uuid, runtime_epoch: epoch,
  session_id: uuid, session_epoch: epoch,
  run_id: uuid, attempt_id: uuid, attempt_number: z.number().int().positive(),
  claim_token: uuid, sequence, lease_expires_at: instant,
  descriptor_digest: digest,
});
export type ResourceSyncClaim = z.infer<typeof ResourceSyncClaimSchema>;
export const ResourceSyncClaimReplySchema = z.strictObject({
  schema_version: version, audience, claim: ResourceSyncClaimSchema.nullable(),
});

export const ResourceSyncStartSchema = z.strictObject({
  schema_version: version, audience, work_kind: z.literal('sync_page'),
  resource_binding_id: uuid, run_id: uuid, attempt_id: uuid, sequence,
  lease_expires_at: instant, descriptor_digest: digest,
  descriptor: SyncDescriptorV1Schema, input: SyncRequestV1Schema,
});
export type ResourceSyncStart = z.infer<typeof ResourceSyncStartSchema>;
export const ResourceSyncStartReplySchema = z.strictObject({
  schema_version: version, audience, started: ResourceSyncStartSchema,
});
export const ResourceSyncHeartbeatReplySchema = z.strictObject({
  schema_version: version, audience, work_kind: z.literal('sync_page'),
  run_id: uuid, attempt_id: uuid, sequence, renewed: z.literal(true),
  lease_expires_at: instant,
});
export const ResourceSyncResultReplySchema = z.strictObject({
  schema_version: version, audience, work_kind: z.literal('sync_page'),
  run_id: uuid, attempt_id: uuid, sequence, accepted: z.literal(true),
});

export { ResourceSyncErrorSchema } from './resource-sync-transport-contract.js';
/** Matches the host's sorted-key SHA-256 descriptor digest. It confers no
 * authority; the host must compare the stored reviewed descriptor independently. */
export async function digestResourceSyncDescriptor(value: unknown): Promise<`sha256:${string}`> {
  const descriptor = SyncDescriptorV1Schema.parse(value);
  const canonical = (item: unknown): string => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    return `{${Object.keys(item).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`).join(',')}}`;
  };
  const hash = await globalThis.crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(canonical(descriptor)));
  return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function parseResourceSyncStartForClaim(
  claimValue: unknown, startedValue: unknown,
): Promise<ResourceSyncStart> {
  const claim = ResourceSyncClaimSchema.parse(claimValue);
  const started = ResourceSyncStartSchema.parse(startedValue);
  if (started.resource_binding_id !== claim.resource_binding_id
    || started.run_id !== claim.run_id || started.attempt_id !== claim.attempt_id
    || started.sequence !== claim.sequence
    || started.descriptor_digest !== claim.descriptor_digest
    || await digestResourceSyncDescriptor(started.descriptor) !== claim.descriptor_digest) {
    throw new TypeError('Resource sync start does not match the reviewed claim');
  }
  return started;
}

export type ResourceSyncOutcome = z.infer<typeof ResourceSyncOutcomeSchema>;
export type ResourceSyncClientOptions = Readonly<{
  channel_url: string;
  credential: ResourceSyncSessionCredential;
  fetch?: typeof globalThis.fetch;
  timeout_ms?: number;
}>;
export type ResourceSyncCallOptions = Readonly<{ signal?: AbortSignal }>;

export { ResourceSyncClientError } from './resource-sync-transport.js';

export function createResourceSyncClient(options: ResourceSyncClientOptions) {
  const credential = ResourceSyncSessionCredentialSchema.parse(options.credential);
  const post = createResourceSyncTransport({ ...options, channel_version: APP_RESOURCE_SYNC_CHANNEL_VERSION });
  function fieldsForClaim(value: unknown): Record<string, unknown> {
    const claim = ResourceSyncClaimSchema.parse(value);
    if (claim.session_id !== credential.session_id) throw new TypeError('Resource sync session mismatch');
    return { run_id: claim.run_id, attempt_id: claim.attempt_id,
      claim_token: claim.claim_token, sequence: claim.sequence };
  }

  return Object.freeze({
    async claim(callOptions?: ResourceSyncCallOptions): Promise<ResourceSyncClaim | null> {
      const payload = ResourceSyncClaimReplySchema.safeParse(
        await post('claim', { max_claims: 1 }, callOptions));
      if (!payload.success) throw new ResourceSyncClientError(200, 'APP_RESOURCE_SYNC_INVALID_RESPONSE');
      if (payload.data.claim && payload.data.claim.session_id !== credential.session_id) {
        throw new ResourceSyncClientError(200, 'APP_RESOURCE_SYNC_INVALID_RESPONSE');
      }
      return payload.data.claim;
    },
    async start(claimValue: ResourceSyncClaim,
      callOptions?: ResourceSyncCallOptions): Promise<ResourceSyncStart> {
      const fields = fieldsForClaim(claimValue);
      const payload = ResourceSyncStartReplySchema.safeParse(await post('start', fields, callOptions));
      if (!payload.success) throw new ResourceSyncClientError(200, 'APP_RESOURCE_SYNC_INVALID_RESPONSE');
      try { return await parseResourceSyncStartForClaim(claimValue, payload.data.started); }
      catch { throw new ResourceSyncClientError(200, 'APP_RESOURCE_SYNC_INVALID_RESPONSE'); }
    },
    async heartbeat(claimValue: ResourceSyncClaim,
      callOptions?: ResourceSyncCallOptions): Promise<string> {
      const fields = fieldsForClaim(claimValue);
      const payload = ResourceSyncHeartbeatReplySchema.safeParse(
        await post('heartbeat', fields, callOptions));
      if (!payload.success || payload.data.run_id !== fields.run_id
        || payload.data.attempt_id !== fields.attempt_id
        || payload.data.sequence !== fields.sequence) {
        throw new ResourceSyncClientError(200, 'APP_RESOURCE_SYNC_INVALID_RESPONSE');
      }
      return payload.data.lease_expires_at;
    },
    async result(claimValue: ResourceSyncClaim, startedValue: ResourceSyncStart,
      outcomeValue: ResourceSyncOutcome,
      callOptions?: ResourceSyncCallOptions): Promise<void> {
      const fields = fieldsForClaim(claimValue);
      const started = await parseResourceSyncStartForClaim(claimValue, startedValue);
      const parsedOutcome = ResourceSyncOutcomeSchema.parse(outcomeValue);
      let outcome: ResourceSyncOutcome;
      if (parsedOutcome.status === 'returned' && parsedOutcome.provider_succeeded) {
        outcome = { status: 'returned', provider_succeeded: true,
          page: parseSyncPage(started.descriptor, started.input, parsedOutcome.page) };
      } else {
        outcome = parsedOutcome;
      }
      const payload = ResourceSyncResultReplySchema.safeParse(
        await post('result', { ...fields, ...outcome }, callOptions));
      if (!payload.success || payload.data.run_id !== fields.run_id
        || payload.data.attempt_id !== fields.attempt_id
        || payload.data.sequence !== fields.sequence) {
        throw new ResourceSyncClientError(200, 'APP_RESOURCE_SYNC_INVALID_RESPONSE');
      }
    },
  });
}

export type { SyncDescriptorV1, SyncPageV1, SyncRequestV1 };
