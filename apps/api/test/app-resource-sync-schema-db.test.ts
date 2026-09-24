import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { insertAppResourceSyncSchemaFixture } from '../../../packages/db/scripts/fixtures/app-resource-sync-schema-fixture.js';

const databaseUrl = process.env.DEFT_TEST_DATABASE_URL;
const assignedDatabase = databaseUrl && databaseUrl === process.env.DATABASE_URL
  && new URL(databaseUrl).hostname === '127.0.0.1'
  && new URL(databaseUrl).port === '55435'
  && /^\/gate_g_phase5_test_c04_s04_(?:fresh|upgrade)(?:_v\d+)?$/.test(new URL(databaseUrl).pathname);

test('S04 v2 schema pins reviewed ancestry, intent CAS and encrypted capacity', {
  skip: !assignedDatabase,
}, async () => {
  process.env.DEFT_APPS_ENABLED = 'true';
  const [{ db, closeDb }, schema, kit, appService, appReview, moduleService] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('@deft/app-kit'),
    import('../src/lib/app-service.js'), import('../src/lib/app-runtime-review.js'),
    import('../src/lib/module-service.js'),
  ]);
  const { and, eq } = await import('drizzle-orm');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const suffix = randomUUID();
    const orgId = randomUUID();
    const ownerId = randomUUID();
    await db.insert(schema.orgs).values({ id: orgId, name: 'S04 schema fixture',
      slug: `s04-schema-${suffix}` });
    await db.insert(schema.users).values({ id: ownerId,
      email: `s04-schema-${suffix}@example.test`, name: 'S04 owner' });
    await db.insert(schema.orgMembers).values({ id: randomUUID(),
      org_id: orgId, user_id: ownerId, role: 'owner', is_active: true });
    const actor = moduleService.humanModuleActor({ orgId, userId: ownerId,
      role: 'owner', source: 'ui' });
    // The host v2 authoring/activation path is a later slice. A reviewed v3
    // App supplies real installation/version/effective-grant ancestors here;
    // the fixture only probes the additive SQL shape, never live sync authority.
    const pkg = (await kit.buildDeftAppPackage({ manifest: {
      schema_version: '3', id: `community.example.s04.schema${suffix.replace(/-/g, '')}`,
      version: '1.0.0', name: 'S04 schema', license: 'AGPL-3.0-only',
      compatibility: { app_protocol: '3' }, modules: [], navigation: [],
      runtime_requirements: [{ key: 'provider', protocol_version: 'deft.app_runtime_channel.v1' }],
      private_capabilities: [{ key: 'deliver', version: '1',
        input_schema: { type: 'object', properties: { id: { type: 'string', maxLength: 120 } },
          required: ['id'], additionalProperties: false },
        output_schema: { type: 'object', properties: { ok: { type: 'boolean' } },
          required: ['ok'], additionalProperties: false } }],
      runtime_actions: [{ key: 'deliver', label: 'Deliver', capability_key: 'deliver',
        runtime_requirement_key: 'provider' }],
    }, artifacts: [] })).json;
    const staged = await appService.stageAppPackage(actor, pkg);
    const [version] = await db.select().from(schema.appVersions).where(and(
      eq(schema.appVersions.org_id, orgId), eq(schema.appVersions.id, staged.version_id)));
    assert.ok(version?.requested_grant_snapshot_id);
    const [requested] = await db.select().from(schema.appGrantSnapshots).where(and(
      eq(schema.appGrantSnapshots.org_id, orgId),
      eq(schema.appGrantSnapshots.id, version.requested_grant_snapshot_id)));
    assert.ok(requested);
    const reviewInput = { app_version_id: version.id,
      expected_package_digest: version.package_digest,
      expected_requested_snapshot_digest: requested.snapshot_digest,
      expected_lifecycle_epoch: staged.lifecycle_epoch,
      expected_grant_epoch: staged.grant_epoch };
    const review = await appReview.prepareRuntimeAppReview(actor, staged.id, reviewInput);
    const active = await appReview.activateRuntimeApp(actor, staged.id, {
      ...reviewInput, expected_review_digest: review.review_digest, accept_host_policy: true });
    const ids = await insertAppResourceSyncSchemaFixture(client, {
      org_id: orgId, app_installation_id: staged.id,
      app_version_id: version.id, grant_snapshot_id: active.grant_snapshot_id,
      owner_user_id: ownerId,
    }, { with_projections: true, key_suffix: 'schema' });
    const lineage = { org_id: orgId, app_installation_id: staged.id,
      app_version_id: version.id, grant_snapshot_id: active.grant_snapshot_id,
      owner_user_id: ownerId };
    await assert.rejects(insertAppResourceSyncSchemaFixture(client, lineage,
      { run_actor_id: randomUUID(), key_suffix: 'badactor' }),
    /app_runs_origin_coherence_check|app_runs_actor_check|check constraint/i);
    await assert.rejects(insertAppResourceSyncSchemaFixture(client, lineage,
      { intent_descriptor_digest: 'sha256:' + '0'.repeat(64),
        key_suffix: 'baddesc' }), /app_sync_intents_descriptor_fk/);

    async function rejectsSql(sql: string, values: unknown[], expected: RegExp) {
      await client.query('BEGIN');
      try {
        await assert.rejects(client.query(sql, values), (error: unknown) => {
          assert.match(String(error), expected);
          return true;
        });
      } finally { await client.query('ROLLBACK'); }
    }
    const [checkpoint] = (await client.query(`SELECT * FROM app_sync_checkpoints
      WHERE org_id=$1 AND id=$2`, [orgId, ids.checkpoint_id])).rows;
    assert.equal(checkpoint.retained_record_count, 2);
    assert.equal(Number(checkpoint.retained_bytes), 42,
      'live and tombstone ciphertext identity bytes count toward consent');
    assert.equal(checkpoint.cursor_sequence, 0);
    await rejectsSql(`UPDATE app_resource_bindings SET owner_user_id=$3
      WHERE org_id=$1 AND id=$2`, [orgId, ids.binding_id, randomUUID()],
    /APP_RESOURCE_BINDING_IMMUTABLE/);
    await rejectsSql(`UPDATE app_resource_bindings SET reviewed_descriptor='{}'::jsonb
      WHERE org_id=$1 AND id=$2`, [orgId, ids.binding_id],
    /APP_RESOURCE_BINDING_IMMUTABLE|app_resource_bindings_descriptor_check/);
    await rejectsSql(`UPDATE app_sync_checkpoints SET retained_bytes=0
      WHERE org_id=$1 AND id=$2`, [orgId, ids.checkpoint_id],
    /APP_SYNC_COUNTER_DIRECT_WRITE/);
    await rejectsSql(`UPDATE app_sync_checkpoints SET fresh_until=now()+interval '1 day'
      WHERE org_id=$1 AND id=$2`, [orgId, ids.checkpoint_id],
    /APP_SYNC_CURSOR_CAS_REQUIRED/);
    await rejectsSql(`UPDATE app_sync_checkpoints SET cursor_sequence=1,
      last_applied_run_id=$3,last_applied_page_digest=$4,
      last_applied_at=now(),last_checked_at=now()
      WHERE org_id=$1 AND id=$2`, [orgId, ids.checkpoint_id, randomUUID(),
      'sha256:' + createHash('sha256').update('wrong').digest('hex')],
    /APP_SYNC_CURSOR_INTENT_MISMATCH|app_sync_checkpoints_last_intent_fk/);
    await rejectsSql(`UPDATE app_resource_projections SET resource_id_hmac_key_version='forged'
      WHERE org_id=$1 AND id=$2`, [orgId, ids.live_projection_id],
    /APP_RESOURCE_PROJECTION_REKEY_REQUIRED/);
    await rejectsSql(`UPDATE app_resource_projections SET body_bytes=0
      WHERE org_id=$1 AND id=$2`, [orgId, ids.live_projection_id],
    /app_resource_projections_body_check|APP_RESOURCE_PROJECTION_REKEY_REQUIRED/);
    await rejectsSql(`UPDATE app_sync_intents SET descriptor_digest=$3
      WHERE org_id=$1 AND run_id=$2`, [orgId, ids.run_id,
      'sha256:' + '0'.repeat(64)], /APP_SYNC_INTENT_APPEND_ONLY/);
    await rejectsSql(`INSERT INTO app_sync_intents
      (id,org_id,run_id,resource_binding_id,checkpoint_id,app_installation_id,
       app_version_id,grant_snapshot_id,provider_snapshot_id,owner_user_id,
       descriptor_digest,generation,expected_cursor_sequence,
       expected_cursor_hmac_key_version,expected_cursor_hmac)
      SELECT $3,org_id,run_id,resource_binding_id,checkpoint_id,
        app_installation_id,app_version_id,grant_snapshot_id,provider_snapshot_id,
        owner_user_id,$4,generation,expected_cursor_sequence,
        expected_cursor_hmac_key_version,expected_cursor_hmac
      FROM app_sync_intents WHERE org_id=$1 AND run_id=$2`,
    [orgId, ids.run_id, randomUUID(), 'sha256:' + '0'.repeat(64)],
    /app_sync_intents_descriptor_fk|app_sync_intents_org_run_unique/);

    const settled = await client.query(`UPDATE app_sync_checkpoints
      SET cursor_sequence=1,last_applied_run_id=$3,last_applied_page_digest=$4,
        last_applied_at=now(),last_checked_at=now(),fresh_until=now()+interval '1 hour'
      WHERE org_id=$1 AND id=$2 RETURNING cursor_sequence,retained_record_count,retained_bytes`,
    [orgId, ids.checkpoint_id, ids.run_id,
      'sha256:' + createHash('sha256').update('page').digest('hex')]);
    assert.equal(settled.rows[0].cursor_sequence, 1);
    assert.equal(settled.rows[0].retained_record_count, 2);
    assert.equal(Number(settled.rows[0].retained_bytes), 42);
    await rejectsSql(`UPDATE app_sync_checkpoints SET cursor_sequence=2,
      last_applied_at=now(),last_checked_at=now()
      WHERE org_id=$1 AND id=$2`, [orgId, ids.checkpoint_id],
    /APP_SYNC_CURSOR_SETTLEMENT_INVALID|APP_SYNC_CURSOR_INTENT_MISMATCH/);
  } finally {
    await client.end();
    await closeDb();
  }
});
