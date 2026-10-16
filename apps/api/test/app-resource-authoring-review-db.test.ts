import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = target === process.env.DATABASE_URL && target !== undefined
  && new URL(target).hostname === '127.0.0.1' && new URL(target).port === '55435'
  && /^\/gate_g_phase5_test_s05_(?:v5_review(?:_v[0-9]+)?|root(?:_v[0-9]+)?)$/.test(new URL(target).pathname);

after(async () => { if (safe) await (await import('../src/lib/db.js')).closeDb(); });

const record = { type: 'object' as const, properties: { subject: { type: 'string' as const, maxLength: 200 } },
  required: ['subject'], additionalProperties: false as const };
const actionObject = { type: 'object' as const,
  properties: { message_id: { type: 'string' as const, maxLength: 120 } },
  required: ['message_id'], additionalProperties: false as const };
function v5Manifest(id: string, mixed = false) {
  return { schema_version: '5' as const, id, version: '1.0.0', name: 'Resource review fixture',
    license: 'AGPL-3.0-only', compatibility: { app_protocol: '5' as const }, modules: [], navigation: [],
    runtime_requirements: [
      { key: 'mail_sync', protocol_version: 'deft.app_runtime_channel.v2' as const },
      ...(mixed ? [{ key: 'mail_action', protocol_version: 'deft.app_runtime_channel.v1' as const }] : []),
    ],
    private_capabilities: mixed ? [{ key: 'archive', version: '1' as const,
      input_schema: actionObject, output_schema: actionObject }] : [],
    runtime_actions: mixed ? [{ key: 'archive_message', label: 'Archive message',
      capability_key: 'archive', runtime_requirement_key: 'mail_action' }] : [],
    sync_descriptors: [{ schema_version: 'deft.app_sync_descriptor.v1' as const,
      key: 'mail', runtime_requirement_key: 'mail_sync', resource_type: 'email_message',
      requested_visibility: 'user_private' as const, record_schema: record, label_field: 'subject' }],
    experiences: [], public_actions: [],
  };
}

