import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import pg from 'pg';
import { mcpClientManager } from '@deft/mcp';
import { sql } from 'drizzle-orm';
import { createAppAutomationScanDatabase } from '../src/lib/app-automation-scan-db.js';
import { persistAppAutomationFire } from '../src/lib/app-automation-definition-service.js';
import { claimAppAutomationFireWithExecutor } from '../src/lib/app-automation-repository.js';
import { runAppAutomationScan } from '../src/lib/app-automation-runtime.js';
import { createAutomationRenewalFixture } from './fixtures/app-automation-renewal.js';
import { handleAppAutomationScan } from '../src/workers/handlers/app-automation-scan.js';
import { db, closeDb } from '../src/lib/db.js';
import { enqueue, dequeueJob, type QueueName } from '../src/lib/queues.js';
import { _processDequeuedJobForTest, getWorkerStatus } from '../src/workers/index.js';

const url = process.env.DATABASE_URL;
const safe = url === process.env.DEFT_TEST_DATABASE_URL
  && url === 'postgresql://gate_g_test@127.0.0.1:55435/gate_g_20260926_a05_limits_test';
process.env.DEFT_SELF_HOSTED = 'true';
process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO = 'true';
process.env.MCP_STDIO_ALLOWED_COMMANDS = process.execPath;
after(async () => { await mcpClientManager.shutdown(); await closeDb(); });

test('A05 worker ordinary Error abort settles a held catalog lock without subsequent scan work', { skip: !safe }, async () => {
  const locker = new pg.Client({ connectionString: url });
  await locker.connect();
  await locker.query('BEGIN');
  await locker.query('LOCK TABLE app_automation_fires IN ACCESS EXCLUSIVE MODE');
  const controller = new AbortController();
  const reason = new Error('worker lease lost');
  const abort = setTimeout(() => controller.abort(reason), 60);
  const watchdog = setTimeout(() => { void locker.query('ROLLBACK'); }, 2500);
  const start = performance.now();
  let failure: unknown;
  try {
    await handleAppAutomationScan({ id: 'a05-test', name: 'app-automation-scan', data: {}, attempts: 1, signal: controller.signal });
  } catch (error) { failure = error; }
  finally {
    clearTimeout(abort);
    clearTimeout(watchdog);
    await locker.query('ROLLBACK');
    await locker.end();
  }
  assert.equal(failure, reason, 'actual handler must preserve worker abort reason');
  assert.ok(performance.now() - start < 1500, 'must settle within frozen unhealthy catalog bound');
});

test('A05 claim recovery refreshes definition expiry after waiting for the exact fire lock', { skip: !safe }, async () => {
  const fixture = await createAutomationRenewalFixture();
  const scheduledAt = new Date('2035-01-02T10:00:00Z');
  const { definition } = await fixture.create(scheduledAt, new Date('2035-01-02T09:59:59Z'), 2);
  const fire = await persistAppAutomationFire({
    organization_id: fixture.orgId, definition_id: definition.id, expected_epoch: definition.definition_epoch,
    logical_local_date: '2035-01-02', resolution: { kind: 'resolved', resolved_at_utc: scheduledAt },
  }, { now: () => scheduledAt });
  const claimed = await db.transaction(tx => claimAppAutomationFireWithExecutor(tx, {
    organization_id: fixture.orgId, definition_id: definition.id, fire_id: fire.id,
    expected_epoch: definition.definition_epoch, claim_owner: 'a05-recovery', claim_token: crypto.randomUUID(),
    claimed_at: scheduledAt, lease_expires_at: new Date('2035-01-02T10:00:00.800Z'),
  }));
  assert.ok(claimed);
  const locker = new pg.Client({ connectionString: url });
  await locker.connect();
  await locker.query('BEGIN');
  await locker.query('SELECT id FROM app_automation_fires WHERE id = $1 FOR UPDATE', [fire.id]);
  const release = setTimeout(() => { void locker.query('ROLLBACK'); }, 150);
  try {
    await runAppAutomationScan(new Date('2035-01-02T10:00:00.900Z'));
    const result = await locker.query('SELECT state, terminal_reason FROM app_automation_fires WHERE id = $1', [fire.id]);
    assert.deepEqual(result.rows, [{ state: 'skipped', terminal_reason: 'definition_ineligible' }]);
    const deliveries = await locker.query("SELECT count(*)::int AS count FROM job_queue WHERE name = 'app-automation-fire' AND data->>'fire_id' = $1", [fire.id]);
    assert.equal(deliveries.rows[0].count, 0);
  } finally { clearTimeout(release); await locker.query('ROLLBACK'); await locker.end(); }
});

