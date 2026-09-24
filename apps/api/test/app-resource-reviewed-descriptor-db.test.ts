import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const databaseUrl = process.env.DEFT_TEST_DATABASE_URL;
const assigned = databaseUrl === process.env.DATABASE_URL && databaseUrl !== undefined
  && databaseUrl === 'postgresql://gate_g_test@127.0.0.1:55435/gate_g_phase5_test_s05_resource_reader';

test('reviewed resource reader reconstructs current v5 grants and rejects stale or foreign lineage', {
  skip: !assigned,
}, async () => {
  process.env.DEFT_APPS_ENABLED = 'true';
  const [{ db, closeDb }, schema, kit, apps, reviews, modules, resources, drizzle, grants] =
    await Promise.all([import('../src/lib/db.js'), import('@deft/db/schema'),
      import('@deft/app-kit'), import('../src/lib/app-service.js'),
      import('../src/lib/app-runtime-review.js'), import('../src/lib/module-service.js'),
      import('../src/lib/app-resource-sync-reviewed.js'), import('drizzle-orm'),
      import('../src/lib/app-grant-service.js')]);
  const { and, eq, sql } = drizzle;
  const orgId = randomUUID();
  const ownerId = randomUUID();
  try {
    await db.insert(schema.orgs).values({ id: orgId, name: 'Resource grant reader',
      slug: `resource-reader-${orgId}` });
    await db.insert(schema.users).values({ id: ownerId,
      name: 'Synthetic owner', email: `resource-reader-${ownerId}@example.test` });
    await db.insert(schema.orgMembers).values({ id: randomUUID(), org_id: orgId,
      user_id: ownerId, role: 'owner', is_active: true });
    const owner = modules.humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'ui' });
    const artifact = await kit.buildDeftAppPackage({ manifest: {
      schema_version: '5', id: `community.example.reader.app${orgId.replaceAll('-', '')}`,
      version: '1.0.0', name: 'Private resources', license: 'AGPL-3.0-only',
      compatibility: { app_protocol: '5' }, modules: [], navigation: [],
      runtime_requirements: [{ key: 'provider', protocol_version: 'deft.app_runtime_channel.v2' },
        { key: 'actions', protocol_version: 'deft.app_runtime_channel.v1' }],
      private_capabilities: [{ key: 'archive', version: '1',
        input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        output_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
      runtime_actions: [{ key: 'archive_message', label: 'Archive', capability_key: 'archive',
        runtime_requirement_key: 'actions' }], experiences: [], public_actions: [],
      sync_descriptors: [{ schema_version: 'deft.app_sync_descriptor.v1', key: 'inbox',
        runtime_requirement_key: 'provider', resource_type: 'message',
        requested_visibility: 'user_private', label_field: 'subject',
        record_schema: { type: 'object', properties: {
          subject: { type: 'string', maxLength: 120 },
        }, required: ['subject'], additionalProperties: false } }],
    }, artifacts: [] });
    const staged = await apps.stageAppPackage(owner, artifact.json);
    const [version] = await db.select().from(schema.appVersions).where(and(
      eq(schema.appVersions.org_id, orgId), eq(schema.appVersions.id, staged.version_id)));
    assert.ok(version?.requested_grant_snapshot_id);
    const [requested] = await db.select().from(schema.appGrantSnapshots).where(and(
      eq(schema.appGrantSnapshots.org_id, orgId),
      eq(schema.appGrantSnapshots.id, version.requested_grant_snapshot_id)));
    assert.ok(requested);
    const stale = (error: unknown) => (error as { code?: string }).code === 'APP_STALE';
    const read = (organization = orgId, key = 'inbox') => db.transaction((tx) =>
      resources.loadReviewedResourceSyncDescriptor(tx, organization, staged.id, key));
    await assert.rejects(read(), stale, 'a staged package has no effective authority');
    const request = { app_version_id: version.id, expected_package_digest: version.package_digest,
      expected_requested_snapshot_digest: requested.snapshot_digest,
      expected_lifecycle_epoch: staged.lifecycle_epoch, expected_grant_epoch: staged.grant_epoch };
    const review = await reviews.prepareRuntimeAppReview(owner, staged.id, request);
    const activated = await reviews.activateRuntimeApp(owner, staged.id, { ...request,
      expected_review_digest: review.review_digest, accept_host_policy: true });
    const current = await read();
    assert.equal(current.grant.id, activated.grant_snapshot_id);
    assert.equal(current.descriptor.key, 'inbox');
    assert.equal(current.descriptor.requested_visibility, 'user_private');
    assert.match(current.descriptor_digest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(current.grant.resource_rights, [], 'App review confers no resource read right');
    // These forged snapshots satisfy SQL shape checks, so force deferred
    // constraints before proving the host reconstructs the complete grant.
    for (const field of ['sync_descriptors', 'runtime_actions'] as const) {
      const rollback = new Error(`rollback forged ${field}`);
      await assert.rejects(db.transaction(async (tx) => {
        const canonical = structuredClone(current.grant.canonical_snapshot);
        const items = canonical[field] as Array<Record<string, unknown>>;
        if (field === 'sync_descriptors') items[0]!.descriptor_digest = `sha256:${'0'.repeat(64)}`;
        else items[0]!.operation_name = 'forged_operation';
        const forgedId = randomUUID();
        await tx.insert(schema.appGrantSnapshots).values({ ...current.grant, id: forgedId,
          supersedes_snapshot_id: current.grant.id, canonical_snapshot: canonical,
          snapshot_digest: grants.digestAppGrantValue(canonical) });
        await tx.update(schema.appInstallations).set({ active_grant_snapshot_id: forgedId,
          grant_epoch: sql`${schema.appInstallations.grant_epoch} + 1` }).where(and(
          eq(schema.appInstallations.org_id, orgId), eq(schema.appInstallations.id, staged.id)));
        await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
        await assert.rejects(resources.loadReviewedResourceSyncDescriptor(tx, orgId,
          staged.id, 'inbox'), stale);
        throw rollback;
      }), (error) => error === rollback);
    }
    await assert.rejects(read(randomUUID()), stale);
    await assert.rejects(read(orgId, 'undeclared'), stale);
    const disabled = await apps.disableAppInstallation(owner, staged.id,
      activated.installation.lifecycle_epoch);
    await assert.rejects(read(), stale);
    const renewedRequest = { ...request, expected_lifecycle_epoch: disabled.lifecycle_epoch,
      expected_grant_epoch: disabled.grant_epoch };
    const renewedReview = await reviews.prepareRuntimeAppReview(owner, staged.id, renewedRequest);
    const renewed = await reviews.activateRuntimeApp(owner, staged.id, { ...renewedRequest,
      expected_review_digest: renewedReview.review_digest, accept_host_policy: true });
    assert.notEqual(renewed.grant_snapshot_id, activated.grant_snapshot_id);
    assert.equal((await read()).grant.id, renewed.grant_snapshot_id);
    assert.deepEqual(await db.select({ id: schema.appResourceBindings.id })
      .from(schema.appResourceBindings).where(eq(schema.appResourceBindings.org_id, orgId)), [],
    'descriptor review and resolution never create resource consent');
  } finally { await closeDb(); }
});
