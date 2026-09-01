import { z } from 'zod';

import {
  CapabilityJsonObjectSchema,
  CapabilityJsonValueSchema,
  CapabilityProviderOperationIdentitySchema,
  assertCapabilityJsonWithinBudget,
  type CapabilityJsonValue,
} from './capabilities';

export const APP_RUN_CONTRACT_VERSIONS = {
  run: 'deft.app_run.v1',
  event: 'deft.app_run_event.v1',
  receipt: 'deft.app_run_receipt.v1',
  secret_envelope: 'deft.secret.v1',
  secret_aad: 'deft.app_run_aad.v1',
  keyring: 'deft.app_run_keyring.v1',
  provider_result: 'deft.app_run_provider_result.v1',
} as const;

export const APP_RUN_LIMITS = {
  input_bytes: 256 * 1024,
  output_bytes: 1024 * 1024,
  authorization_snapshot_bytes: 64 * 1024,
  safe_preview_bytes: 16 * 1024,
  safe_event_payload_bytes: 32 * 1024,
  safe_receipt_envelope_bytes: 32 * 1024,
  idempotency_key_bytes: 256,
  keyring_entries: 16,
  key_id_chars: 64,
  max_child_depth: 8,
  resource_refs_per_preview: 32,
} as const;

export const APP_RUN_SECRET_RETENTION_MS = {
  ephemeral: 60 * 60 * 1000,
  standard: 7 * 24 * 60 * 60 * 1000,
  extended: 30 * 24 * 60 * 60 * 1000,
} as const;

// Caller idempotency outlives exact input/result retention, but it is bounded
// so self-hosted operators and the hosted service can eventually retire old
// fingerprint keys. Apps cannot widen this host-owned policy.
export const APP_RUN_IDEMPOTENCY_RETENTION_MS = {
  ephemeral: 7 * 24 * 60 * 60 * 1000,
  standard: 30 * 24 * 60 * 60 * 1000,
  extended: 90 * 24 * 60 * 60 * 1000,
} as const;

export const APP_RUN_DEFAULT_ATTEMPT_LIMIT = 3;

const ExactIdentitySchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value === value.trim(), 'Identity must not have surrounding whitespace')
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Identity must not contain control characters');

const APP_RUN_FORBIDDEN_SAFE_KEYS = new Set([
  'input',
  'output',
  'raw_input',
  'raw_output',
  'params',
  'idempotency_key',
  'retry_key',
  'ciphertext',
  'ciphertext_b64',
  'nonce_b64',
  'auth_tag_b64',
  'credential',
  'credentials',
  'secret',
  'password',
  'access_token',
  'refresh_token',
  'api_key',
  'private_key',
  'signature_hmac',
]);

function findForbiddenSafeKey(value: CapabilityJsonValue, path: readonly string[] = []): readonly string[] | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findForbiddenSafeKey(item, [...path, String(index)]);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const next = [...path, key];
      if (APP_RUN_FORBIDDEN_SAFE_KEYS.has(key.toLowerCase())) return next;
      const found = findForbiddenSafeKey(item, next);
      if (found) return found;
    }
  }
  return null;
}

export const AppRunSafeMetadataSchema = CapabilityJsonObjectSchema.superRefine((value, ctx) => {
  const forbiddenPath = findForbiddenSafeKey(value);
  if (forbiddenPath) {
    ctx.addIssue({
      code: 'custom',
      path: [...forbiddenPath],
      message: 'Safe App Run metadata cannot contain secret-bearing fields',
    });
  }
});
export type AppRunSafeMetadata = z.infer<typeof AppRunSafeMetadataSchema>;

export const AppRunStateSchema = z.enum([
  'pending',
  'pending_approval',
  'running',
  'waiting_external',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
  'unknown_outcome',
]);
export type AppRunState = z.infer<typeof AppRunStateSchema>;

export const APP_RUN_TERMINAL_STATES = [
  'succeeded',
  'failed',
  'cancelled',
  'expired',
] as const satisfies readonly AppRunState[];

