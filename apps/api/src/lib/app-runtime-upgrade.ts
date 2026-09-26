import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appInstallations, appVersions, appGrantSnapshots, appModuleBindings, appDependencyLocks,
  appRuns, appPublicIngress, appPublicEndpoints, moduleInstallations, moduleVersions, users, auditLog } from '@deft/db/schema';
import { AppDigestSchema, parseRuntimeAppManifest, parseResourceAppManifest } from '@deft/app-kit';
import { parseSupportedDeftModuleManifest, type ModuleActor } from '@deft/shared/modules';
import { db } from './db.js';
import { AppError } from './app-errors.js';
import { inspectAppPackageJson, stageAppUpgrade } from './app-service.js';
import { buildResourceAppReviewedAuthority, runtimeActionDescriptors, type RuntimeAppReviewOptions } from './app-runtime-review.js';
import { APP_GRANT_SNAPSHOT_VERSION, buildRequestedAppGrantProjection, digestAppGrantValue } from './app-grant-service.js';
import { acquireModuleInstallLocks, assertCurrentModuleManagerWithExecutor, installModuleFromManifestWithExecutor,
  upgradeAppOwnedModuleAdditivelyWithExecutor, invalidateModuleCatalogCaches, type ModuleLifecyclePostCommit } from './module-service.js';

const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const stale = () => new AppError('Runtime upgrade authority changed', 'APP_STALE', 409);
export const RuntimeUpgradeStageSchema = z.strictObject({ schema_version: z.literal('deft.app_runtime_upgrade_stage.v1'),
  package_json: z.string().min(1).max(1_048_576), expected_lifecycle_epoch: z.number().int().nonnegative() });
export const RuntimeUpgradeRequestSchema = z.strictObject({ schema_version: z.literal('deft.app_runtime_upgrade_review_request.v1'),
  pending_work_policy: z.literal('drain_before_activation'),
  prior_app_version_id: Id, expected_prior_package_digest: AppDigestSchema,
  expected_prior_grant_snapshot_digest: AppDigestSchema, app_version_id: Id,
  expected_package_digest: AppDigestSchema, expected_requested_snapshot_digest: AppDigestSchema,
  expected_lifecycle_epoch: z.number().int().nonnegative(), expected_grant_epoch: z.number().int().nonnegative() });
export const RuntimeUpgradeActivateSchema = RuntimeUpgradeRequestSchema.extend({ expected_review_digest: AppDigestSchema,
  accept_host_policy: z.literal(true) });
export const RuntimeUpgradeContextSchema = z.strictObject({ schema_version: z.literal('deft.app_runtime_upgrade_context.v1'),
  installation_id: Id, app_version_id: Id, protocol_version: z.enum(['3', '4', '5']),
  review_request: RuntimeUpgradeRequestSchema.nullable(), current_activation: z.strictObject({
    grant_snapshot_id: Id, review_digest: AppDigestSchema }).nullable() });
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Actor = Extract<ModuleActor, { kind: 'human' }>;
const nonterminal = ['pending', 'pending_approval', 'running', 'waiting_external', 'unknown_outcome'] as const;