test('A05 actual worker timeout and lease loss retain the scanner slot until SQL rollback settles', { skip: !safe }, async () => {
  const scanner = createAppAutomationScanDatabase(url!);
  const observer = new pg.Client({ connectionString: url });
  await observer.connect();
  const queue = `a05-worker-limits:${crypto.randomUUID()}` as QueueName;
  await observer.query('CREATE TABLE IF NOT EXISTS a05_worker_abort_probe (value integer)');
  await observer.query('TRUNCATE a05_worker_abort_probe');
  try {
    await scanner.transaction(tx => tx.execute(sql`SELECT 1`));
    for (const mode of ['timeout', 'lease loss'] as const) {
      await enqueue(queue, 'app-automation-scan', {}, { maxAttempts: 3 });
      const job = await dequeueJob(queue, { leaseMs: 10_000 });
      assert.ok(job);
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      let aborted!: () => void;
      const abortObserved = new Promise<void>(resolve => { aborted = resolve; });
      let originalReason: unknown;
      let handlerError: unknown;
      let handlerSettled = false;
      let workerSettled = false;
      const work = _processDequeuedJobForTest(queue, job, {
        timeoutMs: mode === 'timeout' ? 150 : 2000,
        leaseMs: 10_000, renewIntervalMs: 30, recurrence: null,
        resolveHandler: async () => async runtimeJob => {
          runtimeJob.signal!.addEventListener('abort', () => {
            originalReason = runtimeJob.signal!.reason;
            aborted();
          }, { once: true });
          try {
            await scanner.transaction(async tx => {
              entered();
              await tx.execute(sql`INSERT INTO a05_worker_abort_probe SELECT 1 FROM pg_sleep(0.5)`);
            }, runtimeJob.signal);
          } catch (error) { handlerError = error; throw error; }
          finally { handlerSettled = true; }
        },
      }).finally(() => { workerSettled = true; });
      await started;
      if (mode === 'lease loss') {
        await observer.query('UPDATE job_queue SET lock_token = $1 WHERE id = $2', [crypto.randomUUID(), job.id]);
      }
      await abortObserved;
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(handlerSettled, false, 'statement remains active until its server response');
      assert.equal(workerSettled, false, 'worker must await transaction rollback before returning');
      assert.equal(getWorkerStatus().inFlight, 1, 'underlying scanner remains tracked while settling');
      await work;
      assert.equal(handlerSettled, true);
      assert.equal(handlerError, originalReason, 'rollback preserves the worker cancellation reason');
      assert.ok(originalReason instanceof Error);
      assert.match(originalReason.message, mode === 'timeout' ? /timed out/ : /lost its job lease/);
      assert.equal(getWorkerStatus().inFlight, 0);
      assert.equal((await observer.query('SELECT count(*)::int AS count FROM a05_worker_abort_probe')).rows[0].count, 0);
    }
  } finally {
    await observer.query('DELETE FROM job_queue WHERE queue = $1', [queue]);
    await observer.query('DROP TABLE a05_worker_abort_probe');
    await scanner.close();
    await observer.end();
  }
});

test('A05 persistence refreshes expiry and catch-up policy after real pending-budget lock waits', { skip: !safe }, async () => {
  const fixture = await createAutomationRenewalFixture();
  const scanner = createAppAutomationScanDatabase(url!);
  const locker = new pg.Client({ connectionString: url });
  await locker.connect();
  try {
    const scheduledAt = new Date('2035-01-01T10:00:00Z');
    for (const boundary of ['expiry', 'catch-up'] as const) {
      const { definition } = await fixture.create(scheduledAt, new Date('2035-01-01T09:59:59Z'), boundary === 'expiry' ? 2 : 3600);
      await locker.query('BEGIN');
      await locker.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`deft.app_automation.pending_budget:${fixture.orgId}`]);
      let now = scheduledAt;
      const release = setTimeout(() => {
        now = boundary === 'expiry' ? new Date('2035-01-01T10:00:01Z') : new Date('2035-01-01T10:15:00.001Z');
        void locker.query('ROLLBACK');
      }, 100);
      try {
        await assert.rejects(scanner.transaction(tx => persistAppAutomationFire({
          organization_id: fixture.orgId, definition_id: definition.id, expected_epoch: definition.definition_epoch,
          logical_local_date: '2035-01-01', resolution: { kind: 'resolved', resolved_at_utc: scheduledAt },
        }, { executor: tx, now: () => now })), /changed while waiting for persistence/);
        const fires = await locker.query('SELECT count(*)::int AS count FROM app_automation_fires WHERE definition_id = $1', [definition.id]);
        assert.equal(fires.rows[0].count, 0, `${boundary} must not leave a pending fire after the wait`);
      } finally { clearTimeout(release); await locker.query('ROLLBACK'); }
    }
  } finally { await scanner.close(); await locker.end(); }
});

