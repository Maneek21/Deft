import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { mcpClientManager } from '@deft/mcp';
import { closeDb } from '../src/lib/db.js';
import { getAppAutomationDefinition } from '../src/lib/app-automation-definition-service.js';
import { runAppAutomationScan, runAppAutomationFire } from '../src/lib/app-automation-runtime.js';
import { closeAppAutomationScanDatabase } from '../src/lib/app-automation-scan-db.js';
import { APP_AUTOMATION_SCAN_CRON } from '../src/lib/app-automation-scan-progress.js';
import { getAppRunRuntime, shutdownAppRunRuntime } from '../src/lib/app-run-runtime.js';
import { dequeueJob, ensureCronJob, QUEUE_NAMES } from '../src/lib/queues.js';
import { _processDequeuedJobForTest, startWorkers, stopWorkers } from '../src/workers/index.js';
import { createAutomationRenewalFixture } from './fixtures/app-automation-renewal.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = !!target && target === process.env.DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c10_a05_provider_test(?:_v[0-9]+)?$/.test(target);
process.env.DEFT_SELF_HOSTED = 'true';
process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO = 'true';
process.env.MCP_STDIO_ALLOWED_COMMANDS = process.execPath;
after(async () => { if (safe) {
  await stopWorkers(); await shutdownAppRunRuntime(); await mcpClientManager.shutdown();
  await closeAppAutomationScanDatabase(); await closeDb();
} });

async function waitFor<T>(read: () => Promise<T | null>, milliseconds: number): Promise<T | null> {
  const deadline = performance.now() + milliseconds;
  do {
    const value = await read();
    if (value !== null) return value;
    await delay(25);
  } while (performance.now() < deadline);
  return null;
}

test('A05 later healthy tenant reaches a verified receipt while one external provider is held and worker slots remain spare',
  { skip: !safe, timeout: 90_000 }, async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'deft-a05-provider-fairness-'));
    const marker = resolve(root, 'held-effect.json');
    const held = await createAutomationRenewalFixture({ pauseAfterEffectFile: marker });
    // Prepare only authority before the held batch. The healthy definition and
    // its queue work arrive strictly after the actual provider checkpoint.
    const healthy = await createAutomationRenewalFixture();
    const due = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const bad = await held.create(due, new Date(due.getTime() - 1_000));
    const observer = new pg.Client({ connectionString: target }); await observer.connect();
    let started = false;
    try {
      await observer.query('DELETE FROM job_queue WHERE cron_key=$1', [APP_AUTOMATION_SCAN_CRON]);
      await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'app-automation-scan', APP_AUTOMATION_SCAN_CRON, {}, 0);
      const scan = await dequeueJob(QUEUE_NAMES.SCHEDULED_JOBS, { jobName: 'app-automation-scan' }); assert.ok(scan);
      await _processDequeuedJobForTest(QUEUE_NAMES.SCHEDULED_JOBS, scan, { resolveHandler: async () => async job =>
        runAppAutomationScan(new Date(), job.signal, { id: job.id, lockToken: job.lockToken! }) });
      const fire = await dequeueJob(QUEUE_NAMES.SCHEDULED_JOBS, { orgId: held.orgId, jobName: 'app-automation-fire',
        dataMatch: { key: 'definition_id', value: bad.definition.id } }); assert.ok(fire);
      await _processDequeuedJobForTest(QUEUE_NAMES.SCHEDULED_JOBS, fire, { resolveHandler: async () => runAppAutomationFire });
      await startWorkers(); started = true;
      const checkpoint = await waitFor(async () => {
        try { return JSON.parse(await readFile(marker, 'utf8')) as { pid: number; idempotency_key: string }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      }, 10_000);
      assert.ok(checkpoint, 'actual external provider must reach its durable-effect hold');
      const heldAt = performance.now();
      const heldRows = (await observer.query("SELECT status FROM job_queue WHERE org_id=$1 AND name='app-run-attempt'", [held.orgId])).rows;
      assert.deepEqual(heldRows.map(row => row.status), ['running']);
      assert.equal((await held.effects()).length, 1);
      const arrivedAt = performance.now();
      const good = await healthy.create(due, new Date(due.getTime() - 1_000));
      const managementAt = performance.now();
      assert.ok(await getAppAutomationDefinition(healthy.actor, good.definition.id));
      const managementMs = performance.now() - managementAt;
      assert.ok(managementMs <= 250, `management ${managementMs.toFixed(1)}ms exceeds frozen250ms`);
      // Only disposable delivery cadence changes. Domain state is not patched.
      await observer.query('DELETE FROM job_queue WHERE cron_key=$1', [APP_AUTOMATION_SCAN_CRON]);
      await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'app-automation-scan', APP_AUTOMATION_SCAN_CRON, {}, 0);
      const enqueued = await waitFor(async () => (await observer.query(
        "SELECT id FROM job_queue WHERE org_id=$1 AND name='app-automation-fire' AND data->>'definition_id'=$2",
        [healthy.orgId, good.definition.id])).rows[0] ?? null, 15_000);
      const enqueueMs = performance.now() - arrivedAt;
      assert.ok(enqueued && enqueueMs <= 15_000, `healthy enqueue ${enqueueMs.toFixed(1)}ms exceeds frozen15s`);
      const receipt = await waitFor(async () => (await observer.query(
        'SELECT id,run_id FROM app_run_receipts WHERE org_id=$1', [healthy.orgId])).rows[0] ?? null,
      Math.max(1, 18_000 - (performance.now() - heldAt)));
      const observed = (await observer.query(`SELECT r.id,r.state,j.status AS delivery_status
        FROM app_runs r LEFT JOIN job_queue j ON j.org_id=r.org_id AND j.name='app-run-attempt' AND j.data->>'runId'=r.id::text
        WHERE r.org_id=$1`, [healthy.orgId])).rows;
      console.log('A05_PROVIDER_FAIRNESS', JSON.stringify({ provider_pid: checkpoint.pid, held_ms: performance.now() - heldAt,
        management_ms: managementMs, enqueue_ms: enqueueMs, healthy_receipt_ms: receipt ? performance.now() - arrivedAt : null,
        healthy: observed, held_effects: (await held.effects()).length, healthy_effects: (await healthy.effects()).length }));
      assert.ok(receipt, 'later healthy tenant must settle a verified receipt before the held provider is released');
      assert.equal((await healthy.effects()).length, 1);
      const verified = await (await getAppRunRuntime()).receiptReader.readVerified(healthy.orgId, receipt.run_id);
      assert.equal(verified.length, 1); assert.equal(verified[0].verified, true);
      assert.equal((await observer.query('SELECT count(*)::int AS count FROM app_run_receipts WHERE org_id=$1', [held.orgId])).rows[0].count, 0,
        'held provider has not responded or settled while healthy work succeeds');
    } finally {
      await writeFile(`${marker}.release`, 'release');
      if (started) await stopWorkers({ timeoutMs: 10_000 });
      await observer.end();
    }
  });
