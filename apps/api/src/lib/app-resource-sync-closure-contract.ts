import { AppConsentExpirySchema, AppConsentLifetimeSchema, appConsentExpiryValid } from '@deft/app-kit/core';
import { z } from 'zod';

const id = z.string().uuid();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const AppResourceSyncClosureRequestSchema = z.strictObject({ run_id: id, current_resource_binding_id: id.optional() });
export const AppResourceSyncClosureActivationSchema = AppResourceSyncClosureRequestSchema.extend({
  expected_review_digest: digest, accept_host_policy: z.literal(true),
});
export const AppResourceSyncClosureReceiptRequestSchema = AppResourceSyncClosureRequestSchema.extend({
  current_resource_binding_id: id, expected_review_digest: digest,
});
export const AppResourceSyncClosureReviewSchema = z.strictObject({
  schema_version: z.literal('deft.app_private_sync_closure_review.v1'),
  org_id: id, run_id: id, reviewer_user_id: id, resource_binding_id: id,
  runtime_registration_id: id, owner_user_id: id, operator_user_id: id,
  installation_id: id, app_version_id: id, grant_snapshot_id: id,
  package_digest: digest, grant_snapshot_digest: digest, descriptor_digest: digest,
  lifecycle_epoch: z.number().int().nonnegative(), grant_epoch: z.number().int().nonnegative(),
  runtime_epoch: z.number().int().positive(), target_key: z.string().min(1).max(48),
  consent_expires_at: AppConsentExpirySchema, consent_lifetime: AppConsentLifetimeSchema.optional(), state: z.literal('unknown_outcome'),
  unknown_outcome_at: z.iso.datetime(), attempt_id: id, attempt_digest: digest,
  intent_digest: digest, checkpoint_id: id, checkpoint_digest: digest,
  basis: z.literal('operator_closes_unknown_sync'), provider_outcome: z.literal('unknown'),
  no_retry: z.literal(true), review_digest: digest,
  historical_closure: z.strictObject({
    operation_name: z.string().min(1).max(128), run_created_at: z.iso.datetime(),
    current_resource_binding_id: id, current_runtime_registration_id: id,
    current_app_version_id: id, current_grant_snapshot_id: id,
    current_package_digest: digest, current_grant_snapshot_digest: digest,
    current_lifecycle_epoch: z.number().int().nonnegative(), current_grant_epoch: z.number().int().nonnegative(),
    current_runtime_epoch: z.number().int().positive(), current_consent_expires_at: AppConsentExpirySchema,
    current_consent_lifetime: AppConsentLifetimeSchema.optional(),
    profile_digest: digest, transport_digest: digest,
  }).refine(value => appConsentExpiryValid(value.current_consent_expires_at, value.current_consent_lifetime)).optional(),
  observation:z.strictObject({consent_id:id,consent_digest:digest,connection_session_id:id,
    account_ref:z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/u),
    expected_custody_generation:z.number().int().positive().max(2147483646).nullable(),receipt_digest:digest.nullable()})
    .refine(value=>(value.expected_custody_generation===null)===(value.receipt_digest===null)).optional(),
}).refine(value => appConsentExpiryValid(value.consent_expires_at, value.consent_lifetime));
export type AppResourceSyncClosureReview = z.infer<typeof AppResourceSyncClosureReviewSchema>;
export type AppResourceSyncClosureResult = Readonly<{
  run_id: string; state: 'failed'; basis: 'operator_closes_unknown_sync';
  provider_outcome: 'unknown'; no_retry: true; review_digest: string;
  receipt?: Readonly<{ receipt_id: string; envelope_digest: string; signing_key_version: string; signed_at: string; verified: true }>;
}>;
