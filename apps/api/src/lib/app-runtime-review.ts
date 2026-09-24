import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appInstallations, appVersions, appGrantSnapshots, auditLog } from '@deft/db/schema';
import { DeftAppManifestV3Schema, RUNTIME_ACTION_HOST_POLICY, AppDigestSchema, type DeftAppManifestV3 } from '@deft/app-kit';
import type { ModuleActor } from '@deft/shared/modules';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { assertCurrentModuleManagerWithExecutor } from './module-service.js';
import { APP_GRANT_SNAPSHOT_VERSION, buildRequestedAppGrantProjection, digestAppGrantValue } from './app-grant-service.js';

type Executor = Pick<typeof db, 'select' | 'insert' | 'update' | 'execute'>;
const stale = () => new AppError('Runtime App authority changed or is unavailable', 'APP_STALE', 409);
export const RuntimeAppReviewRequestSchema = z.strictObject({
  app_version_id: z.string().min(1).max(128),
  expected_package_digest: AppDigestSchema,
  expected_requested_snapshot_digest: AppDigestSchema,
  expected_lifecycle_epoch: z.number().int().nonnegative(),
  expected_grant_epoch: z.number().int().nonnegative(),
});
export const RuntimeAppActivateRequestSchema = RuntimeAppReviewRequestSchema.extend({
  expected_review_digest: AppDigestSchema, accept_host_policy: z.literal(true),
});

export function runtimeActionDescriptors(manifest: DeftAppManifestV3) {
  return manifest.runtime_actions.map((action) => {
    const capability = manifest.private_capabilities.find((item) => item.key === action.capability_key)!;
    const identity = { namespace: 'app_lineage' as const, key: capability.key, version: capability.version };
    return { action_key: action.key, runtime_requirement_key: action.runtime_requirement_key,
      interface: identity, operation_name: action.key,
      input_schema: capability.input_schema, output_schema: capability.output_schema,
      contract_digest: digestAppGrantValue({ interface: identity, input_schema: capability.input_schema, output_schema: capability.output_schema }),
      host_policy: RUNTIME_ACTION_HOST_POLICY };
  });
}
export type ReviewedRuntimeAction = ReturnType<typeof runtimeActionDescriptors>[number];

async function reviewContext(tx: Executor, actor: ModuleActor, installationId: string,
  request: z.infer<typeof RuntimeAppReviewRequestSchema>) {
  await assertCurrentModuleManagerWithExecutor(tx, actor);
  const [installation] = await tx.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, actor.org_id), eq(appInstallations.id, installationId),
  )).limit(1).for('update');
  if (!installation || !['staged', 'disabled'].includes(installation.state)
    || installation.lifecycle_epoch !== request.expected_lifecycle_epoch
    || installation.grant_epoch !== request.expected_grant_epoch) throw stale();
  const [version] = await tx.select().from(appVersions).where(and(
    eq(appVersions.org_id, actor.org_id), eq(appVersions.installation_id, installationId),
    eq(appVersions.id, request.app_version_id),
  )).limit(1).for('share');
  if (!version || version.protocol_version !== '3' || !['staged', 'active'].includes(version.state)
    || version.package_digest !== request.expected_package_digest
    || (installation.active_version_id && installation.active_version_id !== version.id)) throw stale();
  const manifest = DeftAppManifestV3Schema.parse(version.manifest);
  const [requested] = await tx.select().from(appGrantSnapshots).where(and(
    eq(appGrantSnapshots.org_id, actor.org_id), eq(appGrantSnapshots.app_installation_id, installationId),
    eq(appGrantSnapshots.app_version_id, version.id), eq(appGrantSnapshots.id, version.requested_grant_snapshot_id ?? ''),
    eq(appGrantSnapshots.snapshot_kind, 'requested'),
  )).limit(1);
  const expected = buildRequestedAppGrantProjection({ organization_id: actor.org_id,
    app_installation_id: installationId, app_version_id: version.id, manifest,
    manifest_digest: version.manifest_digest, package_digest: version.package_digest });
  if (!requested || requested.snapshot_digest !== request.expected_requested_snapshot_digest
    || requested.snapshot_digest !== expected.snapshot_digest
    || digestAppGrantValue(requested.canonical_snapshot) !== expected.snapshot_digest) throw stale();
  const authority = { schema: 'deft.app_runtime_grant.v1' as const, lineage_key: installation.lineage_key,
    package_digest: version.package_digest, manifest_digest: version.manifest_digest,
    runtime_actions: runtimeActionDescriptors(manifest) };
  const review = { ...request, installation_id: installationId, organization_id: actor.org_id,
    authority, requested_snapshot_id: requested.id };
  return { installation, version, requested, authority, review: { ...review, review_digest: digestAppGrantValue(review) } };
}

export async function prepareRuntimeAppReview(actor: ModuleActor, installationId: string, raw: unknown) {
  const request = RuntimeAppReviewRequestSchema.parse(raw);
  return db.transaction(async (tx) => (await reviewContext(tx, actor, installationId, request)).review);
}

