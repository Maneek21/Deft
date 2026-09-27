import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppDigestSchema, parseAttachmentAppManifest, type DeftAppPackage } from '@deft/app-kit';
import { appInstallations, appVersions, appGrantSnapshots, appModuleBindings, moduleInstallations, auditLog } from '@deft/db/schema';
import type { ModuleActor } from '@deft/shared/modules';
import { db } from './db.js';
import { assertCurrentModuleManagerWithExecutor, installModuleFromManifestWithExecutor, invalidateModuleCatalogCaches,
  type ModuleLifecyclePostCommit } from './module-service.js';
import { APP_GRANT_SNAPSHOT_VERSION, buildRequestedAppGrantProjection, digestAppGrantValue } from './app-grant-service.js';
import { buildAttachmentAppReviewedAuthority, assertAttachmentManifestAdmission, assertAttachmentCompositionActionsEnabled,
  ATTACHMENT_APP_EFFECTIVE_CLASSIFICATION } from './app-attachment-authority.js';
import { assertAttachmentBrokerEnabled, loadReviewedAttachmentApp, attachmentStale, attachmentFinalAuthorityIsCurrent } from './app-attachment-authority.js';
import type { AttachmentManagementOptions } from './app-attachment-authority.js';
import type { AppRunTransaction } from './app-run-repository.js';
import { AppError } from './app-errors.js';

