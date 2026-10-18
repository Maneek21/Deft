import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { mcpClientManager } from '@deft/mcp';
import { db, closeDb } from '../src/lib/db.js';
import { createAppAutomationScanDatabase } from '../src/lib/app-automation-scan-db.js';
import { APP_AUTOMATION_SCAN_CRON, initialAppAutomationScanProgress, saveAppAutomationScanProgress,
  ensureAppAutomationScan, loadAppAutomationScanProgress } from '../src/lib/app-automation-scan-progress.js';
import { ensureCronJob, dequeueJob, completeJob, QUEUE_NAMES } from '../src/lib/queues.js';
import { persistAppAutomationFire, pauseAppAutomationDefinition } from '../src/lib/app-automation-definition-service.js';
import { runAppAutomationScan } from '../src/lib/app-automation-runtime.js';
import { createAutomationRenewalFixture } from './fixtures/app-automation-renewal.js';
import { _processDequeuedJobForTest } from '../src/workers/index.js';

const url = process.env.DATABASE_URL;
const safe = url === process.env.DEFT_TEST_DATABASE_URL
  && url === 'postgresql://gate_g_test@127.0.0.1:55435/gate_g_20260926_a05_continuation_test';
process.env.DEFT_SELF_HOSTED = 'true';
process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO = 'true';
process.env.MCP_STDIO_ALLOWED_COMMANDS = process.execPath;
after(async () => { await mcpClientManager.shutdown(); await closeDb(); });

test('A05 progress rejects a lease that expires during an unchanged queue row lock wait', { skip: !safe }, async () => {
  const locker = new pg.Client({ connectionString: url });
  await locker.connect();
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'app-automation-scan', APP_AUTOMATION_SCAN_CRON, {}, 0);
  const job = await dequeueJob(QUEUE_NAMES.SCHEDULED_JOBS, { jobName: 'app-automation-scan', leaseMs: 100 });
  assert.ok(job);
  await locker.query('BEGIN');
  await locker.query('SELECT id FROM job_queue WHERE id=$1 FOR UPDATE', [job.id]);
  const next = initialAppAutomationScanProgress();
  next.fires.after = { organization_id: 'tenant', fire_id: 'fire' };
  const release = setTimeout(() => { void locker.query('ROLLBACK'); }, 150);
  try {
    await assert.rejects(saveAppAutomationScanProgress(job, next), /lease lost/);
    assert.deepEqual((await locker.query('SELECT data FROM job_queue WHERE id=$1', [job.id])).rows[0].data, {});
  } finally {
    clearTimeout(release); await locker.query('ROLLBACK');
    await locker.query('DELETE FROM job_queue WHERE id=$1', [job.id]); await locker.end();
  }
});

test('A05 progress rejects wrong queue name cron key and replaced lease token', { skip: !safe }, async () => {
  const observer = new pg.Client({ connectionString: url }); await observer.connect();
  try {
    for (const column of ['queue', 'name', 'cron_key', 'lock_token'] as const) {
      await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'app-automation-scan', APP_AUTOMATION_SCAN_CRON, {}, 0);
      const job = await dequeueJob(QUEUE_NAMES.SCHEDULED_JOBS, { jobName: 'app-automation-scan' }); assert.ok(job);
      await observer.query(`UPDATE job_queue SET ${column}=$2 WHERE id=$1`, [job.id, 'wrong-identity']);
      await assert.rejects(saveAppAutomationScanProgress(job, initialAppAutomationScanProgress()), /lease (lost|unavailable)/);
      assert.deepEqual((await observer.query('SELECT data FROM job_queue WHERE id=$1', [job.id])).rows[0].data, {});
      await observer.query('DELETE FROM job_queue WHERE id=$1', [job.id]);
    }
  } finally { await observer.query('DELETE FROM job_queue WHERE cron_key=$1', [APP_AUTOMATION_SCAN_CRON]); await observer.end(); }
});

