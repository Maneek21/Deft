import { z } from 'zod';
import {
  ResourceSyncClaimSchema, ResourceSyncClaimRequestSchema, ResourceSyncStartRequestSchema,
  ResourceSyncHeartbeatRequestSchema, ResourceSyncStartSchema, ResourceSyncHeartbeatReplySchema,
  ResourceSyncResultReplySchema, ResourceSyncSessionCredentialSchema,
  type ResourceSyncClientOptions, type ResourceSyncCallOptions,
} from './resource-sync-client.js';
import { createResourceSyncTransport, ResourceSyncClientError } from './resource-sync-transport.js';
import {
  AttachmentStageHeaderSchema, AttachmentStagedReplySchema, frameResourceSyncAttachment,
  digestResourceSyncDescriptorV2, parseSyncPageV2, RESOURCE_ATTACHMENT_LIMITS,
  SyncDescriptorV2Schema, SyncRequestV2Schema, SyncPageV2Schema,
  type AttachmentStageHeader, type AttachmentStagedReply,
} from './resource-sync-attachments.js';

export const APP_RESOURCE_SYNC_CHANNEL_VERSION_V3 = 'deft.app_runtime_channel.v3' as const;
const version = z.literal(APP_RESOURCE_SYNC_CHANNEL_VERSION_V3);
export const ResourceSyncClaimRequestV3Schema = ResourceSyncClaimRequestSchema.extend({ schema_version: version });
export const ResourceSyncStartRequestV3Schema = ResourceSyncStartRequestSchema.extend({ schema_version: version });
export const ResourceSyncHeartbeatRequestV3Schema = ResourceSyncHeartbeatRequestSchema.extend({ schema_version: version });
export const ResourceSyncClaimV3Schema = ResourceSyncClaimSchema.extend({ schema_version: version });
export type ResourceSyncClaimV3 = z.infer<typeof ResourceSyncClaimV3Schema>;
export const ResourceSyncClaimReplyV3Schema = z.strictObject({ schema_version: version,
  audience: z.literal('app_resource_sync'), claim: ResourceSyncClaimV3Schema.nullable() });
export const ResourceSyncStartV3Schema = ResourceSyncStartSchema.extend({ schema_version: version,
  descriptor: SyncDescriptorV2Schema, input: SyncRequestV2Schema });
export type ResourceSyncStartV3 = z.infer<typeof ResourceSyncStartV3Schema>;
export const ResourceSyncStartReplyV3Schema = z.strictObject({ schema_version: version,
  audience: z.literal('app_resource_sync'), started: ResourceSyncStartV3Schema });
export const ResourceSyncHeartbeatReplyV3Schema = ResourceSyncHeartbeatReplySchema.extend({ schema_version: version });
export const ResourceSyncResultReplyV3Schema = ResourceSyncResultReplySchema.extend({ schema_version: version });
const attempt = ResourceSyncStartRequestV3Schema.shape;
const success = z.strictObject({ status: z.literal('returned'), provider_succeeded: z.literal(true), page: SyncPageV2Schema });
const failure = z.strictObject({ status: z.literal('returned'), provider_succeeded: z.literal(false), error_code: z.literal('APP_RUN_PROVIDER_ERROR') });
const unavailable = z.strictObject({ status: z.literal('not_attempted'), error_code: z.enum(['APP_RUN_PROVIDER_UNAVAILABLE', 'APP_RUN_PROVIDER_TIMEOUT']) });
const indeterminate = z.strictObject({ status: z.literal('indeterminate') });
export const ResourceSyncOutcomeV3Schema = z.union([success, failure, unavailable, indeterminate]);
export type ResourceSyncOutcomeV3 = z.infer<typeof ResourceSyncOutcomeV3Schema>;
export const ResourceSyncResultRequestV3Schema = z.union([
  success.extend(attempt), failure.extend(attempt), unavailable.extend(attempt), indeterminate.extend(attempt),
]);

export async function parseResourceSyncStartForClaimV3(claimValue: unknown, startedValue: unknown): Promise<ResourceSyncStartV3> {
  const claim = ResourceSyncClaimV3Schema.parse(claimValue);
  const started = ResourceSyncStartV3Schema.parse(startedValue);
  if (started.resource_binding_id !== claim.resource_binding_id || started.run_id !== claim.run_id
    || started.attempt_id !== claim.attempt_id || started.sequence !== claim.sequence
    || started.descriptor_digest !== claim.descriptor_digest
    || await digestResourceSyncDescriptorV2(started.descriptor) !== claim.descriptor_digest) {
    throw new TypeError('Resource sync start does not match the reviewed claim');
  }
  return started;
}

