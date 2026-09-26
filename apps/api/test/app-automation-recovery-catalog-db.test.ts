import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { after, test } from 'node:test';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { mcpClientManager } from '@deft/mcp';
import { db, closeDb } from '../src/lib/db.js';
import { AppError } from '../src/lib/app-errors.js';
import { persistAppAutomationFire } from '../src/lib/app-automation-definition-service.js';
import { claimAppAutomationFireWithExecutor } from '../src/lib/app-automation-repository.js';
import { runAppAutomationScan } from '../src/lib/app-automation-runtime.js';
import { closeAppAutomationScanDatabase } from '../src/lib/app-automation-scan-db.js';
import { APP_AUTOMATION_SCAN_CRON } from '../src/lib/app-automation-scan-progress.js';
import { cleanupStaleJobs, dequeueJob, enqueue, ensureCronJob, QUEUE_NAMES } from '../src/lib/queues.js';
import { _processDequeuedJobForTest } from '../src/workers/index.js';
import { createAutomationRenewalFixture } from './fixtures/app-automation-renewal.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = !!target && target === process.env.DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c09_a05_catalog_test(?:_v[0-9]+)?$/.test(target);
process.env.DEFT_SELF_HOSTED = 'true';
process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO = 'true';
process.env.MCP_STDIO_ALLOWED_COMMANDS = process.execPath;
after(async () => { if (safe) {
  await mcpClientManager.shutdown(); await closeAppAutomationScanDatabase(); await closeDb();
} });

async function restart(observer: pg.Client) {
  await observer.query('DELETE FROM job_queue WHERE cron_key=$1', [APP_AUTOMATION_SCAN_CRON]);
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'app-automation-scan', APP_AUTOMATION_SCAN_CRON, {}, 0);
}
async function slice(observer: pg.Client, policyAt: Date) {
  const job = await dequeueJob(QUEUE_NAMES.SCHEDULED_JOBS, { jobName: 'app-automation-scan' }); assert.ok(job);
  const started = performance.now();
  await _processDequeuedJobForTest(QUEUE_NAMES.SCHEDULED_JOBS, job, {
    resolveHandler: async () => async value => runAppAutomationScan(policyAt, value.signal,
      { id: value.id, lockToken: value.lockToken! }),
  });
  const [row] = (await observer.query('SELECT status,data,attempts FROM job_queue WHERE id=$1', [job.id])).rows;
  return { job, row, elapsed: performance.now() - started };
}

