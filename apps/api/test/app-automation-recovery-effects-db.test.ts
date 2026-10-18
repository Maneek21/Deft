import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import pg from 'pg';
import { mcpClientManager } from '@deft/mcp';
import { closeDb } from '../src/lib/db.js';
import { runAppAutomationFire, runAppAutomationScan } from '../src/lib/app-automation-runtime.js';
import { closeAppAutomationScanDatabase } from '../src/lib/app-automation-scan-db.js';
import { APP_AUTOMATION_SCAN_CRON } from '../src/lib/app-automation-scan-progress.js';
import { getAppRunRuntime, shutdownAppRunRuntime } from '../src/lib/app-run-runtime.js';
import { handleAppRunAttempt } from '../src/lib/app-run-worker-handler.js';
import { dequeueJob, enqueue, ensureCronJob, QUEUE_NAMES } from '../src/lib/queues.js';
import { _processDequeuedJobForTest } from '../src/workers/index.js';
import { createAutomationRenewalFixture } from './fixtures/app-automation-renewal.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = !!target && target === process.env.DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c09_a05_recovery_test(?:_v[0-9]+)?$/.test(target);
process.env.DEFT_SELF_HOSTED = 'true';
process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO = 'true';
process.env.MCP_STDIO_ALLOWED_COMMANDS = process.execPath;
after(async () => { if (safe) {
  await shutdownAppRunRuntime(); await mcpClientManager.shutdown();
  await closeAppAutomationScanDatabase(); await closeDb();
} });

// The server completes the real COMMIT before its Promise rejects. This is an
// exact lost-response injection, not a fabricated row or a claimed rollback.
async function lostCommitResponse(table: string, operation: () => Promise<void>) {
  const original = pg.Client.prototype.query;
  const writes = new WeakSet<pg.Client>();
  let injected = 0;
  const replacement = mock.method(pg.Client.prototype, 'query', function (this: pg.Client, ...args: unknown[]) {
    const query = args[0];
    const text = typeof query === 'string' ? query : (query as { text?: string })?.text ?? '';
    if (new RegExp(`insert into "${table}"`, 'i').test(text)) writes.add(this);
    const response = Reflect.apply(original, this, args);
    if (/^commit$/i.test(text) && writes.has(this) && injected === 0) {
      injected++;
      assert.ok(response instanceof Promise, 'the targeted production transaction uses Promise SQL');
      return response.then(() => { throw new Error(`A05 lost ${table} COMMIT acknowledgement`); });
    }
    return response;
  });
  try { await operation(); assert.equal(injected, 1, `a real ${table} COMMIT was targeted`); }
  finally { replacement.mock.restore(); }
}

async function scan(observer: pg.Client, policyAt: Date) {
  await observer.query('DELETE FROM job_queue WHERE cron_key=$1', [APP_AUTOMATION_SCAN_CRON]);
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'app-automation-scan', APP_AUTOMATION_SCAN_CRON, {}, 0);
  for (let slice = 0; slice < 8; slice++) {
    const job = await dequeueJob(QUEUE_NAMES.SCHEDULED_JOBS, { jobName: 'app-automation-scan' }); assert.ok(job);
    await _processDequeuedJobForTest(QUEUE_NAMES.SCHEDULED_JOBS, job, {
      resolveHandler: async () => async value => runAppAutomationScan(policyAt, value.signal,
        { id: value.id, lockToken: value.lockToken! }),
    });
    const [row] = (await observer.query('SELECT status,data FROM job_queue WHERE id=$1', [job.id])).rows;
    assert.equal(row.status, 'completed');
    if (row.data.automation_scan.complete) return;
  }
  assert.fail('bounded recovery fixture failed to complete');
}
async function fireWorker(orgId: string, definitionId: string) {
  const job = await dequeueJob(QUEUE_NAMES.SCHEDULED_JOBS, { orgId, jobName: 'app-automation-fire',
    dataMatch: { key: 'definition_id', value: definitionId } }); assert.ok(job);
  await _processDequeuedJobForTest(QUEUE_NAMES.SCHEDULED_JOBS, job, {
    resolveHandler: async () => async value => runAppAutomationFire(value),
  });
  return job;
}
async function attemptWorker(orgId: string, runId: string) {
  const job = await dequeueJob(QUEUE_NAMES.AGENT_JOBS, { orgId, jobName: 'app-run-attempt',
    dataMatch: { key: 'runId', value: runId } }); assert.ok(job);
  await _processDequeuedJobForTest(QUEUE_NAMES.AGENT_JOBS, job, { resolveHandler: async () => handleAppRunAttempt });
  return job;
}
async function identities(observer: pg.Client, orgId: string, definitionId: string) {
  const fires = (await observer.query('SELECT id,fire_identity,state,app_run_id FROM app_automation_fires WHERE definition_id=$1', [definitionId])).rows;
  const runs = (await observer.query('SELECT id,state FROM app_runs WHERE org_id=$1', [orgId])).rows;
  const receipts = (await observer.query('SELECT id,run_id FROM app_run_receipts WHERE org_id=$1', [orgId])).rows;
  return { fires, runs, receipts };
}

