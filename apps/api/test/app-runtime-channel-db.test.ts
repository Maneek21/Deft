import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const databaseUrl = process.env.DEFT_TEST_DATABASE_URL;
const safeDatabase = databaseUrl && databaseUrl === process.env.DATABASE_URL
  && /(?:^|[-_])(test|ci|acceptance|phase\d+)(?:$|[-_])/iu.test(
    new URL(databaseUrl).pathname.slice(1));

test('reviewed v3 Runtime channel preserves fencing, replay, revocation and unknown outcomes', {
  skip: !safeDatabase,
}, async () => {
  process.env.DEFT_APPS_ENABLED = 'true';
  process.env.DEFT_APP_RUNS_ENABLED = 'true';
  process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
  process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
  const key = (purpose: string) => createHash('sha256')
    .update(`runtime-channel-v3:${purpose}`).digest('base64');
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({
    schema_version: 'deft.app_run_keyring.v1',
    run_encryption: { current: 'runtime-channel-enc-v1',
      keys: { 'runtime-channel-enc-v1': key('encryption') } },
    receipt_signing: { current: 'runtime-channel-sig-v1',
      keys: { 'runtime-channel-sig-v1': key('signing') } },
    fingerprint: { current: 'runtime-channel-fp-v1',
      keys: { 'runtime-channel-fp-v1': key('fingerprint') } },
  });
  const [{ db, closeDb }, schema, kit, appService, appReview, management,
    moduleService, actionsModule, runtimeModule, keyFixture, secretModule,
    keyringModule, runnerModule, providerModule, receiptModule] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('@deft/app-kit'),
    import('../src/lib/app-service.js'), import('../src/lib/app-runtime-review.js'),
    import('../src/lib/app-runtime-management.js'), import('../src/lib/module-service.js'),
    import('../src/lib/app-runtime-action-service.js'), import('../src/lib/app-run-runtime.js'),
    import('./fixtures/app-run-test-keyrings.js'), import('../src/lib/app-run-secrets.js'),
    import('../src/lib/app-run-keyrings.js'), import('../src/lib/app-run-attempt-runner.js'),
    import('../src/lib/app-run-provider-executor.js'), import('../src/lib/app-run-receipts.js'),
  ]);
  const { and, eq, sql } = await import('drizzle-orm');
  const ring = await keyFixture.databaseCompleteAppRunTestKeyringFixture('runtime-channel-v3');
  const combined = JSON.parse(ring.environment);
  const own = JSON.parse(process.env.DEFT_APP_RUN_KEYRINGS!);
  for (const purpose of ['run_encryption', 'receipt_signing', 'fingerprint']) {
    combined[purpose].current = own[purpose].current;
    Object.assign(combined[purpose].keys, own[purpose].keys);
  }
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify(combined);
  ring.keys.destroy();
  let runtime: Awaited<ReturnType<typeof runtimeModule.getAppRunRuntime>> | undefined;
  try {
    const suffix = randomUUID();
    const orgId = randomUUID();
    const userId = randomUUID();
    await db.insert(schema.orgs).values({ id: orgId, name: 'Runtime channel v3',
      slug: `runtime-channel-${suffix}` });
    await db.insert(schema.users).values({ id: userId,
      email: `runtime-channel-${suffix}@example.test`, name: 'Runtime owner' });
    const [member] = await db.insert(schema.orgMembers).values({ id: randomUUID(),
      org_id: orgId, user_id: userId, role: 'owner', is_active: true }).returning();
    assert.ok(member);
    const owner = moduleService.humanModuleActor({ orgId, userId, role: 'owner', source: 'ui' });
    const packageJson = (await kit.buildDeftAppPackage({ manifest: {
      schema_version: '3', id: `community.example.runtime.app${suffix.replace(/-/g, '')}`,
      version: '1.0.0', name: 'Runtime channel', license: 'AGPL-3.0-only',
      compatibility: { app_protocol: '3' }, modules: [], navigation: [],
      runtime_requirements: [{ key: 'provider', protocol_version: 'deft.app_runtime_channel.v1' }],
      private_capabilities: [{ key: 'deliver', version: '1',
        input_schema: { type: 'object', properties: { item_id: { type: 'string', maxLength: 120 } },
          required: ['item_id'], additionalProperties: false },
        output_schema: { type: 'object', properties: { receipt_id: { type: 'string', maxLength: 120 } },
          required: ['receipt_id'], additionalProperties: false } }],
      runtime_actions: [{ key: 'deliver', label: 'Deliver', capability_key: 'deliver',
        runtime_requirement_key: 'provider' }],
    }, artifacts: [] })).json;
    const staged = await appService.stageAppPackage(owner, packageJson);
    const [version] = await db.select().from(schema.appVersions).where(and(
      eq(schema.appVersions.org_id, orgId), eq(schema.appVersions.id, staged.version_id)));
    assert.ok(version?.requested_grant_snapshot_id);
    const [requested] = await db.select().from(schema.appGrantSnapshots).where(and(
      eq(schema.appGrantSnapshots.org_id, orgId),
      eq(schema.appGrantSnapshots.id, version.requested_grant_snapshot_id)));
    assert.ok(requested);
    const appReviewInput = { app_version_id: version.id,
      expected_package_digest: version.package_digest,
      expected_requested_snapshot_digest: requested.snapshot_digest,
      expected_lifecycle_epoch: staged.lifecycle_epoch, expected_grant_epoch: staged.grant_epoch };
    const appReviewValue = await appReview.prepareRuntimeAppReview(owner, staged.id, appReviewInput);
    const active = await appReview.activateRuntimeApp(owner, staged.id, { ...appReviewInput,
      expected_review_digest: appReviewValue.review_digest, accept_host_policy: true });
    const [grant] = await db.select().from(schema.appGrantSnapshots).where(and(
      eq(schema.appGrantSnapshots.org_id, orgId), eq(schema.appGrantSnapshots.id, active.grant_snapshot_id)));
    assert.ok(grant);
    const bindInput = { installation_id: staged.id, action_key: 'deliver',
      operator_user_id: userId, expected_app_version_id: version.id,
      expected_package_digest: version.package_digest,
      expected_grant_snapshot_digest: grant.snapshot_digest,
      expected_lifecycle_epoch: active.installation.lifecycle_epoch,
      expected_grant_epoch: active.installation.grant_epoch };
    const bindingReview = await management.prepareRuntimeBindingReview(owner, bindInput);
    const binding = await management.activateRuntimeBinding(owner, { ...bindInput,
      expected_review_digest: bindingReview.review_digest, accept_host_policy: true });
    const secondOwnerId = randomUUID();
    await db.insert(schema.users).values({ id: secondOwnerId,
      email: `runtime-owner2-${suffix}@example.test`, name: 'Second owner' });
    await db.insert(schema.orgMembers).values({ id: randomUUID(), org_id: orgId,
      user_id: secondOwnerId, role: 'owner', is_active: true });
    const secondOwner = moduleService.humanModuleActor({ orgId, userId: secondOwnerId,
      role: 'owner', source: 'ui' });
    const reciprocalReviews = await Promise.all([
      management.prepareRuntimeBindingReview(owner,
        { ...bindInput, operator_user_id: secondOwnerId }),
      management.prepareRuntimeBindingReview(secondOwner,
        { ...bindInput, operator_user_id: userId }),
    ]);
    assert.equal(reciprocalReviews.length, 2,
      'reciprocal reviewer/operator locks must serialize without deadlock');
    const otherUserId = randomUUID();
    await db.insert(schema.users).values({ id: otherUserId,
      email: `runtime-other-${suffix}@example.test`, name: 'Other member' });
    await db.insert(schema.orgMembers).values({ id: randomUUID(), org_id: orgId,
      user_id: otherUserId, role: 'member', is_active: true });
    const otherMember = moduleService.humanModuleActor({ orgId, userId: otherUserId,
      role: 'member', source: 'ui' });
    await assert.rejects(management.prepareRuntimeBindingReview(otherMember, bindInput),
      (error: unknown) => (error as { code?: string }).code === 'APP_ACCESS_DENIED');
    await assert.rejects(management.issueRuntimeOperatorSession(otherMember, binding.binding_id),
      (error: unknown) => (error as { code?: string }).code === 'APP_ACCESS_DENIED');
    process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'false';
    await assert.rejects(management.issueRuntimeOperatorSession(owner, binding.binding_id),
      (error: unknown) => (error as { code?: string }).code === 'APP_FEATURE_DISABLED');
    process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
    runtime = await runtimeModule.getAppRunRuntime();
    const actions = new actionsModule.AppRuntimeActionService(runtime.service);
    const channel = runtime.runtimeChannel;
    const session = await management.issueRuntimeOperatorSession(owner, binding.binding_id);
    assert.ok(session);
    let runNumber = 0;
    async function approvedRun() {
      const itemId = `item-${++runNumber}`;
      const run = await actions.invoke({ org_id: orgId, user_id: userId }, {
        runtime_binding_id: binding.binding_id,
        idempotency_key: `runtime-channel-v3:${suffix}:${itemId}`,
        input: { item_id: itemId },
      });
      assert.equal(run.state, 'pending_approval');
      const [approval] = await db.select().from(schema.agentActions).where(and(
        eq(schema.agentActions.org_id, orgId), eq(schema.agentActions.app_run_id, run.id)));
      assert.ok(approval);
      assert.equal((await runtime!.approvalResolver.approve(approval.id, userId)).status, 'approved');
      return { run, input: { item_id: itemId } };
    }
    async function claimFor(expectedRunId: string) {
      const claim = await channel.claim({ schema_version: 'deft.app_runtime_channel.v1',
        session_id: session.session_id, session_token: session.session_token, max_claims: 1 });
      assert.ok(claim);
      assert.equal(claim.run_id, expectedRunId);
      return { claim, request: { schema_version: 'deft.app_runtime_channel.v1',
        session_id: session.session_id, session_token: session.session_token,
        run_id: claim.run_id, attempt_id: claim.attempt_id,
        claim_token: claim.claim_token, sequence: claim.sequence } };
    }

    const first = await approvedRun();
    const { claim, request } = await claimFor(first.run.id);
    // A released Run may be rescheduled while its Runtime lease is renewed.
    // A manager's App UPDATE must not complete an App -> Run -> App lock cycle.
    const originalAuthorize = runtime.liveAuthorization.authorizeExecution.bind(runtime.liveAuthorization);
    const originalLockRun = runtime.repository.lockRun.bind(runtime.repository);
    let resumeSchedule!: () => void;
    let scheduleHoldingRun!: () => void;
    let channelAtRun!: () => void;
    const resumeSchedulePromise = new Promise<void>((resolve) => { resumeSchedule = resolve; });
    const scheduleHoldingRunPromise = new Promise<void>((resolve) => { scheduleHoldingRun = resolve; });
    const channelAtRunPromise = new Promise<void>((resolve) => { channelAtRun = resolve; });
    async function awaitLockBoundary(boundary: Promise<void>, name: string) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([boundary, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${name} boundary not reached`)), 5000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    }
    let channelStarting = false;
    let appLockAvailableAtChannelRun = false;
    runtime.liveAuthorization.authorizeExecution = async (params) => {
      if (params.run.id === first.run.id && params.stage === 'prepare') {
        scheduleHoldingRun();
        await resumeSchedulePromise;
      }
      return originalAuthorize(params);
    };
    runtime.repository.lockRun = async (...args) => {
      if (channelStarting && args[2] === first.run.id) {
        try {
          await db.transaction((tx) => tx.execute(sql`SELECT id FROM app_installations
            WHERE org_id = ${orgId} AND id = ${staged.id} FOR UPDATE NOWAIT`));
          appLockAvailableAtChannelRun = true;
        } catch { /* An authority-first channel already holds App SHARE. */ }
        channelAtRun();
      }
      return originalLockRun(...args);
    };
    let scheduling: Promise<string | null> | undefined;
    let heartbeating: Promise<boolean> | undefined;
    try {
      scheduling = runtime.attemptRunner.prepareAttempt(orgId, first.run.id);
      await awaitLockBoundary(scheduleHoldingRunPromise, 'schedule');
      channelStarting = true;
      heartbeating = channel.heartbeat(request);
      await awaitLockBoundary(channelAtRunPromise, 'channel');
      const managerLock = db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '4s'`);
        await tx.execute(sql`SELECT id FROM app_installations WHERE org_id = ${orgId}
          AND id = ${staged.id} FOR UPDATE`);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      resumeSchedule();
      const results = await Promise.allSettled([scheduling, heartbeating, managerLock]);
      assert.equal(appLockAvailableAtChannelRun, true,
        'Runtime channel must reach the Run lock before acquiring App authority');
      assert.ok(results.every((item) => item.status === 'fulfilled'),
        `released Run schedule/Runtime heartbeat/manager App lock must not deadlock: ${
          results.map((item) => item.status === 'rejected' ? String(item.reason) : 'ok').join('; ')}`);
      assert.equal(results[1].status === 'fulfilled' ? results[1].value : false, true);
    } finally {
      resumeSchedule();
      runtime.liveAuthorization.authorizeExecution = originalAuthorize;
      runtime.repository.lockRun = originalLockRun;
      await Promise.allSettled([scheduling, heartbeating]);
    }
    const otherSession = await management.issueRuntimeOperatorSession(owner, binding.binding_id);
    assert.equal(await channel.start({ ...request, session_id: otherSession.session_id,
      session_token: otherSession.session_token }), null);
    const readInput = runtime.secretRepository.readInput.bind(runtime.secretRepository);
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    runtime.secretRepository.readInput = async (...args) => {
      entered(); await releasePromise; return readInput(...args);
    };
    const pendingStart = channel.start(request);
    try {
      await Promise.race([enteredPromise, new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Input release boundary not reached')), 5000))]);
      for (const revoke of ['binding', 'membership']) {
        await assert.rejects(db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
          if (revoke === 'binding') await tx.update(schema.appRuntimeBindings)
            .set({ state: 'revoked' }).where(eq(schema.appRuntimeBindings.id, binding.binding_id));
          else await tx.update(schema.orgMembers).set({ is_active: false })
            .where(eq(schema.orgMembers.id, member.id));
        }), (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === '55P03');
      }
    } finally {
      release(); runtime.secretRepository.readInput = readInput;
    }
    assert.deepEqual((await pendingStart)?.input, first.input);
    assert.equal(await channel.heartbeat(request), true);
    const result = { ...request, status: 'returned' as const,
      provider_succeeded: true, output: { receipt_id: 'effect-1' } };
    assert.equal((await channel.complete(result))?.state, 'succeeded');
    assert.equal((await channel.complete(result))?.state, 'succeeded');
    const rotated = JSON.parse(process.env.DEFT_APP_RUN_KEYRINGS!);
    rotated.fingerprint.current = 'runtime-channel-fp-v2';
    rotated.fingerprint.keys['runtime-channel-fp-v2'] = key('fingerprint-v2');
    const rotatedKeys = keyringModule.parseEnvironmentAppRunKeyrings(JSON.stringify(rotated));
    const rotatedSecrets = new secretModule.AppRunSecretService(rotatedKeys);
    const rotatedRunner = new runnerModule.AppRunAttemptRunner(runtime.repository,
      runtime.secretRepository, rotatedSecrets, new providerModule.PinnedMcpAppRunProviderExecutor(),
      runtime.liveAuthorization, () => new Date(), 60_000, 20_000,
      new receiptModule.PostgresAppRunReceiptWriter(rotatedSecrets, runtime.secretRepository));
    assert.equal((await new (await import('../src/lib/app-runtime-channel.js'))
      .AppRuntimeChannel(rotatedRunner).complete(result))?.state, 'succeeded');
    rotatedKeys.destroy();
    assert.equal((await runtime.receiptReader.readVerified(orgId, first.run.id))
      .filter((row) => row.receipt_kind === 'attempt_terminal').length, 1);
    assert.equal(await channel.complete({ ...result, output: { receipt_id: 'substituted' } }), null);

    const httpRun = await approvedRun();
    const child = fork(fileURLToPath(new URL('./fixtures/app-runtime-http-host.ts', import.meta.url)), {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, DEFT_RUNTIME_HTTP_FIXTURE: 'true' },
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4000); });
    const closed = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Runtime HTTP host startup timed out')), 30_000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Runtime HTTP host exited ${code}: ${stderr}`)); });
        child.once('message', (message) => {
          clearTimeout(timer);
          const value = (message as { port?: number }).port;
          if (!Number.isInteger(value) || !value || value < 1 || value > 65535) reject(new Error('Invalid HTTP host port'));
          else resolve(value);
        });
      });
      async function post(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
        return fetch(`http://127.0.0.1:${port}/${path}`, { method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `AppRuntime ${session.session_token}`,
            ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      }
      const wireSession = { schema_version: 'deft.app_runtime_channel.v1', session_id: session.session_id };
      assert.equal((await post('claim', { ...wireSession, max_claims: 1 }, { cookie: 'forged=1' })).status, 403);
      assert.equal((await post('claim', { ...wireSession, max_claims: 1,
        session_token: session.session_token })).status, 400);
      assert.equal((await post('claim', { ...wireSession, max_claims: 1, padding: 'x'.repeat(5000) })).status, 413);
      const response = await post('claim', { ...wireSession, max_claims: 1 });
      assert.equal(response.status, 200);
      const wireClaim = (await response.json() as { claim: { run_id: string; attempt_id: string;
        claim_token: string; sequence: number } }).claim;
      assert.equal(wireClaim.run_id, httpRun.run.id);
      const wireRequest = { ...wireSession, run_id: wireClaim.run_id,
        attempt_id: wireClaim.attempt_id, claim_token: wireClaim.claim_token,
        sequence: wireClaim.sequence };
      assert.equal((await post('start', { ...wireRequest, sequence: wireClaim.sequence + 1 })).status, 403);
      const started = await post('start', wireRequest);
      assert.equal(started.status, 200);
      assert.deepEqual((await started.json() as { started: { input: unknown } }).started.input, httpRun.input);
      assert.equal((await post('heartbeat', wireRequest)).status, 200);
      const wireResult = { ...wireRequest, status: 'returned', provider_succeeded: true,
        output: { receipt_id: 'http-effect' } };
      for (let i = 0; i < 2; i++) {
        const returned = await post('result', wireResult);
        assert.equal(returned.status, 200);
        assert.equal((await returned.json() as { run: { state: string } }).run.state, 'succeeded');
      }
      assert.equal((await runtime.receiptReader.readVerified(orgId, httpRun.run.id))
        .filter((row) => row.receipt_kind === 'attempt_terminal').length, 1);

      // The provider is a separate process using the public SDK. Kill it
      // after its external fixture ledger is fsynced but before result ACK.
      const killedRun = await approvedRun();
      const ledgerDir = await mkdtemp(join(tmpdir(), 'deft-runtime-provider-'));
      const ledgerPath = join(ledgerDir, 'carrier-ledger.jsonl');
      const providerFixture = fileURLToPath(new URL('./fixtures/app-runtime-provider-child.ts', import.meta.url));
      async function provider(mode: 'normal' | 'pause_after_effect') {
        const worker = fork(providerFixture, { execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          env: { ...process.env, DEFT_RUNTIME_PROVIDER_FIXTURE: 'true' } });
        let errors = '';
        worker.stderr?.on('data', (chunk) => { errors = (errors + String(chunk)).slice(-4000); });
        const signal = new Promise<{ type: string; run_id?: string; attempt_id?: string }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Runtime provider child timed out: ${errors}`)), 30_000);
          let attemptId: string | undefined;
          worker.on('message', (message) => {
            const event = message as { type: string; run_id?: string; attempt_id?: string; code?: string };
            if (event.type === 'claimed') attemptId = event.attempt_id;
            if (event.type === 'error') {
              clearTimeout(timer); reject(new Error(`Runtime provider child failed: ${event.code}`));
            }
            if (event.type === (mode === 'pause_after_effect' ? 'effect_committed' : 'idle')) {
              clearTimeout(timer); resolve({ ...event, attempt_id: attemptId });
            }
          });
          worker.once('exit', (code) => {
            clearTimeout(timer);
            if (code !== 0) reject(new Error(`Runtime provider child exited ${code}: ${errors}`));
          });
        });
        worker.send({ type: 'start', channel_url: `http://127.0.0.1:${port}`,
          session_id: session.session_id, session_token: session.session_token,
          ledger_path: ledgerPath, mode });
        return { worker, signal };
      }
      try {
        const killed = await provider('pause_after_effect');
        let effect: Awaited<typeof killed.signal>;
        try { effect = await killed.signal; }
        finally {
          const exited = new Promise<void>((resolve) => killed.worker.once('exit', () => resolve()));
          killed.worker.kill('SIGKILL');
          await exited;
        }
        assert.equal(effect.run_id, killedRun.run.id);
        assert.ok(effect.attempt_id);
        const ledger = (await readFile(ledgerPath, 'utf8')).trim().split('\n')
          .map((line) => JSON.parse(line) as { run_id: string; effect: string });
        assert.deepEqual(ledger, [{ run_id: killedRun.run.id,
          item_id: `item-${runNumber}`, effect: 'synthetic_carrier_label' }]);
        const secrets = new secretModule.AppRunSecretService(runtime.keys);
        const recovery = new runnerModule.AppRunAttemptRunner(runtime.repository,
          runtime.secretRepository, secrets, new providerModule.PinnedMcpAppRunProviderExecutor(),
          runtime.liveAuthorization, () => new Date(Date.now() + 120_000), 60_000, 20_000,
          new receiptModule.PostgresAppRunReceiptWriter(secrets, runtime.secretRepository));
        assert.equal(await recovery.recoverRun(orgId, killedRun.run.id, effect.attempt_id!), 1);
        assert.equal((await runtime.repository.inspect(orgId, killedRun.run.id))?.state, 'unknown_outcome');
        assert.equal((await runtime.receiptReader.readVerified(orgId, killedRun.run.id))
          .filter((row) => row.receipt_kind === 'attempt_terminal').length, 1);
        const restarted = await provider('normal');
        try { assert.equal((await restarted.signal).type, 'idle'); }
        finally { restarted.worker.kill(); }
        assert.equal((await readFile(ledgerPath, 'utf8')).trim().split('\n').length, 1);
      } finally {
        await unlink(ledgerPath).catch(() => {});
        await rmdir(ledgerDir).catch(() => {});
      }
    } finally {
      if (child.connected) child.send('stop');
      const timer = setTimeout(() => child.kill(), 5000);
      await closed; clearTimeout(timer);
    }

    const invalid = await approvedRun();
    const invalidClaim = await claimFor(invalid.run.id);
    assert.ok(await channel.start(invalidClaim.request));
    assert.equal((await channel.complete({ ...invalidClaim.request, status: 'returned',
      provider_succeeded: true, output: { unexpected: 'value' } }))?.state, 'unknown_outcome');
    assert.equal((await runtime.receiptReader.readVerified(orgId, invalid.run.id))
      .filter((row) => row.receipt_kind === 'attempt_terminal').length, 1);

    const revoked = await approvedRun();
    const revokedClaim = await claimFor(revoked.run.id);
    assert.ok(await channel.start(revokedClaim.request));
    assert.deepEqual(await management.revokeRuntimeBinding(owner, binding.binding_id), { revoked: true });
    assert.equal(await channel.complete({ ...revokedClaim.request, status: 'returned',
      provider_succeeded: true, output: { receipt_id: 'late' } }), null);
    assert.equal(await channel.start(revokedClaim.request), null);
    assert.equal(await channel.heartbeat(revokedClaim.request), false);
    const offsetSecrets = new secretModule.AppRunSecretService(runtime.keys);
    const offsetRunner = new runnerModule.AppRunAttemptRunner(runtime.repository,
      runtime.secretRepository, offsetSecrets, new providerModule.PinnedMcpAppRunProviderExecutor(),
      runtime.liveAuthorization, () => new Date(Date.now() + 120_000), 60_000, 20_000,
      new receiptModule.PostgresAppRunReceiptWriter(offsetSecrets, runtime.secretRepository));
    assert.equal(await offsetRunner.recoverRun(orgId, revoked.run.id,
      revokedClaim.claim.attempt_id), 1);
    assert.equal((await runtime.repository.inspect(orgId, revoked.run.id))?.state, 'unknown_outcome');
    assert.equal((await runtime.receiptReader.readVerified(orgId, revoked.run.id))
      .filter((row) => row.receipt_kind === 'attempt_terminal').length, 1);
    const status = await management.inspectRuntimeBinding(owner, binding.binding_id);
    assert.equal(status.binding.state, 'revoked');
    assert.equal(status.drain.drained, false);
    assert.ok(status.drain.run_state_counts.unknown_outcome >= 2);
    assert.ok(status.sessions.every((item) => item.revoked));
    await assert.rejects(management.issueRuntimeOperatorSession(owner, binding.binding_id));
  } finally {
    await runtimeModule.shutdownAppRunRuntime();
    await closeDb();
  }
});