export function createDeftResourceSyncClientV3(options: ResourceSyncClientOptions) {
  const credential = ResourceSyncSessionCredentialSchema.parse(options.credential);
  const post = createResourceSyncTransport({ ...options, timeout_ms: Math.min(options.timeout_ms ?? 10_000, 10_000),
    channel_version: APP_RESOURCE_SYNC_CHANNEL_VERSION_V3 });
  const pendingStages = new Set<string>();
  const fields = (value: unknown) => {
    const claim = ResourceSyncClaimV3Schema.parse(value);
    if (claim.session_id !== credential.session_id) throw new TypeError('Resource sync session mismatch');
    return { run_id: claim.run_id, attempt_id: claim.attempt_id, claim_token: claim.claim_token, sequence: claim.sequence };
  };
  const invalid = () => new ResourceSyncClientError(200, 'APP_RESOURCE_SYNC_INVALID_RESPONSE');
  return Object.freeze({
    async claim(callOptions?: ResourceSyncCallOptions): Promise<ResourceSyncClaimV3 | null> {
      const reply = ResourceSyncClaimReplyV3Schema.parse(await post('claim', { max_claims: 1 }, callOptions));
      if (reply.claim && reply.claim.session_id !== credential.session_id) throw invalid();
      return reply.claim;
    },
    async start(claim: ResourceSyncClaimV3, callOptions?: ResourceSyncCallOptions): Promise<ResourceSyncStartV3> {
      const reply = ResourceSyncStartReplyV3Schema.parse(await post('start', fields(claim), callOptions));
      return parseResourceSyncStartForClaimV3(claim, reply.started);
    },
    async heartbeat(claim: ResourceSyncClaimV3, callOptions?: ResourceSyncCallOptions): Promise<string> {
      const pins = fields(claim);
      const reply = ResourceSyncHeartbeatReplyV3Schema.parse(await post('heartbeat', pins, callOptions));
      if (reply.run_id !== pins.run_id || reply.attempt_id !== pins.attempt_id || reply.sequence !== pins.sequence) throw invalid();
      return reply.lease_expires_at;
    },
    async stageAttachment(claim: ResourceSyncClaimV3,
      metadata: Pick<AttachmentStageHeader, 'parent_resource_id' | 'parent_revision' | 'attachment_key' | 'filename' | 'declared_media_type'>,
      bytes: Uint8Array, callOptions?: ResourceSyncCallOptions): Promise<AttachmentStagedReply> {
      const pins = fields(claim);
      if (pendingStages.has(pins.run_id)) throw new TypeError('Serialize attachment stages within one Run');
      // No queue or automatic retry: uncertain writes remain the caller's exact identity.
      pendingStages.add(pins.run_id);
      try {
        if (bytes.byteLength > RESOURCE_ATTACHMENT_LIMITS.attachment_bytes) throw new TypeError('Attachment exceeds 2 MiB');
        const header = AttachmentStageHeaderSchema.parse({ ...metadata, ...pins, session_id: credential.session_id,
          schema_version: 'deft.app_sync_attachment_stage.v1', channel_version: APP_RESOURCE_SYNC_CHANNEL_VERSION_V3,
          audience: 'app_resource_sync', declared_size_bytes: bytes.byteLength });
        const reply = AttachmentStagedReplySchema.parse(await post('attachments/stage', {}, callOptions,
          frameResourceSyncAttachment(header, bytes)));
        if (reply.size_bytes !== bytes.byteLength) throw invalid();
        return reply;
      } finally { pendingStages.delete(pins.run_id); }
    },
    async result(claim: ResourceSyncClaimV3, startedValue: ResourceSyncStartV3, outcomeValue: ResourceSyncOutcomeV3,
      callOptions?: ResourceSyncCallOptions): Promise<void> {
      const pins = fields(claim);
      if (pendingStages.has(pins.run_id)) throw new TypeError('Attachment stage is still pending');
      const started = await parseResourceSyncStartForClaimV3(claim, startedValue);
      const parsed = ResourceSyncOutcomeV3Schema.parse(outcomeValue);
      const outcome = parsed.status === 'returned' && parsed.provider_succeeded
        ? { ...parsed, page: parseSyncPageV2(started.descriptor, started.input, parsed.page) } : parsed;
      const reply = ResourceSyncResultReplyV3Schema.parse(await post('result', { ...pins, ...outcome }, callOptions));
      if (reply.run_id !== pins.run_id || reply.attempt_id !== pins.attempt_id || reply.sequence !== pins.sequence) throw invalid();
    },
  });
}
