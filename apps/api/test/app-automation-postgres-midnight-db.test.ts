import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, test } from 'node:test';
import pg from 'pg';
import { mcpClientManager } from '@deft/mcp';
import { db, closeDb } from '../src/lib/db.js';
import { AppActionService } from '../src/lib/app-action-service.js';
import { persistAppAutomationFire } from '../src/lib/app-automation-definition-service.js';
import { claimAppAutomationFireWithExecutor, type AppAutomationFireRow } from '../src/lib/app-automation-repository.js';
import { getAppRunRuntime, shutdownAppRunRuntime } from '../src/lib/app-run-runtime.js';
import { handleAppRunAttempt } from '../src/lib/app-run-worker-handler.js';
import { dequeueJob, QUEUE_NAMES } from '../src/lib/queues.js';
import { _processDequeuedJobForTest } from '../src/workers/index.js';
import { createAutomationRenewalFixture } from './fixtures/app-automation-renewal.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const clockFile = process.env.DEFT_A05_CLOCK_FILE;
const realNow = (globalThis as typeof globalThis & { __deftA05RealNow?: () => number }).__deftA05RealNow;
const safe = !!target && target === process.env.DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55436\/gate_g_20260926_c10_a05_midnight_test(?:_v[0-9]+)?$/.test(target)
  && clockFile === 'C:/tmp/deft-c10-a05-clock/private-clock.rc' && !!realNow;
process.env.DEFT_SELF_HOSTED = 'true';
process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO = 'true';
process.env.MCP_STDIO_ALLOWED_COMMANDS = process.execPath;
after(async () => { if (safe) { await shutdownAppRunRuntime(); await mcpClientManager.shutdown(); await closeDb(); } });

async function positionClock(iso: string) {
  assert.ok(safe && realNow && clockFile);
  await writeFile(`${clockFile}.next`, `+${((Date.parse(iso) - realNow()) / 1000).toFixed(3)}`, 'ascii');
  await rename(`${clockFile}.next`, clockFile);
  // The isolated PostgreSQL library caches configuration for one real second.
  // Refresh all offsets BEFORE work can acquire a production lease.
  await delay(1_200);
}
async function verifyPoolClocks() {
  const clients = await Promise.all(Array.from({ length: db.$client.totalCount }, () => db.$client.connect()));
  try {
    const clocks = await Promise.all(clients.map(async client => (await client.query(
      'SELECT pg_backend_pid() AS pid,extract(epoch from clock_timestamp())*1000 AS clock_ms')).rows[0]));
    assert.equal(new Set(clocks.map(row => row.pid)).size, clients.length);
    for (const row of clocks) assert.ok(Math.abs(Number(row.clock_ms) - Date.now()) < 1_500, `backend${row.pid} clock is stale`);
    return clocks;
  } finally { for (const client of clients) client.release(); }
}
function claim(fire: AppAutomationFireRow) {
  const at = new Date();
  return db.transaction(tx => claimAppAutomationFireWithExecutor(tx, { organization_id: fire.org_id,
    definition_id: fire.definition_id, fire_id: fire.id, expected_epoch: fire.definition_epoch,
    claim_owner: 'a05-isolated-postgres-midnight', claim_token: randomUUID(), claimed_at: at,
    lease_expires_at: new Date(at.getTime() + 60_000) }));
}
function invoke(fire: AppAutomationFireRow) {
  assert.ok(fire.claim_token);
  return new AppActionService().invokeApprovedAutomation({ organization_id: fire.org_id,
    definition_id: fire.definition_id, fire_id: fire.id, claim_token: fire.claim_token });
}
async function attempt(orgId: string, runId: string) {
  const job = await dequeueJob(QUEUE_NAMES.AGENT_JOBS, { orgId, jobName: 'app-run-attempt',
    dataMatch: { key: 'runId', value: runId } }); assert.ok(job);
  await _processDequeuedJobForTest(QUEUE_NAMES.AGENT_JOBS, job, { resolveHandler: async () => handleAppRunAttempt });
}