export async function activateRuntimeApp(actor: ModuleActor, installationId: string, raw: unknown) {
  const { expected_review_digest, accept_host_policy: _accept, ...request } = RuntimeAppActivateRequestSchema.parse(raw);
  return db.transaction(async (tx) => {
    const context = await reviewContext(tx, actor, installationId, request);
    if (context.review.review_digest !== expected_review_digest) throw stale();
    const [prior] = await tx.select().from(appGrantSnapshots).where(and(
      eq(appGrantSnapshots.org_id, actor.org_id), eq(appGrantSnapshots.app_installation_id, installationId),
      eq(appGrantSnapshots.snapshot_kind, 'effective'),
    )).orderBy(desc(appGrantSnapshots.created_at), desc(appGrantSnapshots.id)).limit(1);
    const effectiveId = randomUUID();
    const now = new Date();
    const classification = { authority_state: 'effective', executable: false, provider_access: false,
      runtime_binding_review_required: true };
    const canonical = { ...context.authority, organization_id: actor.org_id,
      app_installation_id: installationId, app_version_id: context.version.id,
      requested_snapshot_id: context.requested.id, requested_snapshot_digest: context.requested.snapshot_digest,
      classification, review_digest: expected_review_digest };
    await tx.insert(appGrantSnapshots).values({ id: effectiveId, org_id: actor.org_id,
      app_installation_id: installationId, app_version_id: context.version.id,
      app_id: context.installation.app_id, app_version: context.version.version,
      manifest_digest: context.version.manifest_digest, package_digest: context.version.package_digest,
      snapshot_kind: 'effective', snapshot_version: APP_GRANT_SNAPSHOT_VERSION,
      requested_snapshot_id: context.requested.id, supersedes_snapshot_id: prior?.id ?? null,
      resource_rights: [], classification, canonical_snapshot: canonical,
      snapshot_digest: digestAppGrantValue(canonical), reviewed_by_actor_type: 'human',
      reviewed_by_actor_id: actor.actor_id, reviewed_at: now });
    if (context.version.state === 'staged') {
      await tx.update(appVersions).set({ state: 'active', activated_at: now }).where(and(
        eq(appVersions.org_id, actor.org_id), eq(appVersions.id, context.version.id),
        eq(appVersions.state, 'staged')));
    }
    const [installation] = await tx.update(appInstallations).set({ state: 'active',
      active_version_id: context.version.id, active_grant_snapshot_id: effectiveId, active_grant_snapshot_kind: 'effective',
      lifecycle_epoch: sql`${appInstallations.lifecycle_epoch} + 1`, grant_epoch: sql`${appInstallations.grant_epoch} + 1`,
      disabled_at: null, updated_by_actor_type: 'human', updated_by_actor_id: actor.actor_id,
    }).where(and(eq(appInstallations.org_id, actor.org_id), eq(appInstallations.id, installationId))).returning();
    await tx.insert(auditLog).values({ org_id: actor.org_id, actor_type: 'human', actor_id: actor.actor_id,
      action: 'app.runtime.review_activate', entity_type: 'app_installation', entity_id: installationId,
      before_state: { state: context.installation.state },
      after_state: { state: 'active', grant_snapshot_id: effectiveId, review_digest: expected_review_digest },
      metadata: { source: actor.source } });
    return { installation, grant_snapshot_id: effectiveId };
  });
}

/** Callers lock membership first. This reader locks the installation/version and
 * reconstructs the reviewed descriptor rather than trusting a JSON grant alone. */
export async function loadReviewedRuntimeAction(tx: Executor, orgId: string, installationId: string, actionKey: string) {
  const [installation] = await tx.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, orgId), eq(appInstallations.id, installationId),
  )).limit(1).for('share');
  if (!installation || installation.state !== 'active' || !installation.active_version_id
    || !installation.active_grant_snapshot_id || installation.active_grant_snapshot_kind !== 'effective') throw stale();
  const [version] = await tx.select().from(appVersions).where(and(eq(appVersions.org_id, orgId),
    eq(appVersions.installation_id, installationId), eq(appVersions.id, installation.active_version_id),
    eq(appVersions.state, 'active'), eq(appVersions.protocol_version, '3'))).limit(1).for('share');
  const [grant] = await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id, orgId),
    eq(appGrantSnapshots.app_installation_id, installationId), eq(appGrantSnapshots.id, installation.active_grant_snapshot_id),
    eq(appGrantSnapshots.snapshot_kind, 'effective'))).limit(1);
  if (!version || !grant || grant.app_version_id !== version.id
    || digestAppGrantValue(grant.canonical_snapshot) !== grant.snapshot_digest) throw stale();
  const manifest = DeftAppManifestV3Schema.parse(version.manifest);
  const expected = runtimeActionDescriptors(manifest);
  const stored = grant.canonical_snapshot;
  if (stored.schema !== 'deft.app_runtime_grant.v1' || stored.lineage_key !== installation.lineage_key
    || stored.package_digest !== version.package_digest || stored.manifest_digest !== version.manifest_digest
    || digestAppGrantValue(stored.runtime_actions) !== digestAppGrantValue(expected)) throw stale();
  const action = expected.find((item) => item.action_key === actionKey);
  if (!action) throw stale();
  return { installation, version, grant, action };
}