test('A05 partial success retains hints and advances a maintenance-created successor without failure spinning', { skip: !safe }, async () => {
  const observer = new pg.Client({ connectionString: url }); await observer.connect();
  try {
    await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'app-automation-scan', APP_AUTOMATION_SCAN_CRON, {}, 0);
    const job = await dequeueJob(QUEUE_NAMES.SCHEDULED_JOBS, { jobName: 'app-automation-scan' }); assert.ok(job);
    const progress = initialAppAutomationScanProgress();
    progress.definitions.after = { organization_id: 'tenant', definition_id: 'definition' };
    await saveAppAutomationScanProgress(job, progress);
    assert.equal(await completeJob(job.id, job.lockToken), true);
    await ensureAppAutomationScan({ mode: 'startup' });
    let successor = (await observer.query("SELECT *,extract(epoch FROM run_at-clock_timestamp())*1000 AS delay_ms FROM job_queue WHERE cron_key=$1 AND status='pending'", [APP_AUTOMATION_SCAN_CRON])).rows[0];
    assert.ok(Number(successor.delay_ms) > 55_000, 'startup does not trust partial hints for an immediate loop');
    await ensureAppAutomationScan({ mode: 'success', completed_job_id: job.id });
    const claimed = await dequeueJob(QUEUE_NAMES.SCHEDULED_JOBS, { jobName: 'app-automation-scan' }); assert.ok(claimed);
    assert.deepEqual(await loadAppAutomationScanProgress(claimed), progress);
    await observer.query("UPDATE job_queue SET status='failed',lock_token=NULL,lock_expires_at=NULL WHERE id=$1", [claimed.id]);
    await ensureAppAutomationScan({ mode: 'failure' });
    successor = (await observer.query("SELECT *,extract(epoch FROM run_at-clock_timestamp())*1000 AS delay_ms FROM job_queue WHERE cron_key=$1 AND status='pending'", [APP_AUTOMATION_SCAN_CRON])).rows[0];
    assert.ok(Number(successor.delay_ms) > 55_000);
    assert.deepEqual(successor.data.automation_scan, progress);
  } finally { await observer.query('DELETE FROM job_queue WHERE cron_key=$1', [APP_AUTOMATION_SCAN_CRON]); await observer.end(); }
});

test('A05 simultaneous successor ensures and stale predecessor retain latest progress and recover retention loss', { skip: !safe }, async () => {
  const observer = new pg.Client({ connectionString: url }); await observer.connect();
  try {
    await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'app-automation-scan', APP_AUTOMATION_SCAN_CRON, {}, 0);
    const first = await dequeueJob(QUEUE_NAMES.SCHEDULED_JOBS, { jobName: 'app-automation-scan' }); assert.ok(first);
    const progress = initialAppAutomationScanProgress();
    progress.fires.after = { organization_id: 'tenant', fire_id: 'first' };
    await saveAppAutomationScanProgress(first, progress); await completeJob(first.id, first.lockToken);
    await Promise.all([ensureAppAutomationScan({ mode: 'success', completed_job_id: first.id }),
      ensureAppAutomationScan({ mode: 'success', completed_job_id: first.id })]);
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM job_queue WHERE cron_key=$1 AND status IN ('pending','running')", [APP_AUTOMATION_SCAN_CRON])).rows[0].count, 1);
    const second = await dequeueJob(QUEUE_NAMES.SCHEDULED_JOBS, { jobName: 'app-automation-scan' }); assert.ok(second);
    progress.fires.after.fire_id = 'second';
    await saveAppAutomationScanProgress(second, progress); await completeJob(second.id, second.lockToken);
    await ensureAppAutomationScan({ mode: 'success', completed_job_id: first.id });
    const next = (await observer.query("SELECT data,extract(epoch FROM run_at-clock_timestamp())*1000 AS delay_ms FROM job_queue WHERE cron_key=$1 AND status='pending'", [APP_AUTOMATION_SCAN_CRON])).rows[0];
    assert.deepEqual(next.data.automation_scan, progress); assert.ok(Number(next.delay_ms) > 55_000);
    await observer.query('DELETE FROM job_queue WHERE cron_key=$1', [APP_AUTOMATION_SCAN_CRON]);
    await ensureAppAutomationScan({ mode: 'startup' });
    assert.deepEqual((await observer.query('SELECT data FROM job_queue WHERE cron_key=$1', [APP_AUTOMATION_SCAN_CRON])).rows[0].data.automation_scan,
      initialAppAutomationScanProgress());
  } finally { await observer.query('DELETE FROM job_queue WHERE cron_key=$1', [APP_AUTOMATION_SCAN_CRON]); await observer.end(); }
});