test('A05 real leased scanner interleaves 105 expired claims and 106 definitions across catalog pages with stable repair identities', { skip: !safe }, async () => {
  const fixtures = [];
  for (let tenant = 0; tenant < 6; tenant++) fixtures.push(await createAutomationRenewalFixture());
  const due = new Date('2049-01-01T10:00:00.000Z');
  const scanAt = new Date('2049-01-01T10:01:00.000Z');
  const originals: Array<{ id: string; definition_id: string; fire_identity: string }> = [];
  for (let tenant = 0; tenant < 5; tenant++) {
    const fixture = fixtures[tenant]!;
    for (let item = 0; item < 21; item++) {
      const { definition } = await fixture.create(due, new Date(due.getTime() - 1_000 + item), 3_600);
      const fire = await persistAppAutomationFire({ organization_id: fixture.orgId,
        definition_id: definition.id, expected_epoch: 1, logical_local_date: '2049-01-01',
        resolution: { kind: 'resolved', resolved_at_utc: due } }, { now: () => due });
      await enqueue(QUEUE_NAMES.SCHEDULED_JOBS, 'app-automation-fire', {
        organization_id: fixture.orgId, definition_id: definition.id, fire_id: fire.id, definition_epoch: 1,
      }, { orgId: fixture.orgId, dedupeKey: `app-automation-fire:${fire.fire_identity}:attempt:0`, maxAttempts: 3 });
      const claimed = await db.transaction(tx => claimAppAutomationFireWithExecutor(tx, {
        organization_id: fixture.orgId, definition_id: definition.id, fire_id: fire.id,
        expected_epoch: 1, claim_owner: 'a05-expired-delivery', claim_token: randomUUID(),
        claimed_at: new Date(due.getTime() + 1_000), lease_expires_at: new Date(due.getTime() + 2_000),
      })); assert.ok(claimed);
      originals.push({ id: fire.id, definition_id: definition.id, fire_identity: fire.fire_identity });
    }
  }
  const healthy = fixtures[5]!;
  const { definition: healthyDefinition } = await healthy.create(due, new Date(due.getTime() - 1_000), 3_600);
  const observer = new pg.Client({ connectionString: target }); await observer.connect();
  try {
    // Remove actual queued deliveries while preserving all domain identities.
    const removed = await observer.query("DELETE FROM job_queue WHERE name='app-automation-fire' RETURNING id");
    assert.equal(removed.rowCount, 105);
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM app_automation_fires WHERE state='claimed'")).rows[0].count, 105);
    await restart(observer);
    const slices: number[] = [];
    let ordinaryMax = 0;
    let complete = false;
    for (let index = 0; index < 8; index++) {
      const measured = await slice(observer, scanAt); slices.push(measured.elapsed);
      assert.equal(measured.row.status, 'completed');
      const progress = measured.row.data.automation_scan;
      assert.ok(progress.definitions.after || progress.definitions.partial || progress.definitions.done);
      assert.ok(progress.fires.after || progress.fires.done, 'both lanes make real persisted progress');
      const started = performance.now(); await db.execute(sql`SELECT 1`);
      ordinaryMax = Math.max(ordinaryMax, performance.now() - started);
      assert.ok(ordinaryMax <= 1_000, `ordinary query ${ordinaryMax}ms`);
      assert.ok(measured.elapsed <= 12_000, `responsive synthetic slice ${measured.elapsed}ms`);
      if (progress.complete) { complete = true; break; }
    }
    assert.equal(complete, true); assert.ok(slices.length <= 8);
    const repaired = (await observer.query('SELECT id,definition_id,fire_identity,state,attempt_count,claim_token FROM app_automation_fires WHERE id=ANY($1::text[]) ORDER BY id', [originals.map(row => row.id)])).rows;
    assert.equal(repaired.length, 105);
    for (const fire of repaired) {
      assert.deepEqual({ id: fire.id, definition_id: fire.definition_id, fire_identity: fire.fire_identity }, originals.find(row => row.id === fire.id));
      assert.equal(fire.state, 'pending'); assert.equal(fire.attempt_count, 1); assert.equal(fire.claim_token, null);
    }
    const deliveries = (await observer.query("SELECT id,data->>'fire_id' AS fire_id FROM job_queue WHERE name='app-automation-fire' ORDER BY id")).rows;
    assert.equal(deliveries.length, 106); assert.equal(new Set(deliveries.map(row => row.fire_id)).size, 106);
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM job_queue WHERE name='app-automation-fire' AND data->>'definition_id'=$1", [healthyDefinition.id])).rows[0].count, 1);
    await restart(observer);
    for (let index = 0; index < 8; index++) {
      const measured = await slice(observer, scanAt); assert.equal(measured.row.status, 'completed');
      if (measured.row.data.automation_scan.complete) break;
      assert.ok(index < 7, 'retention replay completes');
    }
    assert.deepEqual((await observer.query("SELECT id,data->>'fire_id' AS fire_id FROM job_queue WHERE name='app-automation-fire' ORDER BY id")).rows, deliveries);
    const connections = Number((await observer.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name='deft-app-automation-scanner'")).rows[0].count);
    assert.ok(connections <= 2); assert.equal((await observer.query('SELECT count(*)::int AS count FROM app_runs')).rows[0].count, 0);
    for (const fixture of fixtures) assert.deepEqual(await fixture.effects(), []);
    console.log('A05_REAL_RECOVERY_CATALOG', JSON.stringify({ recovery_items: 105, definitions: 106,
      deliveries: 106, slice_ms: slices, ordinary_max_ms: ordinaryMax, scanner_connections: connections }));
  } finally { await observer.end(); }
});

test('A05 repeated real catalog lock outages retain fire cursor while definitions progress then retry with backoff', { skip: !safe }, async () => {
  const fixture = await createAutomationRenewalFixture();
  const policyAt = new Date('2050-01-01T09:00:00.000Z');
  await fixture.create(new Date('2050-01-01T10:00:00.000Z'), new Date('2050-01-01T08:59:59.000Z'), 3_600);
  const observer = new pg.Client({ connectionString: target }); await observer.connect();
  const locker = new pg.Client({ connectionString: target }); await locker.connect();
  try {
    await restart(observer); await locker.query('BEGIN');
    await locker.query('LOCK TABLE app_automation_fires IN ACCESS EXCLUSIVE MODE');
    const first = await slice(observer, policyAt);
    assert.equal(first.row.status, 'completed');
    const retained = first.row.data.automation_scan;
    assert.equal(retained.definitions.done, true); assert.equal(retained.fires.done, false);
    assert.equal(retained.fires.after, null); assert.equal(retained.complete, false);
    for (let repeat = 0; repeat < 2; repeat++) {
      const measured = await slice(observer, policyAt);
      assert.ok(['pending', 'failed'].includes(measured.row.status)); assert.ok(measured.row.attempts > 0);
      assert.deepEqual(measured.row.data.automation_scan, retained);
      // Retry budget exhaustion creates a normal delayed successor with the
      // same hints; it must not discard progress or immediately failure-spin.
      const [delay] = (await observer.query("SELECT id,data,extract(epoch FROM run_at-clock_timestamp())*1000 AS ms FROM job_queue WHERE cron_key=$1 AND status='pending'", [APP_AUTOMATION_SCAN_CRON])).rows;
      assert.ok(delay); assert.deepEqual(delay.data.automation_scan, retained);
      assert.ok(Number(delay.ms) > 500, 'no-progress outage uses queue backoff');
      if (measured.row.status === 'failed') assert.ok(Number(delay.ms) > 55_000);
      assert.ok(measured.elapsed <= 3_000);
      await observer.query('UPDATE job_queue SET run_at=clock_timestamp() WHERE id=$1', [delay.id]);
    }
    await locker.query('ROLLBACK');
    let complete = false;
    for (let continuation = 0; continuation < 8; continuation++) {
      const recovered = await slice(observer, policyAt);
      assert.equal(recovered.row.status, 'completed'); assert.ok(recovered.elapsed <= 12_000);
      if (recovered.row.data.automation_scan.complete) { complete = true; break; }
    }
    assert.equal(complete, true);
    assert.equal((await observer.query('SELECT count(*)::int AS count FROM app_runs')).rows[0].count, 0);
    assert.deepEqual(await fixture.effects(), []);
    console.log('A05_CATALOG_OUTAGE_RECOVERY', JSON.stringify({ failed_catalog_reads: 3,
      retries_without_progress: 2, retained_cursor: retained.fires.after, recovered_complete: true }));
  } finally { await locker.query('ROLLBACK'); await locker.end(); await observer.end(); }
});

test('A05 scanner process kills before and after progress COMMIT resume full history with identical settled fire IDs', { skip: !safe }, async () => {
  const observer = new pg.Client({ connectionString: target }); await observer.connect();
  try {
    const firstYear = Math.max(2051, 1 + Number((await observer.query(
      'SELECT coalesce(max(extract(year FROM valid_until)),2050)::int AS year FROM app_automation_definitions',
    )).rows[0].year));
    for (const [index, mode] of (['before-progress', 'after-progress'] as const).entries()) {
      const year = firstYear + index;
      const due = new Date(`${year}-01-01T10:00:00.000Z`);
      const policyAt = new Date(`${year}-01-30T10:01:00.000Z`);
      // Settle preceding cases through production traversal before introducing
      // the one definition whose first history unit is the interruption target.
      await restart(observer);
      let drained = false;
      for (let continuation = 0; continuation < 8; continuation++) {
        const settled = await slice(observer, policyAt); assert.equal(settled.row.status, 'completed');
        if (settled.row.data.automation_scan.complete) { drained = true; break; }
      }
      assert.equal(drained, true);
      const fixture = await createAutomationRenewalFixture();
      const { definition } = await fixture.create(due, new Date(due.getTime() - 60_000));
      await restart(observer);
      const child = fork(fileURLToPath(new URL('./fixtures/app-automation-scan-interruption-child.ts', import.meta.url)), {
        execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env },
      });
      let stderr = ''; child.stderr?.on('data', value => { stderr = (stderr + String(value)).slice(-3_000); });
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      try {
        const checkpoint = new Promise<{ phase: string; job_id: string }>((resolve, reject) => {
          // Importing the complete worker composition is outside the scanner
          // slice budget. Send the command only after its listener is ready.
          const timer = setTimeout(() => reject(new Error(`Scanner boundary timeout: ${stderr}`)), 45_000);
          child.on('message', (message: { phase: string; job_id: string; message?: string }) => {
            if (message.phase === 'ready') {
              child.send({ mode, policy_at: policyAt.toISOString() });
              return;
            }
            clearTimeout(timer);
            if (message.phase === mode) resolve(message);
            else reject(new Error(`Scanner child: ${message.message}; ${stderr}`));
          });
          child.once('error', reject);
        });
        const reached = await checkpoint;
        child.kill('SIGKILL'); await exited;
        const prior = (await observer.query('SELECT id,fire_identity FROM app_automation_fires WHERE definition_id=$1 ORDER BY id', [definition.id])).rows;
        assert.equal(prior.length, 1, 'one settled logical work unit precedes the process kill');
        const [row] = (await observer.query('SELECT data FROM job_queue WHERE id=$1', [reached.job_id])).rows;
        if (mode === 'before-progress') assert.equal(row.data.automation_scan.definitions.partial, null);
        else assert.equal(row.data.automation_scan.definitions.partial.next_logical_local_date, `${year}-01-02`);
        // Wait for the real short queue lease, then use production stale cleanup.
        await delay(1_100); assert.ok(await cleanupStaleJobs());
        await observer.query('UPDATE job_queue SET run_at=clock_timestamp() WHERE id=$1', [reached.job_id]);
        let complete = false;
        for (let attempt = 0; attempt < 8; attempt++) {
          const measured = await slice(observer, policyAt); assert.equal(measured.row.status, 'completed');
          if (measured.row.data.automation_scan.complete) { complete = true; break; }
        }
        assert.equal(complete, true);
        const all = (await observer.query('SELECT id,fire_identity,state FROM app_automation_fires WHERE definition_id=$1', [definition.id])).rows;
        assert.equal(all.length, 30); assert.equal(new Set(all.map(value => value.fire_identity)).size, 30);
        assert.equal(all.filter(value => value.state === 'skipped').length, 29);
        assert.equal(all.filter(value => value.state === 'pending').length, 1);
        assert.ok(all.some(value => value.id === prior[0].id && value.fire_identity === prior[0].fire_identity));
        assert.equal((await observer.query("SELECT count(*)::int AS count FROM job_queue WHERE name='app-automation-fire' AND data->>'definition_id'=$1", [definition.id])).rows[0].count, 1);
        assert.deepEqual(await fixture.effects(), []);
        console.log('A05_HISTORY_PROCESS_KILL', JSON.stringify({ boundary: mode, fire_id_retained: prior[0].id,
          child_pid: child.pid, logical_identities: 30, terminal_misfires: 29, pending: 1 }));
      } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; }
    }
  } finally { await observer.end(); }
});

