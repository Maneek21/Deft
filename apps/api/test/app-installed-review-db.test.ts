import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = target === process.env.DATABASE_URL && target !== undefined
  && new URL(target).hostname === '127.0.0.1' && new URL(target).port === '55435'
  && /^\/gate_g_phase5_test_c03(?:b)?_root(?:_v[0-9]+)?$/.test(new URL(target).pathname);

test('v4 activation rolls back earlier included Modules when a later Module conflicts', { skip: !safe }, async () => {
  const [{ db, closeDb }, schema, kit, apps, review, modules] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('@deft/app-kit'),
    import('../src/lib/app-service.js'), import('../src/lib/app-runtime-review.js'),
    import('../src/lib/module-service.js'),
  ]);
  const { and, eq } = await import('drizzle-orm');
  try {
    const orgId = randomUUID();
    const ownerId = randomUUID();
    const suffix = randomUUID().replaceAll('-', '');
    await db.insert(schema.orgs).values({ id: orgId, name: 'Atomic installed App', slug: `atomic-${suffix}` });
    await db.insert(schema.users).values({ id: ownerId, name: 'Owner', email: `atomic-${suffix}@example.test` });
    await db.insert(schema.orgMembers).values({ id: randomUUID(), org_id: orgId,
      user_id: ownerId, role: 'owner', is_active: true });
    const owner = modules.humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'rest' });
    const moduleManifest = (name: string) => ({ schema_version: '1',
      id: `community.example.${name}`, slug: name, version: '1.0.0', name,
      collections: [{ key: 'items', name: 'Items', singular_name: 'Item',
        fields: [{ key: 'title', label: 'Title', type: 'text', required: true }],
        views: [{ key: 'all', name: 'All', type: 'table', fields: ['title'] }],
        search: { title_field: 'title', subtitle_fields: [], fields: ['title'] } }],
      navigation: { default_collection: 'items', default_view: 'all' } });
    const first = moduleManifest('a-atomic');
    const conflict = moduleManifest('z-existing');
    await modules.installModuleFromManifest(owner, conflict, { source: 'sideloaded' });
    const artifacts = await Promise.all([first, conflict].map((manifest) =>
      kit.prepareModuleArtifact({ path: `modules/${manifest.slug}/deft.module.json`, manifest })));
    const object = { type: 'object' as const,
      properties: { resource_id: { type: 'string' as const, maxLength: 120 } },
      required: ['resource_id'], additionalProperties: false as const };
    const pkg = await kit.buildDeftAppPackage({ manifest: {
      schema_version: '4', id: `community.example.atomic.a${suffix}`, version: '1.0.0',
      name: 'Atomic App', license: 'AGPL-3.0-only', compatibility: { app_protocol: '4' },
      modules: artifacts.map((artifact, index) => ({ module_id: [first, conflict][index]!.id,
        version: '1.0.0', manifest_path: artifact.path, manifest_digest: artifact.digest })),
      navigation: [], runtime_requirements: [{ key: 'operator', protocol_version: 'deft.app_runtime_channel.v1' }],
      private_capabilities: [{ key: 'action', version: '1', input_schema: object, output_schema: object }],
      runtime_actions: [{ key: 'perform_action', label: 'Perform action', capability_key: 'action', runtime_requirement_key: 'operator' }],
      experiences: [], public_actions: [],
    }, artifacts });
    const staged = await apps.stageAppPackage(owner, pkg.json);
    const [version] = await db.select().from(schema.appVersions).where(eq(schema.appVersions.id, staged.version_id));
    assert.ok(version?.requested_grant_snapshot_id);
    const [requested] = await db.select().from(schema.appGrantSnapshots)
      .where(eq(schema.appGrantSnapshots.id, version.requested_grant_snapshot_id));
    assert.ok(requested);
    const request = { app_version_id: version.id, expected_package_digest: version.package_digest,
      expected_requested_snapshot_digest: requested.snapshot_digest,
      expected_lifecycle_epoch: staged.lifecycle_epoch, expected_grant_epoch: staged.grant_epoch };
    const prepared = await review.prepareRuntimeAppReview(owner, staged.id, request);
    await assert.rejects(review.activateRuntimeApp(owner, staged.id, { ...request,
      expected_review_digest: prepared.review_digest, accept_host_policy: true }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'MODULE_ALREADY_INSTALLED');
    const installed = await db.select().from(schema.moduleInstallations).where(eq(schema.moduleInstallations.org_id, orgId));
    assert.equal(installed.length, 1);
    assert.equal(installed[0]!.module_id, conflict.id);
    assert.equal(installed[0]!.is_enabled, true);
    assert.deepEqual(await db.select().from(schema.appModuleBindings)
      .where(eq(schema.appModuleBindings.app_installation_id, staged.id)), []);
    assert.deepEqual(await db.select().from(schema.appGrantSnapshots).where(and(
      eq(schema.appGrantSnapshots.app_installation_id, staged.id),
      eq(schema.appGrantSnapshots.snapshot_kind, 'effective'))), []);
    const [after] = await db.select().from(schema.appInstallations).where(eq(schema.appInstallations.id, staged.id));
    assert.equal(after?.state, 'staged');
    assert.equal(after?.active_version_id, null);
    assert.equal(after?.lifecycle_epoch, staged.lifecycle_epoch);
    assert.equal(after?.grant_epoch, staged.grant_epoch);
    const [afterVersion] = await db.select().from(schema.appVersions).where(eq(schema.appVersions.id, version.id));
    assert.equal(afterVersion?.state, 'staged');
    assert.equal(afterVersion?.activated_at, null);
    assert.equal((await review.prepareRuntimeAppReview(owner, staged.id, request)).review_digest, prepared.review_digest);
  } finally { await closeDb(); }
});