test('A05 terminal unknown-handler settlement retains recurrence while stale owner cannot create successor', { skip: !safe }, async () => {
  const observer = new pg.Client({ connectionString: url }); await observer.connect();
  try {
    await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'app-automation-scan', APP_AUTOMATION_SCAN_CRON, {}, 0);
    const job = await dequeueJob(QUEUE_NAMES.SCHEDULED_JOBS, { jobName: 'app-automation-scan' }); assert.ok(job);
    const progress = initialAppAutomationScanProgress();
    progress.fires.after = { organization_id: 'tenant', fire_id: 'retained' };
    await saveAppAutomationScanProgress(job, progress);
    await _processDequeuedJobForTest(QUEUE_NAMES.SCHEDULED_JOBS, job, { resolveHandler: async () => null });
    const [next] = (await observer.query("SELECT data,extract(epoch FROM run_at-clock_timestamp())*1000 AS delay_ms FROM job_queue WHERE cron_key=$1 AND status='pending'", [APP_AUTOMATION_SCAN_CRON])).rows;
    assert.ok(next, 'terminal handler lookup failure keeps normal recurrence');
    assert.deepEqual(next.data.automation_scan, progress); assert.ok(Number(next.delay_ms) > 55_000);
    await observer.query("DELETE FROM job_queue WHERE cron_key=$1 AND status='pending'", [APP_AUTOMATION_SCAN_CRON]);
    await _processDequeuedJobForTest(QUEUE_NAMES.SCHEDULED_JOBS, job, { resolveHandler: async () => null });
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM job_queue WHERE cron_key=$1 AND status='pending'", [APP_AUTOMATION_SCAN_CRON])).rows[0].count, 0);
  } finally { await observer.query('DELETE FROM job_queue WHERE cron_key=$1', [APP_AUTOMATION_SCAN_CRON]); await observer.end(); }
});

test('A05 pending queue loss after definition expiry reaches an honest terminal outcome', { skip: !safe }, async () => {
  const fixture = await createAutomationRenewalFixture();
  const scheduledAt = new Date('2037-01-01T10:00:00Z');
  const { definition } = await fixture.create(scheduledAt, new Date('2037-01-01T09:59:59Z'), 2);
  const fire = await persistAppAutomationFire({ organization_id: fixture.orgId, definition_id: definition.id,
    expected_epoch: definition.definition_epoch, logical_local_date: '2037-01-01',
    resolution: { kind: 'resolved', resolved_at_utc: scheduledAt } }, { now: () => scheduledAt });
  const observer = new pg.Client({ connectionString: url }); await observer.connect();
  try {
    await runAppAutomationScan(scheduledAt);
    assert.equal((await observer.query("DELETE FROM job_queue WHERE name='app-automation-fire' AND data->>'fire_id'=$1 RETURNING id", [fire.id])).rowCount, 1);
    await runAppAutomationScan(new Date('2037-01-01T10:00:02Z'));
    assert.deepEqual((await observer.query('SELECT state,terminal_reason FROM app_automation_fires WHERE id=$1', [fire.id])).rows,
      [{ state: 'skipped', terminal_reason: 'definition_ineligible' }]);
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM job_queue WHERE data->>'fire_id'=$1", [fire.id])).rows[0].count, 0);
  } finally { await observer.end(); }
});

