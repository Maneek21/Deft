import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { runtimeV3PackageJson } from './fixtures/runtime-v3-package.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = target === process.env.DATABASE_URL && target !== undefined
  && new URL(target).hostname === '127.0.0.1'
  && new URL(target).port === '55435'
  && /^\/gate_g_phase5_test_c03(?:b)?_(?:public|root)(?:_v[0-9]+)?$/.test(new URL(target).pathname);

test('packed Runtime Kit follows reviewed human Run, approval, claim, result, and signed receipt', {
  skip: !safe,
}, async (t) => {
  process.env.DEFT_APPS_ENABLED = 'true';
  process.env.DEFT_APP_RUNS_ENABLED = 'true';
  process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
  process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
  const key = (purpose: string) => createHash('sha256')
    .update(`runtime-action-journey:${purpose}`).digest('base64');
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({
    schema_version: 'deft.app_run_keyring.v1',
    run_encryption: { current: 'enc-v1', keys: { 'enc-v1': key('encryption') } },
    receipt_signing: { current: 'sig-v1', keys: { 'sig-v1': key('signing') } },
    fingerprint: { current: 'fp-v1', keys: { 'fp-v1': key('fingerprint') } },
  });
  const [{ db, closeDb }, schema, appService, appReview, management, moduleService,
    actionModule, runModule, keyringFixture, lockHelper] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'),
    import('../src/lib/app-service.js'), import('../src/lib/app-runtime-review.js'),
    import('../src/lib/app-runtime-management.js'), import('../src/lib/module-service.js'),
    import('../src/lib/app-runtime-action-service.js'), import('../src/lib/app-run-runtime.js'),
    import('./fixtures/app-run-test-keyrings.js'),
    import('./fixtures/app-runtime-review-lock.js'),
  ]);
  const { and, eq } = await import('drizzle-orm');
  let runtime: Awaited<ReturnType<typeof runModule.getAppRunRuntime>> | undefined;
  try {
    const ring = await keyringFixture.databaseCompleteAppRunTestKeyringFixture('runtime-action-journey');
    process.env.DEFT_APP_RUN_KEYRINGS = ring.environment;
    ring.keys.destroy();
    const suffix = randomUUID();
    const orgId = randomUUID();
    const ownerId = randomUUID();
    await db.insert(schema.orgs).values({ id: orgId, name: 'Runtime action journey', slug: `runtime-action-${suffix}` });
    await db.insert(schema.users).values({ id: ownerId, email: `runtime-action-${suffix}@example.test`, name: 'Runtime owner' });
    await db.insert(schema.orgMembers).values({ id: randomUUID(), org_id: orgId,
      user_id: ownerId, role: 'owner', is_active: true });
    const owner = moduleService.humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'ui' });
    const packageJson = await runtimeV3PackageJson();
    const staged = await appService.stageAppPackage(owner, packageJson);
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
      expected_lifecycle_epoch: staged.lifecycle_epoch, expected_grant_epoch: staged.grant_epoch };
    const review = await appReview.prepareRuntimeAppReview(owner, staged.id, reviewInput);
    const active = await appReview.activateRuntimeApp(owner, staged.id, {
      ...reviewInput, expected_review_digest: review.review_digest, accept_host_policy: true,
    });
    const [grant] = await db.select().from(schema.appGrantSnapshots).where(and(
      eq(schema.appGrantSnapshots.org_id, orgId),
      eq(schema.appGrantSnapshots.id, active.grant_snapshot_id)));
    assert.ok(grant);
    const bindInput = { installation_id: staged.id, action_key: 'create_shipping_label',
      operator_user_id: ownerId, expected_app_version_id: version.id,
      expected_package_digest: version.package_digest,
      expected_grant_snapshot_digest: grant.snapshot_digest,
      expected_lifecycle_epoch: active.installation.lifecycle_epoch,
      expected_grant_epoch: active.installation.grant_epoch };
    const bindingReview = await management.prepareRuntimeBindingReview(owner, bindInput);
    const binding = await management.activateRuntimeBinding(owner, {
      ...bindInput, expected_review_digest: bindingReview.review_digest, accept_host_policy: true,
    });
    runtime = await runModule.getAppRunRuntime();
    const actions = new actionModule.AppRuntimeActionService(runtime.service);
    const caller = { org_id: orgId, user_id: ownerId };
    const request = { runtime_binding_id: binding.binding_id,
      idempotency_key: `shipping:${suffix}`, input: { shipment_id: 'synthetic-shipment-1' } };
    await assert.rejects(actions.invoke(caller, { ...request, input: { shipment_id: 'x', admin: true } }));
    assert.throws(() => actions.invoke(caller, { ...request, policy: { review_requirement: 'never' } }));
    assert.throws(() => actions.invoke(caller, { ...request, initiating_actor: { actor_type: 'human', user_id: ownerId } }));
    await assert.rejects(actions.invoke({ org_id: randomUUID(), user_id: ownerId }, request));
    const [before] = await db.select().from(schema.appRuns).where(eq(schema.appRuns.org_id, orgId));
    assert.equal(before, undefined, 'invalid and foreign requests never write a Run');
    const run = await actions.invoke(caller, request);
    assert.equal(run.state, 'pending_approval');
    assert.equal(run.provider_kind, 'app_runtime');
    await t.test('pending input review does not hold App lock while waiting on approval-held Run',
      async () => lockHelper.assertRuntimeInputReviewLockOrder({ org_id: orgId, run_id: run.id,
        installation_id: staged.id, review: () => runtime!.service.reviewRuntimeInput(caller, run.id) }));
    assert.equal((await actions.invoke(caller, request)).id, run.id);
    await assert.rejects(actions.invoke(caller, { ...request, input: { shipment_id: 'different' } }),
      (error: unknown) => (error as { code?: string }).code === 'APP_RUN_IDEMPOTENCY_CONFLICT');
    const [approval] = await db.select().from(schema.agentActions).where(and(
      eq(schema.agentActions.org_id, orgId), eq(schema.agentActions.app_run_id, run.id)));
    assert.ok(approval);
    assert.equal(approval.approval_status, 'pending');
    assert.equal((await runtime.approvalResolver.approve(approval.id, ownerId)).status, 'approved');
    const session = await management.issueRuntimeOperatorSession(owner, binding.binding_id);
    const claimed = await runtime.runtimeChannel.claim({ schema_version: 'deft.app_runtime_channel.v1',
      session_id: session.session_id, session_token: session.session_token, max_claims: 1 });
    assert.ok(claimed);
    assert.equal(claimed.run_id, run.id);
    const channelRequest = { schema_version: 'deft.app_runtime_channel.v1',
      session_id: session.session_id, session_token: session.session_token,
      run_id: run.id, attempt_id: claimed.attempt_id,
      claim_token: claimed.claim_token, sequence: claimed.sequence };
    const started = await runtime.runtimeChannel.start(channelRequest);
    assert.ok(started);
    assert.deepEqual(started.input, { shipment_id: 'synthetic-shipment-1' });
    const resultRequest = { ...channelRequest, status: 'returned',
      provider_succeeded: true, output: { label_id: 'synthetic-label-1' } };
    const result = await runtime.runtimeChannel.complete(resultRequest);
    assert.equal(result?.state, 'succeeded');
    assert.equal((await runtime.runtimeChannel.complete(resultRequest))?.id, run.id);
    const receipts = await runtime.receiptReader.readVerified(orgId, run.id);
    assert.ok(receipts.some((receipt) => receipt.receipt_kind === 'attempt_terminal' && receipt.verified));
    assert.deepEqual((await runtime.service.result(orgId, run.id,
      { actor_type: 'human', user_id: ownerId }, null)).value,
    { schema_version: 'deft.app_run_provider_result.v1', provider_succeeded: true,
      output: { label_id: 'synthetic-label-1' } });
    await management.revokeRuntimeBinding(owner, binding.binding_id);
    await assert.rejects(actions.invoke(caller, { ...request, idempotency_key: `after-revoke:${suffix}` }),
      (error: unknown) => (error as { code?: string }).code === 'APP_RUN_AUTHORIZATION_STALE');
    const rows = await db.select({ id: schema.appRuns.id }).from(schema.appRuns).where(
      eq(schema.appRuns.org_id, orgId));
    assert.deepEqual(rows.map((row) => row.id), [run.id], 'revoked binding adds no Run');
  } finally {
    await runModule.shutdownAppRunRuntime();
    await closeDb();
  }
});
