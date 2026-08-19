import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import pg from 'pg';
import {
  createModuleRecord,
  createModuleSavedView,
  deleteModuleSavedView,
  getModuleRecord,
  getModuleRecordRelations,
  humanModuleActor,
  listModuleRecordReferences,
  listModuleSavedViews,
  replaceModuleRecordRelations,
  updateModuleSavedView,
  upgradeModuleInstallationToManifest,
} from '../src/lib/module-service.js';
import { getBundledModule } from '../src/lib/bundled-modules.js';
import { closeDb } from '../src/lib/db.js';
import {
  digestModuleManifest,
  parseDeftModuleManifest,
  type DeftModuleManifestV1,
  type ModuleManifestDigest,
} from '@deft/shared/modules';

const TEST_DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const canRun = Boolean(
  TEST_DATABASE_URL && /(?:test|ci|acceptance)/i.test(new URL(TEST_DATABASE_URL).pathname),
);

after(async () => {
  await closeDb();
});

function legacyContactsManifest(includeRemovedField = false): DeftModuleManifestV1 {
  const latest = getBundledModule('contacts');
  assert.ok(latest);
  const contacts = latest.collections.find((collection) => collection.key === 'contacts');
  assert.ok(contacts);
  const removed = new Set(['company_id', 'owner', 'tags']);
  const fields = contacts.fields.filter((field) => !removed.has(field.key));
  if (includeRemovedField) {
    fields.push({ key: 'legacy_only', label: 'Legacy only', type: 'text', required: false });
  }
  return parseDeftModuleManifest({
    schema_version: '1',
    id: latest.id,
    slug: latest.slug,
    version: '1.0.0',
    name: 'Contacts Directory',
    collections: [{
      ...contacts,
      fields,
      views: contacts.views
        ?.filter((view) => view.type === 'table' || view.type === 'form' || view.type === 'detail')
        .map((view) => ({ ...view, fields: view.fields.filter((field) => !removed.has(field)) })),
    }],
    navigation: { default_collection: 'contacts', default_view: 'table' },
  });
}