export const APP_RUN_STATE_TRANSITIONS = {
  pending: ['pending_approval', 'running', 'cancelled', 'expired'],
  pending_approval: ['running', 'cancelled', 'expired'],
  running: ['waiting_external', 'succeeded', 'failed', 'unknown_outcome'],
  waiting_external: ['running', 'succeeded', 'failed', 'cancelled', 'unknown_outcome'],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
  unknown_outcome: ['succeeded', 'failed'],
} as const satisfies Record<AppRunState, readonly AppRunState[]>;

export function isAppRunStateTransitionAllowed(from: AppRunState, to: AppRunState): boolean {
  return from === to || (APP_RUN_STATE_TRANSITIONS[from] as readonly AppRunState[]).includes(to);
}

export const AppRunAttemptStateSchema = z.enum([
  'pending',
  'claimed',
  'provider_call_started',
  'succeeded',
  'failed',
  'cancelled',
  'unknown_outcome',
]);
export type AppRunAttemptState = z.infer<typeof AppRunAttemptStateSchema>;

export const APP_RUN_ATTEMPT_STATE_TRANSITIONS = {
  pending: ['claimed', 'cancelled'],
  claimed: ['provider_call_started', 'failed', 'cancelled'],
  provider_call_started: ['succeeded', 'failed', 'cancelled', 'unknown_outcome'],
  succeeded: [],
  failed: [],
  cancelled: [],
  unknown_outcome: [],
} as const satisfies Record<AppRunAttemptState, readonly AppRunAttemptState[]>;

export function isAppRunAttemptStateTransitionAllowed(
  from: AppRunAttemptState,
  to: AppRunAttemptState,
): boolean {
  return from === to
    || (APP_RUN_ATTEMPT_STATE_TRANSITIONS[from] as readonly AppRunAttemptState[]).includes(to);
}

export const AppRunOriginKindSchema = z.enum(['core', 'legacy_connector', 'app']);
export type AppRunOriginKind = z.infer<typeof AppRunOriginKindSchema>;

export const AppRunActorSchema = z.discriminatedUnion('actor_type', [
  z.object({ actor_type: z.literal('human'), user_id: ExactIdentitySchema }).strict(),
  z.object({
    actor_type: z.literal('agent_employee'),
    agent_employee_id: ExactIdentitySchema,
    user_id: ExactIdentitySchema.optional(),
  }).strict(),
  z.object({ actor_type: z.literal('system'), system_id: ExactIdentitySchema }).strict(),
  z.object({
    actor_type: z.literal('automation'),
    automation_id: ExactIdentitySchema,
    user_id: ExactIdentitySchema.optional(),
  }).strict(),
]);
export type AppRunActor = z.infer<typeof AppRunActorSchema>;

export const AppRunOriginSchema = z.discriminatedUnion('origin_kind', [
  z.object({ origin_kind: z.literal('core') }).strict(),
  z.object({
    origin_kind: z.literal('legacy_connector'),
    connection_id: ExactIdentitySchema,
  }).strict(),
  z.object({
    origin_kind: z.literal('app'),
    installation_id: ExactIdentitySchema,
    app_version_id: ExactIdentitySchema,
    binding_key: ExactIdentitySchema,
    grant_snapshot_id: ExactIdentitySchema,
  }).strict(),
]);
export type AppRunOrigin = z.infer<typeof AppRunOriginSchema>;

export const AppRunRiskClassSchema = z.enum([
  'read',
  'internal_write',
  'external_write',
  'destructive',
  'privileged',
]);
export type AppRunRiskClass = z.infer<typeof AppRunRiskClassSchema>;

export const AppRunReviewRequirementSchema = z.enum(['policy', 'always']);
export type AppRunReviewRequirement = z.infer<typeof AppRunReviewRequirementSchema>;

export const AppRunReviewScopeSchema = z.enum([
  'per_invocation',
  'immutable_batch',
  'approved_automation_definition',
  'forbidden_in_automation',
]);
export type AppRunReviewScope = z.infer<typeof AppRunReviewScopeSchema>;

export const AppRunRetryClassSchema = z.enum(['safe', 'idempotent_with_key', 'unsafe_or_unknown']);
export type AppRunRetryClass = z.infer<typeof AppRunRetryClassSchema>;

