import { z } from 'zod';
import { ResourceHostOrganizationIdSchema, ResourceProviderInstanceIdSchema } from './resources';

/** Host-created identity pins, not credentials or authorization decisions.
 * Never accept these objects from an App to establish its rights. Callers must
 * resolve the live principal, active installation and effective grant first.
 * These internal contracts do not widen released App Protocol v0-v2 manifests.
 */
const id = ResourceProviderInstanceIdSchema;
const epoch = z.number().int().min(0).max(2_147_483_647);
const installationShape = {
  org_id: ResourceHostOrganizationIdSchema,
  app_installation_id: id,
  app_version_id: id,
  lifecycle_epoch: epoch,
  grant_epoch: epoch,
};

export const AppInstallationAuthoritySchema = z.strictObject(installationShape);
export type AppInstallationAuthority = z.infer<typeof AppInstallationAuthoritySchema>;

export const AppRuntimeSessionAuthoritySchema = z.strictObject({
  ...installationShape,
  audience: z.literal('app_runtime'),
  runtime_registration_id: id,
  runtime_binding_id: id,
  runtime_epoch: epoch,
  session_id: id,
  session_epoch: epoch,
});
export type AppRuntimeSessionAuthority = z.infer<typeof AppRuntimeSessionAuthoritySchema>;

export const AppPublicPrincipalSchema = z.strictObject({
  ...installationShape,
  audience: z.literal('app_public'),
  endpoint_id: id,
  endpoint_epoch: epoch,
});
export type AppPublicPrincipal = z.infer<typeof AppPublicPrincipalSchema>;

export const AppExperienceSessionAuthoritySchema = z.strictObject({
  ...installationShape,
  audience: z.literal('app_experience'),
  user_id: id,
  session_id: id,
  session_epoch: epoch,
});
export type AppExperienceSessionAuthority = z.infer<typeof AppExperienceSessionAuthoritySchema>;

/** Equality is necessary but insufficient: lifecycle and membership are live checks. */
export function isSameAppInstallationAuthority(
  expected: AppInstallationAuthority,
  current: AppInstallationAuthority,
): boolean {
  return expected.org_id === current.org_id &&
    expected.app_installation_id === current.app_installation_id &&
    expected.app_version_id === current.app_version_id &&
    expected.lifecycle_epoch === current.lifecycle_epoch &&
    expected.grant_epoch === current.grant_epoch;
}