test('A05 isolated PostgreSQL UTC midnight admits a fresh Run reservation while an old-day provider Run remains in flight',
  { skip: !safe, timeout: 180_000 }, async context => {
    await positionClock('2055-09-26T23:50:00Z');
    const root = await mkdtemp(resolve(tmpdir(), 'deft-a05-real-pg-midnight-'));
    const marker = resolve(root, 'old-day-effect.json');
    const fixture = await createAutomationRenewalFixture({ pauseAfterEffectFile: marker });
    const due = new Date('2055-09-26T23:50:00Z');
    const observer = new pg.Client({ connectionString: target }); await observer.connect();
    const oldTransaction = new pg.Client({ connectionString: target }); await oldTransaction.connect();
    let heldAttempt: Promise<void> | undefined;
    try {
      const fires: AppAutomationFireRow[] = [];
      for (let index = 0; index < 101; index++) {
        context.signal.throwIfAborted();
        const { definition } = await fixture.create(due, new Date(due.getTime() - 1_000 + index));
        const fire = await persistAppAutomationFire({ organization_id: fixture.orgId, definition_id: definition.id,
          expected_epoch: definition.definition_epoch, logical_local_date: '2055-09-26',
          resolution: { kind: 'resolved', resolved_at_utc: due } });
        fires.push(fire);
        if (index < 100) { context.signal.throwIfAborted(); const reserved = await claim(fire); assert.ok(reserved); await invoke(reserved); }
      }
      const next = fires[100]!;
      assert.equal(await claim(next), null, 'prior-day101st reservation is denied');
      assert.equal((await observer.query('SELECT count(*)::int AS count FROM app_runs WHERE org_id=$1', [fixture.orgId])).rows[0].count, 100);
      const [oldRun] = (await observer.query('SELECT id FROM app_runs WHERE org_id=$1 ORDER BY created_at,id LIMIT 1', [fixture.orgId])).rows;
      assert.ok(oldRun);
      // Position only the disposable process clocks before dispatch. There is
      // no jump while this attempt owns a lease; midnight then ticks naturally.
      await positionClock('2055-09-26T23:59:50Z');
      const leaseClocks = await verifyPoolClocks();
      heldAttempt = attempt(fixture.orgId, oldRun.id);
      for (let i = 0; i < 200; i++) {
        try { await readFile(marker); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await delay(25); }
      }
      assert.equal((await fixture.effects()).length, 1);
      await oldTransaction.query('BEGIN');
      const before = (await oldTransaction.query('SELECT now()::text AS tx_now,clock_timestamp()::text AS sql_clock')).rows[0];
      assert.ok(before.tx_now.startsWith('2055-09-26'));
      const tickStarted = performance.now();
      while (Date.now() < Date.parse('2055-09-27T00:00:01.500Z') && performance.now() - tickStarted < 15_000) {
        context.signal.throwIfAborted(); await delay(25);
      }
      const fresh = (await observer.query('SELECT now()::text AS tx_now,clock_timestamp()::text AS sql_clock')).rows[0];
      const retained = (await oldTransaction.query('SELECT now()::text AS tx_now,clock_timestamp()::text AS sql_clock')).rows[0];
      assert.ok(fresh.tx_now.startsWith('2055-09-27'));
      assert.equal(retained.tx_now, before.tx_now, 'an old transaction keeps PostgreSQL transaction time');
      assert.ok(retained.sql_clock.startsWith('2055-09-27'));
      await oldTransaction.query('ROLLBACK');
      const [inflight] = (await observer.query('SELECT id,state FROM app_runs WHERE id=$1', [oldRun.id])).rows;
      assert.equal(inflight.id, oldRun.id); assert.equal(inflight.state, 'running');
      assert.equal((await observer.query('SELECT count(*)::int AS count FROM app_run_receipts WHERE org_id=$1', [fixture.orgId])).rows[0].count, 0);
      const reserved = await claim(next); assert.ok(reserved);
      const nextRun = await invoke(reserved); assert.notEqual(nextRun.id, oldRun.id);
      const replay = await invoke(reserved); assert.equal(replay.id, nextRun.id);
      // Run created_at is UTC-naive storage. Group the actual persisted
      // admission timestamp, rather than a synthetic reservation count. The
      // application writes this timestamp from the synchronized process clock.
      const days = (await observer.query(`SELECT created_at::date::text AS day,count(*)::int AS count FROM app_runs
        WHERE org_id=$1 GROUP BY created_at::date ORDER BY day`, [fixture.orgId])).rows;
      assert.deepEqual(days, [{ day: '2055-09-26', count: 100 }, { day: '2055-09-27', count: 1 }]);
      await writeFile(`${marker}.release`, 'release'); await heldAttempt;
      await attempt(fixture.orgId, nextRun.id);
      for (const runId of [oldRun.id, nextRun.id]) {
        const receipts = await (await getAppRunRuntime()).receiptReader.readVerified(fixture.orgId, runId);
        assert.equal(receipts.length, 1); assert.equal(receipts[0].verified, true);
      }
      assert.equal((await fixture.effects()).length, 2);
      console.log('A05_POSTGRES_MIDNIGHT', JSON.stringify({ before, fresh, retained, js_now: new Date().toISOString(),
        raw_real_now: new Date(realNow!()).toISOString(), monotonic_elapsed_ms: performance.now() - tickStarted,
        lease_backend_clocks: leaseClocks, old_run_id: oldRun.id, next_run_id: nextRun.id, actual_run_days: days, effects: 2, verified_receipts: 2 }));
    } finally {
      await writeFile(`${marker}.release`, 'release'); await heldAttempt;
      await oldTransaction.query('ROLLBACK'); await oldTransaction.end(); await observer.end();
      await writeFile(clockFile!, '+0', 'ascii');
    }
  });