export const AttachmentAppReviewRequestSchema = z.strictObject({
  schema_version: z.literal('deft.app_blob_review_request.v1'), app_version_id: z.uuid(),
  expected_package_digest: AppDigestSchema, expected_requested_snapshot_digest: AppDigestSchema,
  expected_lifecycle_epoch: z.number().int().nonnegative(), expected_grant_epoch: z.number().int().nonnegative(),
});
export const AttachmentAppActivateSchema = AttachmentAppReviewRequestSchema.extend({ expected_review_digest: AppDigestSchema, accept_host_policy: z.literal(true) });
export const AttachmentCompositionReviewRequestSchema = AttachmentAppReviewRequestSchema.extend({
  schema_version: z.literal('deft.app_blob_review_request.v2'),
});
export const AttachmentCompositionActivateSchema = AttachmentCompositionReviewRequestSchema.extend({
  expected_review_digest: AppDigestSchema, accept_host_policy: z.literal(true),
});
async function context(tx: AppRunTransaction, actor: ModuleActor, installationId: string, versionId: string, composition = false) {
  assertAttachmentBrokerEnabled();
  if (actor.kind !== 'human' || !['owner', 'admin'].includes(actor.role) || !['rest', 'ui'].includes(actor.source)) {
    throw new AppError('Attachment App manager required', 'APP_ACCESS_DENIED', 403);
  }
  await assertCurrentModuleManagerWithExecutor(tx, actor);
  const [installation] = await tx.select().from(appInstallations).where(and(eq(appInstallations.org_id, actor.org_id),
    eq(appInstallations.id, installationId))).limit(1).for('update');
  if (!installation || !['staged', 'active', 'disabled'].includes(installation.state)
    || (installation.active_version_id && installation.active_version_id !== versionId)) throw attachmentStale();
  const [version] = await tx.select().from(appVersions).where(and(eq(appVersions.org_id, actor.org_id),
    eq(appVersions.installation_id, installationId), eq(appVersions.id, versionId), eq(appVersions.protocol_version, '7'))).limit(1).for('share');
  if (!version || !['staged', 'active'].includes(version.state)) throw attachmentStale();
  const manifest = parseAttachmentAppManifest(version.manifest);
  const [requested] = await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id, actor.org_id),
    eq(appGrantSnapshots.app_installation_id, installationId), eq(appGrantSnapshots.app_version_id, version.id),
    eq(appGrantSnapshots.id, version.requested_grant_snapshot_id ?? ''), eq(appGrantSnapshots.snapshot_kind, 'requested'))).limit(1);
  const expected = buildRequestedAppGrantProjection({ organization_id: actor.org_id, app_installation_id: installationId,
    app_version_id: version.id, manifest, manifest_digest: version.manifest_digest, package_digest: version.package_digest });
  if (!requested || requested.snapshot_digest !== expected.snapshot_digest || digestAppGrantValue(requested.canonical_snapshot) !== expected.snapshot_digest) throw attachmentStale();
  const authority = buildAttachmentAppReviewedAuthority(manifest, { lineage_key: installation.lineage_key,
    package_digest: version.package_digest, manifest_digest: version.manifest_digest }, composition);
  const request = (composition ? AttachmentCompositionReviewRequestSchema : AttachmentAppReviewRequestSchema).parse({
    schema_version: composition ? 'deft.app_blob_review_request.v2' : 'deft.app_blob_review_request.v1', app_version_id: version.id,
    expected_package_digest: version.package_digest, expected_requested_snapshot_digest: requested.snapshot_digest,
    expected_lifecycle_epoch: installation.lifecycle_epoch, expected_grant_epoch: installation.grant_epoch });
  const review = { schema_version: composition ? 'deft.app_blob_review.v2' : 'deft.app_blob_review.v1', installation_id: installationId, organization_id: actor.org_id,
    request, authority, requested_snapshot_id: requested.id };
  return { installation, version, requested, manifest, authority, request, review: { ...review, review_digest: digestAppGrantValue(review) } };
}
async function final(tx: AppRunTransaction, actor: ModuleActor, options: AttachmentManagementOptions,
  manifest: Parameters<typeof assertAttachmentManifestAdmission>[0]) {
  if (!await attachmentFinalAuthorityIsCurrent(tx, [actor.actor_id], options)) throw attachmentStale();
  assertAttachmentManifestAdmission(manifest, options.composition === true);
  if (options.composition) assertAttachmentCompositionActionsEnabled(manifest);
}
export async function getAttachmentAppReviewContext(actor: ModuleActor, installationId: string, versionId: string,
  options: AttachmentManagementOptions = {}) {
  return db.transaction(async tx => {
    const current = await context(tx, actor, installationId, versionId, options.composition === true);
    let activation: { grant_snapshot_id: string; review_digest: string } | null = null;
    if (current.installation.state === 'active') {
      const live = await loadReviewedAttachmentApp(tx, actor.org_id, installationId);
      if (live.composition !== (options.composition === true)) throw attachmentStale();
      activation = { grant_snapshot_id: live.grant.id, review_digest: AppDigestSchema.parse(live.grant.canonical_snapshot.review_digest) };
    }
    await final(tx, actor, options, current.manifest);
    return { schema_version: options.composition ? 'deft.app_blob_review_context.v2' : 'deft.app_blob_review_context.v1', installation_id: installationId, app_version_id: versionId,
      protocol_version: '7', state: current.installation.state, review_request: activation ? null : current.request, current_activation: activation };
  });
}
export async function prepareAttachmentAppReview(actor: ModuleActor, installationId: string, raw: unknown, options: AttachmentManagementOptions = {}) {
  const input = (options.composition ? AttachmentCompositionReviewRequestSchema : AttachmentAppReviewRequestSchema).parse(raw);
  return db.transaction(async tx => {
    const current = await context(tx, actor, installationId, input.app_version_id, options.composition === true);
    if (current.installation.state === 'active' || digestAppGrantValue(input) !== digestAppGrantValue(current.request)) throw attachmentStale();
    await final(tx, actor, options, current.manifest);
    return current.review;
  });
}
export async function activateAttachmentApp(actor: ModuleActor, installationId: string, raw: unknown, options: AttachmentManagementOptions = {}) {
  const { expected_review_digest, accept_host_policy: _accept, ...input } =
    (options.composition ? AttachmentCompositionActivateSchema : AttachmentAppActivateSchema).parse(raw);
  const postCommit: ModuleLifecyclePostCommit[] = [];
  const result = await db.transaction(async tx => {
    const current = await context(tx, actor, installationId, input.app_version_id, options.composition === true);
    if (current.installation.state === 'active' || digestAppGrantValue(input) !== digestAppGrantValue(current.request)
      || current.review.review_digest !== expected_review_digest) throw attachmentStale();
    if (current.version.state === 'staged') {
      const pkg = current.version.package as unknown as DeftAppPackage;
      for (const reference of [...current.manifest.modules].sort((a, b) => a.module_id.localeCompare(b.module_id))) {
        const artifact = pkg.artifacts.find(item => item.path === reference.manifest_path);
        if (!artifact || artifact.digest !== reference.manifest_digest) throw attachmentStale();
        const installed = await installModuleFromManifestWithExecutor(tx, actor, JSON.parse(artifact.content), { source: 'sideloaded' });
        postCommit.push(installed.postCommit);
        await tx.insert(appModuleBindings).values({ org_id: actor.org_id, app_installation_id: installationId, app_version_id: current.version.id,
          module_installation_id: installed.row.installation.id, module_version_id: installed.row.version.id, module_id: reference.module_id, ownership: 'app' });
      }
    } else {
      const owned = await tx.select().from(appModuleBindings).where(and(eq(appModuleBindings.org_id, actor.org_id),
        eq(appModuleBindings.app_installation_id, installationId), eq(appModuleBindings.app_version_id, current.version.id), eq(appModuleBindings.ownership, 'app')));
      if (owned.length !== current.manifest.modules.length || current.manifest.modules.some(reference => !owned.some(binding => binding.module_id === reference.module_id))) throw attachmentStale();
      for (const binding of owned) await tx.update(moduleInstallations).set({ is_enabled: true, disabled_at: null,
        updated_by_actor_type: actor.kind, updated_by_actor_id: actor.actor_id }).where(and(eq(moduleInstallations.org_id, actor.org_id),
        eq(moduleInstallations.id, binding.module_installation_id), eq(moduleInstallations.is_deleted, false)));
    }
    const [prior] = await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id, actor.org_id),
      eq(appGrantSnapshots.app_installation_id, installationId), eq(appGrantSnapshots.snapshot_kind, 'effective')))
      .orderBy(desc(appGrantSnapshots.created_at), desc(appGrantSnapshots.id)).limit(1);
    const effectiveId = randomUUID(), now = new Date();
    const canonical = { ...current.authority, organization_id: actor.org_id, app_installation_id: installationId,
      app_version_id: current.version.id, requested_snapshot_id: current.requested.id, requested_snapshot_digest: current.requested.snapshot_digest,
      classification: ATTACHMENT_APP_EFFECTIVE_CLASSIFICATION, review_digest: expected_review_digest };
    await tx.insert(appGrantSnapshots).values({ id: effectiveId, org_id: actor.org_id, app_installation_id: installationId,
      app_version_id: current.version.id, app_id: current.installation.app_id, app_version: current.version.version,
      manifest_digest: current.version.manifest_digest, package_digest: current.version.package_digest, snapshot_kind: 'effective',
      snapshot_version: APP_GRANT_SNAPSHOT_VERSION, requested_snapshot_id: current.requested.id, supersedes_snapshot_id: prior?.id ?? null,
      resource_rights: [], classification: ATTACHMENT_APP_EFFECTIVE_CLASSIFICATION, canonical_snapshot: canonical,
      snapshot_digest: digestAppGrantValue(canonical), reviewed_by_actor_type: 'human', reviewed_by_actor_id: actor.actor_id, reviewed_at: now });
    if (current.version.state === 'staged') await tx.update(appVersions).set({ state: 'active', activated_at: now }).where(and(
      eq(appVersions.org_id, actor.org_id), eq(appVersions.id, current.version.id), eq(appVersions.state, 'staged')));
    const [installation] = await tx.update(appInstallations).set({ state: 'active', active_version_id: current.version.id,
      active_grant_snapshot_id: effectiveId, active_grant_snapshot_kind: 'effective', lifecycle_epoch: sql`${appInstallations.lifecycle_epoch} + 1`,
      grant_epoch: sql`${appInstallations.grant_epoch} + 1`, disabled_at: null, updated_by_actor_type: 'human', updated_by_actor_id: actor.actor_id })
      .where(and(eq(appInstallations.org_id, actor.org_id), eq(appInstallations.id, installationId))).returning();
    await tx.insert(auditLog).values({ org_id: actor.org_id, actor_type: 'human', actor_id: actor.actor_id,
      action: 'app.blob.review_activate', entity_type: 'app_installation', entity_id: installationId,
      after_state: { state: 'active', grant_snapshot_id: effectiveId, review_digest: expected_review_digest } });
    await final(tx, actor, options, current.manifest);
    return { installation, grant_snapshot_id: effectiveId };
  });
  for (const effect of postCommit) effect.emit();
  await Promise.all(postCommit.map(effect => effect.invalidate()));
  await invalidateModuleCatalogCaches(actor.org_id);
  return result;
}
