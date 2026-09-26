import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const PublicControlSecretSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const PublicCancellationPolicySchema = z.strictObject({
  schema_version: z.literal('deft.app_public_cancellation_policy.v1'),
  control_ttl_seconds: z.number().int().min(1).max(604800),
  cancel_native_binding_id: z.string().uuid(),
  expected_cancel_consent_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
export const PublicControlInputSchema = z.strictObject({
  schema_version: z.literal('deft.app_public_control.v1'), control_secret: PublicControlSecretSchema,
});
export const PublicCancelInputSchema = z.strictObject({
  schema_version: z.literal('deft.app_public_cancel.v1'), control_secret: PublicControlSecretSchema,
  idempotency_key: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
});
export function publicControlDigest(org: string, endpoint: string, claim: string, secret: string) {
  return `sha256:${createHash('sha256').update(JSON.stringify([
    'deft.app_public_control.v1', org, endpoint, claim, secret,
  ])).digest('hex')}`;
}
export function publicControlMatches(expected: string | null, org: string, endpoint: string, claim: string, secret: string) {
  const actual = publicControlDigest(org, endpoint, claim, secret);
  return expected !== null && expected.length === actual.length
    && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}
export type PublicControlState = 'reserved' | 'released_before_effect' | 'withdrawal_requested' | 'cancellation_unavailable';
