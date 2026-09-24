import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = target === process.env.DATABASE_URL && target !== undefined
  && new URL(target).hostname === '127.0.0.1'
  && new URL(target).port === '55435'
  && /^\/gate_g_phase5_test_c03(?:_b_experience|_root(?:_v[0-9]+)?|b_root(?:_v[0-9]+)?)$/.test(new URL(target).pathname);

test('installed Experience session pins human web SID, App, grant and bounded active count',
  { skip: !safe }, async () => {
    process.env.DEFT_APPS_ENABLED = 'true';
    process.env.DEFT_APP_RUNS_ENABLED = 'true';
    process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
    process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
    const key = (purpose: string) => createHash('sha256').update(`experience-db:${purpose}`).digest('base64');
    process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({
      schema_version: 'deft.app_run_keyring.v1',
      run_encryption: { current: 'enc-v1', keys: { 'enc-v1': key('enc') } },
      receipt_signing: { current: 'sig-v1', keys: { 'sig-v1': key('sig') } },
      fingerprint: { current: 'fp-v1', keys: { 'fp-v1': key('fp') } },
    });
    const [{ db, closeDb }, schema, kit, appService, reviewService,
      moduleService, experience, management, keyringFixture, runtimeAction, runRuntime] = await Promise.all([
      import('../src/lib/db.js'), import('@deft/db/schema'), import('@deft/app-kit'),
      import('../src/lib/app-service.js'), import('../src/lib/app-runtime-review.js'),
      import('../src/lib/module-service.js'), import('../src/lib/app-experience-service.js'),
      import('../src/lib/app-runtime-management.js'), import('./fixtures/app-run-test-keyrings.js'),
      import('../src/lib/app-runtime-action-service.js'), import('../src/lib/app-run-runtime.js'),
    ]);
    const { and, eq } = await import('drizzle-orm');
    try {
      const ring = await keyringFixture.databaseCompleteAppRunTestKeyringFixture('experience-db');
      process.env.DEFT_APP_RUN_KEYRINGS = ring.environment;
      ring.keys.destroy();
      const suffix = randomUUID().replaceAll('-', '');
      const orgId = randomUUID();
      const otherOrgId = randomUUID();
      const ownerId = randomUUID();
      const otherId = randomUUID();
      const agentId = randomUUID();
      const sid = randomUUID();
      const nextSid = randomUUID();
      await db.insert(schema.orgs).values([
        { id: orgId, name: 'Experience test', slug: `experience-${suffix}` },
        { id: otherOrgId, name: 'Other Experience test', slug: `other-experience-${suffix}` },
      ]);
      await db.insert(schema.users).values([
        { id: ownerId, name: 'Owner', email: `experience-owner-${suffix}@example.test` },
        { id: otherId, name: 'Other', email: `experience-other-${suffix}@example.test` },
        { id: agentId, kind: 'agent', name: 'Agent', email: `experience-agent-${suffix}@example.test` },
      ]);
      await db.insert(schema.orgMembers).values([
        { id: randomUUID(), org_id: orgId, user_id: ownerId, role: 'owner', is_active: true },
        { id: randomUUID(), org_id: otherOrgId, user_id: otherId, role: 'owner', is_active: true },
        { id: randomUUID(), org_id: orgId, user_id: agentId, role: 'member', is_active: true },
      ]);
      const expiry = new Date(Date.now() + 86_400_000);
      await db.insert(schema.webSessions).values([
        { id: sid, org_id: orgId, user_id: ownerId, refresh_token_hash: 'fixture', expires_at: expiry },
        { id: nextSid, org_id: orgId, user_id: ownerId, refresh_token_hash: 'fixture-next', expires_at: expiry },
        { id: randomUUID(), org_id: orgId, user_id: agentId, refresh_token_hash: 'fixture-agent', expires_at: expiry },
      ]);
      const owner = moduleService.humanModuleActor({ orgId, userId: ownerId, role: 'owner', source: 'rest' });
      const object = { type: 'object' as const,
        properties: { shipment_id: { type: 'string' as const, maxLength: 120 } },
        required: ['shipment_id'], additionalProperties: false as const };
      const artifact = await kit.prepareDeftExperienceArtifact('experiences/main.json', {
        schema_version: 'deft.experience_bundle.v1',
        worker_source: 'self.onmessage = () => {};', entry_view: 'main',
        resource_keys: [], action_keys: ['create_shipping_label'],
      });
      const pkg = await kit.buildDeftAppPackage({ manifest: {
        schema_version: '4', id: `community.example.experience.a${suffix}`,
        version: '1.0.0', name: 'Experience fixture', license: 'AGPL-3.0-only',
        compatibility: { app_protocol: '4' }, modules: [], navigation: [],
        runtime_requirements: [{ key: 'carrier', protocol_version: 'deft.app_runtime_channel.v1' }],
        private_capabilities: [{ key: 'label', version: '1', input_schema: object, output_schema: object }],
        runtime_actions: [{ key: 'create_shipping_label', label: 'Create shipping label',
          capability_key: 'label', runtime_requirement_key: 'carrier' }],
        experiences: [{ key: 'main', label: 'Shipping Label', artifact_path: artifact.path,
          artifact_digest: artifact.digest, bridge_version: 'deft.experience_bridge.v1',
          renderer_version: 'deft.trusted_renderer.v1' }], public_actions: [],
      }, artifacts: [artifact] });
      const staged = await appService.stageAppPackage(owner, pkg.json);
      const [version] = await db.select().from(schema.appVersions).where(and(
        eq(schema.appVersions.org_id, orgId), eq(schema.appVersions.id, staged.version_id)));
      assert.ok(version?.requested_grant_snapshot_id);
      const [requested] = await db.select().from(schema.appGrantSnapshots).where(and(
        eq(schema.appGrantSnapshots.org_id, orgId),
        eq(schema.appGrantSnapshots.id, version.requested_grant_snapshot_id)));
      assert.ok(requested);
      const reviewRequest = { app_version_id: version.id, expected_package_digest: version.package_digest,
        expected_requested_snapshot_digest: requested.snapshot_digest,
        expected_lifecycle_epoch: staged.lifecycle_epoch, expected_grant_epoch: staged.grant_epoch };
      const review = await reviewService.prepareRuntimeAppReview(owner, staged.id, reviewRequest);
      const active = await reviewService.activateRuntimeApp(owner, staged.id, {
        ...reviewRequest, expected_review_digest: review.review_digest, accept_host_policy: true,
      });
      assert.equal(active.installation.state, 'active');
      const [effective] = await db.select().from(schema.appGrantSnapshots).where(and(
        eq(schema.appGrantSnapshots.org_id, orgId),
        eq(schema.appGrantSnapshots.id, active.grant_snapshot_id)));
      assert.ok(effective);
      const bindRequest = { installation_id: staged.id, action_key: 'create_shipping_label',
        operator_user_id: ownerId, expected_app_version_id: version.id,
        expected_package_digest: version.package_digest,
        expected_grant_snapshot_digest: effective.snapshot_digest,
        expected_lifecycle_epoch: active.installation.lifecycle_epoch,
        expected_grant_epoch: active.installation.grant_epoch };
      const bindReview = await management.prepareRuntimeBindingReview(owner, bindRequest);
      const binding = await management.activateRuntimeBinding(owner, {
        ...bindRequest, expected_review_digest: bindReview.review_digest, accept_host_policy: true,
      });
      assert.ok(binding.binding_id);
      const caller = { org_id: orgId, user_id: ownerId, sid };
      const first = await experience.appExperienceService.create(caller, staged.id, 'main');
      assert.equal(first.bundle.worker_source, 'self.onmessage = () => {};');
      assert.equal(first.pin.app_version_id, version.id);
      assert.equal(first.pin.grant_snapshot_id, active.grant_snapshot_id);
      assert.equal((await experience.appExperienceService.live(caller, first.pin.session_id)).live, true);
      await assert.rejects(experience.appExperienceService.live({ ...caller, sid: nextSid }, first.pin.session_id));
      await assert.rejects(experience.appExperienceService.live({ ...caller, user_id: otherId }, first.pin.session_id));
      await assert.rejects(experience.appExperienceService.live({ ...caller, org_id: otherOrgId }, first.pin.session_id));
      await assert.rejects(experience.appExperienceService.create({ org_id: orgId, user_id: agentId,
        sid: (await db.select().from(schema.webSessions).where(eq(schema.webSessions.user_id, agentId)))[0]!.id },
      staged.id, 'main'));
      await assert.rejects(experience.appExperienceService.create(caller, staged.id, 'unknown'));
      const concurrent = await Promise.allSettled(Array.from({ length: 9 }, () =>
        experience.appExperienceService.create(caller, staged.id, 'main')));
      assert.equal(concurrent.filter((item) => item.status === 'fulfilled').length, 7,
        'one existing plus seven parallel sessions reach the cap of eight');
      assert.equal(concurrent.filter((item) => item.status === 'rejected').length, 2);
      const invoked = await experience.appExperienceService.action(caller, first.pin.session_id,
        'create_shipping_label', { request_id: 'request_1', input: { shipment_id: 'shipment-1' } });
      assert.equal(invoked.run.state, 'pending_approval');
      const replay = await experience.appExperienceService.action(caller, first.pin.session_id,
        'create_shipping_label', { request_id: 'request_1', input: { shipment_id: 'shipment-1' } });
      assert.equal(replay.run.id, invoked.run.id);
      await assert.rejects(experience.appExperienceService.action(caller, first.pin.session_id,
        'create_shipping_label', { request_id: 'request_1', input: { shipment_id: 'different' } }));
      const beforeRace = await db.select({ id: schema.appRuns.id }).from(schema.appRuns)
        .where(eq(schema.appRuns.org_id, orgId));
      let signalEntered!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const delayedRuntime = new runtimeAction.AppRuntimeActionService({
        async submitReviewedRuntime(actor, request, guard) {
          signalEntered();
          await barrier;
          return (await runRuntime.getAppRunRuntime()).service.submitReviewedRuntime(actor, request, guard);
        },
        async reviewRuntimeInput(actor, runId) {
          return (await runRuntime.getAppRunRuntime()).service.reviewRuntimeInput(actor, runId);
        },
      });
      const delayedService = new experience.AppExperienceService(delayedRuntime);
      const pending = delayedService.action(caller, first.pin.session_id, 'create_shipping_label',
        { request_id: 'request_2', input: { shipment_id: 'race-shipment' } });
      await entered;
      await db.update(schema.webSessions).set({ revoked_at: new Date() }).where(eq(schema.webSessions.id, sid));
      release();
      await assert.rejects(pending, 'revoked web SID must fail inside the real Run transaction');
      const afterRace = await db.select({ id: schema.appRuns.id }).from(schema.appRuns)
        .where(eq(schema.appRuns.org_id, orgId));
      assert.equal(afterRace.length, beforeRace.length, 'revoked request inserted no Run');
      await assert.rejects(experience.appExperienceService.live(caller, first.pin.session_id));
      const nextCaller = { ...caller, sid: nextSid };
      const afterLogin = await experience.appExperienceService.create(nextCaller, staged.id, 'main');
      await assert.rejects(experience.appExperienceService.live(caller, afterLogin.pin.session_id));
      const disabled = await appService.disableAppInstallation(owner, staged.id,
        active.installation.lifecycle_epoch);
      assert.equal(disabled.state, 'disabled');
      await assert.rejects(experience.appExperienceService.live(nextCaller, afterLogin.pin.session_id));
      await assert.rejects(experience.appExperienceService.create(nextCaller, staged.id, 'main'));
    } finally { await closeDb(); }
  });
