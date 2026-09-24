import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const databaseUrl = process.env.DEFT_TEST_DATABASE_URL;
const safeDatabase = databaseUrl && databaseUrl === process.env.DATABASE_URL
  && /(?:^|[-_])(test|ci|acceptance|phase\d+)(?:$|[-_])/iu.test(
    new URL(databaseUrl).pathname.slice(1));

test('reviewed Runtime claim, start, known result and replay use the App Run ledger', {
  skip: !safeDatabase,
}, async () => {
  process.env.DEFT_APPS_ENABLED = 'true';
  process.env.DEFT_APP_RUNS_ENABLED = 'true';
  process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
  process.env.DEFT_APP_RUNTIME_CHANNEL_ENABLED = 'true';
  const key = (purpose: string) => createHash('sha256').update(`runtime-db-test:${purpose}`).digest('base64');
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({
    schema_version: 'deft.app_run_keyring.v1',
    run_encryption: { current: 'runtime-test-enc-v1', keys: { 'runtime-test-enc-v1': key('encryption') } },
    receipt_signing: { current: 'runtime-test-sig-v1', keys: { 'runtime-test-sig-v1': key('signing') } },
    fingerprint: { current: 'runtime-test-fp-v1', keys: { 'runtime-test-fp-v1': key('fingerprint') } },
  });
  const [{ db, closeDb }, schema, shared, appKit, appService, reviewService,
    moduleService, packageFixture, providerExecutor, repositoryModule,
    secretModule, keyringModule, secretRepositoryModule, receiptModule, runnerModule,
    channelModule, authorityModule] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('@deft/shared'),
    import('@deft/app-kit'), import('../src/lib/app-service.js'),
    import('../src/lib/app-review-service.js'), import('../src/lib/module-service.js'),
    import('./fixtures/phase5-connected-app-package.js'),
    import('../src/lib/app-run-provider-executor.js'),
    import('../src/lib/app-run-repository.js'),
    import('../src/lib/app-run-secrets.js'),
    import('../src/lib/app-run-keyrings.js'),
    import('../src/lib/app-run-secret-repository.js'),
    import('../src/lib/app-run-receipts.js'),
    import('../src/lib/app-run-attempt-runner.js'),
    import('../src/lib/app-runtime-channel.js'),
    import('../src/lib/app-runtime-authority.js'),
  ]);
  const { and, eq, sql } = await import('drizzle-orm');
  // The HTTP host uses the production global key-retirement guard. Preserve
  // unrelated test key IDs while isolating this fixture's actual key material.
  const { databaseCompleteAppRunTestKeyringFixture } = await import('./fixtures/app-run-test-keyrings.js');
  const covered = await databaseCompleteAppRunTestKeyringFixture('runtime-db-test');
  covered.keys.destroy();
  const combinedKeyrings = JSON.parse(covered.environment);
  const runtimeKeyrings = JSON.parse(process.env.DEFT_APP_RUN_KEYRINGS!);
  for (const purpose of ['run_encryption', 'receipt_signing', 'fingerprint']) {
    combinedKeyrings[purpose].current = runtimeKeyrings[purpose].current;
    Object.assign(combinedKeyrings[purpose].keys, runtimeKeyrings[purpose].keys);
  }
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify(combinedKeyrings);
  const orgId = randomUUID();
  const userId = randomUUID();
  const connectionId = randomUUID();
  const registrationId = randomUUID();
  const bindingId = randomUUID();
  const snapshotId = randomUUID();
  const suffix = randomUUID();
  try {
    await db.insert(schema.orgs).values({ id: orgId, name: 'Runtime fixture', slug: `runtime-${suffix}` });
    await db.insert(schema.users).values({ id: userId,
      email: `runtime-${suffix}@example.test`, name: 'Runtime owner' });
    const [membership] = await db.insert(schema.orgMembers).values({
      id: randomUUID(), org_id: orgId, user_id: userId, role: 'owner', is_active: true,
    }).returning();
    assert.ok(membership);
    const owner = moduleService.humanModuleActor({ orgId, userId, role: 'owner', source: 'ui' });
    const dependencyPackage = await packageFixture.buildPhase5DependencyAppPackage();
    const dependency = await appService.stageAppPackage(owner, dependencyPackage.json);
    await appService.activateAppInstallation(owner, dependency.id, dependency.package_digest);
    const connectedPackage = await packageFixture.buildPhase5ConnectedAppPackage();
    const connected = await appService.stageAppPackage(owner, connectedPackage.json);
    const [version] = await db.select().from(schema.appVersions).where(and(
      eq(schema.appVersions.org_id, orgId), eq(schema.appVersions.id, connected.version_id),
    ));
    assert.ok(version?.requested_grant_snapshot_id);
    const [requested] = await db.select().from(schema.appGrantSnapshots).where(and(
      eq(schema.appGrantSnapshots.org_id, orgId),
      eq(schema.appGrantSnapshots.id, version.requested_grant_snapshot_id),
    ));
    assert.ok(requested);
    await db.insert(schema.mcpConnections).values({
      id: connectionId, org_id: orgId, name: 'Fixture review connector',
      slug: `runtime-review-${suffix}`, server_url: 'https://example.test/mcp',
      transport: 'streamable-http', auth_type: 'none', is_active: true,
      enabled_tools: ['send_email'], created_by: userId,
    });
    const mcpProvider = { org_id: orgId, provider_kind: 'mcp' as const,
      provider_instance_id: connectionId };
    const discovery = await shared.createCapabilityProviderDiscoverySnapshot({
      adapter_contract_version: shared.CAPABILITY_CONTRACT_VERSIONS.mcp_adapter,
      provider: mcpProvider, captured_at: new Date().toISOString(),
      operations: [{ identity: { provider: mcpProvider, operation_name: 'send_email' },
        title: 'Fixture review connector', description: 'Synthetic only',
        input_schema: appKit.SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema,
        output_schema: appKit.SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.output_schema }],
    });
    const capability = {
      async discover() { return {
        provider_kind: 'mcp' as const,
        tools: [{ name: `mcp__runtime_review_${suffix}__send_email`, originalName: 'send_email',
          description: 'Synthetic only',
          inputSchema: appKit.SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.input_schema,
          outputSchema: appKit.SANDBOX_EMAIL_SEND_PRIVATE_CONTRACT.output_schema,
          connectionId, connectionSlug: `runtime-review-${suffix}`, isWrite: true,
          approvalTier: 'full-review' as const, rawTool: { name: 'send_email' } }],
        snapshot: discovery,
      }; },
      async invoke() { throw new Error('fixture review connector must never invoke'); },
    };
    const reviewRequest = {
      app_version_id: version.id, expected_package_digest: version.package_digest,
      expected_requested_snapshot_digest: requested.snapshot_digest,
      expected_lifecycle_epoch: connected.lifecycle_epoch,
      expected_grant_epoch: connected.grant_epoch,
      connector_selections: [{ connector_requirement_key: 'mail_provider',
        mcp_connection_id: connectionId }],
    };
    const review = await reviewService.prepareConnectedAppReview(
      owner, connected.id, reviewRequest, capability);
    await reviewService.activateConnectedAppInstallation(owner, connected.id, {
      ...reviewRequest, expected_review_digest: review.review_digest,
      accept_host_policy: true,
    }, capability);
    const [installation] = await db.select().from(schema.appInstallations).where(and(
      eq(schema.appInstallations.org_id, orgId), eq(schema.appInstallations.id, connected.id),
    ));
    assert.ok(installation?.active_grant_snapshot_id);

    // Synthetic host-reviewed Runtime binding. Released v0-v2 package did not
    // author this contract, and no public intake accepts Runtime Runs yet.
    await db.insert(schema.capabilityProviderSnapshots).values({
      id: snapshotId, org_id: orgId, provider_kind: 'app_runtime',
      provider_instance_id: registrationId,
      adapter_contract_version: 'deft.app_runtime_channel.v1',
      snapshot_digest: `sha256:${'a'.repeat(64)}`,
      safe_snapshot: { fixture: true }, captured_at: new Date(),
    });
    await db.insert(schema.appRuntimeRegistrations).values({
      id: registrationId, org_id: orgId, app_installation_id: connected.id,
      app_version_id: version.id, grant_snapshot_id: installation.active_grant_snapshot_id,
      operator_user_id: userId, contract_version: 'deft.app_runtime_channel.v1',
    });
    await assert.rejects(db.update(schema.appRuntimeRegistrations).set({
      state: 'active', runtime_epoch: 1, contract_version: 'substituted',
      reviewed_by_user_id: userId, reviewed_at: new Date(),
    }).where(eq(schema.appRuntimeRegistrations.id, registrationId)),
    (error: unknown) => (error as { cause?: { message?: string } }).cause?.message === 'APP_RUNTIME_IMMUTABLE_FIELD');
    await db.update(schema.appRuntimeRegistrations).set({ state: 'active', runtime_epoch: 1,
      reviewed_by_user_id: userId, reviewed_at: new Date() }).where(and(
      eq(schema.appRuntimeRegistrations.org_id, orgId),
      eq(schema.appRuntimeRegistrations.id, registrationId),
    ));
    await db.insert(schema.appRuntimeBindings).values({
      id: bindingId, org_id: orgId, app_installation_id: connected.id,
      app_version_id: version.id, grant_snapshot_id: installation.active_grant_snapshot_id,
      runtime_registration_id: registrationId, action_key: 'fixture_action',
      interface_identity: `deft.runtime.v1:${orgId.toLowerCase()}:${connected.id.toLowerCase()}:fixture_action`,
      provider_instance_id: registrationId, provider_snapshot_id: snapshotId,
      operation_name: 'fixture_action', risk_class: 'external_write',
      review_requirement: 'always', retry_class: 'unsafe_or_unknown',
      retention_class: 'standard',
    });
    await assert.rejects(db.update(schema.appRuntimeBindings).set({
      state: 'active', operation_name: 'substituted',
      reviewed_by_user_id: userId, reviewed_at: new Date(),
    }).where(eq(schema.appRuntimeBindings.id, bindingId)),
    (error: unknown) => (error as { cause?: { message?: string } }).cause?.message === 'APP_RUNTIME_IMMUTABLE_FIELD');
    await db.update(schema.appRuntimeBindings).set({ state: 'active',
      reviewed_by_user_id: userId, reviewed_at: new Date() }).where(and(
      eq(schema.appRuntimeBindings.org_id, orgId), eq(schema.appRuntimeBindings.id, bindingId),
    ));
    const keys = keyringModule.parseEnvironmentAppRunKeyrings(process.env.DEFT_APP_RUN_KEYRINGS);
    const secrets = new secretModule.AppRunSecretService(keys);
    const secretRepository = new secretRepositoryModule.AppRunSecretRepository(secrets);
    const repository = new repositoryModule.PostgresAppRunRepository();
    const receiptWriter = new receiptModule.PostgresAppRunReceiptWriter(secrets, secretRepository);
    const receiptReader = new receiptModule.PostgresAppRunReceiptReader(secrets);
    let clockOffsetMs = 0;
    const runner = new runnerModule.AppRunAttemptRunner(repository, secretRepository, secrets,
      new providerExecutor.PinnedMcpAppRunProviderExecutor(), undefined,
      () => new Date(Date.now() + clockOffsetMs), 60_000, 20_000, receiptWriter);
    const channel = new channelModule.AppRuntimeChannel(runner);
    const session = await channel.issueSession({ org_id: orgId,
      runtime_binding_id: bindingId, operator_user_id: userId });
    assert.ok(session);

    async function createSyntheticRun() {
      const runId = randomUUID();
      const attemptId = randomUUID();
      const input = { fixture: 'exact input' };
      const membershipVersion = `sha256:${createHash('sha256')
        .update('deft.app_run.authority.v1\0membership\0')
        .update(shared.canonicalCapabilityJson({ id: membership.id,
          authority_version: membership.app_run_authorization_version })).digest('hex')}`;
      const inputFingerprint = secrets.fingerprintJson('input', input);
      const idemFingerprint = secrets.fingerprintText('idempotency', runId);
      await db.insert(schema.appRuns).values({
        id: runId, org_id: orgId, contract_version: shared.APP_RUN_CONTRACT_VERSIONS.run,
        origin_kind: 'app', initiating_actor_type: 'human', initiating_actor_id: userId,
        execution_actor_type: 'human', execution_actor_id: userId,
        provider_kind: 'app_runtime', provider_instance_id: registrationId,
        operation_name: 'fixture_action', provider_snapshot_id: snapshotId,
        origin_app_installation_id: connected.id, origin_app_version_id: version.id,
        origin_app_grant_snapshot_id: installation.active_grant_snapshot_id!,
        origin_runtime_binding_id: bindingId,
        risk_class: 'external_write', review_requirement: 'always',
        review_scope: 'per_invocation', retry_class: 'unsafe_or_unknown',
        retention_class: 'standard', idempotency_key_version: idemFingerprint.key_version,
        idempotency_fingerprint: idemFingerprint.fingerprint,
        input_fingerprint_key_version: inputFingerprint.key_version,
        input_fingerprint: inputFingerprint.fingerprint,
        authorization_snapshot: { schema_version: shared.APP_RUN_CONTRACT_VERSIONS.run,
          authenticated_subject: { actor_type: 'human', user_id: userId },
          authority_refs: [{ authority_kind: 'membership', authority_id: userId,
            version: membershipVersion }] },
        safe_preview: { schema_version: shared.APP_RUN_CONTRACT_VERSIONS.run,
          title: 'Runtime fixture', resource_refs: [] },
        root_run_id: runId, depth: 0,
        input_expires_at: new Date(Date.now() + 300_000),
        result_expires_at: new Date(Date.now() + 600_000),
        idempotency_expires_at: new Date(Date.now() + 900_000),
        attempt_limit: 1, execution_release_kind: 'approved',
        execution_released_at: new Date(),
      });
      await db.transaction((tx) => secretRepository.insertInput(tx, {
        org_id: orgId, run_id: runId, value: input,
        expires_at: new Date(Date.now() + 300_000),
      }));
      await db.insert(schema.appRunAttempts).values({
        id: attemptId, org_id: orgId, run_id: runId,
        attempt_number: 1, state: 'pending',
      });
      return { runId, attemptId, input };
    }

    const run = await createSyntheticRun();
    const claim = await channel.claim({ schema_version: 'deft.app_runtime_channel.v1',
      session_id: session.session_id, session_token: session.session_token, max_claims: 1 });
    assert.equal(claim?.run_id, run.runId);
    assert.equal(claim?.attempt_id, run.attemptId);
    const request = { schema_version: 'deft.app_runtime_channel.v1',
      session_id: session.session_id, session_token: session.session_token,
      run_id: run.runId, attempt_id: run.attemptId,
      claim_token: claim!.claim_token, sequence: claim!.sequence };
    const foreignSession = await channel.issueSession({ org_id: orgId,
      runtime_binding_id: bindingId, operator_user_id: userId });
    assert.ok(foreignSession);
    assert.equal(await channel.start({ ...request,
      session_id: foreignSession.session_id, session_token: foreignSession.session_token }), null);
    const originalReadInput = secretRepository.readInput.bind(secretRepository);
    let enteredInput!: () => void;
    let releaseInput!: () => void;
    const inputEntered = new Promise<void>((resolve) => { enteredInput = resolve; });
    const inputReleased = new Promise<void>((resolve) => { releaseInput = resolve; });
    secretRepository.readInput = async (...args) => {
      enteredInput();
      await inputReleased;
      return originalReadInput(...args);
    };
    const startPending = channel.start(request);
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([inputEntered, new Promise<never>((_, reject) => {
        waitTimer = setTimeout(() => reject(new Error('Input disclosure boundary was not reached')), 5000);
      })]);
      for (const revoke of ['binding', 'membership']) {
        await assert.rejects(db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
          if (revoke === 'binding') {
            await tx.update(schema.appRuntimeBindings).set({ state: 'revoked' })
              .where(eq(schema.appRuntimeBindings.id, bindingId));
          } else {
            await tx.update(schema.orgMembers).set({ is_active: false })
              .where(eq(schema.orgMembers.id, membership.id));
          }
        }), (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === '55P03',
        'revocation must wait for the authorized input read');
      }
    } finally {
      if (waitTimer) clearTimeout(waitTimer);
      releaseInput();
      secretRepository.readInput = originalReadInput;
    }
    const started = await startPending;
    assert.deepEqual(started?.input, run.input);
    assert.equal(await channel.heartbeat(request), true);
    const result = { ...request, status: 'returned' as const,
      provider_succeeded: true, output: { provider_receipt: 'fixture-effect-1' } };
    assert.equal((await channel.complete(result))?.state, 'succeeded');
    assert.equal((await channel.complete(result))?.state, 'succeeded');
    const rotatedEnvironment = JSON.parse(process.env.DEFT_APP_RUN_KEYRINGS!);
    rotatedEnvironment.fingerprint.current = 'runtime-test-fp-v2';
    rotatedEnvironment.fingerprint.keys['runtime-test-fp-v2'] = key('fingerprint-v2');
    const rotatedKeys = keyringModule.parseEnvironmentAppRunKeyrings(JSON.stringify(rotatedEnvironment));
    const rotatedSecrets = new secretModule.AppRunSecretService(rotatedKeys);
    const rotatedSecretRepository = new secretRepositoryModule.AppRunSecretRepository(rotatedSecrets);
    const rotatedRunner = new runnerModule.AppRunAttemptRunner(repository,
      rotatedSecretRepository, rotatedSecrets,
      new providerExecutor.PinnedMcpAppRunProviderExecutor(), undefined,
      () => new Date(), 60_000, 20_000,
      new receiptModule.PostgresAppRunReceiptWriter(rotatedSecrets, rotatedSecretRepository));
    const rotatedChannel = new channelModule.AppRuntimeChannel(rotatedRunner);
    assert.equal((await rotatedChannel.complete(result))?.state, 'succeeded',
      'retained fingerprint keys must accept exact replay after rotation');
    rotatedKeys.destroy();
    assert.equal((await receiptReader.readVerified(orgId, run.runId))
      .filter((row) => row.receipt_kind === 'attempt_terminal').length, 1);
    assert.equal(await channel.complete({ ...result, output: { provider_receipt: 'substituted' } }), null);

    // Exercise the actual HTTP router in a separate host process. The client
    // has only the session credential and wire requests; it cannot call runner
    // methods in the server process. Intake above remains a synthetic fixture.
    const httpRun = await createSyntheticRun();
    const child = fork(fileURLToPath(new URL('./fixtures/app-runtime-http-host.ts', import.meta.url)), {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, DEFT_RUNTIME_HTTP_FIXTURE: 'true' },
    });
    let childErrors = '';
    child.stderr?.on('data', (chunk) => { childErrors = (childErrors + String(chunk)).slice(-4000); });
    const closed = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Runtime fixture startup timed out')), 30_000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Runtime fixture exited ${code}: ${childErrors}`)); });
        child.once('message', (message) => {
          clearTimeout(timer);
          const value = (message as { port?: number }).port;
          if (!Number.isInteger(value) || !value || value < 1 || value > 65535) reject(new Error('Invalid fixture port'));
          else resolve(value);
        });
      });
      async function post(path: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
        return fetch(`http://127.0.0.1:${port}/${path}`, {
          method: 'POST', headers: { 'content-type': 'application/json',
            authorization: `AppRuntime ${session!.session_token}`, ...extraHeaders },
          body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
        });
      }
      const wireSession = { schema_version: 'deft.app_runtime_channel.v1', session_id: session.session_id };
      assert.equal((await post('claim', { ...wireSession, max_claims: 1 }, { cookie: 'session=forged' })).status, 403);
      assert.equal((await post('claim', { ...wireSession, max_claims: 1, session_token: session.session_token })).status, 400);
      assert.equal((await post('claim', { ...wireSession, max_claims: 1, padding: 'x'.repeat(5000) })).status, 413);
      const claimedResponse = await post('claim', { ...wireSession, max_claims: 1 });
      assert.equal(claimedResponse.status, 200);
      const wireClaim = (await claimedResponse.json() as { claim: { run_id: string; attempt_id: string; claim_token: string; sequence: number } }).claim;
      assert.equal(wireClaim.run_id, httpRun.runId);
      const wireRequest = { ...wireSession, run_id: wireClaim.run_id, attempt_id: wireClaim.attempt_id,
        claim_token: wireClaim.claim_token, sequence: wireClaim.sequence };
      assert.equal((await post('start', { ...wireRequest, sequence: wireClaim.sequence + 1 })).status, 403);
      const wireStart = await post('start', wireRequest);
      assert.equal(wireStart.status, 200);
      assert.deepEqual((await wireStart.json() as { started: { input: unknown } }).started.input, httpRun.input);
      assert.equal((await post('heartbeat', wireRequest)).status, 200);
      const wireResult = { ...wireRequest, status: 'returned', provider_succeeded: true, output: { provider_receipt: 'http-fixture-effect' } };
      for (let i = 0; i < 2; i++) {
        const response = await post('result', wireResult);
        assert.equal(response.status, 200);
        assert.equal((await response.json() as { run: { state: string } }).run.state, 'succeeded');
      }
      assert.equal((await receiptReader.readVerified(orgId, httpRun.runId))
        .filter((row) => row.receipt_kind === 'attempt_terminal').length, 1);
    } finally {
      if (child.connected) child.send('stop');
      const timer = setTimeout(() => child.kill(), 5000);
      await closed;
      clearTimeout(timer);
    }

    const unknown = await createSyntheticRun();
    const unknownClaim = await channel.claim({ schema_version: 'deft.app_runtime_channel.v1',
      session_id: session.session_id, session_token: session.session_token, max_claims: 1 });
    assert.equal(unknownClaim?.run_id, unknown.runId);
    const unknownRequest = { schema_version: 'deft.app_runtime_channel.v1',
      session_id: session.session_id, session_token: session.session_token,
      run_id: unknown.runId, attempt_id: unknown.attemptId,
      claim_token: unknownClaim!.claim_token, sequence: unknownClaim!.sequence };
    assert.ok(await channel.start(unknownRequest));
    await db.update(schema.appRuntimeBindings).set({ state: 'revoked' }).where(and(
      eq(schema.appRuntimeBindings.org_id, orgId), eq(schema.appRuntimeBindings.id, bindingId),
    ));
    assert.equal(await channel.complete({ ...unknownRequest, status: 'returned',
      provider_succeeded: true, output: { provider_receipt: 'late' } }), null);
    assert.equal(await channel.start(unknownRequest), null);
    assert.equal(await channel.heartbeat(unknownRequest), false);
    clockOffsetMs = 120_000;
    assert.equal(await runner.recoverRun(orgId, unknown.runId, unknown.attemptId), 1);
    assert.equal((await repository.inspect(orgId, unknown.runId))?.state, 'unknown_outcome');
    assert.equal((await receiptReader.readVerified(orgId, unknown.runId))
      .filter((row) => row.receipt_kind === 'attempt_terminal').length, 1);
    assert.equal(await authorityModule.issueAppRuntimeSession({ org_id: orgId,
      runtime_binding_id: bindingId, operator_user_id: userId }), null);
    keys.destroy();
  } finally {
    await closeDb();
  }
});
