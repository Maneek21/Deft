import {AppConsentLifetimeSchema,AppConsentExpirySchema,appConsentExpiryValid,type AppConsentLifetime} from '@deft/app-kit';
import { z } from 'zod';
import { OwnerConnectionPolicyDeclarationSchema, AttachmentPolicySchema, AppConnectionProfileSchema } from '@deft/app-kit';
import type { OwnerConnectionPolicyDeclaration } from '@deft/app-kit';
import { AppResourceSyncConsentLimitsSchema } from './app-resource-sync-policy.js';
import { AppError } from './app-errors.js';

/** E1 declarations cannot silently enter the in-process legacy connection
 * registry. E2 must compose admitted external profile/runtime authority first. */
export function assertLegacyOwnerConnectionPolicy(policy: OwnerConnectionPolicyDeclaration): void {
  if (policy.provider_profile_key !== undefined || policy.runtime_requirement_key !== undefined)
    throw new AppError('External connection profile is not available', 'APP_CONNECTION_PROFILE_UNAVAILABLE', 409);
}
/** Manually reviewed legacy owner/admin bindings may have no admission row.
 * A matching external profile must still never enter the private adapter path. */
export function assertLegacyOwnerConnectionResourcePolicies(
  policies: readonly OwnerConnectionPolicyDeclaration[] | undefined, resourceKey: string,
): void {
  for (const policy of policies ?? []) if (policy.resource_key === resourceKey) assertLegacyOwnerConnectionPolicy(policy);
}

const id = z.string().uuid(), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const epoch = z.number().int().nonnegative().max(2147483647);
export const OwnerConnectionAdmissionReferenceSchema = z.strictObject({ admission_id: id, admission_digest: digest });
export type OwnerConnectionAdmissionReference = z.infer<typeof OwnerConnectionAdmissionReferenceSchema>;
/** The deployment profile is included in the admin review digest; config alone
 * never establishes an installation's external connection authority. */
export async function resolveOwnerConnectionProfile(orgId: string, installationId: string,
  policy: OwnerConnectionPolicyDeclaration, operatorId?: string) {
  if (policy.provider_profile_key === undefined && policy.runtime_requirement_key === undefined) return undefined;
  const { getAppConnectionSessionRegistry } = await import('./app-connection-session-registry.js');
  return (await getAppConnectionSessionRegistry()).profile(orgId, installationId, policy, operatorId);
}
export async function ownerConnectionTransportDigest(orgId: string, installationId: string,
  profile: z.infer<typeof AppConnectionProfileSchema>) {
  const { getAppConnectionSessionRegistry } = await import('./app-connection-session-registry.js');
  return (await getAppConnectionSessionRegistry()).transportDigest(orgId, installationId, profile);
}
export const OwnerConnectionAdmissionInputSchema = z.strictObject({ installation_id: id, policy_key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
  operator_user_id: id, limits: AppResourceSyncConsentLimitsSchema, expected_app_version_id: id,
  expected_package_digest: digest, expected_grant_snapshot_digest: digest, expected_lifecycle_epoch: epoch, expected_grant_epoch: epoch });
export const OwnerConnectionAdmissionSnapshotSchema = z.strictObject({ schema_version: z.literal('deft.owner_connection_admission.v1'),
  org_id: id, installation_id: id, app_version_id: id, grant_snapshot_id: id, package_digest: digest, grant_snapshot_digest: digest,
  lifecycle_epoch: epoch, grant_epoch: epoch, operator_user_id: id, policy: OwnerConnectionPolicyDeclarationSchema,
  policy_digest: digest, resource_descriptor_digest: digest, actions: z.array(z.strictObject({ action_key: z.string(), contract_digest: digest })).max(16),
  limits: AppResourceSyncConsentLimitsSchema,
  connection_profile: AppConnectionProfileSchema.optional(),
  connection_profile_digest: digest.optional(),
  connection_transport_digest: digest.optional(),
}).refine(value => (value.connection_profile === undefined) === (value.connection_profile_digest === undefined)
  && (value.connection_profile === undefined) === (value.connection_transport_digest === undefined));
export type OwnerConnectionAdmissionSnapshot = z.infer<typeof OwnerConnectionAdmissionSnapshotSchema>;
export const OwnerConnectionResourceRequestSchema = z.strictObject({ ...OwnerConnectionAdmissionReferenceSchema.shape,
  target_key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/), consent_expires_at: AppConsentExpirySchema, consent_lifetime: AppConsentLifetimeSchema.optional(),
  limits: AppResourceSyncConsentLimitsSchema, attachment_policy: AttachmentPolicySchema }).refine(v=>appConsentExpiryValid(v.consent_expires_at,v.consent_lifetime));
export const OwnerConnectionActionRequestSchema = z.strictObject({ ...OwnerConnectionAdmissionReferenceSchema.shape,
  owner_resource_binding_id: id, action_key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/) });
export type OwnerConnectionContext = Readonly<{ schema_version: 'deft.owner_connection_context.v1'; installation_id: string;
  policies: readonly Readonly<{ policy: OwnerConnectionPolicyDeclaration; status: 'admitted' | 'deployment_review_required';
    admission: null | (OwnerConnectionAdmissionReference & { operator_user_id: string; operator_label: string;
      resource_request: z.infer<typeof OwnerConnectionResourceRequestSchema> });
    bindings: readonly Readonly<{ binding_id: string; target_key: string; state: string; consent_expires_at: string | null; consent_lifetime?:AppConsentLifetime;
      actions: readonly Readonly<{ action_key: string; binding_id: string; state: string }>[] }>[] }>[] }>;
export type OwnerConnectionResourceActivation = Readonly<{ registration_id: string; binding_id: string; checkpoint_id: string;
  app_version_id: string; grant_snapshot_id: string; resource_key: string; review_digest: string }>;
export type OwnerConnectionActionActivation = Readonly<{ registration_id: string; binding_id: string;
  app_version_id: string; grant_snapshot_id: string; action_key: string; review_digest: string }>;
export function ownerConnectionLimitsWithin(request: z.infer<typeof AppResourceSyncConsentLimitsSchema>, ceiling: z.infer<typeof AppResourceSyncConsentLimitsSchema>) {
  return Object.entries(request).every(([key, value]) => key === 'min_interval_seconds'
    ? value >= ceiling[key] : value <= ceiling[key as keyof typeof ceiling]);
}
