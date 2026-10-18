import { z } from 'zod';
import { ExposureSnapshotSchema, exposureDigest, type ExposureSnapshot } from './app-experience-exposure-contract.js';

// Durable permission is independent of any tab, Web SID, access token or lease.
const { web_session_id: _sid, experience_session_id: _session, prepared_at: _prepared,
  review_expires_at: _review, web_access_expires_at: _access, expires_at: _expiry,
  owner_label: _ownerLabel, schema_version: _version, ...scopeShape } = ExposureSnapshotSchema.shape;
export const ExperienceConsentScopeSchema = z.strictObject({
  ...scopeShape, schema_version: z.literal('deft.experience_consent.v1'),
  exposure_schema_version: ExposureSnapshotSchema.shape.schema_version,
});
export type ExperienceConsentScope = z.infer<typeof ExperienceConsentScopeSchema>;
export function experienceConsentScope(snapshot: ExposureSnapshot): ExperienceConsentScope {
  const { web_session_id: _sid, experience_session_id: _session, prepared_at: _prepared,
    review_expires_at: _review, web_access_expires_at: _access, expires_at: _expiry,
    owner_label: _ownerLabel, schema_version, ...scope } = snapshot;
  return ExperienceConsentScopeSchema.parse({ ...scope, schema_version: 'deft.experience_consent.v1', exposure_schema_version: schema_version });
}
export const ExperienceConsentAcceptSchema = z.strictObject({
  review_token: z.string().min(1).max(24576), review_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  accept_exposure: z.literal(true),
});
export const experienceConsentDigest = (scope: ExperienceConsentScope) => exposureDigest(scope);
export const ExperienceConsentReviewTokenSchema = z.strictObject({
  scope: ExperienceConsentScopeSchema, web_session_id: z.string().uuid(), experience_session_id: z.string().uuid(),
  prepared_at: z.iso.datetime(), review_expires_at: z.iso.datetime(),
});