function manager(actor: ModuleActor): asserts actor is Actor {
  if (actor.kind !== 'human' || !['owner', 'admin'].includes(actor.role)) throw new AppError('Human manager required', 'APP_ACCESS_DENIED', 403);
}
async function final(tx: Tx, actor: Actor, manifest: Parameters<NonNullable<RuntimeAppReviewOptions['assertAdmission']>>[0], options: RuntimeAppReviewOptions) {
  await options.guard?.(tx);
  const [human] = await tx.select({ kind: users.kind }).from(users).where(eq(users.id, actor.actor_id)).limit(1);
  if (human?.kind !== 'human') throw new AppError('Current human manager required', 'APP_ACCESS_DENIED', 403);
  options.assertAdmission?.(manifest);
}
export async function stageRuntimeAppUpgrade(actor: ModuleActor, installationId: string, raw: unknown, options: RuntimeAppReviewOptions = {}) {
  manager(actor); const request = RuntimeUpgradeStageSchema.parse(raw);
  const app = await stageAppUpgrade(actor, Id.parse(installationId), request.package_json, request.expected_lifecycle_epoch,
    { ...options, runtimeUpgrade: true });
  return { schema_version: 'deft.app_runtime_upgrade_staged.v1' as const, installation_id: app.id, app_version_id: app.version_id };
}
function authority(manifest: ReturnType<typeof parseRuntimeAppManifest> | ReturnType<typeof parseResourceAppManifest>, installation: typeof appInstallations.$inferSelect,
  version: typeof appVersions.$inferSelect) {
  const pins = { lineage_key: installation.lineage_key, package_digest: version.package_digest, manifest_digest: version.manifest_digest };
  return manifest.schema_version === '5' ? buildResourceAppReviewedAuthority(manifest, pins)
    : { schema: 'deft.app_runtime_grant.v1' as const, ...pins, runtime_actions: runtimeActionDescriptors(manifest),
      ...(manifest.schema_version === '4' ? { modules: manifest.modules, experiences: manifest.experiences, public_actions: manifest.public_actions } : {}) };
}
async function context(tx: Tx, actor: Actor, installationId: string, targetId: string, options: RuntimeAppReviewOptions) {
  await assertCurrentModuleManagerWithExecutor(tx, actor);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`app:${actor.org_id}:${installationId}`}, 0))`);
  const [installation] = await tx.select().from(appInstallations).where(and(eq(appInstallations.org_id, actor.org_id),
    eq(appInstallations.id, installationId))).limit(1).for('update');
  if (!installation || installation.state !== 'active' || !installation.active_version_id
    || installation.active_grant_snapshot_kind !== 'effective' || !installation.active_grant_snapshot_id) throw stale();
  const versions = await tx.select().from(appVersions).where(and(eq(appVersions.org_id, actor.org_id),
    eq(appVersions.installation_id, installationId), inArray(appVersions.id, [installation.active_version_id, targetId])))
    .orderBy(asc(appVersions.id)).for('update');
  const prior = versions.find(version => version.id === installation.active_version_id);
  const target = versions.find(version => version.id === targetId);
  if (!prior || !target || prior.state !== 'active' || !['3', '4', '5'].includes(prior.protocol_version)
    || target.protocol_version !== prior.protocol_version || !['staged', 'active'].includes(target.state)) throw stale();
  const inspected = await inspectAppPackageJson(JSON.stringify(target.package));
  if (inspected.package_digest !== target.package_digest || inspected.manifest_digest !== target.manifest_digest
    || digestAppGrantValue(inspected.manifest) !== digestAppGrantValue(target.manifest)) throw stale();
  const manifest = target.protocol_version === '5' ? parseResourceAppManifest(target.manifest) : parseRuntimeAppManifest(target.manifest);
  options.assertAdmission?.(manifest);
  const grants = await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id, actor.org_id),
    eq(appGrantSnapshots.app_installation_id, installationId), inArray(appGrantSnapshots.id,
      [installation.active_grant_snapshot_id, target.requested_grant_snapshot_id ?? ''])))
    .orderBy(asc(appGrantSnapshots.id)).for('share');
  const effective = grants.find(grant => grant.id === installation.active_grant_snapshot_id);
  const requested = grants.find(grant => grant.id === target.requested_grant_snapshot_id);
  if (!effective || effective.app_version_id !== prior.id || effective.snapshot_kind !== 'effective'
    || effective.package_digest !== prior.package_digest || effective.manifest_digest !== prior.manifest_digest
    || digestAppGrantValue(effective.canonical_snapshot) !== effective.snapshot_digest || !requested
    || requested.snapshot_kind !== 'requested' || requested.app_version_id !== target.id
    || effective.canonical_snapshot.organization_id !== actor.org_id
    || effective.canonical_snapshot.app_installation_id !== installationId
    || effective.canonical_snapshot.app_version_id !== prior.id
    || effective.canonical_snapshot.requested_snapshot_id !== prior.requested_grant_snapshot_id) throw stale();
  const priorManifest = prior.protocol_version === '5' ? parseResourceAppManifest(prior.manifest) : parseRuntimeAppManifest(prior.manifest);
  const priorAuthority = authority(priorManifest, installation, prior);
  for (const [key, value] of Object.entries(priorAuthority)) {
    if (!Object.hasOwn(effective.canonical_snapshot, key)
      || digestAppGrantValue(effective.canonical_snapshot[key]) !== digestAppGrantValue(value)) throw stale();
  }
  const expected = buildRequestedAppGrantProjection({ organization_id: actor.org_id, app_installation_id: installationId,
    app_version_id: target.id, manifest, package_digest: target.package_digest, manifest_digest: target.manifest_digest });
  if (requested.snapshot_digest !== expected.snapshot_digest || digestAppGrantValue(requested.canonical_snapshot) !== expected.snapshot_digest) throw stale();
  const targetAuthority = authority(manifest, installation, target);
  if (prior.id === target.id) {
    const digest = AppDigestSchema.safeParse(effective.canonical_snapshot.review_digest);
    const [audit] = await tx.select().from(auditLog).where(and(eq(auditLog.org_id, actor.org_id),
      eq(auditLog.entity_id, installationId), eq(auditLog.entity_type, 'app_installation'), eq(auditLog.action, 'app.runtime.upgrade_activate'),
      sql`${auditLog.after_state}->>'app_version_id'=${target.id}`,
      sql`${auditLog.after_state}->>'grant_snapshot_id'=${effective.id}`)).limit(1);
    const before = z.strictObject({ app_version_id: Id, grant_snapshot_id: Id }).safeParse(audit?.before_state);
    const after = z.strictObject({ app_version_id: Id, grant_snapshot_id: Id, review_digest: AppDigestSchema }).safeParse(audit?.after_state);
    const metadata = z.object({ schema_version: z.literal('deft.app_runtime_upgrade_activation.v1'),
      prior_grant_snapshot_digest: AppDigestSchema,
      pending_work_policy: z.literal('drain_before_activation').optional() }).safeParse(audit?.metadata);
    if (!digest.success || !audit || !before.success || !after.success || !metadata.success
      || after.data.review_digest !== digest.data || before.data.grant_snapshot_id !== effective.supersedes_snapshot_id
      || before.data.app_version_id === target.id) throw stale();
    const [superseded] = await tx.select().from(appVersions).where(and(eq(appVersions.org_id, actor.org_id),
      eq(appVersions.installation_id, installationId), eq(appVersions.id, before.data.app_version_id))).limit(1);
    const [supersededGrant] = await tx.select().from(appGrantSnapshots).where(and(eq(appGrantSnapshots.org_id, actor.org_id),
      eq(appGrantSnapshots.app_installation_id, installationId), eq(appGrantSnapshots.id, before.data.grant_snapshot_id))).limit(1);
    if (superseded?.state !== 'superseded' || superseded.protocol_version !== target.protocol_version
      || !supersededGrant || supersededGrant.app_version_id !== superseded.id || supersededGrant.snapshot_kind !== 'effective'
      || metadata.data.prior_grant_snapshot_digest !== supersededGrant.snapshot_digest
      || digestAppGrantValue(supersededGrant.canonical_snapshot) !== supersededGrant.snapshot_digest) throw stale();
    return { mode: 'recovered', installation, target, manifest, effective, requested, targetAuthority, recovered: digest.data } as const;
  }
  if (target.state !== 'staged') throw stale();
  const oldBindings = await tx.select({ binding: appModuleBindings, version: moduleVersions }).from(appModuleBindings)
    .innerJoin(moduleVersions, and(eq(moduleVersions.org_id, appModuleBindings.org_id),
      eq(moduleVersions.id, appModuleBindings.module_version_id), eq(moduleVersions.installation_id, appModuleBindings.module_installation_id)))
    .where(and(eq(appModuleBindings.org_id, actor.org_id), eq(appModuleBindings.app_installation_id, installationId),
      eq(appModuleBindings.app_version_id, prior.id), eq(appModuleBindings.ownership, 'app')));
  if (oldBindings.length !== priorManifest.modules.length || priorManifest.modules.some(reference => {
    const rows = oldBindings.filter(row => row.binding.module_id === reference.module_id);
    return rows.length !== 1 || rows[0]!.version.version !== reference.version
      || rows[0]!.version.manifest_digest !== reference.manifest_digest;
  })) throw stale();
  if (oldBindings.some(row => !manifest.modules.some(reference => reference.module_id === row.binding.module_id))) {
    throw new AppError('Runtime upgrade cannot remove App-owned Modules', 'APP_INVALID_PACKAGE', 409);
  }
  const modules = [];
  for (const reference of [...manifest.modules].sort((a, b) => a.module_id.localeCompare(b.module_id))) {
    const artifact = inspected.package.artifacts.find(item => item.path === reference.manifest_path);
    if (!artifact || artifact.digest !== reference.manifest_digest) throw stale();
    const parsed = parseSupportedDeftModuleManifest(JSON.parse(artifact.content) as unknown);
    await acquireModuleInstallLocks(tx, actor.org_id, reference.module_id, parsed.slug);
    const [current] = await tx.select({ installation: moduleInstallations, version: moduleVersions }).from(moduleInstallations)
      .innerJoin(moduleVersions, and(eq(moduleVersions.org_id, moduleInstallations.org_id),
        eq(moduleVersions.installation_id, moduleInstallations.id), eq(moduleVersions.is_active, true)))
      .where(and(eq(moduleInstallations.org_id, actor.org_id), eq(moduleInstallations.module_id, reference.module_id),
        eq(moduleInstallations.is_deleted, false))).limit(1).for('update');
    const old = oldBindings.find(row => row.binding.module_id === reference.module_id);
    if (old && (!current || current.installation.id !== old.binding.module_installation_id
      || current.version.id !== old.binding.module_version_id || current.version.manifest_digest !== old.version.manifest_digest)) throw stale();
    if (!old && current) throw new AppError('New included Module already exists', 'APP_STATE_CONFLICT', 409);
    modules.push({ reference, manifest: parsed, old, effect: { module_id: reference.module_id,
      previous_module_installation_id: old?.binding.module_installation_id ?? null,
      previous_manifest_digest: old?.version.manifest_digest ?? null, target_manifest_digest: reference.manifest_digest,
      mode: !old ? 'install' : old.version.manifest_digest === reference.manifest_digest ? 'carry' : 'additive_upgrade' } });
  }
  // App UPDATE excludes every supported insertion while this plain count runs.
  // Never lock Runs here: settlement takes Run before App SHARE.
  const counts = await tx.select({ state: appRuns.state, count: sql<number>`count(*)::int` }).from(appRuns).where(and(
    eq(appRuns.org_id, actor.org_id), eq(appRuns.origin_app_installation_id, installationId),
    eq(appRuns.origin_app_version_id, prior.id), inArray(appRuns.state, nonterminal))).groupBy(appRuns.state);
  const [dependencies] = await tx.select({ count: sql<number>`count(*)::int` }).from(appDependencyLocks)
    .innerJoin(appInstallations, and(eq(appInstallations.org_id, appDependencyLocks.org_id),
      eq(appInstallations.id, appDependencyLocks.app_installation_id), eq(appInstallations.active_version_id, appDependencyLocks.app_version_id)))
    .where(and(eq(appDependencyLocks.org_id, actor.org_id), eq(appDependencyLocks.dependency_installation_id, installationId),
      eq(appInstallations.state, 'active')));
  const [followups] = await tx.select({ count: sql<number>`count(*)::int` }).from(appPublicIngress)
    .innerJoin(appPublicEndpoints, and(eq(appPublicEndpoints.org_id, appPublicIngress.org_id),
      eq(appPublicEndpoints.id, appPublicIngress.endpoint_id)))
    .where(and(eq(appPublicIngress.org_id, actor.org_id), eq(appPublicEndpoints.app_installation_id, installationId),
      eq(appPublicEndpoints.app_version_id, prior.id), eq(appPublicIngress.state, 'confirmed'),
      eq(appPublicIngress.follow_up_state, 'pending')));
  const request = RuntimeUpgradeRequestSchema.parse({ schema_version: 'deft.app_runtime_upgrade_review_request.v1',
    pending_work_policy: 'drain_before_activation',
    prior_app_version_id: prior.id, expected_prior_package_digest: prior.package_digest,
    expected_prior_grant_snapshot_digest: effective.snapshot_digest, app_version_id: target.id,
    expected_package_digest: target.package_digest, expected_requested_snapshot_digest: requested.snapshot_digest,
    expected_lifecycle_epoch: installation.lifecycle_epoch, expected_grant_epoch: installation.grant_epoch });
  const review = { schema_version: 'deft.app_runtime_upgrade_review.v1' as const, organization_id: actor.org_id,
    pending_work_policy: request.pending_work_policy,
    installation_id: installationId, request, prior_authority: priorAuthority, target_authority: targetAuthority,
    modules: modules.map(item => item.effect), blockers: { old_work: Object.fromEntries(counts.map(row => [row.state, row.count])),
      active_dependents: dependencies?.count ?? 0, pending_public_followups: followups?.count ?? 0 }, fresh_runtime_binding_review_required: true,
    fresh_resource_binding_consent_required: manifest.schema_version === '5', authority_carry_forward: false };
  return { mode: 'review', installation, prior, target, manifest, effective, requested, targetAuthority, modules, request,
    review: { ...review, review_digest: digestAppGrantValue(review) }, recovered: null } as const;
}
export async function getRuntimeUpgradeContext(actor: ModuleActor, installationId: string, targetId: string, options: RuntimeAppReviewOptions = {}) {
  manager(actor); installationId = Id.parse(installationId); targetId = Id.parse(targetId);
  return db.transaction(async tx => {
    const current = await context(tx, actor, installationId, targetId, options);
    const result = RuntimeUpgradeContextSchema.parse({ schema_version: 'deft.app_runtime_upgrade_context.v1', installation_id: installationId,
      app_version_id: targetId, protocol_version: current.target.protocol_version, review_request: current.mode === 'recovered' ? null : current.request,
      current_activation: current.mode === 'recovered' ? { grant_snapshot_id: current.effective.id, review_digest: current.recovered } : null });
    await final(tx, actor, current.manifest, options); return result;
  });
}
export async function prepareRuntimeUpgrade(actor: ModuleActor, installationId: string, raw: unknown, options: RuntimeAppReviewOptions = {}) {
  manager(actor); installationId = Id.parse(installationId); const request = RuntimeUpgradeRequestSchema.parse(raw);
  return db.transaction(async tx => {
    const current = await context(tx, actor, installationId, request.app_version_id, options);
    if (current.mode === 'recovered' || digestAppGrantValue(request) !== digestAppGrantValue(current.request)) throw stale();
    await final(tx, actor, current.manifest, options); return current.review;
  });
}
export async function activateRuntimeUpgrade(actor: ModuleActor, installationId: string, raw: unknown,
  options: RuntimeAppReviewOptions & { testHooks?: { failAfterModulePreparation?: boolean; failBeforePointerSwap?: boolean } } = {}) {
  manager(actor); installationId = Id.parse(installationId);
  const { expected_review_digest, accept_host_policy: _accept, ...request } = RuntimeUpgradeActivateSchema.parse(raw);
  const effects: ModuleLifecyclePostCommit[] = [];
  const result = await db.transaction(async tx => {
    const current = await context(tx, actor, installationId, request.app_version_id, options);
    if (current.mode === 'recovered' || digestAppGrantValue(request) !== digestAppGrantValue(current.request)
      || current.review.review_digest !== expected_review_digest) throw stale();
    if (current.review.blockers.active_dependents || current.review.blockers.pending_public_followups
      || Object.values(current.review.blockers.old_work).some(count => count > 0)) {
      throw new AppError('Old App work or active dependents block upgrade', 'APP_UPGRADE_BLOCKED', 409);
    }
    for (const item of current.modules) {
      let installationIdForModule: string; let versionIdForModule: string;
      if (!item.old) {
        const installed = await installModuleFromManifestWithExecutor(tx, actor, item.manifest, { source: 'sideloaded' });
        effects.push(installed.postCommit); installationIdForModule = installed.row.installation.id; versionIdForModule = installed.row.version.id;
      } else if (item.effect.mode === 'carry') {
        installationIdForModule = item.old.binding.module_installation_id; versionIdForModule = item.old.binding.module_version_id;
      } else {
        const upgraded = await upgradeAppOwnedModuleAdditivelyWithExecutor(tx, actor, { app_installation_id: installationId,
          module_installation_id: item.old.binding.module_installation_id, expected_active_manifest_digest: item.old.version.manifest_digest,
          manifest: item.manifest });
        effects.push(upgraded.postCommit); installationIdForModule = upgraded.row.installation.id; versionIdForModule = upgraded.row.version.id;
      }
      await tx.insert(appModuleBindings).values({ org_id: actor.org_id, app_installation_id: installationId,
        app_version_id: current.target.id, module_installation_id: installationIdForModule,
        module_version_id: versionIdForModule, module_id: item.reference.module_id, ownership: 'app' });
    }
    if (options.testHooks?.failAfterModulePreparation) throw new Error('Injected runtime upgrade rollback');
    const grantId = randomUUID(); const now = new Date();
    const classification = { authority_state: 'effective', executable: false, provider_access: false,
      runtime_binding_review_required: true, ...(current.manifest.schema_version === '5' ? { resource_binding_consent_required: true } : {}) };
    const canonical = { ...current.targetAuthority, organization_id: actor.org_id, app_installation_id: installationId,
      app_version_id: current.target.id, requested_snapshot_id: current.requested.id, requested_snapshot_digest: current.requested.snapshot_digest,
      classification, review_digest: expected_review_digest };
    await tx.insert(appGrantSnapshots).values({ id: grantId, org_id: actor.org_id, app_installation_id: installationId,
      app_version_id: current.target.id, app_id: current.installation.app_id, app_version: current.target.version,
      manifest_digest: current.target.manifest_digest, package_digest: current.target.package_digest, snapshot_kind: 'effective',
      snapshot_version: APP_GRANT_SNAPSHOT_VERSION, requested_snapshot_id: current.requested.id, supersedes_snapshot_id: current.effective.id,
      resource_rights: [], classification, canonical_snapshot: canonical, snapshot_digest: digestAppGrantValue(canonical),
      reviewed_by_actor_type: 'human', reviewed_by_actor_id: actor.actor_id, reviewed_at: now });
    if (options.testHooks?.failBeforePointerSwap) throw new Error('Injected runtime upgrade pointer rollback');
    await tx.update(appVersions).set({ state: 'superseded', superseded_at: now }).where(and(eq(appVersions.org_id, actor.org_id), eq(appVersions.id, current.prior.id)));
    await tx.update(appVersions).set({ state: 'active', activated_at: now }).where(and(eq(appVersions.org_id, actor.org_id), eq(appVersions.id, current.target.id)));
    const [installation] = await tx.update(appInstallations).set({ active_version_id: current.target.id,
      active_grant_snapshot_id: grantId, active_grant_snapshot_kind: 'effective', lifecycle_epoch: sql`${appInstallations.lifecycle_epoch}+1`,
      grant_epoch: sql`${appInstallations.grant_epoch}+1`, updated_by_actor_type: 'human', updated_by_actor_id: actor.actor_id })
      .where(and(eq(appInstallations.org_id, actor.org_id), eq(appInstallations.id, installationId))).returning();
    await tx.insert(auditLog).values({ org_id: actor.org_id, actor_type: 'human', actor_id: actor.actor_id,
      action: 'app.runtime.upgrade_activate', entity_type: 'app_installation', entity_id: installationId,
      before_state: { app_version_id: current.prior.id, grant_snapshot_id: current.effective.id },
      after_state: { app_version_id: current.target.id, grant_snapshot_id: grantId, review_digest: expected_review_digest },
      metadata: { source: actor.source, schema_version: 'deft.app_runtime_upgrade_activation.v1',
        pending_work_policy: request.pending_work_policy,
        prior_grant_snapshot_digest: current.effective.snapshot_digest, review_schema_version: current.review.schema_version, authority_carry_forward: false } });
    await final(tx, actor, current.manifest, options);
    return { schema_version: 'deft.app_runtime_upgrade_activation.v1' as const, installation: installation!, grant_snapshot_id: grantId,
      review_digest: expected_review_digest };
  });
  for (const effect of effects) effect.emit();
  await Promise.all(effects.map(effect => effect.invalidate())); await invalidateModuleCatalogCaches(actor.org_id);
  return result;
}
