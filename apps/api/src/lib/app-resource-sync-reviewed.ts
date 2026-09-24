import { and, eq } from 'drizzle-orm';
import { appGrantSnapshots, appInstallations, appVersions } from '@deft/db/schema';
import { parseResourceAppManifest } from '@deft/app-kit';
import { digestResourceSyncDescriptor } from '@deft/app-kit/experimental/resource-sync';
import type { AppRunTransaction } from './app-run-repository.js';
import { AppError } from './app-errors.js';
import { buildRequestedAppGrantProjection, digestAppGrantValue } from './app-grant-service.js';
import { buildResourceAppReviewedAuthority } from './app-runtime-review.js';

const stale = () => new AppError('Reviewed App resource authority changed', 'APP_STALE', 409);

/** App-level authority only. Callers must lock and authorize the current human
 * owner/operator before this reader, and separately check resource consent,
 * registration, session and Run intent. A reviewed App never grants a read. */
export async function loadReviewedResourceSyncDescriptor(
  tx: AppRunTransaction, orgId: string, installationId: string, resourceKey: string,
) {
  const [installation] = await tx.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, orgId), eq(appInstallations.id, installationId),
  )).limit(1).for('share');
  if (!installation || installation.state !== 'active'
    || !installation.active_version_id || !installation.active_grant_snapshot_id
    || installation.active_grant_snapshot_kind !== 'effective') throw stale();
  const [version] = await tx.select().from(appVersions).where(and(
    eq(appVersions.org_id, orgId), eq(appVersions.installation_id, installation.id),
    eq(appVersions.id, installation.active_version_id), eq(appVersions.state, 'active'),
    eq(appVersions.protocol_version, '5'),
  )).limit(1).for('share');
  if (!version) throw stale();
  let manifest: ReturnType<typeof parseResourceAppManifest>;
  try { manifest = parseResourceAppManifest(version.manifest); }
  catch { throw stale(); }
  const descriptor = manifest.sync_descriptors.find((item) => item.key === resourceKey);
  if (!descriptor) throw stale();
  const [grant] = await tx.select().from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, orgId), eq(appGrantSnapshots.app_installation_id, installation.id),
    eq(appGrantSnapshots.app_version_id, version.id),
    eq(appGrantSnapshots.id, installation.active_grant_snapshot_id),
    eq(appGrantSnapshots.snapshot_kind, 'effective'),
  )).limit(1);
  const [requested] = await tx.select().from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, orgId), eq(appGrantSnapshots.app_installation_id, installation.id),
    eq(appGrantSnapshots.app_version_id, version.id),
    eq(appGrantSnapshots.id, version.requested_grant_snapshot_id ?? ''),
    eq(appGrantSnapshots.snapshot_kind, 'requested'),
  )).limit(1);
  if (!grant || !requested || grant.requested_snapshot_id !== requested.id
    || grant.manifest_digest !== version.manifest_digest
    || grant.package_digest !== version.package_digest
    || grant.app_id !== installation.app_id || grant.app_version !== version.version
    || manifest.id !== installation.app_id || manifest.version !== version.version
    || digestAppGrantValue(manifest) !== version.manifest_digest
    || digestAppGrantValue(grant.canonical_snapshot) !== grant.snapshot_digest) throw stale();
  const requestedProjection = buildRequestedAppGrantProjection({ organization_id: orgId,
    app_installation_id: installation.id, app_version_id: version.id, manifest,
    manifest_digest: version.manifest_digest, package_digest: version.package_digest });
  if (requested.snapshot_digest !== requestedProjection.snapshot_digest
    || digestAppGrantValue(requested.canonical_snapshot) !== requestedProjection.snapshot_digest) throw stale();
  const authority = buildResourceAppReviewedAuthority(manifest, {
    lineage_key: installation.lineage_key,
    package_digest: version.package_digest, manifest_digest: version.manifest_digest,
  });
  const stored = grant.canonical_snapshot;
  const classification = { authority_state: 'effective', executable: false, provider_access: false,
    runtime_binding_review_required: true, resource_binding_consent_required: true };
  if (typeof stored.review_digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(stored.review_digest)
    || digestAppGrantValue(grant.classification) !== digestAppGrantValue(classification)
    || grant.resource_rights.length !== 0) throw stale();
  const expected = { ...authority, organization_id: orgId,
    app_installation_id: installation.id, app_version_id: version.id,
    requested_snapshot_id: requested.id, requested_snapshot_digest: requested.snapshot_digest,
    classification, review_digest: stored.review_digest };
  if (digestAppGrantValue(expected) !== grant.snapshot_digest) throw stale();
  const descriptorDigest = await digestResourceSyncDescriptor(descriptor);
  return { installation, version, grant, descriptor, descriptor_digest: descriptorDigest };
}