test('A05 scanner SQL timeout settles before reuse and does not change ordinary pool limits', { skip: !safe }, async () => {
  const scanner = createAppAutomationScanDatabase(url!);
  const ordinary = new pg.Client({ connectionString: url });
  await ordinary.connect();
  try {
    const start = performance.now();
    await assert.rejects(scanner.transaction(tx => tx.execute(sql`SELECT pg_sleep(10)`)));
    assert.ok(performance.now() - start < 3000);
    const result = await scanner.transaction(tx => tx.execute(sql`SELECT 7 AS value`));
    assert.equal(result.rows[0]?.value, 7);
    assert.equal((await ordinary.query('SHOW statement_timeout')).rows[0].statement_timeout, '0');
    assert.equal((await ordinary.query('SHOW lock_timeout')).rows[0].lock_timeout, '0');
  } finally { await scanner.close(); await ordinary.end(); }
});

test('A05 scanner saturation bounds acquisition while unrelated database work progresses', { skip: !safe }, async () => {
  const scanner = createAppAutomationScanDatabase(url!);
  const ordinary = new pg.Client({ connectionString: url });
  await ordinary.connect();
  let entered = 0;
  let bothEntered!: () => void;
  const occupied = new Promise<void>(resolve => { bothEntered = resolve; });
  const occupy = () => scanner.transaction(async tx => {
    if (++entered === 2) bothEntered();
    await tx.execute(sql`SELECT pg_sleep(1.8)`);
  });
  const holders = [occupy(), occupy()];
  try {
    await occupied;
    const start = performance.now();
    await ordinary.query('SELECT 1');
    assert.ok(performance.now() - start < 1000, 'ordinary connection remains independent');
    await assert.rejects(scanner.transaction(tx => tx.execute(sql`SELECT 1`)), /timeout/);
    assert.ok(performance.now() - start < 1500, 'queued borrower is removed by pg acquisition timeout');
    await Promise.all(holders);
    await scanner.transaction(tx => tx.execute(sql`SELECT 1`));
  } finally { await Promise.allSettled(holders); await scanner.close(); await ordinary.end(); }
});

test('A05 ordinary Error abort rolls back in-flight SQL before releasing scanner slot', { skip: !safe }, async () => {
  const scanner = createAppAutomationScanDatabase(url!);
  const observer = new pg.Client({ connectionString: url });
  await observer.connect();
  await observer.query('CREATE TABLE IF NOT EXISTS a05_scan_abort_probe (value integer)');
  await observer.query('TRUNCATE a05_scan_abort_probe');
  const controller = new AbortController();
  const reason = new Error('lease renewal failed');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(scanner.transaction(async tx => {
      timer = setTimeout(() => controller.abort(reason), 60);
      await tx.execute(sql`INSERT INTO a05_scan_abort_probe SELECT 1 FROM pg_sleep(0.2)`);
      assert.fail('aborted SQL must not start subsequent callback work');
    }, controller.signal), error => error === reason);
    assert.equal((await observer.query('SELECT count(*)::int AS count FROM a05_scan_abort_probe')).rows[0].count, 0);
    await scanner.transaction(tx => tx.execute(sql`INSERT INTO a05_scan_abort_probe VALUES (2)`));
    assert.deepEqual((await observer.query('SELECT value FROM a05_scan_abort_probe')).rows, [{ value: 2 }]);
  } finally {
    clearTimeout(timer);
    await observer.query('DROP TABLE a05_scan_abort_probe');
    await scanner.close();
    await observer.end();
  }
});
