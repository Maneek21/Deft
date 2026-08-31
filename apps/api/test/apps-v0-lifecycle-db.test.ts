import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { buildDeftAppPackage, prepareModuleArtifact } from '@deft/app-kit';
import {
  appGrantSnapshots,
  appInstallations,
  appModuleBindings,
  appVersions,
  moduleInstallations,
  moduleRecords,
  orgMembers,
  orgs,
  users,
} from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import {
  activateAppInstallation,
  disableAppInstallation,
  enableAppInstallation,
  listActiveAppNavigation,
  stageAppPackage,
} from '../src/lib/app-service.js';
import { humanModuleActor, updateModuleInstallation } from '../src/lib/module-service.js';

const DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL
  ?? (process.env.CI === 'true' ? process.env.DATABASE_URL : undefined);
if (!DATABASE_URL) throw new Error('App lifecycle DB tests require DEFT_TEST_DATABASE_URL');
if (process.env.CI !== 'true' && !/(?:test|ci|acceptance|phase5)/i.test(new URL(DATABASE_URL).pathname)) {
  throw new Error('App lifecycle DB tests require an explicitly disposable database');
}

const orgId = '11111111-1111-4111-8111-111111111101';
const otherOrgId = '11111111-1111-4111-8111-111111111102';
const userId = '22222222-2222-4222-8222-222222222201';

before(async () => {
  await db.insert(orgs).values([
    { id: orgId, name: 'Apps v0 test', slug: `apps-v0-test-${orgId.slice(-6)}` },
    { id: otherOrgId, name: 'Apps v0 other', slug: `apps-v0-other-${otherOrgId.slice(-6)}` },
  ]).onConflictDoNothing();
  await db.insert(users).values({
    id: userId,
    email: 'apps-v0-owner@example.test',
    name: 'Apps owner',
  }).onConflictDoNothing();
  await db.insert(orgMembers).values({
    id: '33333333-3333-4333-8333-333333333301',
    org_id: orgId,
    user_id: userId,
    role: 'owner',
    is_active: true,
  }).onConflictDoUpdate({
    target: [orgMembers.org_id, orgMembers.user_id],
    set: { role: 'owner', is_active: true },
  });
});

after(async () => closeDb());

async function packageJson(suffix: string) {
  const moduleManifest = {
    schema_version: '1',
    id: `test.deft.${suffix}`,
    slug: suffix,
    version: '1.0.0',
    name: `Test ${suffix}`,
    collections: [{
      key: 'items', name: 'Items',
      fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
      views: [{ key: 'all', name: 'All items', type: 'table', fields: ['name'] }],
      search: { title_field: 'name', subtitle_fields: [], fields: ['name'] },
    }],
  };
  const artifact = await prepareModuleArtifact({ path: `modules/${suffix}/deft.module.json`, manifest: moduleManifest });
  return buildDeftAppPackage({
    manifest: {
      schema_version: '0', id: `test.deft.${suffix}-app`, version: '1.0.0', name: `Test ${suffix}`,
      license: 'AGPL-3.0-only', compatibility: { app_protocol: '0' },
      modules: [{ module_id: moduleManifest.id, version: '1.0.0', manifest_path: artifact.path, manifest_digest: artifact.digest }],
      navigation: [{ key: 'items', label: `Test ${suffix}`, module_id: moduleManifest.id, collection_key: 'items', view_key: 'all' }],
    },
    artifacts: [artifact],
  });
}