export const AppRunRetentionClassSchema = z.enum(['ephemeral', 'standard', 'extended']);
export type AppRunRetentionClass = z.infer<typeof AppRunRetentionClassSchema>;

export const AppRunErrorCodeSchema = z.enum([
  'APP_RUNS_DISABLED',
  'APP_RUN_KEYRING_INVALID',
  'APP_RUN_KEY_VERSION_UNAVAILABLE',
  'APP_RUN_INPUT_INVALID',
  'APP_RUN_INPUT_TOO_LARGE',
  'APP_RUN_OUTPUT_TOO_LARGE',
  'APP_RUN_IDEMPOTENCY_CONFLICT',
  'APP_RUN_ILLEGAL_TRANSITION',
  'APP_RUN_EXECUTION_NOT_RELEASED',
  'APP_RUN_ACCESS_DENIED',
  'APP_RUN_AUTHORIZATION_STALE',
  'APP_RUN_PROVIDER_UNAVAILABLE',
  'APP_RUN_PROVIDER_ERROR',
  'APP_RUN_PROVIDER_TIMEOUT',
  'APP_RUN_APPROVAL_REJECTED',
  'APP_RUN_APPROVAL_EXPIRED',
  'APP_RUN_CANCELLED',
  'APP_RUN_EXPIRED',
  'APP_RUN_UNKNOWN_OUTCOME',
  'APP_RUN_RESULT_EXPIRED',
  'APP_RUN_REPAIR_REQUIRED',
  'APP_RUN_ANCESTRY_LIMIT',
  'APP_RUN_CAPABILITY_CYCLE',
]);
export type AppRunErrorCode = z.infer<typeof AppRunErrorCodeSchema>;

export type AppRunCrashRecoveryDecision =
  | 'persist_known_result'
  | 'create_retry_attempt'
  | 'unknown_outcome';

export function classifyAppRunCrashRecovery(input: Readonly<{
  retry_class: AppRunRetryClass;
  provider_call_started: boolean;
  provider_result_known: boolean;
  provider_idempotency_key_bound: boolean;
}>): AppRunCrashRecoveryDecision {
  if (input.provider_result_known) return 'persist_known_result';
  if (!input.provider_call_started) return 'create_retry_attempt';
  if (input.retry_class === 'safe') return 'create_retry_attempt';
  if (input.retry_class === 'idempotent_with_key' && input.provider_idempotency_key_bound) {
    return 'create_retry_attempt';
  }
  return 'unknown_outcome';
}

export const AppRunPolicySnapshotSchema = z.object({
  risk_class: AppRunRiskClassSchema,
  review_requirement: AppRunReviewRequirementSchema,
  review_scope: AppRunReviewScopeSchema,
  retry_class: AppRunRetryClassSchema,
}).strict();
export type AppRunPolicySnapshot = z.infer<typeof AppRunPolicySnapshotSchema>;

export const AppRunAuthorityRefSchema = z.object({
  authority_kind: z.enum([
    'membership',
    'token_scope',
    'employee_health',
    'employee_budget',
    'assignment',
    'connector',
    'provider_schema',
    'policy',
    'app_surface',
    'app_installation',
    'app_version',
    'app_grant',
    'app_binding',
    'app_dependency',
    'app_automation_request',
    'app_automation_definition',
    'app_automation_fire',
    'app_automation_policy',
    'resource',
    'relation',
  ]),
  authority_id: ExactIdentitySchema,
  version: ExactIdentitySchema,
}).strict();

export const AppRunAuthorizationSnapshotSchema = z.object({
  schema_version: z.literal(APP_RUN_CONTRACT_VERSIONS.run),
  authenticated_subject: AppRunActorSchema,
  authority_refs: z.array(AppRunAuthorityRefSchema).min(1).max(32),
}).strict().superRefine((value, ctx) => {
  const identities = new Set<string>();
  for (const [index, ref] of value.authority_refs.entries()) {
    const identity = `${ref.authority_kind}\u0000${ref.authority_id}`;
    if (identities.has(identity)) {
      ctx.addIssue({
        code: 'custom',
        path: ['authority_refs', index],
        message: 'Authorization authority identity must be unique',
      });
    }
    identities.add(identity);
  }
});
export type AppRunAuthorizationSnapshot = z.infer<typeof AppRunAuthorizationSnapshotSchema>;

