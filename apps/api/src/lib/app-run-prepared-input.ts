import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CapabilityJsonObjectSchema } from '@deft/shared';
import {
  AppRunSecretEnvelopeSchema,
  type AppRunSecretEnvelope,
  type AppRunSecretSafeProjection,
  type AppRunSecretService,
} from './app-run-secrets.js';

export const APP_RUN_PREPARED_INPUT_VERSION = 'deft.app_run_prepared_input.v1' as const;
const PREPARED_INPUT_TTL_MS = 5 * 60 * 1_000;

const ExactIdentitySchema = z.string().min(1).max(512)
  .refine((value) => value === value.trim())
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));

const BindingIdentitySchema = z.strictObject({
  app_installation_id: ExactIdentitySchema,
  app_version_id: ExactIdentitySchema,
  grant_snapshot_id: ExactIdentitySchema,
  binding_id: ExactIdentitySchema,
  binding_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

const PreparedPayloadSchema = z.strictObject({
  schema_version: z.literal(APP_RUN_PREPARED_INPUT_VERSION),
  expires_at: z.string().datetime({ offset: true }),
  replay_identity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  binding_identity: BindingIdentitySchema,
  provider_input: CapabilityJsonObjectSchema,
});

export type AppRunPreparedInputPayload = z.infer<typeof PreparedPayloadSchema>;

export type AppRunPreparedInputCandidate = Readonly<{
  schema_version: typeof APP_RUN_PREPARED_INPUT_VERSION;
  candidate_id: string;
  expires_at: string;
  sealed_payload: AppRunSecretEnvelope;
  safe_envelope: AppRunSecretSafeProjection;
}>;

/** App-Run-owned transient protection for a fully revalidated action input.
 * It creates no Run, approval, receipt, or provider effect. Loop 5 may open it
 * only after repeating live action authorization. */
export class AppRunPreparedInputService {
  constructor(
    private readonly secrets: AppRunSecretService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  protect(input: Readonly<{
    org_id: string;
    replay_identity: string;
    binding_identity: z.infer<typeof BindingIdentitySchema>;
    provider_input: unknown;
  }>): AppRunPreparedInputCandidate {
    const candidateId = randomUUID();
    const expiresAt = new Date(this.now().getTime() + PREPARED_INPUT_TTL_MS).toISOString();
    const payload = PreparedPayloadSchema.parse({
      schema_version: APP_RUN_PREPARED_INPUT_VERSION,
      expires_at: expiresAt,
      replay_identity: input.replay_identity,
      binding_identity: input.binding_identity,
      provider_input: input.provider_input,
    });
    const sealed = this.secrets.sealJson(payload, {
      org_id: input.org_id,
      run_id: candidateId,
      payload_kind: 'input',
    });
    return Object.freeze({
      schema_version: APP_RUN_PREPARED_INPUT_VERSION,
      candidate_id: candidateId,
      expires_at: expiresAt,
      sealed_payload: sealed,
      safe_envelope: this.secrets.safeProjection(sealed),
    });
  }

  open(orgId: string, candidate: AppRunPreparedInputCandidate): AppRunPreparedInputPayload {
    if (
      candidate.schema_version !== APP_RUN_PREPARED_INPUT_VERSION
      || !ExactIdentitySchema.safeParse(candidate.candidate_id).success
      || !Number.isFinite(Date.parse(candidate.expires_at))
      || Date.parse(candidate.expires_at) <= this.now().getTime()
    ) throw new Error('APP_RUN_PREPARED_INPUT_INVALID');
    const sealed = AppRunSecretEnvelopeSchema.parse(candidate.sealed_payload);
    const payload = PreparedPayloadSchema.parse(this.secrets.openJson(sealed, {
      org_id: orgId,
      run_id: candidate.candidate_id,
      payload_kind: 'input',
    }));
    if (
      payload.expires_at !== candidate.expires_at
      || Date.parse(payload.expires_at) <= this.now().getTime()
    ) throw new Error('APP_RUN_PREPARED_INPUT_INVALID');
    return payload;
  }
}
