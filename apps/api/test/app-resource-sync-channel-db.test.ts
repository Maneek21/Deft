import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

const assigned = process.env.DATABASE_URL === process.env.DEFT_TEST_DATABASE_URL
  && process.env.DATABASE_URL === 'postgresql://gate_g_test@127.0.0.1:55435/gate_g_phase5_test_s06_channel';

test('reviewed v2 Run claims and atomically settles page, output and signed receipt', {
  skip: !assigned,
}, async () => {
  process.env.DEFT_APPS_ENABLED = 'true';
  process.env.DEFT_APP_RUNS_ENABLED = 'true';
  process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
  process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true';
  const key = (purpose: string) => createHash('sha256').update(`s06-channel:${purpose}`).digest('base64');
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: { current: 'channel-enc', keys: { 'channel-enc': key('enc') } },
    receipt_signing: { current: 'channel-sig', keys: { 'channel-sig': key('sig') } },
    fingerprint: { current: 'channel-fp1', keys: { 'channel-fp1': key('fp1') } } });
  const [{ db, closeDb }, schema, drizzle, fixture, keyrings, repositories,
    secretModule, inputModule, syncSecretModule, storeModule, admissionModule,
    runnerModule, channelModule, providerModule, queueModule, receiptModule] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'),
    import('./fixtures/resource-sync-v5.js'), import('../src/lib/app-run-keyrings.js'),
    import('../src/lib/app-run-repository.js'), import('../src/lib/app-run-secrets.js'),
    import('../src/lib/app-run-secret-repository.js'), import('../src/lib/app-resource-sync-secrets.js'),
    import('../src/lib/app-resource-sync-store.js'), import('../src/lib/app-resource-sync-admission.js'),
    import('../src/lib/app-run-attempt-runner.js'), import('../src/lib/app-resource-sync-channel.js'),
    import('../src/lib/app-run-provider-executor.js'), import('../src/lib/app-run-scheduler.js'),
    import('../src/lib/app-run-receipts.js'),
  ]);
  const keys = keyrings.parseEnvironmentAppRunKeyrings(process.env.DEFT_APP_RUN_KEYRINGS);
  let checkedAt = new Date();
  const clock = () => new Date(checkedAt);
  const repository = new repositories.PostgresAppRunRepository();
  const secrets = new secretModule.AppRunSecretService(keys);
  const inputs = new inputModule.AppRunSecretRepository(secrets);
  const syncSecrets = new syncSecretModule.AppResourceSyncSecretService(keys);
  const store = new storeModule.AppResourceSyncStore(syncSecrets, inputs);
  const receiptWriter = new receiptModule.PostgresAppRunReceiptWriter(secrets, inputs);
  const makeRunner = (writer: typeof receiptWriter = receiptWriter) =>
    new runnerModule.AppRunAttemptRunner(repository, inputs, secrets,
      new providerModule.PinnedMcpAppRunProviderExecutor(), undefined, clock,
      60_000, 20_000, writer, undefined, queueModule.postgresAppRunAttemptQueue, store);
  const runner = makeRunner();
  const admission = new admissionModule.AppResourceSyncAdmissionService(repository, inputs,
    secrets, syncSecrets, runner, clock, () => true);
  const channel = new channelModule.AppResourceSyncChannel(runner);
  const page = { schema_version: 'deft.app_sync_page.v1' as const,
    upserts: [{ id: 'provider-message-1', revision: 'rev1', data: { subject: 'Private subject' } }],
    tombstones: [], next_cursor: 'cursor-1', has_more: false };
  const newClaim = async () => {
    const owned = await fixture.createReviewedResourceSyncFixture({ keys, clock });
    const admitted = await admission.admitDue({ org_id: owned.org_id,
      resource_binding_id: owned.binding_id });
    if (admitted.state !== 'created') throw new Error('Expected a fresh due sync Run');
    const issued = await owned.management.issueOperatorSession(owned.operator_actor, owned.binding_id);
    const base = { schema_version: 'deft.app_runtime_channel.v2' as const,
      audience: 'app_resource_sync' as const,
      session_id: issued.session_id, session_token: issued.session_token };
    const claim = await channel.claim({ ...base, max_claims: 1 });
    assert.ok(claim);
    return { owned, admitted, issued, base, claim,
      attempt: { ...base, run_id: claim.run_id, attempt_id: claim.attempt_id,
        claim_token: claim.claim_token, sequence: claim.sequence } };
  };
  try {
    const owned = await fixture.createReviewedResourceSyncFixture({ keys, clock });
    const admitted = await admission.admitDue({ org_id: owned.org_id,
      resource_binding_id: owned.binding_id });
    assert.equal(admitted.state, 'created');
    if (admitted.state !== 'created') return;
    const issued = await owned.management.issueOperatorSession(owned.operator_actor, owned.binding_id);
    const base = { schema_version: 'deft.app_runtime_channel.v2' as const,
      audience: 'app_resource_sync' as const, session_id: issued.session_id,
      session_token: issued.session_token };
    const claim = await channel.claim({ ...base, max_claims: 1 });
    assert.ok(claim);
    assert.equal(claim.run_id, admitted.run_id);
    assert.equal(claim.resource_binding_id, owned.binding_id);
    assert.equal(claim.descriptor_digest.length, 71);
    const attemptBase = { ...base, run_id: claim.run_id, attempt_id: claim.attempt_id,
      claim_token: claim.claim_token, sequence: claim.sequence };
    const started = await channel.start(attemptBase);
    assert.ok(started);
    assert.equal(await channel.start(attemptBase), null,
      'a started unsafe sync attempt never releases the cursor/input twice');
    assert.deepEqual(started.input, { schema_version: 'deft.app_sync_request.v1',
      cursor: null, max_items: 100 });
    assert.equal(started.descriptor_digest, claim.descriptor_digest);
    const heartbeat = await channel.heartbeat(attemptBase);
    assert.ok(heartbeat);
    assert.equal(heartbeat.sequence, claim.sequence);
    const result = { ...attemptBase, status: 'returned' as const,
      provider_succeeded: true as const, page };
    assert.deepEqual(await channel.complete(result), { run_id: claim.run_id,
      attempt_id: claim.attempt_id, sequence: claim.sequence });
    const [checkpoint] = await db.select().from(schema.appSyncCheckpoints)
      .where(drizzle.eq(schema.appSyncCheckpoints.id, owned.checkpoint_id));
    assert.equal(checkpoint?.cursor_sequence, 1);
    const projections = await db.select().from(schema.appResourceProjections)
      .where(drizzle.eq(schema.appResourceProjections.resource_binding_id, owned.binding_id));
    assert.equal(projections.length, 1);
    assert.equal(projections[0]?.state, 'live');
    const [run] = await db.select().from(schema.appRuns)
      .where(drizzle.eq(schema.appRuns.id, admitted.run_id));
    assert.equal(run?.state, 'succeeded');
    const output = await inputs.readOutput(owned.org_id, claim.run_id, claim.attempt_id);
    assert.equal((output as { provider_succeeded?: boolean })?.provider_succeeded, true);
    const receipts = await new receiptModule.PostgresAppRunReceiptReader(secrets)
      .readVerified(owned.org_id, admitted.run_id);
    assert.equal(receipts.filter((item) => item.receipt_kind === 'attempt_terminal').length, 1);
    const [rawReceipt] = await db.select().from(schema.appRunReceipts)
      .where(drizzle.eq(schema.appRunReceipts.attempt_id, claim.attempt_id));
    assert.equal(typeof rawReceipt?.envelope.output_envelope_digest, 'string');
    assert.equal(rawReceipt?.envelope.facts?.checkpoint_id, owned.checkpoint_id);
    const [attempt] = await db.select().from(schema.appRunAttempts)
      .where(drizzle.eq(schema.appRunAttempts.id, claim.attempt_id));
    assert.equal(attempt?.runtime_result_hmac, secrets.fingerprintTextCandidates('idempotency',
      `deft.app_resource_sync.result.v2:${createHash('sha256')
        .update((await import('@deft/shared')).canonicalCapabilityJson(result)).digest('hex')}`)
      .find((candidate) => candidate.key_version === run?.idempotency_key_version)?.fingerprint);
    assert.deepEqual(await channel.complete(result), { run_id: claim.run_id,
      attempt_id: claim.attempt_id, sequence: claim.sequence });
    assert.equal(await channel.complete({ ...result, page: { ...page, next_cursor: 'altered' } }), null);
    assert.equal((await db.select().from(schema.appResourceProjections)
      .where(drizzle.eq(schema.appResourceProjections.resource_binding_id, owned.binding_id))).length, 1);
    const immediate = await admission.admitDue({ org_id: owned.org_id,
      resource_binding_id: owned.binding_id });
    assert.equal(immediate.state, 'not_due', 'provider cannot schedule its own cadence');
    checkedAt = new Date(checkedAt.getTime() + 61_000);
    const nextDue = await admission.admitDue({ org_id: owned.org_id,
      resource_binding_id: owned.binding_id });
    assert.equal(nextDue.state, 'created');
    if (nextDue.state === 'created') {
      assert.deepEqual(await inputs.readInput(owned.org_id, nextDue.run_id), {
        schema_version: 'deft.app_sync_request.v1', cursor: 'cursor-1', max_items: 100,
      });
    }

    const rollbackOwned = await fixture.createReviewedResourceSyncFixture({ keys, clock });
    const lateWriter = { async write(tx: Parameters<typeof receiptWriter.write>[0],
      value: Parameters<typeof receiptWriter.write>[1]) {
      await receiptWriter.write(tx, value);
      if (value.receipt_kind === 'attempt_terminal' && value.run.state === 'succeeded') {
        checkedAt = new Date(checkedAt.getTime() + 2 * 60_000);
      }
    } };
    const rollbackRunner = makeRunner(lateWriter as typeof receiptWriter);
    const rollbackAdmission = new admissionModule.AppResourceSyncAdmissionService(repository,
      inputs, secrets, syncSecrets, rollbackRunner, clock, () => true);
    const rollbackRun = await rollbackAdmission.admitDue({ org_id: rollbackOwned.org_id,
      resource_binding_id: rollbackOwned.binding_id });
    assert.equal(rollbackRun.state, 'created');
    if (rollbackRun.state !== 'created') return;
    const rollbackIssued = await rollbackOwned.management.issueOperatorSession(
      rollbackOwned.operator_actor, rollbackOwned.binding_id);
    const rollbackBase = { schema_version: 'deft.app_runtime_channel.v2' as const,
      audience: 'app_resource_sync' as const, session_id: rollbackIssued.session_id,
      session_token: rollbackIssued.session_token };
    const rollbackChannel = new channelModule.AppResourceSyncChannel(rollbackRunner);
    const rollbackClaim = await rollbackChannel.claim({ ...rollbackBase, max_claims: 1 });
    assert.ok(rollbackClaim);
    const rollbackAttempt = { ...rollbackBase, run_id: rollbackClaim.run_id,
      attempt_id: rollbackClaim.attempt_id, claim_token: rollbackClaim.claim_token,
      sequence: rollbackClaim.sequence };
    assert.ok(await rollbackChannel.start(rollbackAttempt));
    await assert.rejects(rollbackChannel.complete({ ...rollbackAttempt,
      status: 'returned', provider_succeeded: true, page }),
    /APP_RESOURCE_SYNC_SETTLEMENT_EXPIRED/);
    const [rollbackCheckpoint] = await db.select().from(schema.appSyncCheckpoints)
      .where(drizzle.eq(schema.appSyncCheckpoints.id, rollbackOwned.checkpoint_id));
    assert.equal(rollbackCheckpoint?.cursor_sequence, 0);
    assert.equal((await db.select().from(schema.appResourceProjections)
      .where(drizzle.eq(schema.appResourceProjections.resource_binding_id, rollbackOwned.binding_id))).length, 0);
    assert.equal(await inputs.readOutput(rollbackOwned.org_id, rollbackClaim.run_id,
      rollbackClaim.attempt_id), null);
    assert.equal((await db.select().from(schema.appRunReceipts)
      .where(drizzle.eq(schema.appRunReceipts.run_id, rollbackClaim.run_id))).length, 0);
    const [rollbackStoredRun] = await db.select().from(schema.appRuns)
      .where(drizzle.eq(schema.appRuns.id, rollbackClaim.run_id));
    assert.equal(rollbackStoredRun?.state, 'running');

    // Result HMAC uses the Run-pinned FP1 even when the callback host's
    // current fingerprint key has rotated to FP2. This no-page failure
    // result lets FP2 be removed without hiding projection/cursor refs.
    const failureOwned = await fixture.createReviewedResourceSyncFixture({ keys, clock });
    const failureAdmission = await admission.admitDue({ org_id: failureOwned.org_id,
      resource_binding_id: failureOwned.binding_id });
    assert.equal(failureAdmission.state, 'created');
    if (failureAdmission.state !== 'created') return;
    const failureIssued = await failureOwned.management.issueOperatorSession(
      failureOwned.operator_actor, failureOwned.binding_id);
    const failureBase = { schema_version: 'deft.app_runtime_channel.v2' as const,
      audience: 'app_resource_sync' as const, session_id: failureIssued.session_id,
      session_token: failureIssued.session_token };
    const failureClaim = await channel.claim({ ...failureBase, max_claims: 1 });
    assert.ok(failureClaim);
    const failureAttempt = { ...failureBase, run_id: failureClaim.run_id,
      attempt_id: failureClaim.attempt_id, claim_token: failureClaim.claim_token,
      sequence: failureClaim.sequence };
    assert.ok(await channel.start(failureAttempt));
    const baseRing = JSON.parse(process.env.DEFT_APP_RUN_KEYRINGS!);
    const fp2Ring = structuredClone(baseRing);
    fp2Ring.fingerprint.current = 'channel-fp2';
    fp2Ring.fingerprint.keys['channel-fp2'] = key('fp2');
    const fp2Keys = keyrings.parseEnvironmentAppRunKeyrings(JSON.stringify(fp2Ring));
    const fp3Ring = structuredClone(baseRing);
    fp3Ring.fingerprint.current = 'channel-fp3';
    fp3Ring.fingerprint.keys['channel-fp3'] = key('fp3');
    const fp3Keys = keyrings.parseEnvironmentAppRunKeyrings(JSON.stringify(fp3Ring));
    const channelFor = (provider: typeof keys) => {
      const runSecrets = new secretModule.AppRunSecretService(provider);
      const runInputs = new inputModule.AppRunSecretRepository(runSecrets);
      const sync = new syncSecretModule.AppResourceSyncSecretService(provider);
      const writer = new receiptModule.PostgresAppRunReceiptWriter(runSecrets, runInputs);
      const rotatedRunner = new runnerModule.AppRunAttemptRunner(repository, runInputs,
        runSecrets, new providerModule.PinnedMcpAppRunProviderExecutor(), undefined,
        clock, 60_000, 20_000, writer, undefined,
        queueModule.postgresAppRunAttemptQueue,
        new storeModule.AppResourceSyncStore(sync, runInputs));
      return new channelModule.AppResourceSyncChannel(rotatedRunner);
    };
    try {
      const failed = { ...failureAttempt, status: 'returned' as const,
        provider_succeeded: false as const, error_code: 'APP_RUN_PROVIDER_ERROR' as const };
      assert.ok(await channelFor(fp2Keys).complete(failed));
      const [failureRun] = await db.select().from(schema.appRuns)
        .where(drizzle.eq(schema.appRuns.id, failureClaim.run_id));
      const [failureAttemptRow] = await db.select().from(schema.appRunAttempts)
        .where(drizzle.eq(schema.appRunAttempts.id, failureClaim.attempt_id));
      const canonical = (await import('@deft/shared')).canonicalCapabilityJson(failed);
      const value = `deft.app_resource_sync.result.v2:${createHash('sha256')
        .update(canonical).digest('hex')}`;
      assert.equal(failureAttemptRow?.runtime_result_hmac,
        new secretModule.AppRunSecretService(fp2Keys)
          .fingerprintTextCandidates('idempotency', value)
          .find((candidate) => candidate.key_version === failureRun?.idempotency_key_version)?.fingerprint);
      assert.equal(failureRun?.idempotency_key_version, 'channel-fp1');
      assert.ok(await channelFor(fp3Keys).complete(failed),
        'identical replay survives removal of unreferenced completion-current FP2');
      assert.equal((await db.select().from(schema.appResourceProjections)
        .where(drizzle.eq(schema.appResourceProjections.resource_binding_id,
          failureOwned.binding_id))).length, 0);
    } finally { fp2Keys.destroy(); fp3Keys.destroy(); }

    const cross = await newClaim();
    const other = await newClaim();
    assert.equal(await channel.start({ ...cross.attempt,
      session_id: other.issued.session_id, session_token: other.issued.session_token }), null);
    assert.equal(await channel.start({ ...cross.attempt, claim_token: randomUUID() }), null);
    assert.equal(await channel.start({ ...cross.attempt, sequence: cross.claim.sequence + 1 }), null);
    assert.equal(await runner.startResourceSyncAttempt({ org_id: other.owned.org_id,
      run_id: cross.claim.run_id, attempt_id: cross.claim.attempt_id,
      session_id: cross.issued.session_id,
      token_hash: (await import('../src/lib/app-resource-sync-policy.js'))
        .hashAppResourceSyncToken(cross.issued.session_token),
      claim_token: cross.claim.claim_token, sequence: cross.claim.sequence }), null);
    assert.ok(await channel.start(cross.attempt));
    assert.equal(await channel.complete({ ...other.attempt,
      run_id: cross.claim.run_id, attempt_id: cross.claim.attempt_id,
      claim_token: cross.claim.claim_token, sequence: cross.claim.sequence,
      status: 'returned', provider_succeeded: true, page }), null);

    const preStart = await newClaim();
    await preStart.owned.management.revokeConsent(preStart.owned.owner_actor,
      preStart.owned.binding_id);
    assert.equal(await channel.start(preStart.attempt), null);
    assert.equal((await db.select().from(schema.appResourceProjections)
      .where(drizzle.eq(schema.appResourceProjections.resource_binding_id,
        preStart.owned.binding_id))).length, 0);

    const postStart = await newClaim();
    assert.ok(await channel.start(postStart.attempt));
    await postStart.owned.management.revokeConsent(postStart.owned.owner_actor,
      postStart.owned.binding_id);
    assert.equal(await channel.complete({ ...postStart.attempt,
      status: 'returned', provider_succeeded: true, page }), null);
    assert.equal((await db.select().from(schema.appResourceProjections)
      .where(drizzle.eq(schema.appResourceProjections.resource_binding_id,
        postStart.owned.binding_id))).length, 0);
    checkedAt = new Date(checkedAt.getTime() + 61_000);
    assert.equal(await runner.recoverRun(postStart.owned.org_id, postStart.claim.run_id), 1);
    const [unknownRun] = await db.select().from(schema.appRuns)
      .where(drizzle.eq(schema.appRuns.id, postStart.claim.run_id));
    assert.equal(unknownRun?.state, 'unknown_outcome');
    assert.equal((await db.select().from(schema.appRunAttempts)
      .where(drizzle.eq(schema.appRunAttempts.run_id, postStart.claim.run_id))).length, 1,
    'started unknown sync work is never retried automatically');

    const revokedSession = await newClaim();
    assert.ok(await channel.start(revokedSession.attempt));
    await revokedSession.owned.management.revokeOperatorSession(
      revokedSession.owned.operator_actor, revokedSession.issued.session_id);
    assert.equal(await channel.heartbeat(revokedSession.attempt), null);
    assert.equal(await channel.complete({ ...revokedSession.attempt,
      status: 'returned', provider_succeeded: true, page }), null);

    const cancelled = await newClaim();
    await repository.transaction(async (tx) => {
      const run = await repository.lockRun(tx, cancelled.owned.org_id, cancelled.claim.run_id);
      assert.ok(run);
      await repository.transition(tx, { run, state: 'cancelled',
        actor: { actor_type: 'system', system_id: cancelled.owned.binding_id },
        now: clock() });
    });
    assert.equal(await channel.start(cancelled.attempt), null);
    const cancelledAfterStart = await newClaim();
    assert.ok(await channel.start(cancelledAfterStart.attempt));
    await repository.transaction(async (tx) => {
      const run = await repository.lockRun(tx, cancelledAfterStart.owned.org_id,
        cancelledAfterStart.claim.run_id);
      assert.ok(run);
      await repository.requestCancellation(tx, run,
        { actor_type: 'system', system_id: cancelledAfterStart.owned.binding_id }, clock());
    });
    assert.equal(await channel.complete({ ...cancelledAfterStart.attempt,
      status: 'returned', provider_succeeded: true, page }), null);

    const neverStarted = await newClaim();
    checkedAt = new Date(checkedAt.getTime() + 61_000);
    assert.equal(await channel.start(neverStarted.attempt), null);
    assert.equal(await runner.recoverRun(neverStarted.owned.org_id,
      neverStarted.claim.run_id), 1);
    const [beforeCall] = await db.select().from(schema.appRunAttempts)
      .where(drizzle.eq(schema.appRunAttempts.id, neverStarted.claim.attempt_id));
    assert.equal(beforeCall?.state, 'failed');
    const [neverRun] = await db.select().from(schema.appRuns)
      .where(drizzle.eq(schema.appRuns.id, neverStarted.claim.run_id));
    assert.notEqual(neverRun?.state, 'unknown_outcome',
      'the provider-call-started boundary distinguishes pre-effect recovery');

    const rekeyBeforeStart = await newClaim();
    await assert.rejects(db.execute(drizzle.sql`UPDATE app_sync_checkpoints
      SET cursor_hmac_key_version = 'forged-rekey'
      WHERE id = ${rekeyBeforeStart.owned.checkpoint_id}`),
    (error: unknown) => error instanceof Error
      && error.cause instanceof Error
      && error.cause.message.includes('APP_SYNC_CURSOR_CAS_REQUIRED'));
    assert.ok(await channel.start(rekeyBeforeStart.attempt),
      'same-sequence cursor rekey is prohibited by the current DB contract');

    const expiredAfterStart = await newClaim();
    assert.ok(await channel.start(expiredAfterStart.attempt));
    checkedAt = new Date(checkedAt.getTime() + 61_000);
    assert.equal(await channel.complete({ ...expiredAfterStart.attempt,
      status: 'returned', provider_succeeded: true, page }), null);
    assert.equal(await runner.recoverRun(expiredAfterStart.owned.org_id,
      expiredAfterStart.claim.run_id), 1);
    const [expiredRun] = await db.select().from(schema.appRuns)
      .where(drizzle.eq(schema.appRuns.id, expiredAfterStart.claim.run_id));
    assert.equal(expiredRun?.state, 'unknown_outcome');
    assert.equal((await db.select().from(schema.appRunAttempts)
      .where(drizzle.eq(schema.appRunAttempts.run_id,
        expiredAfterStart.claim.run_id))).length, 1);
    assert.equal((await db.select().from(schema.appResourceProjections)
      .where(drizzle.eq(schema.appResourceProjections.resource_binding_id,
        expiredAfterStart.owned.binding_id))).length, 0);

    const claimedNoEffect = await newClaim();
    assert.ok(await channel.start(claimedNoEffect.attempt));
    assert.deepEqual(await channel.complete({ ...claimedNoEffect.attempt,
      status: 'not_attempted', error_code: 'APP_RUN_PROVIDER_UNAVAILABLE' }),
    { run_id: claimedNoEffect.claim.run_id,
      attempt_id: claimedNoEffect.claim.attempt_id,
      sequence: claimedNoEffect.claim.sequence });
    const [noEffectRun] = await db.select().from(schema.appRuns)
      .where(drizzle.eq(schema.appRuns.id, claimedNoEffect.claim.run_id));
    assert.equal(noEffectRun?.state, 'unknown_outcome',
      'the provider cannot prove no effect after host input release');
    assert.equal((await db.select().from(schema.appRunAttempts)
      .where(drizzle.eq(schema.appRunAttempts.run_id,
        claimedNoEffect.claim.run_id))).length, 1);
  } finally { keys.destroy(); await closeDb(); }
});