test('A05 persisted 15-minute catch-up edge is inclusive and approved validity expiry is exclusive', { skip: !safe }, async () => {
  const fixture = await createAutomationRenewalFixture();
  const due = new Date('2053-01-01T10:00:00.000Z');
  const edge = await fixture.create(due, new Date(due.getTime() - 60_000), 3_600);
  const late = await fixture.create(due, new Date(due.getTime() - 59_999), 3_600);
  const expiring = await fixture.create(due, new Date(due.getTime() - 59_998), 180);
  const input = (definitionId: string) => ({ organization_id: fixture.orgId,
    definition_id: definitionId, expected_epoch: 1, logical_local_date: '2053-01-01',
    resolution: { kind: 'resolved' as const, resolved_at_utc: due } });
  const stale = (error: unknown) => error instanceof AppError && error.code === 'APP_STALE';
  const atEdge = await persistAppAutomationFire(input(edge.definition.id), {
    now: () => new Date(due.getTime() + 15 * 60_000),
  });
  assert.equal(atEdge.state, 'pending'); assert.equal(atEdge.terminal_reason, null);
  await assert.rejects(persistAppAutomationFire(input(late.definition.id), {
    now: () => new Date(due.getTime() + 15 * 60_000 + 1),
  }), stale);
  const beyondEdge = await persistAppAutomationFire({ ...input(late.definition.id), terminal_reason: 'misfire_skipped' }, {
    now: () => new Date(due.getTime() + 15 * 60_000 + 1),
  });
  assert.equal(beyondEdge.state, 'skipped'); assert.equal(beyondEdge.terminal_reason, 'misfire_skipped');
  const beforeExpiry = await persistAppAutomationFire(input(expiring.definition.id), {
    now: () => new Date(expiring.definition.valid_until.getTime() - 1),
  });
  assert.equal(beforeExpiry.state, 'pending');
  await assert.rejects(persistAppAutomationFire(input(expiring.definition.id), {
    now: () => expiring.definition.valid_until,
  }), stale);
  const observer = new pg.Client({ connectionString: target }); await observer.connect();
  try {
    await restart(observer);
    for (let attempt = 0; attempt < 8; attempt++) {
      const measured = await slice(observer, expiring.definition.valid_until);
      assert.equal(measured.row.status, 'completed');
      if (measured.row.data.automation_scan.complete) break;
      assert.ok(attempt < 7);
    }
    const [expired] = (await observer.query('SELECT id,state,terminal_reason FROM app_automation_fires WHERE id=$1', [beforeExpiry.id])).rows;
    assert.equal(expired.id, beforeExpiry.id); assert.equal(expired.state, 'skipped');
    assert.equal(expired.terminal_reason, 'definition_ineligible');
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM job_queue WHERE name='app-automation-fire' AND data->>'definition_id'=$1", [expiring.definition.id])).rows[0].count, 0);
    assert.equal((await observer.query('SELECT count(*)::int AS count FROM app_runs WHERE org_id=$1', [fixture.orgId])).rows[0].count, 0);
    assert.deepEqual(await fixture.effects(), []);
    console.log('A05_EXACT_POLICY_EDGES', JSON.stringify({ catch_up_edge_ms: 900_000,
      edge_state: atEdge.state, one_ms_later_state: beyondEdge.state, expiry_exclusive: true,
      expired_fire_id_retained: expired.id, effects: 0 }));
  } finally { await observer.end(); }
});
