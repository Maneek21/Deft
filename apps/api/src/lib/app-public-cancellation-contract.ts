import { z } from 'zod';
import { AppDigestSchema } from '@deft/app-kit';
import { canonicalCapabilityJson } from '@deft/shared';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppRunKeyProvider } from './app-run-keyrings.js';

export const HistoricalCreatePinSchema = z.strictObject({
  app_version_id: z.uuid(), package_digest: AppDigestSchema,
  grant_snapshot_id: z.uuid(), grant_snapshot_digest: AppDigestSchema,
});
export const HistoricalCreatePolicySchema = z.strictObject({
  schema_version: z.literal('deft.app_native_historical_create_policy.v1'),
  creates: z.array(HistoricalCreatePinSchema).min(1).max(16),
}).superRefine((policy, context) => {
  const identities = policy.creates.map(pin => `${pin.app_version_id}:${pin.grant_snapshot_id}`);
  if (new Set(identities).size !== identities.length) context.addIssue({
    code: 'custom', message: 'Historical create pins must be unique', path: ['creates'],
  });
});
export const PublicCancellationOwnerReviewSchema = z.strictObject({
  schema_version: z.literal('deft.app_public_cancellation_owner_review_request.v1'),
  native_binding_id: z.uuid(), expected_consent_digest: AppDigestSchema,
});
export const PublicCancellationOwnerSubmitSchema = PublicCancellationOwnerReviewSchema.extend({
  review_token: z.string().min(1).max(8192), expected_review_digest: AppDigestSchema, accept_host_policy: z.literal(true),
});
export const PUBLIC_CANCELLATION_OWNER_REVIEW_MS = 300_000;
export type HistoricalCreatePolicy = z.infer<typeof HistoricalCreatePolicySchema>;

export const PublicCancellationReviewTokenSchema = z.strictObject({
  schema_version: z.literal('deft.app_public_cancellation_owner_review_token.v1'),
  org_id: z.uuid(), cancellation_id: z.uuid(), original_run_id: z.uuid(), owner_user_id: z.uuid(),
  native_binding_id: z.uuid(), consent_digest: AppDigestSchema, proposal_digest: AppDigestSchema,
  app_version_id: z.uuid(), grant_snapshot_id: z.uuid(),
  input_digest: AppDigestSchema, output_digest: AppDigestSchema, session_scope_digest: AppDigestSchema,
  issued_at: z.iso.datetime({ offset: true }), expires_at: z.iso.datetime({ offset: true }),
}).superRefine((value, context) => {
  const lifetime = Date.parse(value.expires_at) - Date.parse(value.issued_at);
  if (lifetime <= 0 || lifetime > PUBLIC_CANCELLATION_OWNER_REVIEW_MS) context.addIssue({
    code: 'custom', message: 'Owner review lifetime exceeds its bound', path: ['expires_at'],
  });
});
export type PublicCancellationReviewToken = z.infer<typeof PublicCancellationReviewTokenSchema>;
const reviewPurpose = 'deft.app_public_cancellation.owner_review.v1\0';

/** Shared key versions survive instance changes; this audience is disjoint
 * from Exposure, public availability, credentials and Run receipts. */
export function sealPublicCancellationReview(keys: AppRunKeyProvider, value: PublicCancellationReviewToken) {
  const key = keys.current('fingerprint');
  try {
    const payload = Buffer.from(canonicalCapabilityJson({ key_version: key.key_id,
      value: PublicCancellationReviewTokenSchema.parse(value) })).toString('base64url');
    const mac = createHmac('sha256', key.key).update(reviewPurpose).update(payload).digest('base64url');
    const token = `${payload}.${mac}`;
    if (token.length > 8192) throw new Error('Invalid cancellation review');
    return token;
  } finally { key.key.fill(0); }
}
export function openPublicCancellationReview(keys: AppRunKeyProvider, token: string): PublicCancellationReviewToken {
  if (token.length > 8192) throw new Error('Invalid cancellation review');
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error('Invalid cancellation review');
  const bytes = Buffer.from(parts[0]!, 'base64url');
  if (bytes.toString('base64url') !== parts[0]) throw new Error('Invalid cancellation review');
  const parsed = z.strictObject({ key_version: z.string().min(1).max(128), value: PublicCancellationReviewTokenSchema })
    .parse(JSON.parse(bytes.toString('utf8')));
  const key = keys.read('fingerprint', parsed.key_version);
  if (!key) throw new Error('Invalid cancellation review');
  try {
    const mac = Buffer.from(parts[1]!, 'base64url');
    const expected = createHmac('sha256', key.key).update(reviewPurpose).update(parts[0]!).digest();
    if (mac.toString('base64url') !== parts[1] || mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
      throw new Error('Invalid cancellation review');
    }
    return parsed.value;
  } finally { key.key.fill(0); }
}

/** Historical pins are ancestry scope, never authority to execute an old grant. */
export function historicalCreateIsExplicitlyConsented(policy: unknown, pin: z.infer<typeof HistoricalCreatePinSchema>) {
  if (policy == null) return false;
  return HistoricalCreatePolicySchema.parse(policy).creates.some(candidate =>
    candidate.app_version_id === pin.app_version_id && candidate.package_digest === pin.package_digest
    && candidate.grant_snapshot_id === pin.grant_snapshot_id
    && candidate.grant_snapshot_digest === pin.grant_snapshot_digest);
}
