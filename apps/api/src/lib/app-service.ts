import { and, asc, eq, sql } from 'drizzle-orm';
import {
  appInstallations,
  appModuleBindings,
  appVersions,
  auditLog,
  moduleInstallations,
} from '@deft/db/schema';
import {
  verifyDeftAppPackageJson,
  type DeftAppManifestV0,
  type DeftAppPackageV0,
} from '@deft/app-kit';
import {
  digestModuleManifest,
  parseDeftModuleManifest,
  type ModuleActor,
} from '@deft/shared/modules';
import { db } from './db.js';
import { getIO } from '../socket.js';
import {
  assertCurrentModuleManagerWithExecutor,
  installModuleFromManifestWithExecutor,
  invalidateModuleCatalogCaches,
  type ModuleLifecyclePostCommit,
} from './module-service.js';
import { AppError } from './app-errors.js';

type AppExecutor = Pick<typeof db, 'select' | 'insert' | 'update' | 'execute'>;
type Installation = typeof appInstallations.$inferSelect;
type Version = typeof appVersions.$inferSelect;

export type InspectedAppPackage = {
  manifest: DeftAppManifestV0;
  manifest_digest: string;
  package_digest: string;
  canonical_package_json: string;
  package: DeftAppPackageV0;
  permissions: [];
};

export type AppInstallationView = {
  id: string;
  app_id: string;
  name: string;
  version: string;
  state: 'staged' | 'active' | 'disabled' | 'failed';
  lifecycle_epoch: number;
  active_version_id: string | null;
  package_digest: string;
  manifest_digest: string;
  manifest: DeftAppManifestV0;
  created_at: string;
  updated_at: string;
};

function assertHumanManager(actor: ModuleActor): asserts actor is Extract<ModuleActor, { kind: 'human' }> {
  if (actor.kind !== 'human' || (actor.role !== 'owner' && actor.role !== 'admin')) {
    throw new AppError('Only workspace owners and admins can manage Apps', 'APP_ACCESS_DENIED', 403);
  }
}

