import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import pg from 'pg';
import {
  createModuleRecord,
  humanModuleActor,
  installModuleFromManifest,
  upgradeModuleInstallationToManifest,
} from '../src/lib/module-service.js';
import { closeDb } from '../src/lib/db.js';
import {
  digestModuleManifest,
  parseDeftModuleManifest,
  type DeftModuleManifestV1,
} from '@deft/shared/modules';

const TEST_DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL;
const canRun = Boolean(
  TEST_DATABASE_URL && /(?:test|ci|acceptance)/i.test(new URL(TEST_DATABASE_URL).pathname),
);

after(async () => {
  await closeDb();
});

function manifestFor(
  slug: string,
  version: string,
  options: { moduleId?: string; includeLegacy?: boolean; name?: string } = {},
): DeftModuleManifestV1 {
  return parseDeftModuleManifest({
    schema_version: '1',
    id: options.moduleId ?? `com.example.${slug}`,
    slug,
    version,
    name: options.name ?? 'Sideload test',
    collections: [{
      key: 'entries',
      name: 'Entries',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        ...(options.includeLegacy === false
          ? []
          : [{ key: 'legacy_note', label: 'Legacy note', type: 'text' as const }]),
      ],
      search: {
        title_field: 'name',
        fields: ['name'],
      },
    }],
  });
}

test('sideload install and upgrade enforce provenance, identity, CAS, semver, and rollback', { skip: !canRun }, async () => {
  assert.ok(TEST_DATABASE_URL);
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const orgId = `sideload-org-${suffix}`;
  const ownerId = `sideload-owner-${suffix}`;
  const memberId = `sideload-member-${suffix}`;
  const slug = `sideload-${suffix}`;
  const v1 = manifestFor(slug, '1.0.0');

  try {
    await client.query(
      `INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`,
      [orgId, `Sideload ${suffix}`, `sideload-${suffix}`],
    );
    for (const [userId, role] of [[ownerId, 'owner'], [memberId, 'member']] as const) {
      await client.query(
        `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`,
        [userId, `${userId}@example.test`, role],
      );
      await client.query(
        `INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, $4)`,
        [`sideload-member-row-${randomUUID()}`, orgId, userId, role],
      );
    }

    const owner = humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'rest' });
    const member = humanModuleActor({ orgId, userId: memberId, role: 'member', source: 'rest' });
    await assert.rejects(
      () => installModuleFromManifest(member, v1, { source: 'sideloaded' }),
      (error: any) => error?.code === 'MODULE_ACCESS_DENIED',
    );

    const attempts = await Promise.allSettled([
      installModuleFromManifest(owner, v1, { source: 'sideloaded' }),
      installModuleFromManifest(owner, v1, { source: 'sideloaded' }),
    ]);
    const successes = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const failures = attempts.filter((attempt) => attempt.status === 'rejected');
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.equal((failures[0] as PromiseRejectedResult).reason?.code, 'MODULE_ALREADY_INSTALLED');
    const installed = (successes[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof installModuleFromManifest>>>).value;
    assert.equal(installed.source, 'sideloaded');

    const created = await createModuleRecord(owner, {
      module_id: v1.id,
      collection_key: 'entries',
      data: { name: 'Private customer', legacy_note: 'must never enter lifecycle metadata' },
      expected_manifest_digest: installed.manifest_digest,
      idempotency_key: `sideload-create-${suffix}`,
    });
    assert.ok(created.record);

    await assert.rejects(
      () => upgradeModuleInstallationToManifest(owner, slug, {
        ...v1,
        name: 'Changed without version bump',
      }, {
        source: 'sideloaded',
        expected_active_manifest_digest: installed.manifest_digest,
      }),
      (error: any) => error?.code === 'MODULE_UPDATE_NOT_AVAILABLE' && error?.status === 409,
    );
    await assert.rejects(
      () => upgradeModuleInstallationToManifest(owner, slug, manifestFor(slug, '1.1.0', {
        moduleId: `com.example.different-${suffix}`,
      }), {
        source: 'sideloaded',
        expected_active_manifest_digest: installed.manifest_digest,
      }),
      (error: any) => error?.code === 'MODULE_IDENTITY_MISMATCH',
    );
    await assert.rejects(
      () => upgradeModuleInstallationToManifest(owner, `different-${suffix}`, manifestFor(slug, '1.1.0'), {
        source: 'sideloaded',
        expected_active_manifest_digest: installed.manifest_digest,
      }),
      (error: any) => error?.code === 'MODULE_IDENTITY_MISMATCH',
    );

    const v11 = manifestFor(slug, '1.1.0');
    await assert.rejects(
      () => upgradeModuleInstallationToManifest(owner, slug, v11, {
        source: 'sideloaded',
        expected_active_manifest_digest: `sha256:${'f'.repeat(64)}`,
      }),
      (error: any) => error?.code === 'MODULE_MANIFEST_STALE',
    );
    const upgraded = await upgradeModuleInstallationToManifest(owner, slug, v11, {
      source: 'sideloaded',
      expected_active_manifest_digest: installed.manifest_digest,
    });
    assert.equal(upgraded.manifest.version, '1.1.0');

    const incompatible = manifestFor(slug, '1.2.0', { includeLegacy: false });
    await assert.rejects(
      () => upgradeModuleInstallationToManifest(owner, slug, incompatible, {
        source: 'sideloaded',
        expected_active_manifest_digest: upgraded.manifest_digest,
      }),
      (error: any) => error?.code === 'MODULE_VALIDATION_ERROR',
    );
    const state = await client.query(
      `SELECT version, is_active FROM module_versions
       WHERE org_id = $1 AND installation_id = $2 ORDER BY version`,
      [orgId, installed.id],
    );
    assert.deepEqual(state.rows, [
      { version: '1.0.0', is_active: false },
      { version: '1.1.0', is_active: true },
    ]);
    const recordState = await client.query(
      `SELECT revision, data FROM module_records WHERE org_id = $1 AND id = $2`,
      [orgId, created.record.id],
    );
    assert.equal(recordState.rows[0]?.revision, 1);
    assert.equal(recordState.rows[0]?.data.legacy_note, 'must never enter lifecycle metadata');

    const audit = await client.query(
      `SELECT action, before_state, after_state, metadata FROM audit_log
       WHERE org_id = $1 AND action IN ('module.install', 'module.update') ORDER BY created_at`,
      [orgId],
    );
    assert.deepEqual(audit.rows.map((row) => row.action), ['module.install', 'module.update']);
    const lifecycleMetadata = JSON.stringify(audit.rows);
    assert.ok(!lifecycleMetadata.includes('must never enter lifecycle metadata'));
    assert.ok(!lifecycleMetadata.includes('collections'));
    assert.ok(!lifecycleMetadata.includes('fields'));
    assert.equal(await digestModuleManifest(v11), upgraded.manifest_digest);
  } finally {
    await client.query(`DELETE FROM module_record_relations WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM module_saved_views WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM module_mutation_receipts WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM module_records WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM module_versions WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM module_installations WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM audit_log WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM org_members WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
    await client.query(`DELETE FROM users WHERE id IN ($1, $2)`, [ownerId, memberId]);
    await client.end();
  }
});
