import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { buildDeftAppPackage, prepareModuleArtifact } from '@deft/app-kit';
import {
  appInstallations,
  appModuleBindings,
  moduleInstallations,
  moduleRecords,
  orgMembers,
} from '@deft/db/schema';
import { db, closeDb } from '../src/lib/db.js';
import {
  activateAppInstallation,
  disableAppInstallation,
  listActiveAppNavigation,
  stageAppPackage,
} from '../src/lib/app-service.js';
import { humanModuleActor, updateModuleInstallation } from '../src/lib/module-service.js';

const orgId = 'apps-v0-test-org';
const otherOrgId = 'apps-v0-other-org';
const userId = 'apps-v0-test-owner';

before(async () => {
  const tables = await db.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'orgs') AS exists
  `);
  if (!tables.rows[0]?.exists) {
    await db.execute(sql.raw(`
      CREATE TYPE org_role AS ENUM ('owner', 'admin', 'member', 'guest');
      CREATE TABLE orgs (id text PRIMARY KEY, name text, slug text);
      CREATE TABLE users (id text PRIMARY KEY, email text, name text);
      CREATE TABLE org_members (
        id text PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL,
        role org_role NOT NULL DEFAULT 'member', is_active boolean NOT NULL DEFAULT true,
        joined_at timestamp NOT NULL DEFAULT now(), created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT org_member_unique UNIQUE (org_id, user_id)
      );
      CREATE TABLE audit_log (
        id text PRIMARY KEY, org_id text NOT NULL, actor_type text NOT NULL, actor_id text NOT NULL,
        action text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL,
        before_state jsonb, after_state jsonb, metadata jsonb, created_at timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE module_installations (
        id text PRIMARY KEY, org_id text NOT NULL, module_id text NOT NULL, slug text NOT NULL, source text NOT NULL,
        is_enabled boolean NOT NULL DEFAULT true, disabled_at timestamp, agent_access text NOT NULL DEFAULT 'none',
        installed_by_user_id text, installed_by_actor_type text NOT NULL, installed_by_actor_id text NOT NULL,
        updated_by_actor_type text NOT NULL, updated_by_actor_id text NOT NULL, is_deleted boolean NOT NULL DEFAULT false,
        deleted_at timestamp, deleted_by_actor_type text, deleted_by_actor_id text,
        created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT module_installations_org_id_id_unique UNIQUE (org_id, id),
        CONSTRAINT module_installations_org_module_id_unique UNIQUE (org_id, module_id),
        CONSTRAINT module_installations_org_slug_unique UNIQUE (org_id, slug),
        CONSTRAINT module_installations_enabled_state_check CHECK ((is_enabled AND disabled_at IS NULL) OR (NOT is_enabled AND disabled_at IS NOT NULL))
      );
      CREATE TABLE module_versions (
        id text PRIMARY KEY, org_id text NOT NULL, installation_id text NOT NULL, version text NOT NULL,
        manifest jsonb NOT NULL, manifest_digest text NOT NULL, is_active boolean NOT NULL DEFAULT false,
        activated_at timestamp, created_by_actor_type text NOT NULL, created_by_actor_id text NOT NULL,
        created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT module_versions_org_installation_fk FOREIGN KEY (org_id, installation_id) REFERENCES module_installations(org_id, id),
        CONSTRAINT module_versions_org_installation_id_unique UNIQUE (org_id, installation_id, id),
        CONSTRAINT module_versions_org_installation_version_unique UNIQUE (org_id, installation_id, version)
      );
      CREATE UNIQUE INDEX module_versions_one_active_unique ON module_versions(org_id, installation_id) WHERE is_active = true;
      CREATE TABLE module_records (
        id text PRIMARY KEY, org_id text NOT NULL, installation_id text NOT NULL, collection_key text NOT NULL,
        validated_version_id text NOT NULL, data jsonb NOT NULL DEFAULT '{}'::jsonb, revision integer NOT NULL DEFAULT 1,
        create_idempotency_key text, search_title text NOT NULL, search_subtitle text, search_text text NOT NULL DEFAULT '',
        search_vector tsvector, created_by_actor_type text NOT NULL, created_by_actor_id text NOT NULL,
        updated_by_actor_type text NOT NULL, updated_by_actor_id text NOT NULL, is_deleted boolean NOT NULL DEFAULT false,
        deleted_at timestamp, deleted_by_actor_type text, deleted_by_actor_id text,
        created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
        CONSTRAINT module_records_org_installation_id_unique UNIQUE (org_id, installation_id, id)
      );
      CREATE TABLE agent_employees (id text PRIMARY KEY, org_id text NOT NULL, is_deleted boolean NOT NULL DEFAULT false);
    `));
  }
  const appMigration = readFileSync(
    resolve(import.meta.dirname, '../../../packages/db/upgrades/0.3.0-preview.16-declarative-apps-v0.sql'),
    'utf8',
  );
  await db.execute(sql.raw(appMigration));
  await db.execute(sql.raw(`
    INSERT INTO orgs (id, name, slug) VALUES
      ('${orgId}', 'Apps v0 test', 'apps-v0-test'),
      ('${otherOrgId}', 'Apps v0 other', 'apps-v0-other') ON CONFLICT DO NOTHING;
    INSERT INTO users (id, email, name) VALUES ('${userId}', 'apps-v0-owner@example.test', 'Apps owner') ON CONFLICT DO NOTHING;
    INSERT INTO org_members (id, org_id, user_id, role, is_active)
      VALUES ('apps-v0-member', '${orgId}', '${userId}', 'owner', true)
      ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'owner', is_active = true;
  `));
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
