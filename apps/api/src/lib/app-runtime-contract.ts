import { z } from 'zod';
import {
  APP_RUN_CONTRACT_VERSIONS,
  AppRunRetainedProviderResultSchema,
  assertAppRunOutputWithinBudget,
  CapabilityJsonValueSchema,
  type CapabilityJsonValue,
  type AppRuntimeSessionAuthority,
} from '@deft/shared';
import { ActionPayloadReferenceSchema, type ActionPayloadReference, type RetainedActionPayload } from './app-private-file-contract.js';

/** Candidate channel contract. It is not exported from the public App Kit. */
export const APP_RUNTIME_CHANNEL_VERSION = 'deft.app_runtime_channel.v1' as const;
export const APP_RUNTIME_AUDIENCE = 'app_runtime' as const;
export const APP_RUNTIME_SESSION_MS = 15 * 60_000;
export const APP_RUNTIME_LEASE_MS = 60_000;
export const APP_ACTION_PAYLOAD_VERSION = 'deft.app_action_payload.v1' as const;
export function runtimePayloadHandshakeAllowed(pointer: Readonly<{ snapshot_id: string | null; snapshot_digest: string | null }> | undefined,
  version: string | undefined): boolean {
  if (version !== undefined && version !== APP_ACTION_PAYLOAD_VERSION) return false;
  if (!pointer || pointer.snapshot_id === null && pointer.snapshot_digest === null) return true;
  return version === APP_ACTION_PAYLOAD_VERSION && ActionPayloadReferenceSchema.safeParse({ snapshot_id: pointer.snapshot_id, digest: pointer.snapshot_digest }).success;
}

const identity = z.string().min(1).max(512)
  .refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
const credential = z.string().min(32).max(512).regex(/^[A-Za-z0-9_-]+$/u);
const sequence = z.number().int().positive().max(2_147_483_647);

export const AppRuntimeSessionCredentialSchema = z.object({
  session_id: identity,
  session_token: credential,
}).strict();
export type AppRuntimeSessionCredential = z.infer<typeof AppRuntimeSessionCredentialSchema>;
export const AppRuntimeRenewRequestSchema=AppRuntimeSessionCredentialSchema.extend({schema_version:z.literal(APP_RUNTIME_CHANNEL_VERSION),expected_expires_at:z.string().datetime()}).strict();
export const AppRuntimeSessionIssueInputSchema=z.strictObject({technical_renewal:z.union([z.strictObject({requested_until:z.string().datetime()}),z.strictObject({renewal_lifetime:z.literal('until_revoked'),requested_until:z.null()})]).optional()});

export const AppRuntimeClaimRequestSchema = AppRuntimeSessionCredentialSchema.extend({
  schema_version: z.literal(APP_RUNTIME_CHANNEL_VERSION),
  max_claims: z.literal(1),
}).strict();
export type AppRuntimeClaimRequest = z.infer<typeof AppRuntimeClaimRequestSchema>;

const claimedAttempt = {
  schema_version: z.literal(APP_RUNTIME_CHANNEL_VERSION),
  session_id: identity,
  session_token: credential,
  run_id: identity,
  attempt_id: identity,
  claim_token: identity,
  sequence,
};
export const AppRuntimeStartRequestSchema = z.object({ ...claimedAttempt,
  action_payload_version: z.literal(APP_ACTION_PAYLOAD_VERSION).optional() }).strict();
export const AppRuntimePayloadReadRequestSchema = z.object({ ...claimedAttempt,
  snapshot_ref: ActionPayloadReferenceSchema,
  part: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('metadata') }),
    z.strictObject({ kind: z.literal('bytes') }), z.strictObject({ kind: z.literal('file'), file_id: z.string().uuid() })]),
}).strict();
export type AppRuntimeAttemptIdentity = Readonly<{ org_id: string; run_id: string; attempt_id: string;
  session_id: string; token_hash: string; claim_token: string; sequence: number }>;
export const AppRuntimeActionResourcesRequestSchema = z.strictObject({ ...claimedAttempt,
  action_resources_version: z.literal('deft.app_action_resources.v1'), input_key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
});
export type AppRuntimePayloadPart = z.infer<typeof AppRuntimePayloadReadRequestSchema>['part'];
export type AppRuntimePayloadRelease =
  | Readonly<{ kind: 'metadata'; payload: RetainedActionPayload }>
  | Readonly<{ kind: 'bytes' | 'file'; snapshot_ref: ActionPayloadReference; bytes: Buffer; byte_count: number; digest: string }>;
export const AppRuntimeHeartbeatRequestSchema = z.object(claimedAttempt).strict();
export const AppRuntimeAuthorizeRequestSchema = z.object(claimedAttempt).strict();
export type AppRuntimeAuthorityEnvelope = Readonly<AppRuntimeSessionAuthority & {
  schema_version: 'deft.app_runtime_authority.v1';
  run_id: string; attempt_id: string; owner_id: string; grant_snapshot_id: string;
  operation_name: string; input: CapabilityJsonValue; input_digest: string;
  lease_expires_at: string;
}>;

export const AppRuntimeResultRequestSchema = z.discriminatedUnion('status', [
  z.object({
    ...claimedAttempt,
    status: z.literal('returned'),
    provider_succeeded: z.boolean(),
    output: CapabilityJsonValueSchema,
  }).strict(),
  z.object({
    ...claimedAttempt,
    status: z.literal('not_attempted'),
    error_code: z.enum(['APP_RUN_PROVIDER_UNAVAILABLE', 'APP_RUN_PROVIDER_TIMEOUT']),
  }).strict(),
  z.object({
    ...claimedAttempt,
    status: z.literal('indeterminate'),
  }).strict(),
]);
export type AppRuntimeResultRequest = z.infer<typeof AppRuntimeResultRequestSchema>;

/** Bound the exact retained result envelope before any completion write. */
export function parseAppRuntimeResult(value: unknown): AppRuntimeResultRequest {
  const parsed = AppRuntimeResultRequestSchema.parse(value);
  if (parsed.status === 'returned') {
    const envelope = AppRunRetainedProviderResultSchema.parse({
      schema_version: APP_RUN_CONTRACT_VERSIONS.provider_result,
      provider_succeeded: parsed.provider_succeeded,
      output: parsed.output,
    });
    assertAppRunOutputWithinBudget(envelope);
  }
  return parsed;
}

export type AppRuntimeClaimEnvelope = Readonly<AppRuntimeSessionAuthority & {
  schema_version: typeof APP_RUNTIME_CHANNEL_VERSION;
  run_id: string;
  attempt_id: string;
  attempt_number: number;
  claim_token: string;
  lease_expires_at: string;
  sequence: number;
  initiating_actor_type: string;
  initiating_actor_id: string;
  grant_snapshot_id: string;
  operation_name: string;
  provider_idempotency_key?: string;
}>;

export type AppRuntimeStartEnvelope = Readonly<{
  schema_version: typeof APP_RUNTIME_CHANNEL_VERSION;
  run_id: string;
  attempt_id: string;
  lease_expires_at: string;
  input: CapabilityJsonValue;
  snapshot_ref?: ActionPayloadReference;
  provider_idempotency_key?: string;
}>;