test('generic upgrade preserves data and unlocks relations plus personal saved views', { skip: !canRun }, async () => {
  assert.ok(TEST_DATABASE_URL);
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const orgId = `module-foundation-org-${suffix}`;
  const userId = `module-foundation-user-${suffix}`;
  const rollbackOrgId = `module-rollback-org-${suffix}`;
  const rollbackUserId = `module-rollback-user-${suffix}`;
  const createdOrgIds = [orgId, rollbackOrgId];
  const createdUserIds = [userId, rollbackUserId];

  async function seedLegacyInstallation(
    targetOrgId: string,
    targetUserId: string,
    manifest: DeftModuleManifestV1,
  ): Promise<{ installationId: string; versionId: string; digest: ModuleManifestDigest }> {
    const installationId = `module-foundation-install-${randomUUID()}`;
    const versionId = `module-foundation-version-${randomUUID()}`;
    const digest = await digestModuleManifest(manifest);
    await client.query(
      `INSERT INTO module_installations
         (id, org_id, module_id, slug, source, installed_by_user_id,
          installed_by_actor_type, installed_by_actor_id,
          updated_by_actor_type, updated_by_actor_id)
       VALUES ($1, $2, $3, $4, 'bundled', $5, 'human', $5, 'human', $5)`,
      [installationId, targetOrgId, manifest.id, manifest.slug, targetUserId],
    );
    await client.query(
      `INSERT INTO module_versions
         (id, org_id, installation_id, version, manifest, manifest_digest,
          is_active, activated_at, created_by_actor_type, created_by_actor_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, true, now(), 'human', $7)`,
      [versionId, targetOrgId, installationId, manifest.version, JSON.stringify(manifest), digest, targetUserId],
    );
    return { installationId, versionId, digest };
  }

  try {
    for (const [targetOrgId, targetUserId, label] of [
      [orgId, userId, 'Foundation'],
      [rollbackOrgId, rollbackUserId, 'Rollback'],
    ] as const) {
      await client.query(
        `INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`,
        [targetOrgId, `${label} ${suffix}`, `${label.toLowerCase()}-${suffix}`],
      );
      await client.query(
        `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`,
        [targetUserId, `${label.toLowerCase()}-${suffix}@example.test`, `${label} Owner`],
      );
      await client.query(
        `INSERT INTO org_members (id, org_id, user_id, role)
         VALUES ($1, $2, $3, 'owner')`,
        [`member-${randomUUID()}`, targetOrgId, targetUserId],
      );
    }

    const oldManifest = legacyContactsManifest();
    const old = await seedLegacyInstallation(orgId, userId, oldManifest);
    const owner = humanModuleActor({ orgId, userId, role: 'owner', source: 'rest' });
    const legacyContact = await createModuleRecord(owner, {
      module_id: oldManifest.id,
      collection_key: 'contacts',
      data: { name: 'Ada Lovelace', company: 'Analytical Engines' },
      expected_manifest_digest: old.digest,
      idempotency_key: `legacy-contact-${suffix}`,
    });
    assert.ok(legacyContact.record);

    const latest = getBundledModule('contacts');
    assert.ok(latest);
    const upgraded = await upgradeModuleInstallationToManifest(owner, 'contacts', latest, {
      source: 'bundled',
      expected_active_manifest_digest: old.digest,
    });
    assert.equal(upgraded.manifest.version, '1.1.0');
    assert.deepEqual(upgraded.manifest.collections.map((collection) => collection.key), [
      'contacts',
      'companies',
      'deals',
      'activities',
    ]);
    const preserved = await getModuleRecord(owner, legacyContact.record.id);
    assert.equal(preserved.revision, 1);
    assert.equal(preserved.data.company, 'Analytical Engines');

    const company = await createModuleRecord(owner, {
      module_id: latest.id,
      collection_key: 'companies',
      data: { name: 'Analytical Engines Ltd', owner: userId, tags: ['customer'] },
      expected_manifest_digest: upgraded.manifest_digest,
      idempotency_key: `company-${suffix}`,
    });
    assert.ok(company.record);
    const relation = await replaceModuleRecordRelations(
      owner,
      legacyContact.record.id,
      'company_id',
      [company.record.id],
      {
        expectedInstallationId: old.installationId,
        expectedRevision: legacyContact.record.revision,
        expectedManifestDigest: upgraded.manifest_digest,
        idempotencyKey: `legacy-company-relation-${suffix}`,
      },
    );
    assert.equal(relation.records[0]?.label, 'Analytical Engines Ltd');
    const relations = await getModuleRecordRelations(owner, legacyContact.record.id);
    assert.equal(relations.find((group) => group.field_key === 'company_id')?.records[0]?.id, company.record.id);
    const relatedRecord = await getModuleRecord(owner, legacyContact.record.id);
    assert.equal(relatedRecord.revision, 2);
    assert.equal(relatedRecord.relations.find((group) => group.field_key === 'company_id')?.records[0]?.id, company.record.id);
    const relationAudits = await client.query(
      `SELECT action, metadata FROM audit_log
       WHERE org_id = $1 AND entity_id = $2 AND action LIKE 'module_record.%'
       ORDER BY created_at`,
      [orgId, legacyContact.record.resource_id],
    );
    assert.deepEqual(relationAudits.rows.map((row) => row.action), [
      'module_record.create',
      'module_record.update',
    ]);
    assert.deepEqual(relationAudits.rows[1]?.metadata.relation_fields, ['company_id']);
    const references = await listModuleRecordReferences(owner, 'contacts', 'companies', [company.record.id]);
    assert.equal(references[0]?.label, 'Analytical Engines Ltd');

    const saved = await createModuleSavedView(owner, 'contacts', {
      collection_key: 'contacts',
      name: 'Active contacts',
      config: {
        type: 'board',
        fields: ['name', 'company_id', 'owner'],
        group_by: 'status',
        filters: [{ field: 'status', operator: 'eq', value: 'active' }],
      },
    });
    assert.equal((await listModuleSavedViews(owner, 'contacts', 'contacts')).length, 1);
    const renamed = await updateModuleSavedView(owner, 'contacts', saved.id, {
      name: 'Current contacts',
    });
    assert.equal(renamed.name, 'Current contacts');
    await deleteModuleSavedView(owner, 'contacts', saved.id);
    assert.equal((await listModuleSavedViews(owner, 'contacts', 'contacts')).length, 0);

    const incompatibleManifest = legacyContactsManifest(true);
    const rollback = await seedLegacyInstallation(rollbackOrgId, rollbackUserId, incompatibleManifest);
    const rollbackOwner = humanModuleActor({
      orgId: rollbackOrgId,
      userId: rollbackUserId,
      role: 'owner',
      source: 'rest',
    });
    await createModuleRecord(rollbackOwner, {
      module_id: incompatibleManifest.id,
      collection_key: 'contacts',
      data: { name: 'Legacy record', legacy_only: 'must not disappear' },
      expected_manifest_digest: rollback.digest,
      idempotency_key: `rollback-${suffix}`,
    });
    await assert.rejects(
      () => upgradeModuleInstallationToManifest(rollbackOwner, 'contacts', latest, {
        source: 'bundled',
        expected_active_manifest_digest: rollback.digest,
      }),
      (error: any) => error?.code === 'MODULE_VALIDATION_ERROR',
    );
    const rollbackState = await client.query(
      `SELECT version, is_active FROM module_versions
       WHERE org_id = $1 AND installation_id = $2 ORDER BY version`,
      [rollbackOrgId, rollback.installationId],
    );
    assert.deepEqual(rollbackState.rows, [{ version: '1.0.0', is_active: true }]);
  } finally {
    for (const targetOrgId of createdOrgIds) {
      await client.query(`DELETE FROM module_record_relations WHERE org_id = $1`, [targetOrgId]);
      await client.query(`DELETE FROM module_saved_views WHERE org_id = $1`, [targetOrgId]);
      await client.query(`DELETE FROM module_mutation_receipts WHERE org_id = $1`, [targetOrgId]);
      await client.query(`DELETE FROM module_records WHERE org_id = $1`, [targetOrgId]);
      await client.query(`DELETE FROM module_versions WHERE org_id = $1`, [targetOrgId]);
      await client.query(`DELETE FROM module_installations WHERE org_id = $1`, [targetOrgId]);
      await client.query(`DELETE FROM audit_log WHERE org_id = $1`, [targetOrgId]);
      await client.query(`DELETE FROM org_members WHERE org_id = $1`, [targetOrgId]);
      await client.query(`DELETE FROM orgs WHERE id = $1`, [targetOrgId]);
    }
    for (const targetUserId of createdUserIds) {
      await client.query(`DELETE FROM users WHERE id = $1`, [targetUserId]);
    }
    await client.end();
  }
});