export const AppRunSafeResourceRefSchema = z.object({
  resource_kind: ExactIdentitySchema,
  resource_id: ExactIdentitySchema,
  label: z.string().min(1).max(200).optional(),
}).strict();

export const AppRunSafePreviewSchema = z.object({
  schema_version: z.literal(APP_RUN_CONTRACT_VERSIONS.run),
  title: z.string().min(1).max(200),
  summary: z.string().max(1_000).optional(),
  resource_refs: z.array(AppRunSafeResourceRefSchema)
    .max(APP_RUN_LIMITS.resource_refs_per_preview)
    .default([]),
  fields: AppRunSafeMetadataSchema.optional(),
}).strict();
export type AppRunSafePreview = z.infer<typeof AppRunSafePreviewSchema>;

export const AppRunSafeOutcomeSchema = z.object({
  success: z.boolean(),
  provider_call_attempted: z.boolean(),
  result_status: z.enum(['retained', 'expired', 'unavailable']),
  summary: z.string().max(1_000).optional(),
  error_code: AppRunErrorCodeSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.success && value.error_code !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['error_code'], message: 'Successful outcomes cannot include an error code' });
  }
  if (!value.success && value.error_code === undefined) {
    ctx.addIssue({ code: 'custom', path: ['error_code'], message: 'Failed outcomes require an error code' });
  }
});
export type AppRunSafeOutcome = z.infer<typeof AppRunSafeOutcomeSchema>;

export const AppRunRetainedProviderResultSchema = z.object({
  schema_version: z.literal(APP_RUN_CONTRACT_VERSIONS.provider_result),
  provider_succeeded: z.boolean(),
  output: CapabilityJsonValueSchema,
}).strict();
export type AppRunRetainedProviderResult = z.infer<typeof AppRunRetainedProviderResultSchema>;

export const AppRunEventTypeSchema = z.enum([
  'run_created',
  'approval_requested',
  'approval_resolved',
  'attempt_created',
  'attempt_claimed',
  'provider_call_started',
  'cancellation_requested',
  'attempt_terminal',
  'run_transitioned',
  'secrets_purged',
  'reconciliation_recorded',
  'repair_gap',
]);

export const AppRunEventSchema = z.object({
  schema_version: z.literal(APP_RUN_CONTRACT_VERSIONS.event),
  event_id: ExactIdentitySchema,
  org_id: ExactIdentitySchema,
  run_id: ExactIdentitySchema,
  sequence: z.number().int().positive(),
  event_type: AppRunEventTypeSchema,
  actor: AppRunActorSchema.optional(),
  payload: AppRunSafeMetadataSchema.default({}),
  occurred_at: z.string().datetime({ offset: true }),
}).strict();
export type AppRunEvent = z.infer<typeof AppRunEventSchema>;

export const AppRunReceiptKindSchema = z.enum([
  'approval',
  'attempt_terminal',
  'reconciliation',
  'repair',
]);
export type AppRunReceiptKind = z.infer<typeof AppRunReceiptKindSchema>;

export const AppRunReceiptEnvelopeSchema = z.object({
  schema_version: z.literal(APP_RUN_CONTRACT_VERSIONS.receipt),
  receipt_id: ExactIdentitySchema,
  receipt_kind: AppRunReceiptKindSchema,
  org_id: ExactIdentitySchema,
  run_id: ExactIdentitySchema,
  attempt_id: ExactIdentitySchema.optional(),
  run_state: AppRunStateSchema,
  actor: AppRunActorSchema.optional(),
  operation: CapabilityProviderOperationIdentitySchema,
  policy: AppRunPolicySnapshotSchema,
  input_fingerprint: z.object({
    key_version: ExactIdentitySchema,
    fingerprint: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/),
  }).strict(),
  output_envelope_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  facts: AppRunSafeMetadataSchema.default({}),
  occurred_at: z.string().datetime({ offset: true }),
}).strict().superRefine((value, ctx) => {
  if (value.receipt_kind === 'attempt_terminal' && value.attempt_id === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['attempt_id'],
      message: 'Attempt terminal receipts require an attempt identity',
    });
  }
  if (value.operation.provider.org_id !== value.org_id) {
    ctx.addIssue({
      code: 'custom',
      path: ['operation', 'provider', 'org_id'],
      message: 'Receipt provider organization must match receipt organization',
    });
  }
});
export type AppRunReceiptEnvelope = z.infer<typeof AppRunReceiptEnvelopeSchema>;