test('v5 sync-only and mixed stage/review/activation pin declaration without resource authority', { skip: !safe }, async () => {
  const [{ db }, schema, kit, sync, apps, review, modules] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('@deft/app-kit'),
    import('@deft/app-kit/experimental/resource-sync'), import('../src/lib/app-service.js'),
    import('../src/lib/app-runtime-review.js'), import('../src/lib/module-service.js'),
  ]);
  const { and, eq } = await import('drizzle-orm');
  try {
    const suffix = randomUUID().replaceAll('-', '');
    const orgId = randomUUID(); const foreignOrgId = randomUUID();
    const ownerId = randomUUID(); const memberId = randomUUID(); const foreignId = randomUUID();
    await db.insert(schema.orgs).values([{ id: orgId, name: 'v5 review', slug: `v5-review-${suffix}` },
      { id: foreignOrgId, name: 'foreign v5', slug: `foreign-v5-${suffix}` }]);
    await db.insert(schema.users).values([
      { id: ownerId, name: 'Owner', email: `v5-owner-${suffix}@example.test` },
      { id: memberId, name: 'Member', email: `v5-member-${suffix}@example.test` },
      { id: foreignId, name: 'Foreign owner', email: `v5-foreign-${suffix}@example.test` },
    ]);
    await db.insert(schema.orgMembers).values([
      { id: randomUUID(), org_id: orgId, user_id: ownerId, role: 'owner', is_active: true },
      { id: randomUUID(), org_id: orgId, user_id: memberId, role: 'member', is_active: true },
      { id: randomUUID(), org_id: foreignOrgId, user_id: foreignId, role: 'owner', is_active: true },
    ]);
    const owner = modules.humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'rest' });
    const spoofed = modules.humanModuleActor({ orgId, userId: memberId, role: 'owner', source: 'rest' });
    const foreign = modules.humanModuleActor({ orgId: foreignOrgId, userId: foreignId, role: 'owner', source: 'rest' });
    for (const mixed of [false, true]) {
      const manifest = v5Manifest(`community.example.v5-review-${mixed ? 'mixed' : 'sync'}.a${suffix}`, mixed);
      const pkg = await kit.buildDeftAppPackage({ manifest, artifacts: [] });
      assert.equal(pkg.package.artifacts.length, 0);
      assert.equal(pkg.package.package_format, 'deft.app.package.v5');
      const staged = await apps.stageAppPackage(owner, pkg.json);
      const [version] = await db.select().from(schema.appVersions).where(and(
        eq(schema.appVersions.org_id, orgId), eq(schema.appVersions.id, staged.version_id)));
      assert.ok(version?.requested_grant_snapshot_id);
      const [requested] = await db.select().from(schema.appGrantSnapshots).where(eq(
        schema.appGrantSnapshots.id, version.requested_grant_snapshot_id));
      assert.ok(requested);
      assert.equal(requested.snapshot_kind, 'requested');
      assert.equal(requested.classification.provider_access, false);
      assert.deepEqual(requested.resource_rights, []);
      assert.deepEqual((requested.canonical_snapshot.requirements as Record<string, unknown>).sync_descriptors,
        manifest.sync_descriptors);
      const input = { app_version_id: version.id, expected_package_digest: version.package_digest,
        expected_requested_snapshot_digest: requested.snapshot_digest,
        expected_lifecycle_epoch: staged.lifecycle_epoch, expected_grant_epoch: staged.grant_epoch };
      await assert.rejects(review.prepareRuntimeAppReview(spoofed, staged.id, input));
      await assert.rejects(review.prepareRuntimeAppReview(foreign, staged.id, input));
      await assert.rejects(review.prepareRuntimeAppReview(owner, staged.id, {
        ...input, expected_requested_snapshot_digest: `sha256:${'0'.repeat(64)}` }));
      await assert.rejects(review.prepareRuntimeAppReview(owner, staged.id, {
        ...input, expected_lifecycle_epoch: staged.lifecycle_epoch + 1 }));
      const prepared = await review.prepareRuntimeAppReview(owner, staged.id, input);
      assert.equal(prepared.authority.schema, 'deft.app_runtime_grant.v2');
      assert.equal(prepared.authority.runtime_actions.length, mixed ? 1 : 0);
      assert.equal(prepared.authority.sync_descriptors.length, 1);
      const pinned = prepared.authority.sync_descriptors[0]!;
      assert.equal(pinned.descriptor_digest, await sync.digestResourceSyncDescriptor(manifest.sync_descriptors[0]));
      assert.deepEqual({ ...pinned, descriptor_digest: undefined },
        { ...manifest.sync_descriptors[0], descriptor_digest: undefined });
      const active = await review.activateRuntimeApp(owner, staged.id, {
        ...input, expected_review_digest: prepared.review_digest, accept_host_policy: true });
      assert.equal(active.installation.state, 'active');
      const [grant] = await db.select().from(schema.appGrantSnapshots).where(eq(
        schema.appGrantSnapshots.id, active.grant_snapshot_id));
      assert.ok(grant);
      assert.equal(grant.classification.executable, false);
      assert.equal(grant.classification.provider_access, false);
      assert.equal(grant.classification.resource_binding_consent_required, true);
      assert.deepEqual(grant.resource_rights, []);
      assert.equal(grant.canonical_snapshot.schema, 'deft.app_runtime_grant.v2');
      if (mixed) await assert.rejects(db.transaction((tx) =>
        review.loadReviewedRuntimeAction(tx, orgId, staged.id, 'archive_message')));
      for (const table of [schema.appRuntimeRegistrations, schema.appRuntimeBindings,
        schema.appResourceBindings, schema.appRuntimeSessions, schema.appSyncCheckpoints, schema.appRuns]) {
        assert.deepEqual(await db.select({ id: table.id }).from(table).where(eq(table.org_id, orgId)), []);
      }
      if (!mixed) {
        const changedDescriptor = structuredClone(grant.canonical_snapshot);
        (changedDescriptor.sync_descriptors as Record<string, unknown>[])[0]!.resource_type = 'forged_mail';
        for (const tampered of [
          { ...grant.canonical_snapshot, lineage_key: 'forged' },
          { ...grant.canonical_snapshot, classification: undefined },
          changedDescriptor,
        ]) {
          await assert.rejects(db.insert(schema.appGrantSnapshots).values({ ...grant,
            id: randomUUID(), supersedes_snapshot_id: grant.id, canonical_snapshot: tampered,
            snapshot_digest: kit.AppDigestSchema.parse(grant.snapshot_digest) }), (error: unknown) => {
              assert.match(String((error as { cause?: { message?: string } }).cause?.message ?? error),
                /APP_V5_GRANT_/);
              return true;
            });
        }
        const disabled = await apps.disableAppInstallation(owner, staged.id, active.installation.lifecycle_epoch);
        await assert.rejects(review.activateRuntimeApp(owner, staged.id, {
          ...input, expected_review_digest: prepared.review_digest, accept_host_policy: true }));
        const fresh = { ...input, expected_lifecycle_epoch: disabled.lifecycle_epoch,
          expected_grant_epoch: disabled.grant_epoch };
        const nextReview = await review.prepareRuntimeAppReview(owner, staged.id, fresh);
        assert.notEqual(nextReview.review_digest, prepared.review_digest);
        const again = await review.activateRuntimeApp(owner, staged.id, {
          ...fresh, expected_review_digest: nextReview.review_digest, accept_host_policy: true });
        assert.notEqual(again.grant_snapshot_id, grant.id);
        assert.equal(again.installation.active_grant_snapshot_id, again.grant_snapshot_id);
      }
    }
  } finally { /* shared pool closes after both cases */ }
});

