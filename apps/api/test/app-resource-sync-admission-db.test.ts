import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { AppRunTransaction } from '../src/lib/app-run-repository.js';

const assigned = process.env.DATABASE_URL === process.env.DEFT_TEST_DATABASE_URL
  && process.env.DATABASE_URL === 'postgresql://gate_g_test@127.0.0.1:55435/gate_g_phase5_test_s06_admission';

test('host sync admission atomically creates one due intent and refuses stale or repeated authority', {
  skip: !assigned,
}, async () => {
  process.env.DEFT_APPS_ENABLED = 'true';
  process.env.DEFT_APP_RUNS_ENABLED = 'true';
  process.env.DEFT_APP_RUN_APP_ORIGIN_ENABLED = 'true';
  process.env.DEFT_APP_RESOURCE_SYNC_CHANNEL_ENABLED = 'true';
  const key = (purpose: string) => createHash('sha256').update(`s06-admission:${purpose}`).digest('base64');
  process.env.DEFT_APP_RUN_KEYRINGS = JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: { current: 'admit-enc', keys: { 'admit-enc': key('enc') } },
    receipt_signing: { current: 'admit-sig', keys: { 'admit-sig': key('sig') } },
    fingerprint: { current: 'admit-fp', keys: { 'admit-fp': key('fp') } } });
  const [{ db, closeDb }, schema, { and, eq, sql }, fixture, keyrings, repositories,
    runSecretModule, inputModule, syncSecretModule, admissionModule, runnerModule,
    providers, queues, access, operations] = await Promise.all([
    import('../src/lib/db.js'), import('@deft/db/schema'), import('drizzle-orm'),
    import('./fixtures/resource-sync-v5.js'), import('../src/lib/app-run-keyrings.js'),
    import('../src/lib/app-run-repository.js'), import('../src/lib/app-run-secrets.js'),
    import('../src/lib/app-run-secret-repository.js'), import('../src/lib/app-resource-sync-secrets.js'),
    import('../src/lib/app-resource-sync-admission.js'), import('../src/lib/app-run-attempt-runner.js'),
    import('../src/lib/app-run-provider-executor.js'), import('../src/lib/app-run-scheduler.js'),
    import('../src/lib/app-run-authorization.js'), import('../src/lib/app-run-operations.js'),
  ]);
  const keys = keyrings.parseEnvironmentAppRunKeyrings(process.env.DEFT_APP_RUN_KEYRINGS);
  let checkedAt = new Date();
  const clock = () => new Date(checkedAt);
  const marker = `sync-admission-${randomUUID()}`;
  class TestRepository extends repositories.PostgresAppRunRepository {
    override transaction<T>(work: (tx: AppRunTransaction) => Promise<T>): Promise<T> {
      return super.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('application_name', ${marker}, true)`);
        await tx.execute(sql`SET LOCAL lock_timeout = '8s'`);
        return work(tx);
      });
    }
  }
  const repository = new TestRepository();
  const runSecrets = new runSecretModule.AppRunSecretService(keys);
  const inputs = new inputModule.AppRunSecretRepository(runSecrets);
  const syncSecrets = new syncSecretModule.AppResourceSyncSecretService(keys);
  const runner = new runnerModule.AppRunAttemptRunner(repository, inputs, runSecrets,
    new providers.PinnedMcpAppRunProviderExecutor(), undefined, clock, 60_000,
    20_000, undefined, undefined, queues.postgresAppRunAttemptQueue);
  const admission = new admissionModule.AppResourceSyncAdmissionService(repository, inputs,
    runSecrets, syncSecrets, runner, clock, () => true);
  const denied = (error: unknown) => (error as { code?: string }).code === 'APP_ACCESS_DENIED';
  try {
    const owned = await fixture.createReviewedResourceSyncFixture({ keys, clock });
    const target = { org_id: owned.org_id, resource_binding_id: owned.binding_id };
    const disabled = new admissionModule.AppResourceSyncAdmissionService(repository, inputs,
      runSecrets, syncSecrets, runner, clock);
    await assert.rejects(disabled.admitDue(target), (error: unknown) =>
      (error as { code?: string }).code === 'APP_FEATURE_DISABLED');
    await assert.rejects(admission.admitDue({ ...target, owner_user_id: owned.owner_user_id }));
    await assert.rejects(admission.admitDue({ ...target, org_id: randomUUID() }), denied);
    const concurrent = await Promise.all([admission.admitDue(target), admission.admitDue(target)]);
    assert.deepEqual(concurrent.map((result) => result.state).sort(), ['created', 'existing']);
    const created = concurrent.find((result) => result.state === 'created');
    assert.ok(created && created.state === 'created');
    const existing = concurrent.find((result) => result.state === 'existing');
    assert.ok(existing && existing.state === 'existing');
    assert.equal(existing.run_id, created.run_id);
    const runs = await db.select().from(schema.appRuns).where(eq(schema.appRuns.org_id, owned.org_id));
    assert.equal(runs.length, 1);
    const run = runs[0]!;
    assert.equal(run.origin_resource_binding_id, owned.binding_id);
    assert.equal(run.origin_runtime_binding_id, null);
    assert.equal(run.execution_actor_type, 'system');
    assert.equal(run.execution_actor_id, owned.binding_id);
    assert.equal(run.initiating_actor_id, owned.binding_id);
    assert.equal(run.review_scope, 'reviewed_resource_sync');
    assert.equal(run.state, 'pending');
    assert.equal(run.execution_release_kind, 'policy_satisfied');
    assert.equal(run.origin_app_grant_snapshot_id, owned.grant_snapshot_id);
    const [binding] = await db.select().from(schema.appResourceBindings)
      .where(eq(schema.appResourceBindings.id, owned.binding_id));
    assert.ok(binding);
    assert.deepEqual(await inputs.readInput(owned.org_id, run.id), {
      schema_version: 'deft.app_sync_request.v1', cursor: null,
      max_items: binding.max_records_per_page,
    });
    const intents = await db.select().from(schema.appSyncIntents)
      .where(eq(schema.appSyncIntents.org_id, owned.org_id));
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.checkpoint_id, owned.checkpoint_id);
    assert.equal(intents[0]!.expected_cursor_sequence, 0);
    assert.equal(intents[0]!.owner_user_id, owned.owner_user_id);
    assert.equal(intents[0]!.descriptor_digest, binding.descriptor_digest);
    const attempts = await db.select().from(schema.appRunAttempts)
      .where(eq(schema.appRunAttempts.org_id, owned.org_id));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.id, created.attempt_id);
    const jobs = await db.select().from(schema.jobQueue).where(and(
      eq(schema.jobQueue.org_id, owned.org_id),
      eq(schema.jobQueue.dedupe_key, `app-run-attempt:${created.attempt_id}`)));
    assert.equal(jobs.length, 1, 'attempt queue is committed with Run/input/intent');
    assert.equal(run.safe_preview.title, 'Sync private App resource');
    assert.deepEqual(run.safe_preview.resource_refs, []);
    const events = await db.select().from(schema.appRunEvents)
      .where(eq(schema.appRunEvents.run_id, run.id));
    assert.deepEqual(events.map((event) => event.event_type).sort(), ['attempt_created', 'run_created']);
    const safeRun = await repository.inspect(owned.org_id, run.id);
    assert.ok(safeRun);
    const authorizer = new access.PostgresAppRunAuthorizer();
    for (const action of ['inspect', 'result'] as const) {
      assert.equal(await authorizer.authorize({ action, org_id: owned.org_id,
        actor: { actor_type: 'human', user_id: owned.owner_user_id }, run: safeRun,
        required_authority_ref: null }), false, 'ordinary human Run entrance cannot read system sync');
    }
    const ops = new operations.AppRunOperationsService(repository,
      operations.postgresAppRunReadOperationsAuthorizer);
    const operational = await ops.list({ org_id: owned.org_id,
      actor: { actor_type: 'human', user_id: owned.owner_user_id } });
    assert.equal(operational.length, 1);
    const safeJson = JSON.stringify(operational);
    assert.ok(!safeJson.includes(owned.owner_user_id) && !safeJson.includes(owned.operator_user_id));
    for (const privateField of ['authorization_snapshot', 'cursor', 'input', 'output',
      'reviewed_descriptor', 'owner_user_id', 'record_schema']) {
      assert.equal(privateField in operational[0]!, false);
    }
    // Operational managers retain generic infrastructure IDs and state only.
    assert.equal(operational[0]!.initiating_actor_id, owned.binding_id);
    assert.equal(operational[0]!.execution_actor_id, owned.binding_id);
    await assert.rejects(ops.list({ org_id: owned.org_id,
      actor: { actor_type: 'human', user_id: owned.operator_user_id } }));

    const rotatedEnvironment = JSON.parse(process.env.DEFT_APP_RUN_KEYRINGS!);
    rotatedEnvironment.fingerprint.current = 'admit-fp2';
    rotatedEnvironment.fingerprint.keys['admit-fp2'] = key('fp2');
    const rotatedKeys = keyrings.parseEnvironmentAppRunKeyrings(JSON.stringify(rotatedEnvironment));
    try {
      const rotatedRunSecrets = new runSecretModule.AppRunSecretService(rotatedKeys);
      const rotatedAdmission = new admissionModule.AppResourceSyncAdmissionService(repository,
        new inputModule.AppRunSecretRepository(rotatedRunSecrets), rotatedRunSecrets,
        new syncSecretModule.AppResourceSyncSecretService(rotatedKeys), runner, clock, () => true);
      assert.deepEqual(await rotatedAdmission.admitDue(target), { state: 'existing', run_id: run.id });
    } finally { rotatedKeys.destroy(); }

    // Cancel through the existing transition seam. The checkpoint is still
    // unchanged; a terminal intent must not silently create another Run.
    await repository.transaction(async (tx) => {
      const current = await repository.lockRun(tx, owned.org_id, run.id);
      assert.ok(current);
      await tx.update(schema.appRunAttempts).set({ state: 'cancelled', updated_at: clock() })
        .where(eq(schema.appRunAttempts.id, created.attempt_id));
      await repository.transition(tx, { run: current, state: 'cancelled', now: clock() });
    });
    assert.deepEqual(await admission.admitDue(target), {
      state: 'blocked', reason: 'cursor_requires_recovery',
    });

    const rollbackFixture = await fixture.createReviewedResourceSyncFixture({ keys, clock });
    const missingEnvironment = JSON.parse(process.env.DEFT_APP_RUN_KEYRINGS!);
    missingEnvironment.fingerprint = { current: 'admit-fp2', keys: { 'admit-fp2': key('fp2') } };
    const missingKeys = keyrings.parseEnvironmentAppRunKeyrings(JSON.stringify(missingEnvironment));
    try {
      const missingSecrets = new runSecretModule.AppRunSecretService(missingKeys);
      const missingAdmission = new admissionModule.AppResourceSyncAdmissionService(repository,
        new inputModule.AppRunSecretRepository(missingSecrets), missingSecrets,
        new syncSecretModule.AppResourceSyncSecretService(missingKeys), runner, clock, () => true);
      await assert.rejects(missingAdmission.admitDue({ org_id: rollbackFixture.org_id,
        resource_binding_id: rollbackFixture.binding_id }), (error: unknown) =>
        (error as { code?: string }).code === 'APP_RUN_KEY_VERSION_UNAVAILABLE');
      assert.equal((await db.select({ id: schema.appRuns.id }).from(schema.appRuns)
        .where(eq(schema.appRuns.org_id, rollbackFixture.org_id))).length, 0);
    } finally { missingKeys.destroy(); }
    const injected = new Error('fault after durable attempt and queue insertion');
    const rollbackAdmission = new admissionModule.AppResourceSyncAdmissionService(repository, inputs,
      runSecrets, syncSecrets, { async scheduleResourceSyncInTransaction(tx, current, now) {
        assert.ok(await runner.scheduleResourceSyncInTransaction(tx, current, now));
        throw injected;
      } }, clock, () => true);
    await assert.rejects(rollbackAdmission.admitDue({ org_id: rollbackFixture.org_id,
      resource_binding_id: rollbackFixture.binding_id }), (error) => error === injected);
    for (const table of [schema.appRuns, schema.appRunAttempts, schema.appRunSecretPayloads,
      schema.appSyncIntents, schema.appRunEvents, schema.jobQueue]) {
      assert.equal((await db.select({ id: table.id }).from(table)
        .where(eq(table.org_id, rollbackFixture.org_id))).length, 0,
      'failed admission leaves no Run/input/intent/attempt/event/queue rows');
    }

    // Prove the post-checkpoint-lock clock is authoritative, not a timestamp
    // captured before waiting. Observe PostgreSQL's actual lock wait.
    const expiring = await fixture.createReviewedResourceSyncFixture({ keys, clock });
    let unlock!: () => void;
    let locked!: () => void;
    const lockReady = new Promise<void>((resolve) => { locked = resolve; });
    const release = new Promise<void>((resolve) => { unlock = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select().from(schema.appSyncCheckpoints)
        .where(eq(schema.appSyncCheckpoints.id, expiring.checkpoint_id)).for('update');
      locked();
      await release;
    });
    await lockReady;
    const pending = assert.rejects(admission.admitDue({ org_id: expiring.org_id,
      resource_binding_id: expiring.binding_id }), denied);
    try {
      let waiting = false;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const result = await db.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE application_name = ${marker} AND wait_event_type = 'Lock'`);
        if (Number((result as { rows: Array<{ count: number }> }).rows[0]?.count) > 0) {
          waiting = true;
          break;
        }
        await delay(10);
      }
      assert.ok(waiting, 'admission must actually wait on the locked checkpoint');
      checkedAt = new Date(checkedAt.getTime() + 91 * 24 * 60 * 60 * 1_000);
    } finally { unlock(); await holder; }
    await pending;
    assert.equal((await db.select({ id: schema.appRuns.id }).from(schema.appRuns)
      .where(eq(schema.appRuns.org_id, expiring.org_id))).length, 0);
  } finally { keys.destroy(); await closeDb(); }
});
