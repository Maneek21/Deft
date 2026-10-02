import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = process.env.DEFT_TEST_PRE38_SEED === 'true' && target === process.env.DATABASE_URL
  && target !== undefined && new URL(target).hostname === '127.0.0.1'
  && new URL(target).port === '55435'
  && new URL(target).pathname === '/gate_g_phase5_test_s05_v5_preserve';

test('seed real v3/v4 reviewed rows before preview38 for byte preservation', { skip: !safe }, async () => {
  const [{ db, closeDb }, schema, kit, apps, review, modules] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('@deft/app-kit'),
    import('../src/lib/app-service.js'), import('../src/lib/app-runtime-review.js'),
    import('../src/lib/module-service.js'),
  ]);
  const { eq } = await import('drizzle-orm');
  try {
    const suffix = randomUUID().replaceAll('-', '');
    const orgId = randomUUID(); const ownerId = randomUUID();
    await db.insert(schema.orgs).values({ id: orgId, name: 'v5 predecessor preservation', slug: `pre38-${suffix}` });
    await db.insert(schema.users).values({ id: ownerId, name: 'Owner', email: `pre38-${suffix}@example.test` });
    await db.insert(schema.orgMembers).values({ id: randomUUID(), org_id: orgId,
      user_id: ownerId, role: 'owner', is_active: true });
    const actor = modules.humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'rest' });
    const object = { type: 'object' as const,
      properties: { shipment_id: { type: 'string' as const, maxLength: 120 } },
      required: ['shipment_id'], additionalProperties: false as const };
    for (const protocol of ['3', '4'] as const) {
      const manifest = { schema_version: protocol, id: `community.example.pre38-${protocol}.a${suffix}`,
        version: '1.0.0', name: `Pre38 v${protocol}`, license: 'AGPL-3.0-only',
        compatibility: { app_protocol: protocol }, modules: [], navigation: [],
        runtime_requirements: [{ key: 'carrier', protocol_version: 'deft.app_runtime_channel.v1' }],
        private_capabilities: [{ key: 'label', version: '1', input_schema: object, output_schema: object }],
        runtime_actions: [{ key: 'create_label', label: 'Create label',
          capability_key: 'label', runtime_requirement_key: 'carrier' }],
        ...(protocol === '4' ? { experiences: [], public_actions: [] } : {}),
      };
      const pkg = await kit.buildDeftAppPackage({ manifest, artifacts: [] });
      const staged = await apps.stageAppPackage(actor, pkg.json);
      const [version] = await db.select().from(schema.appVersions).where(eq(schema.appVersions.id, staged.version_id));
      assert.ok(version?.requested_grant_snapshot_id);
      const [requested] = await db.select().from(schema.appGrantSnapshots).where(eq(
        schema.appGrantSnapshots.id, version.requested_grant_snapshot_id));
      assert.ok(requested);
      const request = { app_version_id: version.id, expected_package_digest: version.package_digest,
        expected_requested_snapshot_digest: requested.snapshot_digest,
        expected_lifecycle_epoch: staged.lifecycle_epoch, expected_grant_epoch: staged.grant_epoch };
      const prepared = await review.prepareRuntimeAppReview(actor, staged.id, request);
      assert.equal(prepared.authority.schema, 'deft.app_runtime_grant.v1');
      const active = await review.activateRuntimeApp(actor, staged.id, {
        ...request, expected_review_digest: prepared.review_digest, accept_host_policy: true });
      assert.equal(active.installation.state, 'active');
    }
  } finally { await closeDb(); }
});