test('App activation is atomic, tenant-bound, zero-rights while staged, and preserves records when disabled', async () => {
  const actor = humanModuleActor({ orgId, userId, role: 'owner' });
  const suffix = `atomic-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const moduleId = `test.deft.${suffix}`;
  const recordId = `apps-v0-record-${suffix}`;
  const built = await packageJson(suffix);
  const staged = await stageAppPackage(actor, built.json);
  assert.equal(staged.state, 'staged');
  const [lineage] = await db.select().from(appInstallations).where(eq(appInstallations.id, staged.id));
  assert.equal(lineage?.lineage_key, `local:${built.package.manifest.id}`);
  assert.equal(lineage?.lineage_authority_type, 'local_user');
  assert.equal(lineage?.lineage_authority_id, userId);
  const [version] = await db.select().from(appVersions).where(and(
    eq(appVersions.org_id, orgId),
    eq(appVersions.installation_id, staged.id),
  ));
  assert.ok(version?.requested_grant_snapshot_id);
  const [requestedGrant] = await db.select().from(appGrantSnapshots).where(eq(
    appGrantSnapshots.id,
    version.requested_grant_snapshot_id,
  ));
  assert.ok(requestedGrant);
  assert.equal(requestedGrant.snapshot_kind, 'requested');
  assert.deepEqual(requestedGrant.resource_rights, []);
  assert.equal(requestedGrant.classification.executable, false);
  await assert.rejects(
    db.insert(appGrantSnapshots).values({
      ...requestedGrant,
      id: randomUUID(),
      snapshot_kind: 'effective',
      requested_snapshot_id: requestedGrant.id,
      classification: { ...requestedGrant.classification, authority_state: 'effective' },
      canonical_snapshot: { ...requestedGrant.canonical_snapshot, snapshot_kind: 'effective' },
      snapshot_digest: `sha256:${'8'.repeat(64)}`,
      reviewed_by_actor_type: 'human',
      reviewed_by_actor_id: userId,
      reviewed_at: new Date(),
      created_at: new Date(),
    }),
    (error: any) => error?.cause?.code === '23514'
      && error?.cause?.message === 'APP_GRANT_EFFECTIVE_PROTOCOL_UNSUPPORTED',
  );
  assert.equal((await listActiveAppNavigation(actor)).some((item) => item.module_slug === suffix), false);
  assert.equal((await db.select().from(moduleInstallations).where(and(
    eq(moduleInstallations.org_id, orgId), eq(moduleInstallations.module_id, moduleId),
  ))).length, 0);

  await assert.rejects(
    () => activateAppInstallation(actor, staged.id, staged.package_digest, { failAfterModulePreparation: true }),
    /Injected App activation failure/,
  );
  const [afterFailure] = await db.select().from(appInstallations).where(and(
    eq(appInstallations.org_id, orgId), eq(appInstallations.id, staged.id),
  ));
  assert.equal(afterFailure?.state, 'staged');
  assert.equal(afterFailure?.active_version_id, null);
  assert.equal((await db.select().from(moduleInstallations).where(and(
    eq(moduleInstallations.org_id, orgId), eq(moduleInstallations.module_id, moduleId),
  ))).length, 0);

  const active = await activateAppInstallation(actor, staged.id, staged.package_digest);
  assert.equal(active.state, 'active');
  const [binding] = await db.select().from(appModuleBindings).where(eq(appModuleBindings.app_installation_id, staged.id));
  assert.ok(binding);
  assert.ok((await listActiveAppNavigation(actor)).some((item) => item.module_slug === suffix));

  await db.insert(moduleRecords).values({
    id: recordId, org_id: orgId, installation_id: binding.module_installation_id,
    collection_key: 'items', validated_version_id: binding.module_version_id, data: { name: 'Preserve me' },
    search_title: 'Preserve me', search_text: 'Preserve me', created_by_actor_type: 'human', created_by_actor_id: userId,
    updated_by_actor_type: 'human', updated_by_actor_id: userId,
  });
  const disabled = await disableAppInstallation(actor, active.id, active.lifecycle_epoch);
  assert.equal(disabled.state, 'disabled');
  assert.equal((await listActiveAppNavigation(actor)).some((item) => item.module_slug === suffix), false);
  assert.equal((await db.select().from(moduleRecords).where(eq(moduleRecords.id, recordId))).length, 1);
  const reenabled = await enableAppInstallation(actor, disabled.id, disabled.lifecycle_epoch);
  assert.equal(reenabled.state, 'active');
  assert.ok((await listActiveAppNavigation(actor)).some((item) => item.module_slug === suffix));
  assert.equal((await db.select().from(moduleRecords).where(eq(moduleRecords.id, recordId))).length, 1);
  const disabledAgain = await disableAppInstallation(actor, reenabled.id, reenabled.lifecycle_epoch);
  assert.equal(disabledAgain.state, 'disabled');
  await assert.rejects(
    () => updateModuleInstallation(actor, suffix, { enabled: true }),
    /owned by an App/,
  );

  await assert.rejects(
    db.insert(appModuleBindings).values({
      org_id: otherOrgId,
      app_installation_id: binding.app_installation_id,
      app_version_id: binding.app_version_id,
      module_installation_id: binding.module_installation_id,
      module_version_id: binding.module_version_id,
      module_id: binding.module_id,
      ownership: 'app',
    }),
  );
});
