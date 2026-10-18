import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = target === process.env.DATABASE_URL && target !== undefined
  && new URL(target).hostname === '127.0.0.1'
  && new URL(target).port === '55435'
  && /^\/gate_g_phase5_test_c03(?:b)?_(?:review|root)(?:_v[0-9]+)?$/.test(new URL(target).pathname);

test('v3 review is tenant- and epoch-bound and reactivation requires a fresh grant', { skip: !safe }, async () => {
  const [{ db, closeDb }, schema, kit, appService, reviewService, management,
    moduleService, authority] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('@deft/app-kit'),
    import('../src/lib/app-service.js'), import('../src/lib/app-runtime-review.js'),
    import('../src/lib/app-runtime-management.js'), import('../src/lib/module-service.js'),
    import('../src/lib/app-runtime-authority.js'),
  ]);
  const { and, eq } = await import('drizzle-orm');
  try {
    const suffix = randomUUID();
    const orgId = randomUUID();
    const foreignOrgId = randomUUID();
    const ownerId = randomUUID();
    const ordinaryId = randomUUID();
    const foreignOwnerId = randomUUID();
    await db.insert(schema.orgs).values([
      { id: orgId, name: 'Runtime review fixture', slug: `review-${suffix}` },
      { id: foreignOrgId, name: 'Foreign review fixture', slug: `foreign-review-${suffix}` },
    ]);
    await db.insert(schema.users).values([
      { id: ownerId, name: 'Owner', email: `owner-review-${suffix}@example.test` },
      { id: ordinaryId, name: 'Member', email: `member-review-${suffix}@example.test` },
      { id: foreignOwnerId, name: 'Foreign owner', email: `foreign-review-${suffix}@example.test` },
    ]);
    await db.insert(schema.orgMembers).values([
      { id: randomUUID(), org_id: orgId, user_id: ownerId, role: 'owner', is_active: true },
      { id: randomUUID(), org_id: orgId, user_id: ordinaryId, role: 'member', is_active: true },
      { id: randomUUID(), org_id: foreignOrgId, user_id: foreignOwnerId, role: 'owner', is_active: true },
    ]);
    const owner = moduleService.humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'ui' });
    const spoofedOwner = moduleService.humanModuleActor({ orgId, userId: ordinaryId, role: 'owner', source: 'ui' });
    const foreignOwner = moduleService.humanModuleActor({ orgId: foreignOrgId,
      userId: foreignOwnerId, role: 'owner', source: 'ui' });
    const object = { type: 'object' as const, properties: { shipment_id: { type: 'string' as const, maxLength: 120 } },
      required: ['shipment_id'], additionalProperties: false as const };
    const pkg = await kit.buildDeftAppPackage({ manifest: {
      schema_version: '3', id: `community.example.review.a${suffix.replace(/-/g, '')}`,
      version: '1.0.0', name: 'Runtime review fixture', license: 'AGPL-3.0-only',
      compatibility: { app_protocol: '3' }, modules: [], navigation: [],
      runtime_requirements: [{ key: 'carrier', protocol_version: 'deft.app_runtime_channel.v1' }],
      private_capabilities: [{ key: 'label', version: '1', input_schema: object, output_schema: object }],
      runtime_actions: [{ key: 'create_label', label: 'Create label',
        capability_key: 'label', runtime_requirement_key: 'carrier' }],
    }, artifacts: [] });
    const staged = await appService.stageAppPackage(owner, pkg.json);
    const [version] = await db.select().from(schema.appVersions).where(and(
      eq(schema.appVersions.org_id, orgId), eq(schema.appVersions.id, staged.version_id)));
    assert.ok(version?.requested_grant_snapshot_id);
    const [requested] = await db.select().from(schema.appGrantSnapshots).where(and(
      eq(schema.appGrantSnapshots.org_id, orgId),
      eq(schema.appGrantSnapshots.id, version.requested_grant_snapshot_id)));
    assert.ok(requested);
    const request = { app_version_id: version.id, expected_package_digest: version.package_digest,
      expected_requested_snapshot_digest: requested.snapshot_digest,
      expected_lifecycle_epoch: staged.lifecycle_epoch, expected_grant_epoch: staged.grant_epoch };
    await assert.rejects(reviewService.prepareRuntimeAppReview(spoofedOwner, staged.id, request));
    await assert.rejects(reviewService.prepareRuntimeAppReview(foreignOwner, staged.id, request));
    await assert.rejects(reviewService.prepareRuntimeAppReview(owner, staged.id, {
      ...request, expected_requested_snapshot_digest: `sha256:${'0'.repeat(64)}`,
    }));
    await assert.rejects(management.prepareRuntimeBindingReview(owner, {
      installation_id: staged.id, action_key: 'create_label', operator_user_id: ownerId,
      expected_app_version_id: version.id, expected_package_digest: version.package_digest,
      expected_grant_snapshot_digest: requested.snapshot_digest,
      expected_lifecycle_epoch: staged.lifecycle_epoch, expected_grant_epoch: staged.grant_epoch,
    }));
    const review = await reviewService.prepareRuntimeAppReview(owner, staged.id, request);
    const active = await reviewService.activateRuntimeApp(owner, staged.id, {
      ...request, expected_review_digest: review.review_digest, accept_host_policy: true,
    });
    assert.equal(active.installation.state, 'active');
    assert.ok(active.grant_snapshot_id);
    const [grant] = await db.select().from(schema.appGrantSnapshots).where(and(
      eq(schema.appGrantSnapshots.org_id, orgId),
      eq(schema.appGrantSnapshots.id, active.grant_snapshot_id)));
    assert.ok(grant);
    const bindRequest = { installation_id: staged.id, action_key: 'create_label',
      operator_user_id: ownerId, expected_app_version_id: version.id,
      expected_package_digest: version.package_digest,
      expected_grant_snapshot_digest: grant.snapshot_digest,
      expected_lifecycle_epoch: active.installation.lifecycle_epoch,
      expected_grant_epoch: active.installation.grant_epoch };
    const bindReview = await management.prepareRuntimeBindingReview(owner, bindRequest);
    const oldBinding = await management.activateRuntimeBinding(owner, {
      ...bindRequest, expected_review_digest: bindReview.review_digest, accept_host_policy: true,
    });
    const disabled = await appService.disableAppInstallation(owner, staged.id,
      active.installation.lifecycle_epoch);
    assert.equal(disabled.state, 'disabled');
    await assert.rejects(reviewService.activateRuntimeApp(owner, staged.id, {
      ...request, expected_review_digest: review.review_digest, accept_host_policy: true,
    }));
    const freshRequest = { ...request, expected_lifecycle_epoch: disabled.lifecycle_epoch,
      expected_grant_epoch: disabled.grant_epoch };
    const freshReview = await reviewService.prepareRuntimeAppReview(owner, staged.id, freshRequest);
    assert.notEqual(freshReview.review_digest, review.review_digest);
    const reactivated = await reviewService.activateRuntimeApp(owner, staged.id, {
      ...freshRequest, expected_review_digest: freshReview.review_digest, accept_host_policy: true,
    });
    assert.equal(reactivated.installation.state, 'active');
    assert.notEqual(reactivated.grant_snapshot_id, active.grant_snapshot_id);
    assert.equal(reactivated.installation.active_grant_snapshot_id, reactivated.grant_snapshot_id);
    assert.equal(await authority.issueAppRuntimeSession({ org_id: orgId,
      runtime_binding_id: oldBinding.binding_id, operator_user_id: ownerId }), null);
    const [newGrant] = await db.select().from(schema.appGrantSnapshots).where(and(
      eq(schema.appGrantSnapshots.org_id, orgId),
      eq(schema.appGrantSnapshots.id, reactivated.grant_snapshot_id)));
    assert.ok(newGrant);
    const newBindRequest = { ...bindRequest,
      expected_grant_snapshot_digest: newGrant.snapshot_digest,
      expected_lifecycle_epoch: reactivated.installation.lifecycle_epoch,
      expected_grant_epoch: reactivated.installation.grant_epoch };
    const newBindReview = await management.prepareRuntimeBindingReview(owner, newBindRequest);
    const newBinding = await management.activateRuntimeBinding(owner, {
      ...newBindRequest, expected_review_digest: newBindReview.review_digest, accept_host_policy: true,
    });
    assert.notEqual(newBinding.binding_id, oldBinding.binding_id);
    assert.ok(await authority.issueAppRuntimeSession({ org_id: orgId,
      runtime_binding_id: newBinding.binding_id, operator_user_id: ownerId }));
  } finally {
    await closeDb();
  }
});