test('A05 actual workers preserve one effect Run and verified receipt after fire and Run COMMIT response loss and queue deletion', { skip: !safe }, async () => {
  const fixture = await createAutomationRenewalFixture();
  const due = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const { definition } = await fixture.create(due, new Date(due.getTime() - 1_000));
  const observer = new pg.Client({ connectionString: target }); await observer.connect();
  try {
    await lostCommitResponse('app_automation_fires', () => scan(observer, new Date()));
    const [committed] = (await observer.query('SELECT id,fire_identity FROM app_automation_fires WHERE definition_id=$1', [definition.id])).rows;
    assert.ok(committed); assert.deepEqual(await fixture.effects(), []);
    await observer.query("DELETE FROM job_queue WHERE name='app-automation-fire' AND data->>'definition_id'=$1", [definition.id]);
    await scan(observer, new Date());
    let fireJob!: Awaited<ReturnType<typeof fireWorker>>;
    await lostCommitResponse('app_runs', async () => { fireJob = await fireWorker(fixture.orgId, definition.id); });
    const created = await identities(observer, fixture.orgId, definition.id);
    assert.equal(created.fires.length, 1); assert.equal(created.fires[0].id, committed.id);
    assert.equal(created.fires[0].state, 'run_created'); assert.equal(created.runs.length, 1);
    assert.equal(created.fires[0].app_run_id, created.runs[0].id);
    assert.equal(created.receipts.length, 0); assert.deepEqual(await fixture.effects(), []);
    // Lost fire acknowledgement cannot manufacture a second Run. Delete the
    // delivery and scan metadata, then replay the retained delivery identity.
    await observer.query('DELETE FROM job_queue WHERE id=$1', [fireJob.id]);
    await scan(observer, new Date());
    await enqueue(QUEUE_NAMES.SCHEDULED_JOBS, 'app-automation-fire', fireJob.data, { orgId: fixture.orgId });
    await fireWorker(fixture.orgId, definition.id);
    await attemptWorker(fixture.orgId, created.runs[0].id);
    const settled = await identities(observer, fixture.orgId, definition.id);
    assert.equal(settled.runs[0].state, 'succeeded'); assert.equal(settled.receipts.length, 1);
    assert.equal((await fixture.effects()).length, 1);
    const verified = await (await getAppRunRuntime()).receiptReader.readVerified(fixture.orgId, created.runs[0].id);
    assert.equal(verified.length, 1); assert.equal(verified[0].verified, true);
    await scan(observer, new Date());
    await enqueue(QUEUE_NAMES.SCHEDULED_JOBS, 'app-automation-fire', fireJob.data, { orgId: fixture.orgId });
    await fireWorker(fixture.orgId, definition.id);
    assert.deepEqual(await identities(observer, fixture.orgId, definition.id), settled);
    assert.equal((await fixture.effects()).length, 1);
    console.log('A05_COMMIT_QUEUE_RECOVERY', JSON.stringify({ fire_id: committed.id,
      run_id: settled.runs[0].id, receipt_id: settled.receipts[0].id, effects: 1, outbox: fixture.outboxRoot }));
  } finally { await observer.end(); }
});

test('A05 actual attempt worker replays a lost receipt COMMIT acknowledgement without a second provider effect or receipt', { skip: !safe }, async () => {
  const fixture = await createAutomationRenewalFixture();
  const due = new Date(Math.floor(Date.now() / 60_000) * 60_000);
  const { definition } = await fixture.create(due, new Date(due.getTime() - 1_000));
  const observer = new pg.Client({ connectionString: target }); await observer.connect();
  try {
    await scan(observer, new Date()); await fireWorker(fixture.orgId, definition.id);
    const [run] = (await identities(observer, fixture.orgId, definition.id)).runs;
    let attempt!: Awaited<ReturnType<typeof attemptWorker>>;
    await lostCommitResponse('app_run_receipts', async () => { attempt = await attemptWorker(fixture.orgId, run.id); });
    const committed = await identities(observer, fixture.orgId, definition.id);
    assert.equal(committed.runs[0].state, 'succeeded'); assert.equal(committed.receipts.length, 1);
    assert.equal((await fixture.effects()).length, 1);
    // Force only delivery cadence; no domain lease/authority/clock is edited.
    await observer.query("UPDATE job_queue SET run_at=clock_timestamp() WHERE id=$1 AND status='pending'", [attempt.id]);
    const [delivery] = (await observer.query('SELECT status FROM job_queue WHERE id=$1', [attempt.id])).rows;
    if (delivery.status === 'pending') await attemptWorker(fixture.orgId, run.id);
    else {
      assert.equal(delivery.status, 'completed');
      await enqueue(QUEUE_NAMES.AGENT_JOBS, 'app-run-attempt', attempt.data, { orgId: fixture.orgId });
      await attemptWorker(fixture.orgId, run.id);
    }
    assert.deepEqual(await identities(observer, fixture.orgId, definition.id), committed);
    assert.equal((await fixture.effects()).length, 1);
    const verified = await (await getAppRunRuntime()).receiptReader.readVerified(fixture.orgId, run.id);
    assert.equal(verified.length, 1); assert.equal(verified[0].verified, true);
    console.log('A05_RECEIPT_COMMIT_RECOVERY', JSON.stringify({ run_id: run.id,
      receipt_id: committed.receipts[0].id, effects: 1, outbox: fixture.outboxRoot }));
  } finally { await observer.end(); }
});
