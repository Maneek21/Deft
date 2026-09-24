import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Host policy for explicitly reviewed private sync. Author descriptors and
 * provider pages cannot override this policy or nominate the resource owner. */
export const APP_RESOURCE_SYNC_HOST_POLICY = Object.freeze({
  risk_class: 'internal_write', review_requirement: 'policy',
  review_scope: 'reviewed_resource_sync', retry_class: 'unsafe_or_unknown',
  retention_class: 'standard',
} as const);
export const APP_RESOURCE_SYNC_MAX_CONSENT_MS = 90 * 24 * 60 * 60 * 1_000;
export const APP_RESOURCE_SYNC_SESSION_MS = 15 * 60 * 1_000;

const identity = z.string().uuid();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const epoch = z.number().int().min(0).max(2_147_483_647);
const resourceKey = z.string().min(1).max(48).regex(/^[a-z][a-z0-9_]*$/u)
  .refine((value) => !['constructor', 'prototype', '__proto__'].includes(value));

export const AppResourceSyncConsentLimitsSchema = z.strictObject({
  max_records_per_page: z.number().int().min(1).max(100),
  max_page_bytes: z.number().int().min(1).max(524_288),
  max_retained_records: z.number().int().min(1).max(100_000),
  max_retained_bytes: z.number().int().min(1).max(1_073_741_824),
  min_interval_seconds: z.number().int().min(60).max(86_400),
});

export const AppResourceSyncConsentRequestSchema = z.strictObject({
  installation_id: identity,
  resource_key: resourceKey,
  operator_user_id: identity,
  expected_app_version_id: identity,
  expected_package_digest: digest,
  expected_grant_snapshot_digest: digest,
  expected_lifecycle_epoch: epoch,
  expected_grant_epoch: epoch,
  consent_expires_at: z.string().max(40).datetime({ offset: true }),
  limits: AppResourceSyncConsentLimitsSchema,
});
export const AppResourceSyncConsentActivationSchema = AppResourceSyncConsentRequestSchema.extend({
  expected_review_digest: digest,
  accept_host_policy: z.literal(true),
});
export type AppResourceSyncConsentRequest = z.infer<typeof AppResourceSyncConsentRequestSchema>;

/** Recheck at both preparation and activation; a review digest cannot extend
 * an expired window. The clock is host-owned and never taken from input. */
export function assertResourceSyncConsentWindow(expiresAt: string, checkedAt: Date): Date {
  const expiry = new Date(z.string().datetime({ offset: true }).parse(expiresAt));
  const remaining = expiry.getTime() - checkedAt.getTime();
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > APP_RESOURCE_SYNC_MAX_CONSENT_MS) {
    throw new TypeError('Resource sync consent must expire within 90 days of review');
  }
  return expiry;
}

/** Audience separation remains mandatory even if a database row is malformed;
 * this domain is deliberately distinct from action Runtime credentials. */
export function hashAppResourceSyncToken(token: string): string {
  return `sha256:${createHash('sha256').update('deft.app_resource_sync.session.v2\0')
    .update(token).digest('hex')}`;
}