async function acquireAppLock(executor: AppExecutor, orgId: string, key: string): Promise<void> {
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`app:${orgId}:${key}`}, 0))`);
}

async function insertAppAudit(
  executor: AppExecutor,
  actor: Extract<ModuleActor, { kind: 'human' }>,
  action: string,
  installationId: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Promise<void> {
  await executor.insert(auditLog).values({
    org_id: actor.org_id,
    actor_type: actor.kind,
    actor_id: actor.actor_id,
    action,
    entity_type: 'app_installation',
    entity_id: installationId,
    before_state: before,
    after_state: after,
    metadata: { source: actor.source },
  });
}

function view(installation: Installation, version: Version): AppInstallationView {
  const manifest = version.manifest as DeftAppManifestV0;
  return {
    id: installation.id,
    app_id: installation.app_id,
    name: manifest.name,
    version: version.version,
    state: installation.state,
    lifecycle_epoch: installation.lifecycle_epoch,
    active_version_id: installation.active_version_id,
    package_digest: version.package_digest,
    manifest_digest: version.manifest_digest,
    manifest,
    created_at: installation.created_at.toISOString(),
    updated_at: installation.updated_at.toISOString(),
  };
}

function emitAppChange(orgId: string, payload: Record<string, unknown>): void {
  getIO()?.to(`org-members:${orgId}`).emit('app:changed', payload);
}

export async function inspectAppPackageJson(value: string): Promise<InspectedAppPackage> {
  let verified;
  try {
    verified = await verifyDeftAppPackageJson(value);
    for (const reference of verified.package.manifest.modules) {
      const artifact = verified.package.artifacts.find((item) => item.path === reference.manifest_path);
      if (!artifact) throw new Error(`Missing artifact ${reference.manifest_path}`);
      const moduleManifest = parseDeftModuleManifest(JSON.parse(artifact.content) as unknown);
      if ((await digestModuleManifest(moduleManifest)) !== reference.manifest_digest) {
        throw new Error(`Module digest mismatch for ${reference.module_id}`);
      }
      const collections = new Set(moduleManifest.collections.map((collection) => collection.key));
      for (const item of verified.package.manifest.navigation.filter((nav) => nav.module_id === reference.module_id)) {
        if (!collections.has(item.collection_key)) {
          throw new Error(`Navigation references unknown collection ${item.collection_key}`);
        }
      }
    }
  } catch (error) {
    throw new AppError(
      error instanceof Error ? error.message : 'Invalid App package',
      'APP_INVALID_PACKAGE',
      400,
    );
  }
  return {
    manifest: verified.package.manifest,
    manifest_digest: verified.package.manifest_digest,
    package_digest: verified.digest,
    canonical_package_json: verified.json,
    package: verified.package,
    permissions: [],
  };
}

export async function stageAppPackage(
  actor: ModuleActor,
  packageJson: string,
): Promise<AppInstallationView> {
  assertHumanManager(actor);
  const inspected = await inspectAppPackageJson(packageJson);
  const identity = { type: actor.kind, id: actor.actor_id };
  const storedPackage = JSON.parse(inspected.canonical_package_json) as Record<string, unknown>;
  const created = await db.transaction(async (tx) => {
    await assertCurrentModuleManagerWithExecutor(tx, actor);
    await acquireAppLock(tx, actor.org_id, inspected.manifest.id);
    const [existing] = await tx.select({ id: appInstallations.id }).from(appInstallations).where(and(
      eq(appInstallations.org_id, actor.org_id),
      eq(appInstallations.app_id, inspected.manifest.id),
    )).limit(1);
    if (existing) throw new AppError('App is already installed', 'APP_ALREADY_INSTALLED', 409);

    const [installation] = await tx.insert(appInstallations).values({
      org_id: actor.org_id,
      app_id: inspected.manifest.id,
      lineage_key: `local:${inspected.manifest.id}`,
      lineage_authority_type: 'local_user',
      lineage_authority_id: actor.actor_id,
      state: 'staged',
      active_version_id: null,
      lifecycle_epoch: 0,
      installed_by_user_id: actor.actor_id,
      installed_by_actor_type: identity.type,
      installed_by_actor_id: identity.id,
      updated_by_actor_type: identity.type,
      updated_by_actor_id: identity.id,
    }).returning();
    if (!installation) throw new Error('App installation insert returned no row');
    const [version] = await tx.insert(appVersions).values({
      org_id: actor.org_id,
      installation_id: installation.id,
      version: inspected.manifest.version,
      protocol_version: inspected.manifest.compatibility.app_protocol,
      manifest: inspected.manifest,
      manifest_digest: inspected.manifest_digest,
      package_digest: inspected.package_digest,
      package: storedPackage,
      provenance: inspected.manifest.provenance ?? null,
      state: 'staged',
      created_by_actor_type: identity.type,
      created_by_actor_id: identity.id,
    }).returning();
    if (!version) throw new Error('App version insert returned no row');
    await insertAppAudit(tx, actor, 'app.stage', installation.id, null, {
      app_id: installation.app_id,
      version: version.version,
      package_digest: version.package_digest,
      permissions: [],
    });
    return { installation, version };
  });
  emitAppChange(actor.org_id, { change: 'staged', installation_id: created.installation.id });
  return view(created.installation, created.version);
}

export async function activateAppInstallation(
  actor: ModuleActor,
  installationId: string,
  expectedPackageDigest: string,
  testHooks?: { failAfterModulePreparation?: boolean },
): Promise<AppInstallationView> {
  assertHumanManager(actor);
  const postCommit: ModuleLifecyclePostCommit[] = [];
  const activated = await db.transaction(async (tx) => {
    await assertCurrentModuleManagerWithExecutor(tx, actor);
    await acquireAppLock(tx, actor.org_id, installationId);
    const [installation] = await tx.select().from(appInstallations).where(and(
      eq(appInstallations.org_id, actor.org_id),
      eq(appInstallations.id, installationId),
    )).limit(1).for('update');
    if (!installation) throw new AppError('App installation not found', 'APP_NOT_FOUND', 404);
    if (installation.state !== 'staged' || installation.active_version_id) {
      throw new AppError('Only a staged App can be activated', 'APP_STATE_CONFLICT', 409);
    }
    const [version] = await tx.select().from(appVersions).where(and(
      eq(appVersions.org_id, actor.org_id),
      eq(appVersions.installation_id, installation.id),
      eq(appVersions.package_digest, expectedPackageDigest),
      eq(appVersions.state, 'staged'),
    )).limit(1).for('update');
    if (!version) throw new AppError('The staged App package changed', 'APP_STALE', 409);
    const packageValue = version.package as unknown as DeftAppPackageV0;
    for (const reference of [...packageValue.manifest.modules].sort((a, b) => a.module_id.localeCompare(b.module_id))) {
      const artifact = packageValue.artifacts.find((item) => item.path === reference.manifest_path);
      if (!artifact) throw new AppError('Staged App artifact is missing', 'APP_INVALID_PACKAGE', 409);
      const installed = await installModuleFromManifestWithExecutor(
        tx,
        actor,
        JSON.parse(artifact.content) as unknown,
        { source: 'sideloaded' },
      );
      postCommit.push(installed.postCommit);
      await tx.insert(appModuleBindings).values({
        org_id: actor.org_id,
        app_installation_id: installation.id,
        app_version_id: version.id,
        module_installation_id: installed.row.installation.id,
        module_version_id: installed.row.version.id,
        module_id: reference.module_id,
        ownership: 'app',
      });
    }
    if (testHooks?.failAfterModulePreparation) throw new Error('Injected App activation failure');
    const now = new Date();
    const [activeVersion] = await tx.update(appVersions).set({ state: 'active', activated_at: now }).where(and(
      eq(appVersions.org_id, actor.org_id), eq(appVersions.installation_id, installation.id), eq(appVersions.id, version.id),
    )).returning();
    const [activeInstallation] = await tx.update(appInstallations).set({
      state: 'active',
      active_version_id: version.id,
      lifecycle_epoch: sql`${appInstallations.lifecycle_epoch} + 1`,
      disabled_at: null,
      updated_by_actor_type: actor.kind,
      updated_by_actor_id: actor.actor_id,
    }).where(and(eq(appInstallations.org_id, actor.org_id), eq(appInstallations.id, installation.id))).returning();
    if (!activeVersion || !activeInstallation) throw new Error('App activation update returned no row');
    await insertAppAudit(tx, actor, 'app.activate', installation.id, { state: 'staged' }, {
      state: 'active', package_digest: version.package_digest, lifecycle_epoch: activeInstallation.lifecycle_epoch,
    });
    return { installation: activeInstallation, version: activeVersion };
  });
  for (const effect of postCommit) effect.emit();
  await Promise.all(postCommit.map((effect) => effect.invalidate()));
  emitAppChange(actor.org_id, { change: 'activated', installation_id: activated.installation.id });
  return view(activated.installation, activated.version);
}

export async function disableAppInstallation(
  actor: ModuleActor,
  installationId: string,
  expectedLifecycleEpoch: number,
): Promise<AppInstallationView> {
  assertHumanManager(actor);
  const disabled = await db.transaction(async (tx) => {
    await assertCurrentModuleManagerWithExecutor(tx, actor);
    await acquireAppLock(tx, actor.org_id, installationId);
    const [installation] = await tx.select().from(appInstallations).where(and(
      eq(appInstallations.org_id, actor.org_id), eq(appInstallations.id, installationId),
    )).limit(1).for('update');
    if (!installation || !installation.active_version_id) throw new AppError('App installation not found', 'APP_NOT_FOUND', 404);
    if (installation.state !== 'active') throw new AppError('Only an active App can be disabled', 'APP_STATE_CONFLICT', 409);
    if (installation.lifecycle_epoch !== expectedLifecycleEpoch) throw new AppError('App lifecycle changed', 'APP_STALE', 409);
    const bindings = await tx.select().from(appModuleBindings).where(and(
      eq(appModuleBindings.org_id, actor.org_id),
      eq(appModuleBindings.app_installation_id, installation.id),
      eq(appModuleBindings.app_version_id, installation.active_version_id),
    ));
    const now = new Date();
    for (const binding of bindings) {
      await tx.update(moduleInstallations).set({
        is_enabled: false,
        disabled_at: now,
        updated_by_actor_type: actor.kind,
        updated_by_actor_id: actor.actor_id,
      }).where(and(
        eq(moduleInstallations.org_id, actor.org_id),
        eq(moduleInstallations.id, binding.module_installation_id),
      ));
    }
    const [updated] = await tx.update(appInstallations).set({
      state: 'disabled',
      lifecycle_epoch: sql`${appInstallations.lifecycle_epoch} + 1`,
      disabled_at: now,
      updated_by_actor_type: actor.kind,
      updated_by_actor_id: actor.actor_id,
    }).where(and(eq(appInstallations.org_id, actor.org_id), eq(appInstallations.id, installation.id))).returning();
    const [version] = await tx.select().from(appVersions).where(and(
      eq(appVersions.org_id, actor.org_id), eq(appVersions.id, installation.active_version_id),
    )).limit(1);
    if (!updated || !version) throw new Error('App disable update returned no row');
    await insertAppAudit(tx, actor, 'app.disable', installation.id, { state: 'active' }, {
      state: 'disabled', lifecycle_epoch: updated.lifecycle_epoch, data_preserved: true,
    });
    return { installation: updated, version, bindings };
  });
  for (const binding of disabled.bindings) {
    getIO()?.to(`org-members:${actor.org_id}`).emit('module:changed', {
      change: 'configured',
      installation_id: binding.module_installation_id,
      module_id: binding.module_id,
      enabled: false,
    });
  }
  await invalidateModuleCatalogCaches(actor.org_id);
  emitAppChange(actor.org_id, { change: 'disabled', installation_id: disabled.installation.id });
  return view(disabled.installation, disabled.version);
}

export async function listAppInstallations(actor: ModuleActor): Promise<AppInstallationView[]> {
  if (actor.kind !== 'human' || actor.role === 'guest') throw new AppError('Apps are unavailable', 'APP_ACCESS_DENIED', 403);
  const rows = await db.select({ installation: appInstallations, version: appVersions })
    .from(appInstallations)
    .innerJoin(appVersions, and(
      eq(appVersions.org_id, appInstallations.org_id),
      eq(appVersions.installation_id, appInstallations.id),
    ))
    .where(eq(appInstallations.org_id, actor.org_id))
    .orderBy(asc(appInstallations.app_id));
  return rows.map((row) => view(row.installation, row.version));
}

export async function getAppInstallation(actor: ModuleActor, installationId: string): Promise<AppInstallationView> {
  const rows = await listAppInstallations(actor);
  const found = rows.find((row) => row.id === installationId);
  if (!found) throw new AppError('App installation not found', 'APP_NOT_FOUND', 404);
  return found;
}

export async function listActiveAppNavigation(actor: ModuleActor) {
  if (actor.kind === 'human' && actor.role === 'guest') return [];
  const rows = await db.select({
    installation: appInstallations,
    version: appVersions,
    binding: appModuleBindings,
    moduleInstallation: moduleInstallations,
  })
    .from(appInstallations)
    .innerJoin(appVersions, and(
      eq(appVersions.org_id, appInstallations.org_id),
      eq(appVersions.installation_id, appInstallations.id),
      eq(appVersions.id, appInstallations.active_version_id),
      eq(appVersions.state, 'active'),
    ))
    .innerJoin(appModuleBindings, and(
      eq(appModuleBindings.org_id, appInstallations.org_id),
      eq(appModuleBindings.app_installation_id, appInstallations.id),
      eq(appModuleBindings.app_version_id, appVersions.id),
    ))
    .innerJoin(moduleInstallations, and(
      eq(moduleInstallations.org_id, appModuleBindings.org_id),
      eq(moduleInstallations.id, appModuleBindings.module_installation_id),
      eq(moduleInstallations.is_enabled, true),
    ))
    .where(and(eq(appInstallations.org_id, actor.org_id), eq(appInstallations.state, 'active')))
    .orderBy(asc(appInstallations.app_id));
  return rows.flatMap(({ installation, version, binding, moduleInstallation }) => {
    const manifest = version.manifest as DeftAppManifestV0;
    return manifest.navigation.filter((item) => item.module_id === binding.module_id).map((item) => ({
      app_installation_id: installation.id,
      app_id: installation.app_id,
      app_name: manifest.name,
      module_slug: moduleInstallation.slug,
      ...item,
    }));
  });
}