test('v5 activation rolls back earlier included Module, grant and lifecycle on later Module conflict', { skip: !safe }, async () => {
  const [{ db }, schema, kit, apps, review, modules] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('@deft/app-kit'),
    import('../src/lib/app-service.js'), import('../src/lib/app-runtime-review.js'),
    import('../src/lib/module-service.js'),
  ]);
  const { eq, and } = await import('drizzle-orm');
  try {
    const suffix = randomUUID().replaceAll('-', '');
    const orgId = randomUUID(); const ownerId = randomUUID();
    await db.insert(schema.orgs).values({ id: orgId, name: 'v5 atomic', slug: `v5-atomic-${suffix}` });
    await db.insert(schema.users).values({ id: ownerId, name: 'Owner', email: `v5-atomic-${suffix}@example.test` });
    await db.insert(schema.orgMembers).values({ id: randomUUID(), org_id: orgId,
      user_id: ownerId, role: 'owner', is_active: true });
    const owner = modules.humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'rest' });
    const moduleManifest = (name: string) => ({ schema_version: '1', id: `community.example.${name}`,
      slug: name, version: '1.0.0', name,
      collections: [{ key: 'items', name: 'Items', singular_name: 'Item',
        fields: [{ key: 'title', label: 'Title', type: 'text', required: true }],
        views: [{ key: 'all', name: 'All', type: 'table', fields: ['title'] }],
        search: { title_field: 'title', subtitle_fields: [], fields: ['title'] } }],
      navigation: { default_collection: 'items', default_view: 'all' } });
    const first = moduleManifest('a-v5-atomic');
    const conflict = moduleManifest('z-v5-existing');
    await modules.installModuleFromManifest(owner, conflict, { source: 'sideloaded' });
    const artifacts = await Promise.all([first, conflict].map((manifest) =>
      kit.prepareModuleArtifact({ path: `modules/${manifest.slug}/deft.module.json`, manifest })));
    const manifest = { ...v5Manifest(`community.example.v5-atomic.a${suffix}`),
      modules: artifacts.map((artifact, index) => ({ module_id: [first, conflict][index]!.id,
        version: '1.0.0', manifest_path: artifact.path, manifest_digest: artifact.digest })) };
    const pkg = await kit.buildDeftAppPackage({ manifest, artifacts });
    const staged = await apps.stageAppPackage(owner, pkg.json);
    const [version] = await db.select().from(schema.appVersions).where(eq(schema.appVersions.id, staged.version_id));
    assert.ok(version?.requested_grant_snapshot_id);
    const [requested] = await db.select().from(schema.appGrantSnapshots).where(eq(
      schema.appGrantSnapshots.id, version.requested_grant_snapshot_id));
    assert.ok(requested);
    const input = { app_version_id: version.id, expected_package_digest: version.package_digest,
      expected_requested_snapshot_digest: requested.snapshot_digest,
      expected_lifecycle_epoch: staged.lifecycle_epoch, expected_grant_epoch: staged.grant_epoch };
    const prepared = await review.prepareRuntimeAppReview(owner, staged.id, input);
    await assert.rejects(review.activateRuntimeApp(owner, staged.id, {
      ...input, expected_review_digest: prepared.review_digest, accept_host_policy: true }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'MODULE_ALREADY_INSTALLED');
    assert.deepEqual(await db.select().from(schema.appModuleBindings).where(eq(
      schema.appModuleBindings.app_installation_id, staged.id)), []);
    assert.deepEqual(await db.select().from(schema.appGrantSnapshots).where(and(
      eq(schema.appGrantSnapshots.app_installation_id, staged.id),
      eq(schema.appGrantSnapshots.snapshot_kind, 'effective'))), []);
    const [after] = await db.select().from(schema.appInstallations).where(eq(schema.appInstallations.id, staged.id));
    assert.equal(after?.state, 'staged');
    assert.equal(after?.active_version_id, null);
    assert.equal(after?.lifecycle_epoch, staged.lifecycle_epoch);
    assert.equal(after?.grant_epoch, staged.grant_epoch);
    const installed = await db.select().from(schema.moduleInstallations).where(eq(schema.moduleInstallations.org_id, orgId));
    assert.equal(installed.length, 1);
    assert.equal(installed[0]?.module_id, conflict.id);
  } finally { /* shared pool closes after both cases */ }
});
