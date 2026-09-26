import { and, eq, inArray } from 'drizzle-orm';
import { AppDigestSchema, parseAttachmentAppManifest, type DeftAppManifestV7 } from '@deft/app-kit';
import { appInstallations, appVersions, appGrantSnapshots, users } from '@deft/db/schema';
import type { AppRunTransaction } from './app-run-repository.js';
import type { WebAuthorityGuard } from './app-resource-sync-web-authority.js';
import { AppError } from './app-errors.js';
import { isAppAttachmentBrokerEnabled } from './env.js';
import { buildRequestedAppGrantProjection, digestAppGrantValue } from './app-grant-service.js';

export const attachmentStale = () => new AppError('Attachment authority changed or is unavailable', 'APP_STALE', 409);
export function assertAttachmentBrokerEnabled(): void {
  if (!isAppAttachmentBrokerEnabled()) throw new AppError('Attachment broker unavailable', 'APP_FEATURE_DISABLED', 503);
}
export function assertAttachmentManifestAdmission(manifest: DeftAppManifestV7): void {
  assertAttachmentBrokerEnabled();
  if (manifest.runtime_actions.length || manifest.native_actions.length || manifest.public_actions.length
    || manifest.experiences.length || manifest.private_capabilities.length) {
    throw new AppError('Protocol7 action and Experience planes are not yet supported', 'APP_PROTOCOL_UNSUPPORTED', 409);
  }
}
export const ATTACHMENT_APP_EFFECTIVE_CLASSIFICATION = Object.freeze({
  authority_state: 'effective', executable: false, provider_access: false,
  runtime_binding_review_required: true, resource_binding_consent_required: true,
  attachment_policy_review_required: true,
});
export function buildAttachmentAppReviewedAuthority(manifest: DeftAppManifestV7, pins: {
  lineage_key: string; package_digest: string; manifest_digest: string;
}) {
  assertAttachmentManifestAdmission(manifest);
  return { schema: 'deft.app_blob_grant.v1' as const, ...pins,
    sync_descriptors: manifest.sync_descriptors.map(descriptor => ({ ...descriptor, descriptor_digest: digestAppGrantValue(descriptor) })),
    modules: manifest.modules, runtime_actions: [], native_actions: [], public_actions: [], experiences: [],
    host_policy: { encrypted_custody: true, current_parent_required: true, provider_url_fetch: false,
      irrecoverable_host_purge: true, owner_only: true, stage_ceiling_seconds: 3600 } };
}
export type AttachmentManagementOptions = Readonly<{ guard?: WebAuthorityGuard;
  clock?: () => Date; expires_at?: readonly Date[]; signal?: AbortSignal }>;

/** IDs come from the complete participant rows already locked/revalidated.
 * SID executes last; no new membership or user locks follow App/custody locks. */
export async function attachmentFinalAuthorityIsCurrent(tx: AppRunTransaction,
  participants: readonly string[], options: AttachmentManagementOptions = {}): Promise<boolean> {
  await options.guard?.(tx);
  const ids = [...new Set(participants)];
  const humans = await tx.select({ id: users.id, kind: users.kind, is_agent: users.is_agent }).from(users).where(inArray(users.id, ids));
  const now = (options.clock ?? (() => new Date()))();
  const webDeadline = options.guard?.current_web_session_expires_at();
  return Number.isFinite(now.getTime()) && ids.every(id => humans.some(row => row.id === id && row.kind === 'human' && row.is_agent === false))
    && isAppAttachmentBrokerEnabled() && !options.signal?.aborted && (!webDeadline || webDeadline > now)
    && (options.expires_at ?? []).every(deadline => Number.isFinite(deadline.getTime()) && deadline > now);
}

/** App/version/requested/effective bytes remain independently reconstructable;
 * this reader never accepts a native6 or Runtime3–5 grant as attachment rights. */
export async function loadReviewedAttachmentApp(tx: AppRunTransaction, orgId: string, installationId: string) {
  assertAttachmentBrokerEnabled();
  const [installation] = await tx.select().from(appInstallations).where(and(eq(appInstallations.org_id, orgId),
    eq(appInstallations.id, installationId))).limit(1).for('share');
  if (!installation || installation.state !== 'active' || !installation.active_version_id
    || installation.active_grant_snapshot_kind !== 'effective' || !installation.active_grant_snapshot_id) throw attachmentStale();
  const [version] = await tx.select().from(appVersions).where(and(eq(appVersions.org_id, orgId),
    eq(appVersions.id, installation.active_version_id), eq(appVersions.installation_id, installationId),
    eq(appVersions.protocol_version, '7'), eq(appVersions.state, 'active'))).limit(1).for('share');
  if (!version) throw attachmentStale();
  const manifest = parseAttachmentAppManifest(version.manifest); assertAttachmentManifestAdmission(manifest);
  const [grant] = await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id, orgId),
    eq(appGrantSnapshots.id, installation.active_grant_snapshot_id), eq(appGrantSnapshots.app_installation_id, installationId),
    eq(appGrantSnapshots.app_version_id, version.id), eq(appGrantSnapshots.snapshot_kind, 'effective'))).limit(1);
  const [requested] = await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id, orgId),
    eq(appGrantSnapshots.id, version.requested_grant_snapshot_id ?? ''), eq(appGrantSnapshots.app_installation_id, installationId),
    eq(appGrantSnapshots.app_version_id, version.id), eq(appGrantSnapshots.snapshot_kind, 'requested'))).limit(1);
  if (!grant || !requested || grant.requested_snapshot_id !== requested.id || manifest.id !== installation.app_id
    || manifest.version !== version.version || digestAppGrantValue(manifest) !== version.manifest_digest
    || grant.manifest_digest !== version.manifest_digest || grant.package_digest !== version.package_digest
    || grant.app_id !== installation.app_id || grant.app_version !== version.version) throw attachmentStale();
  const projection = buildRequestedAppGrantProjection({ organization_id: orgId, app_installation_id: installationId,
    app_version_id: version.id, manifest, manifest_digest: version.manifest_digest, package_digest: version.package_digest });
  const digest = AppDigestSchema.safeParse(grant.canonical_snapshot.review_digest);
  if (!digest.success || requested.snapshot_digest !== projection.snapshot_digest
    || digestAppGrantValue(requested.canonical_snapshot) !== projection.snapshot_digest
    || grant.resource_rights.length || digestAppGrantValue(grant.classification) !== digestAppGrantValue(ATTACHMENT_APP_EFFECTIVE_CLASSIFICATION)) throw attachmentStale();
  const authority = buildAttachmentAppReviewedAuthority(manifest, { lineage_key: installation.lineage_key,
    package_digest: version.package_digest, manifest_digest: version.manifest_digest });
  const canonical = { ...authority, organization_id: orgId, app_installation_id: installationId,
    app_version_id: version.id, requested_snapshot_id: requested.id, requested_snapshot_digest: requested.snapshot_digest,
    classification: ATTACHMENT_APP_EFFECTIVE_CLASSIFICATION, review_digest: digest.data };
  if (digestAppGrantValue(canonical) !== grant.snapshot_digest || digestAppGrantValue(grant.canonical_snapshot) !== grant.snapshot_digest) throw attachmentStale();
  return { installation, version, grant, requested, manifest };
}