test('A05 delivery rearm rolls back when expiry passes during its queue row lock wait', { skip: !safe }, async () => {
  const fixture = await createAutomationRenewalFixture();
  const scheduledAt = new Date('2037-01-02T10:00:00Z');
  const { definition } = await fixture.create(scheduledAt, new Date('2037-01-02T09:59:59Z'), 2);
  const fire = await persistAppAutomationFire({ organization_id: fixture.orgId, definition_id: definition.id,
    expected_epoch: definition.definition_epoch, logical_local_date: '2037-01-02',
    resolution: { kind: 'resolved', resolved_at_utc: scheduledAt } }, { now: () => scheduledAt });
  await runAppAutomationScan(scheduledAt);
  const locker = new pg.Client({ connectionString: url }); await locker.connect();
  await locker.query("UPDATE job_queue SET status='failed' WHERE data->>'fire_id'=$1", [fire.id]);
  await locker.query('BEGIN');
  await locker.query("SELECT id FROM job_queue WHERE data->>'fire_id'=$1 FOR UPDATE", [fire.id]);
  const release = setTimeout(() => { void locker.query('ROLLBACK'); }, 150);
  try {
    await runAppAutomationScan(new Date('2037-01-02T10:00:00.900Z'));
    assert.equal((await locker.query("SELECT status FROM job_queue WHERE data->>'fire_id'=$1", [fire.id])).rows[0].status, 'failed');
    assert.equal((await locker.query('SELECT attempt_count FROM app_automation_fires WHERE id=$1', [fire.id])).rows[0].attempt_count, 0);
  } finally { clearTimeout(release); await locker.query('ROLLBACK'); await locker.end(); }
});

test('A05 initial enqueue and queue loss repair roll back across expiry catch-up and pause', { skip: !safe }, async () => {
  for (const mode of ['expiry', 'catch-up', 'pause'] as const) {
    const fixture = await createAutomationRenewalFixture();
    const scheduledAt = new Date('2037-01-03T10:00:00Z');
    const { definition } = await fixture.create(scheduledAt, new Date('2037-01-03T09:59:59Z'), mode === 'expiry' ? 2 : 3600);
    const fire = await persistAppAutomationFire({ organization_id: fixture.orgId, definition_id: definition.id,
      expected_epoch: definition.definition_epoch, logical_local_date: '2037-01-03',
      resolution: { kind: 'resolved', resolved_at_utc: scheduledAt } }, { now: () => scheduledAt });
    const locker = new pg.Client({ connectionString: url }); await locker.connect();
    let release: ReturnType<typeof setTimeout> | undefined;
    try {
      if (mode === 'pause') {
        await runAppAutomationScan(scheduledAt);
        assert.equal((await locker.query("DELETE FROM job_queue WHERE data->>'fire_id'=$1 RETURNING id", [fire.id])).rowCount, 1);
        await pauseAppAutomationDefinition(fixture.actor, { definition_id: definition.id, expected_epoch: definition.definition_epoch },
          { now: () => scheduledAt });
      } else {
        await locker.query('BEGIN'); await locker.query('LOCK TABLE job_queue IN ACCESS EXCLUSIVE MODE');
        release = setTimeout(() => { void locker.query('ROLLBACK'); }, 150);
      }
      const scanAt = mode === 'catch-up' ? new Date('2037-01-03T10:14:59.900Z')
        : new Date('2037-01-03T10:00:00.900Z');
      await runAppAutomationScan(scanAt);
      assert.equal((await locker.query("SELECT count(*)::int AS count FROM job_queue WHERE data->>'fire_id'=$1", [fire.id])).rows[0].count, 0);
      assert.equal((await locker.query('SELECT count(*)::int AS count FROM app_automation_fires WHERE definition_id=$1', [definition.id])).rows[0].count, 1);
      assert.deepEqual(await fixture.effects(), []);
    } finally { clearTimeout(release); await locker.query('ROLLBACK'); await locker.end(); }
  }
});

test('A05 cancellation after COMMIT admission reports the committed result without claiming rollback', { skip: !safe }, async () => {
  const scanner = createAppAutomationScanDatabase(url!);
  const observer = new pg.Client({ connectionString: url }); await observer.connect();
  await observer.query('CREATE TABLE a05_commit_probe (value integer)');
  await observer.query("CREATE FUNCTION a05_commit_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$");
  await observer.query('CREATE CONSTRAINT TRIGGER a05_commit_wait AFTER INSERT ON a05_commit_probe DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION a05_commit_wait()');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await scanner.transaction(async tx => {
      await tx.execute(sql`INSERT INTO a05_commit_probe VALUES (1)`);
      timer = setTimeout(() => controller.abort(new Error('lease lost during already-sent commit')), 50);
      return 'committed';
    }, controller.signal);
    assert.equal(controller.signal.aborted, true);
    assert.equal(result, 'committed');
    assert.deepEqual((await observer.query('SELECT value FROM a05_commit_probe')).rows, [{ value: 1 }]);
  } finally {
    clearTimeout(timer); await observer.query('DROP TABLE a05_commit_probe');
    await observer.query('DROP FUNCTION a05_commit_wait()'); await scanner.close(); await observer.end();
  }
});

