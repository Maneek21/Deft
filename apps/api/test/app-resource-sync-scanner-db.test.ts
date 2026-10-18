import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const assigned = process.env.DATABASE_URL === process.env.DEFT_TEST_DATABASE_URL
  && process.env.DATABASE_URL === 'postgresql://gate_g_test@127.0.0.1:55435/gate_g_20260926_scheduler';

test('bounded host resource sync scheduling through the durable worker queue', { skip: !assigned, timeout: 180_000 }, async (t) => {
  process.env.DEFT_APPS_ENABLED = 'true';
  process.env.DEFT_APP_RUNS_ENABLED = 'true';
  process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
  process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true';
  delete process.env.DEFT_APP_RESOURCE_SYNC_SCHEDULER_ENABLED;
  const key = (purpose: string) => createHash('sha256').update(`scheduler:${purpose}`).digest('base64');
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: { current: 'scan-enc', keys: { 'scan-enc': key('enc') } },
    receipt_signing: { current: 'scan-sig', keys: { 'scan-sig': key('sig') } },
    fingerprint: { current: 'scan-fp', keys: { 'scan-fp': key('fp') } } });
  const [{ db, closeDb }, schema, { and, eq, sql }, fixture, keyrings, repositories,
    secretsModule, inputsModule, syncModule, admissionModule, runnerModule, providerModule,
    attemptQueue, queue, scanner, workers, channelModule, storeModule, receiptModule, apps] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'),
    import('./fixtures/resource-sync-v5.js'), import('../src/lib/app-run-keyrings.js'),
    import('../src/lib/app-run-repository.js'), import('../src/lib/app-run-secrets.js'),
    import('../src/lib/app-run-secret-repository.js'), import('../src/lib/app-resource-sync-secrets.js'),
    import('../src/lib/app-resource-sync-admission.js'), import('../src/lib/app-run-attempt-runner.js'),
    import('../src/lib/app-run-provider-executor.js'), import('../src/lib/app-run-scheduler.js'),
    import('../src/lib/queues.js'), import('../src/lib/app-resource-sync-scanner.js'),
    import('../src/workers/index.js'), import('../src/lib/app-resource-sync-channel.js'),
    import('../src/lib/app-resource-sync-store.js'), import('../src/lib/app-run-receipts.js'),
    import('../src/lib/app-service.js'),
  ]);
  const keys = keyrings.parseEnvironmentAppRunKeyrings(process.env.DEFT_APP_RUN_KEYRINGS);
  let checkedAt = new Date();
  const clock = () => new Date(checkedAt);
  const repository = new repositories.PostgresAppRunRepository();
  const secrets = new secretsModule.AppRunSecretService(keys);
  const inputs = new inputsModule.AppRunSecretRepository(secrets);
  const syncSecrets = new syncModule.AppResourceSyncSecretService(keys);
  const runner = new runnerModule.AppRunAttemptRunner(repository, inputs, secrets,
    new providerModule.PinnedMcpAppRunProviderExecutor(), undefined, clock, 60_000, 20_000,
    new receiptModule.PostgresAppRunReceiptWriter(secrets, inputs), undefined,
    attemptQueue.postgresAppRunAttemptQueue, new storeModule.AppResourceSyncStore(syncSecrets, inputs));
  const admission = new admissionModule.AppResourceSyncAdmissionService(repository, inputs,
    secrets, syncSecrets, runner, clock, () => true);
  const channel = new channelModule.AppResourceSyncChannel(runner);
  const fixtures: Awaited<ReturnType<typeof fixture.createReviewedResourceSyncFixture>>[] = [];
  const makeFixture = async () => {
    const item = await fixture.createReviewedResourceSyncFixture({ keys, clock });
    fixtures.push(item);
    return item;
  };
  const scanJobs = () => db.select().from(schema.jobQueue)
    .where(eq(schema.jobQueue.name, scanner.APP_RESOURCE_SYNC_SCAN_JOB));
  const claim = async () => {
    await scanner.ensureAppResourceSyncScan(0);
    await db.update(schema.jobQueue).set({ run_at: sql`now()` }).where(and(
      eq(schema.jobQueue.name, scanner.APP_RESOURCE_SYNC_SCAN_JOB), eq(schema.jobQueue.status, 'pending')));
    const job = await queue.dequeueJob(queue.QUEUE_NAMES.SCHEDULED_JOBS,
      { jobName: scanner.APP_RESOURCE_SYNC_SCAN_JOB, leaseMs: 60_000 });
    assert.ok(job);
    return job;
  };
  const runPage = async () => {
    const job = await claim();
    const result = await scanner.scanAppResourceSyncBindings(job, admission);
    assert.equal(await queue.completeJob(job.id, job.lockToken), true);
    return result;
  };
  const runCount = async (orgId: string) => (await db.select({ id: schema.appRuns.id })
    .from(schema.appRuns).where(eq(schema.appRuns.org_id, orgId))).length;
  const revokeAll = async () => {
    for (const item of fixtures) await item.management.revokeConsent(item.owner_actor, item.binding_id);
  };
  try {
    // Permit reruns only in this exact dedicated DB. Retain all source cursors,
    // generations, intents and Runs; revoke prior synthetic consent instead of
    // deleting the execution evidence. Queue position is operational metadata.
    await db.update(schema.appResourceBindings).set({ state: 'revoked' })
      .where(eq(schema.appResourceBindings.state, 'active'));
    await db.update(schema.jobQueue).set({ status: 'failed', completed_at: new Date(),
      data: { after_binding_id: null }, lock_token: null, lock_expires_at: null })
      .where(eq(schema.jobQueue.name, scanner.APP_RESOURCE_SYNC_SCAN_JOB));
    const baselineJobCount = (await scanJobs()).length;
    await t.test('scheduler is default-off and requires exact scheduler and channel gates', async () => {
      await scanner.ensureAppResourceSyncScan(0);
      assert.equal((await scanJobs()).length, baselineJobCount);
      assert.equal((await scanner.scanAppResourceSyncBindings({ id: 'disabled', lockToken: 'disabled' },
        { admitDue: async () => { throw new Error('disabled scanner called admission'); } })).state, 'disabled');
      process.env.DEFT_APP_RESOURCE_SYNC_SCHEDULER_ENABLED = 'TRUE';
      await scanner.ensureAppResourceSyncScan(0);
      assert.equal((await scanJobs()).length, baselineJobCount);
      process.env.DEFT_APP_RESOURCE_SYNC_SCHEDULER_ENABLED = 'true';
      process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'false';
      await scanner.ensureAppResourceSyncScan(0);
      assert.equal((await scanJobs()).length, baselineJobCount);
      process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true';
      assert.equal(typeof await workers._getScheduledJobHandlerForTest(scanner.APP_RESOURCE_SYNC_SCAN_JOB), 'function');
    });

    await t.test('twenty-binding pages converge concurrent jobs and preserve restart scan fairness', async () => {
      for (let i = 0; i < 21; i += 1) await makeFixture();
      const ordered = [...fixtures].sort((a, b) => a.binding_id.localeCompare(b.binding_id));
      await Promise.all([scanner.ensureAppResourceSyncScan(0), scanner.ensureAppResourceSyncScan(0)]);
      assert.equal((await scanJobs()).filter((job) => job.status === 'pending').length, 1);
      const job = await claim();
      let release!: () => void;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      let first = true;
      const started = performance.now();
      const primary = scanner.scanAppResourceSyncBindings(job, { async admitDue(target, limits) {
        if (first) { first = false; entered(); await held; }
        return admission.admitDue(target, limits);
      } });
      await ready;
      try { assert.equal((await scanner.scanAppResourceSyncBindings(job, admission)).state, 'busy'); }
      finally { release(); }
      const page = await primary;
      assert.equal(page.inspected, 20);
      assert.equal(page.created, 20);
      assert.equal(page.wrapped, false);
      const elapsedMs = performance.now() - started;
      t.diagnostic(JSON.stringify({ measured_page_bindings: page.inspected, elapsed_ms: Math.round(elapsedMs), cadence_ms: scanner.APP_RESOURCE_SYNC_SCAN_INTERVAL_MS }));
      assert.ok(elapsedMs < 20_000, 'measured 20-binding scan fits the provisional page budget');
      const [stored] = await db.select().from(schema.jobQueue).where(eq(schema.jobQueue.id, job.id));
      assert.deepEqual(stored?.data, { after_binding_id: ordered[19]!.binding_id });
      assert.equal(await queue.completeJob(job.id, job.lockToken), true);
      await scanner.ensureAppResourceSyncScan();
      const pending = (await scanJobs()).find((row) => row.status === 'pending');
      assert.ok(pending);
      assert.deepEqual(pending.data, stored?.data, 'new process/occurrence resumes durable queue position');
      assert.ok(pending.run_at.getTime() - pending.created_at.getTime() >= 59_000,
        'normal recurrence waits sixty seconds');
      await db.update(schema.jobQueue).set({ run_at: sql`now()` }).where(eq(schema.jobQueue.id, pending.id));
      const restarted = await promisify(execFile)(process.execPath, ['--import', 'tsx',
        fileURLToPath(new URL('./fixtures/resource-sync-scan-process.ts', import.meta.url))],
      { timeout: 60_000, windowsHide: true });
      const report = restarted.stdout.split(/\r?\n/).find((line) => line.startsWith('scheduler-restart:'));
      assert.ok(report, 'fresh process reports its actual durable scan');
      const next = JSON.parse(report.slice('scheduler-restart:'.length));
      assert.equal(next.created, 1);
      assert.equal(next.inspected, 1);
      assert.equal(next.wrapped, true);
      for (const item of fixtures) assert.equal(await runCount(item.org_id), 1);
      const repeat = await runPage();
      assert.equal(repeat.created, 0);
      assert.equal(repeat.existing, 20);
      for (const item of fixtures) assert.equal(await runCount(item.org_id), 1);
      // Finish the pass before isolating later fixture cohorts.
      await runPage();
      await revokeAll();
    });

    await t.test('revoked expired disabled owner-lost and operator-lost bindings cannot admit and cannot starve healthy work', async () => {
      const revoked = await makeFixture();
      await revoked.management.revokeConsent(revoked.owner_actor, revoked.binding_id);
      const expired = await makeFixture();
      checkedAt = new Date(checkedAt.getTime() + 60 * 60_000 + 1);
      const disabled = await makeFixture();
      const [installation] = await db.select().from(schema.appInstallations)
        .where(eq(schema.appInstallations.id, disabled.installation_id));
      assert.ok(installation);
      await apps.disableAppInstallation(disabled.owner_actor, disabled.installation_id, installation.lifecycle_epoch);
      const ownerLost = await makeFixture();
      const operatorLost = await makeFixture();
      for (const [item, userId] of [[ownerLost, ownerLost.owner_user_id],
        [operatorLost, operatorLost.operator_user_id]] as const) {
        await db.update(schema.orgMembers).set({ is_active: false }).where(and(
          eq(schema.orgMembers.org_id, item.org_id), eq(schema.orgMembers.user_id, userId)));
      }
      const paused = await makeFixture();
      await db.update(schema.appSyncCheckpoints).set({ state: 'paused' })
        .where(eq(schema.appSyncCheckpoints.id, paused.checkpoint_id));
      const healthy = await makeFixture();
      const result = await runPage();
      assert.equal(result.created, 1);
      assert.equal(result.rejected, 5);
      assert.equal(result.wrapped, true);
      for (const item of [revoked, expired, disabled, ownerLost, operatorLost, paused]) {
        assert.equal(await runCount(item.org_id), 0);
      }
      assert.equal(await runCount(healthy.org_id), 1);
      for (const [item, userId] of [[ownerLost, ownerLost.owner_user_id],
        [operatorLost, operatorLost.operator_user_id]] as const) {
        await db.update(schema.orgMembers).set({ is_active: true }).where(and(
          eq(schema.orgMembers.org_id, item.org_id), eq(schema.orgMembers.user_id, userId)));
      }
      await revokeAll();
    });

    await t.test('interrupted and terminally failed scan retains per-binding progress and isolates lock contention', async () => {
      const cohort = await Promise.all([makeFixture(), makeFixture(), makeFixture()]);
      cohort.sort((a, b) => a.binding_id.localeCompare(b.binding_id));
      let release!: () => void;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const holder = db.transaction(async (tx) => {
        await tx.select().from(schema.appSyncCheckpoints)
          .where(eq(schema.appSyncCheckpoints.id, cohort[0]!.checkpoint_id)).for('update');
        entered(); await held;
      });
      await ready;
      const job = await claim();
      const abort = new AbortController();
      const started = performance.now();
      let page;
      try {
        page = await scanner.scanAppResourceSyncBindings({ ...job, signal: abort.signal }, {
          async admitDue(target, limits) {
            try { return await admission.admitDue(target, limits); }
            finally { abort.abort(); }
          },
        });
      } finally { release(); await holder; }
      assert.equal(page.inspected, 1);
      assert.equal(page.rejected, 1);
      assert.ok(performance.now() - started < 5_000, 'locked binding is bounded by lock_timeout');
      const [stored] = await db.select().from(schema.jobQueue).where(eq(schema.jobQueue.id, job.id));
      assert.deepEqual(stored?.data, { after_binding_id: cohort[0]!.binding_id });
      assert.equal(await queue.failJob(job.id, job.lockToken, 'synthetic interruption', { terminal: true }), true);
      assert.equal((await runPage()).created, 2, 'replacement continues after unhealthy binding');
      assert.equal(await runCount(cohort[0]!.org_id), 0);
      assert.equal((await runPage()).created, 1, 'wrapped pass retries failed pre-admission work safely');
      for (const item of cohort) assert.equal(await runCount(item.org_id), 1);
      await revokeAll();
    });

    await t.test('lost queue lease and consent revoked after selection cannot admit work', async () => {
      const owned = await makeFixture();
      const job = await claim();
      await assert.rejects(scanner.scanAppResourceSyncBindings({ ...job, lockToken: 'stale-token' },
        { admitDue: async () => { throw new Error('stale lease reached admission'); } }),
      /Resource sync scan lease unavailable/);
      const result = await scanner.scanAppResourceSyncBindings(job, { async admitDue(target, limits) {
        await owned.management.revokeConsent(owned.owner_actor, owned.binding_id);
        return admission.admitDue(target, limits);
      } });
      assert.equal(result.inspected, 1);
      assert.equal(result.rejected, 1);
      assert.equal(await runCount(owned.org_id), 0);
      assert.equal(await queue.completeJob(job.id, job.lockToken), true);
    });

    await t.test('admission deadline and cancellation roll back Run input intent attempt and queue together', async () => {
      const owned = await makeFixture();
      const target = { org_id: owned.org_id, resource_binding_id: owned.binding_id };
      await assert.rejects(admission.admitDue(target, { lock_timeout_ms: 500,
        statement_timeout_ms: 2_000, deadline_at: new Date(0) }));
      const abort = new AbortController();
      const cancelled = new admissionModule.AppResourceSyncAdmissionService(repository, inputs,
        secrets, syncSecrets, { async scheduleResourceSyncInTransaction(tx, run, now) {
          const id = await runner.scheduleResourceSyncInTransaction(tx, run, now);
          abort.abort();
          return id;
        } }, clock, () => true);
      await assert.rejects(cancelled.admitDue(target, { lock_timeout_ms: 500,
        statement_timeout_ms: 2_000, deadline_at: new Date(Date.now() + 60_000), signal: abort.signal }));
      for (const table of [schema.appRuns, schema.appSyncIntents, schema.appRunAttempts,
        schema.appRunSecretPayloads, schema.jobQueue]) {
        assert.equal((await db.select({ id: table.id }).from(table)
          .where(eq(table.org_id, owned.org_id))).length, 0);
      }
      assert.equal((await runPage()).created, 1, 'safe pre-admission cancellation leaves no cursor intent');
      await revokeAll();
    });

    await t.test('settled cursors obey interval and post-start unknown work never automatically creates another Run', async () => {
      const success = await makeFixture();
      const uncertain = await makeFixture();
      assert.equal((await runPage()).created, 2);
      for (const [item, succeeds] of [[success, true], [uncertain, false]] as const) {
        const issued = await item.management.issueOperatorSession(item.operator_actor, item.binding_id);
        const base = { schema_version: 'deft.app_runtime_channel.v2' as const,
          audience: 'app_resource_sync' as const, session_id: issued.session_id, session_token: issued.session_token };
        const claimed = await channel.claim({ ...base, max_claims: 1 });
        assert.ok(claimed);
        const attempt = { ...base, run_id: claimed.run_id, attempt_id: claimed.attempt_id,
          claim_token: claimed.claim_token, sequence: claimed.sequence };
        assert.ok(await channel.start(attempt));
        assert.equal(await channel.start(attempt), null, 'one input release');
        const completed = await channel.complete({ ...attempt,
          ...(succeeds ? { status: 'returned', provider_succeeded: true, page: { schema_version: 'deft.app_sync_page.v1' as const,
            upserts: [], tombstones: [], next_cursor: 'next-private-cursor', has_more: false } } : { status: 'not_attempted', error_code: 'APP_RUN_PROVIDER_UNAVAILABLE' }) });
        assert.ok(completed);
      }
      const immediate = await runPage();
      assert.equal(immediate.not_due, 1);
      assert.equal(immediate.blocked, 1);
      checkedAt = new Date(checkedAt.getTime() + 61_000);
      const due = await runPage();
      assert.equal(due.created, 1);
      assert.equal(due.blocked, 1);
      assert.equal(await runCount(success.org_id), 2);
      assert.equal(await runCount(uncertain.org_id), 1);
      const [unknown] = await db.select().from(schema.appRuns).where(eq(schema.appRuns.org_id, uncertain.org_id));
      assert.equal(unknown?.state, 'unknown_outcome');
      const [checkpoint] = await db.select().from(schema.appSyncCheckpoints)
        .where(eq(schema.appSyncCheckpoints.id, uncertain.checkpoint_id));
      assert.equal(checkpoint?.cursor_sequence, 0);
      assert.equal(checkpoint?.generation, 1);
      await revokeAll();
    });

    await t.test('actual scheduled worker routes leased scan and shutdown gate stops recurrence', async () => {
      const owned = await makeFixture();
      const job = await claim();
      await workers._processDequeuedJobForTest(queue.QUEUE_NAMES.SCHEDULED_JOBS, job);
      assert.equal(await runCount(owned.org_id), 1);
      const [finished] = await db.select().from(schema.jobQueue).where(eq(schema.jobQueue.id, job.id));
      assert.equal(finished?.status, 'completed');
      const next = await claim();
      process.env.DEFT_APP_RESOURCE_SYNC_SCHEDULER_ENABLED = 'false';
      await workers._processDequeuedJobForTest(queue.QUEUE_NAMES.SCHEDULED_JOBS, next);
      assert.equal((await scanJobs()).filter((row) => ['pending', 'running'].includes(row.status)).length, 0);
      await revokeAll();
    });
  } finally {
    await (await import('../src/lib/app-run-runtime.js')).shutdownAppRunRuntime();
    keys.destroy();
    await closeDb();
  }
});