export const AppRunSubmissionSchema = z.object({
  schema_version: z.literal(APP_RUN_CONTRACT_VERSIONS.run),
  org_id: ExactIdentitySchema,
  initiating_actor: AppRunActorSchema,
  execution_actor: AppRunActorSchema,
  origin: AppRunOriginSchema,
  operation: CapabilityProviderOperationIdentitySchema,
  provider_snapshot_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  policy: AppRunPolicySnapshotSchema,
  retention_class: AppRunRetentionClassSchema,
  idempotency_key: z.string().min(1),
  input: CapabilityJsonObjectSchema,
  authorization_snapshot: AppRunAuthorizationSnapshotSchema,
  safe_preview: AppRunSafePreviewSchema,
}).strict().superRefine((value, ctx) => {
  if (value.operation.provider.org_id !== value.org_id) {
    ctx.addIssue({ code: 'custom', path: ['operation', 'provider', 'org_id'], message: 'Provider organization must match Run organization' });
  }
});
export type AppRunSubmission = z.infer<typeof AppRunSubmissionSchema>;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function parseAppRunSubmission(value: unknown): AppRunSubmission {
  // Bound adversarial recursive input before Zod walks it.
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'input' in value) {
    assertCapabilityJsonWithinBudget(
      (value as { input?: unknown }).input,
      APP_RUN_LIMITS.input_bytes,
    );
  }
  const parsed = AppRunSubmissionSchema.parse(value);
  if (utf8Bytes(parsed.idempotency_key) > APP_RUN_LIMITS.idempotency_key_bytes) {
    throw new TypeError(`App Run idempotency key exceeds ${APP_RUN_LIMITS.idempotency_key_bytes} bytes`);
  }
  assertCapabilityJsonWithinBudget(parsed.input, APP_RUN_LIMITS.input_bytes);
  assertCapabilityJsonWithinBudget(
    parsed.authorization_snapshot,
    APP_RUN_LIMITS.authorization_snapshot_bytes,
  );
  assertCapabilityJsonWithinBudget(parsed.safe_preview, APP_RUN_LIMITS.safe_preview_bytes);
  return parsed;
}

export function assertAppRunOutputWithinBudget(value: unknown): asserts value is CapabilityJsonValue {
  assertCapabilityJsonWithinBudget(value, APP_RUN_LIMITS.output_bytes);
}

export function parseAppRunEvent(value: unknown): AppRunEvent {
  const parsed = AppRunEventSchema.parse(value);
  assertCapabilityJsonWithinBudget(parsed.payload, APP_RUN_LIMITS.safe_event_payload_bytes);
  return parsed;
}

export function parseAppRunReceiptEnvelope(value: unknown): AppRunReceiptEnvelope {
  const parsed = AppRunReceiptEnvelopeSchema.parse(value);
  assertCapabilityJsonWithinBudget(parsed, APP_RUN_LIMITS.safe_receipt_envelope_bytes);
  return parsed;
}

export function retentionDeadline(
  retentionClass: AppRunRetentionClass,
  from: Date,
): Date {
  return new Date(from.getTime() + APP_RUN_SECRET_RETENTION_MS[retentionClass]);
}

export function idempotencyDeadline(
  retentionClass: AppRunRetentionClass,
  from = new Date(),
): Date {
  return new Date(from.getTime() + APP_RUN_IDEMPOTENCY_RETENTION_MS[retentionClass]);
}