test('A05 leased worker reaches healthy tenant beyond100 locked definitions within four slices and60seconds', { skip: !safe }, async () => {
  const fixtures = [await createAutomationRenewalFixture(), await createAutomationRenewalFixture()]
    .sort((a, b) => a.orgId.localeCompare(b.orgId));
  const early = fixtures[0]!; const healthy = fixtures[1]!;
  const previous = new pg.Client({ connectionString: url }); await previous.connect();
  const latestYear = Number((await previous.query("SELECT coalesce(max(extract(year FROM valid_until)),2040)::int AS year FROM app_automation_definitions")).rows[0].year);
  await previous.end();
  const year = Math.max(2041, latestYear + 1);
  const scheduledAt = new Date(`${year}-01-01T10:00:00Z`);
  const approvedAt = new Date(`${year}-01-01T09:59:59Z`);
  // Settle older test occurrences before freezing this fixture's empty
  // recovery catalog; its two organizations are the only eligible definitions.
  await runAppAutomationScan(scheduledAt);
  for (let index = 0; index < 100; index++) await early.create(scheduledAt, new Date(approvedAt.getTime() + index), 3600);
  const { definition } = await healthy.create(scheduledAt, approvedAt, 3600);
  const locker = new pg.Client({ connectionString: url }); await locker.connect();
  await locker.query('BEGIN');
  await locker.query('SELECT id FROM app_automation_definitions WHERE org_id=$1 FOR UPDATE', [early.orgId]);
  const durations: number[] = []; const queries: number[] = [];
  const started = performance.now();
  try {
    await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'app-automation-scan', APP_AUTOMATION_SCAN_CRON, {}, 0);
    for (let slice = 0; slice < 4; slice++) {
      const job = await dequeueJob(QUEUE_NAMES.SCHEDULED_JOBS, { jobName: 'app-automation-scan' }); assert.ok(job);
      const sliceStarted = performance.now();
      const work = _processDequeuedJobForTest(QUEUE_NAMES.SCHEDULED_JOBS, job, {
        resolveHandler: async () => async runtimeJob => runAppAutomationScan(scheduledAt, runtimeJob.signal,
          { id: runtimeJob.id, lockToken: runtimeJob.lockToken! }),
      });
      const queryStarted = performance.now(); await db.execute(sql`SELECT 1`); queries.push(performance.now() - queryStarted);
      await work; durations.push(performance.now() - sliceStarted);
      const found = await locker.query("SELECT count(*)::int AS count FROM job_queue WHERE name='app-automation-fire' AND data->>'definition_id'=$1", [definition.id]);
      if (found.rows[0].count === 1) break;
    }
    const elapsed = performance.now() - started;
    const found = await locker.query("SELECT count(*)::int AS count FROM job_queue WHERE name='app-automation-fire' AND data->>'definition_id'=$1", [definition.id]);
    const scannerConnections = (await locker.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND application_name='deft-app-automation-scanner'")).rows[0].count;
    console.log('A05_LOCKED_TENANT_WORKER_RESULT', JSON.stringify({ slices: durations.length, slice_ms: durations,
      end_to_end_ms: elapsed, ordinary_query_ms: queries, scanner_connections: scannerConnections }));
    assert.equal(found.rows[0].count, 1); assert.ok(elapsed <= 60_000);
    assert.ok(durations.every(duration => duration <= 12_000)); assert.ok(queries.every(duration => duration <= 1_000));
    assert.ok(scannerConnections <= 2);
  } finally {
    await locker.query('ROLLBACK');
    await locker.query('DELETE FROM job_queue WHERE cron_key=$1', [APP_AUTOMATION_SCAN_CRON]);
    await locker.end();
  }
});
