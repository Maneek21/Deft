import { AttachmentPolicySchema, RESOURCE_ATTACHMENT_LIMITS, type AttachmentPolicy } from '@deft/app-kit';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppResourceSyncConsentRequestSchema } from './app-resource-sync-policy.js';

export const APP_ATTACHMENT_RETAINED_STAGE_LIMIT = 4096;

export const AppAttachmentConsentRequestSchema = AppResourceSyncConsentRequestSchema.extend({
  schema_version: z.literal('deft.app_attachment_consent_request.v1'), attachment_policy: AttachmentPolicySchema,
});
export const AppAttachmentConsentActivationSchema = AppAttachmentConsentRequestSchema.extend({
  expected_review_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u), accept_host_policy: z.literal(true),
});
export type AppAttachmentConsentRequest = z.infer<typeof AppAttachmentConsentRequestSchema>;
export function parseAttachmentConsentPolicy(declaredValue: unknown, selectedValue: unknown): AttachmentPolicy {
  const declared = AttachmentPolicySchema.parse(declaredValue), selected = AttachmentPolicySchema.parse(selectedValue);
  for (const name of ['max_attachment_bytes', 'max_attachments_per_record', 'max_attachments_per_run',
    'max_attachment_bytes_per_run', 'retention_days'] as const) {
    if (selected[name] > declared[name]) throw new TypeError('Attachment consent exceeds descriptor policy');
  }
  if (selected.allowed_media_types.some(type => !declared.allowed_media_types.includes(type))) {
    throw new TypeError('Attachment consent exceeds descriptor media policy');
  }
  return selected;
}
export function hashAppAttachmentSessionToken(token: string): string {
  return `sha256:${createHash('sha256').update('deft.app_resource_sync.session.v3\0').update(token).digest('hex')}`;
}

/** The fixed stage ceiling is independent of the originally observed lease.
 * Callers still recheck the current exact renewed claim at finalize and link. */
export function appAttachmentStageExpiresAt(reservedAt: Date, inputExpiresAt: Date, resultExpiresAt: Date): Date {
  const times = [reservedAt, inputExpiresAt, resultExpiresAt].map(value => value.getTime());
  if (times.some(value => !Number.isFinite(value))) throw new TypeError('Invalid attachment deadline');
  const expiry = Math.min(times[0]! + RESOURCE_ATTACHMENT_LIMITS.stage_lifetime_ms, times[1]!, times[2]!);
  if (expiry <= times[0]!) throw new TypeError('Attachment retention expired');
  return new Date(expiry);
}

/** Only a current attempt sequence is authority. Session next_sequence is not
 * an attempt's sequence and may advance independently for another Run. */
export function appAttachmentClaimMatches(input: Readonly<{
  run_id: string; attempt_id: string; claim_token: string; sequence: number;
}>, current: Readonly<{
  run_id: string; id: string; claim_token: string | null; runtime_sequence: number | null;
  state: string; lease_expires_at: Date | null;
}>, now: Date): boolean {
  return Number.isFinite(now.getTime()) && current.run_id === input.run_id && current.id === input.attempt_id
    && current.claim_token === input.claim_token && current.runtime_sequence === input.sequence
    && current.state === 'provider_call_started' && current.lease_expires_at !== null && current.lease_expires_at > now;
}
