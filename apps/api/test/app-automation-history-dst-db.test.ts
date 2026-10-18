import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import pg from 'pg';
import { mcpClientManager } from '@deft/mcp';
import { db, closeDb } from '../src/lib/db.js';
import { AppError } from '../src/lib/app-errors.js';
import { createReviewedAppAutomationDefinition, persistAppAutomationFire,
  prepareAppAutomationDefinitionReview } from '../src/lib/app-automation-definition-service.js';
import { claimAppAutomationFireWithExecutor, getAppAutomationFireWithExecutor } from '../src/lib/app-automation-repository.js';
import { runAppAutomationScan } from '../src/lib/app-automation-runtime.js';
import { APP_AUTOMATION_SCAN_CRON } from '../src/lib/app-automation-scan-progress.js';
import { dequeueJob, ensureCronJob, QUEUE_NAMES } from '../src/lib/queues.js';
import { _processDequeuedJobForTest } from '../src/workers/index.js';
import { createAutomationRenewalFixture } from './fixtures/app-automation-renewal.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = !!target && target === process.env.DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_a05_history_test(?:_v[0-9]+)?$/.test(target);
process.env.DEFT_SELF_HOSTED = 'true';
process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO = 'true';
process.env.MCP_STDIO_ALLOWED_COMMANDS = process.execPath;
after(async () => { if (safe) { await mcpClientManager.shutdown(); await closeDb(); } });

type Fixture = Awaited<ReturnType<typeof createAutomationRenewalFixture>>;
async function reviewedSchedule(fixture: Fixture, localTime: string, timezone: string, approvedAt: Date) {
  const input = { ...fixture.inputFor(approvedAt, 86_400), local_time: localTime, timezone };
  const review = await prepareAppAutomationDefinitionReview(fixture.actor, input);
  return createReviewedAppAutomationDefinition(fixture.actor, { ...input,
    expected_review_digest: review.review_digest, accept_code_owned_policy: true }, { now: () => approvedAt });
}
async function leasedScan(observer: pg.Client, policyAt: Date) {
  // Retention loss restarts bounded traversal, while domain identities survive.
  await observer.query('DELETE FROM job_queue WHERE cron_key=$1', [APP_AUTOMATION_SCAN_CRON]);
  await ensureCronJob(QUEUE_NAMES.SCHEDULED_JOBS, 'app-automation-scan', APP_AUTOMATION_SCAN_CRON, {}, 0);
  for (let slice = 0; slice < 8; slice++) {
    const job = await dequeueJob(QUEUE_NAMES.SCHEDULED_JOBS, { jobName: 'app-automation-scan' }); assert.ok(job);
    await _processDequeuedJobForTest(QUEUE_NAMES.SCHEDULED_JOBS, job, {
      resolveHandler: async () => async runtimeJob => runAppAutomationScan(policyAt, runtimeJob.signal,
        { id: runtimeJob.id, lockToken: runtimeJob.lockToken! }),
    });
    const [settled] = (await observer.query('SELECT status,data FROM job_queue WHERE id=$1', [job.id])).rows;
    assert.equal(settled.status, 'completed');
    if (settled.data.automation_scan.complete) return slice + 1;
  }
  assert.fail('bounded leased scanner did not complete the small history fixture');
}

test('A05 persisted DST gap is one explicit terminal identity across leased replay and metadata retention loss', { skip: !safe }, async () => {
  const fixture = await createAutomationRenewalFixture();
  const definition = await reviewedSchedule(fixture, '02:30', 'America/New_York', new Date('2026-03-08T05:00:00Z'));
  const observer = new pg.Client({ connectionString: target }); await observer.connect();
  try {
    await leasedScan(observer, new Date('2026-03-08T07:01:00Z'));
    const before = (await observer.query('SELECT id,fire_identity,state,terminal_reason,resolved_at_utc,logical_local_date FROM app_automation_fires WHERE definition_id=$1', [definition.id])).rows;
    assert.equal(before.length, 1);
    assert.equal(before[0].logical_local_date, '2026-03-08'); assert.equal(before[0].state, 'skipped');
    assert.equal(before[0].terminal_reason, 'dst_gap'); assert.equal(before[0].resolved_at_utc, null);
    await leasedScan(observer, new Date('2026-03-08T07:01:00Z'));
    assert.deepEqual((await observer.query('SELECT id,fire_identity,state,terminal_reason,resolved_at_utc,logical_local_date FROM app_automation_fires WHERE definition_id=$1', [definition.id])).rows, before);
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM job_queue WHERE data->>'definition_id'=$1", [definition.id])).rows[0].count, 0);
    assert.equal((await observer.query('SELECT count(*)::int AS count FROM app_runs WHERE org_id=$1', [fixture.orgId])).rows[0].count, 0);
    assert.deepEqual(await fixture.effects(), []);
  } finally { await observer.end(); }
});

test('A05 persisted DST fold chooses earlier UTC identity and refuses a later matching instant', { skip: !safe }, async () => {
  const fixture = await createAutomationRenewalFixture();
  const definition = await reviewedSchedule(fixture, '01:30', 'America/New_York', new Date('2026-11-01T04:00:00Z'));
  const observer = new pg.Client({ connectionString: target }); await observer.connect();
  try {
    await leasedScan(observer, new Date('2026-11-01T05:31:00Z'));
    // Raw pg.Client parses timestamp-without-time-zone using the local host
    // timezone. Compare the persisted UTC-naive representation directly.
    const [fire] = (await observer.query(`SELECT *,to_char(resolved_at_utc,
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS resolved_at_utc_iso
      FROM app_automation_fires WHERE definition_id=$1`, [definition.id])).rows;
    assert.ok(fire); assert.equal(fire.resolved_at_utc_iso, '2026-11-01T05:30:00.000Z');
    const productionRead = await getAppAutomationFireWithExecutor(db, fixture.orgId, definition.id, fire.id);
    assert.equal(productionRead?.resolved_at_utc?.toISOString(), '2026-11-01T05:30:00.000Z');
    assert.equal(fire.logical_local_date, '2026-11-01');
    await assert.rejects(persistAppAutomationFire({ organization_id: fixture.orgId, definition_id: definition.id,
      expected_epoch: definition.definition_epoch, logical_local_date: '2026-11-01',
      resolution: { kind: 'resolved', resolved_at_utc: new Date('2026-11-01T06:30:00Z') } },
    { now: () => new Date('2026-11-01T06:31:00Z') }), error => error instanceof AppError && error.code === 'APP_ACTION_INVALID');
    const token = randomUUID();
    const claimed = await db.transaction(tx => claimAppAutomationFireWithExecutor(tx, {
      organization_id: fixture.orgId, definition_id: definition.id, fire_id: fire.id,
      expected_epoch: definition.definition_epoch, claim_owner: 'a05-fold-fixture', claim_token: token,
      claimed_at: new Date('2026-11-01T05:31:00Z'), lease_expires_at: new Date('2026-11-01T07:31:00Z'),
    }));
    assert.ok(claimed);
    await leasedScan(observer, new Date('2026-11-01T06:31:00Z'));
    const after = (await observer.query(`SELECT id,fire_identity,state,claim_token,attempt_count,
      to_char(resolved_at_utc,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS resolved_at_utc_iso
      FROM app_automation_fires WHERE definition_id=$1`, [definition.id])).rows;
    assert.equal(after.length, 1); assert.equal(after[0].id, fire.id); assert.equal(after[0].fire_identity, fire.fire_identity);
    assert.equal(after[0].state, 'claimed'); assert.equal(after[0].claim_token, token); assert.equal(after[0].attempt_count, 1);
    assert.equal(after[0].resolved_at_utc_iso, '2026-11-01T05:30:00.000Z');
    assert.equal((await observer.query("SELECT count(*)::int AS count FROM job_queue WHERE data->>'definition_id'=$1", [definition.id])).rows[0].count, 1);
    assert.equal((await observer.query('SELECT count(*)::int AS count FROM app_runs WHERE org_id=$1', [fixture.orgId])).rows[0].count, 0);
    assert.deepEqual(await fixture.effects(), []);
  } finally { await observer.end(); }
});

test('A05 leased scanner persists full 30-day history and reuses every fire and delivery identity after retention loss', { skip: !safe }, async () => {
  const fixture = await createAutomationRenewalFixture();
  const scanAt = new Date('2048-01-30T10:01:00Z');
  const { definition } = await fixture.create(new Date('2048-01-01T10:00:00Z'), new Date('2048-01-01T09:59:00Z'), 30 * 86_400);
  const observer = new pg.Client({ connectionString: target }); await observer.connect();
  try {
    const slices = await leasedScan(observer, scanAt);
    const before = (await observer.query('SELECT id,fire_identity,logical_local_date,state,terminal_reason FROM app_automation_fires WHERE definition_id=$1 ORDER BY logical_local_date', [definition.id])).rows;
    assert.equal(before.length, 30); assert.equal(new Set(before.map(row => row.fire_identity)).size, 30);
    assert.deepEqual(before.map(row => row.logical_local_date), Array.from({ length: 30 }, (_value, index) => `2048-01-${String(index + 1).padStart(2, '0')}`));
    assert.ok(before.slice(0, 29).every(row => row.state === 'skipped' && row.terminal_reason === 'misfire_skipped'));
    assert.equal(before[29].state, 'pending'); assert.equal(before[29].terminal_reason, null);
    const delivery = (await observer.query("SELECT id,data FROM job_queue WHERE name='app-automation-fire' AND data->>'definition_id'=$1", [definition.id])).rows;
    assert.equal(delivery.length, 1); assert.equal(delivery[0].data.fire_id, before[29].id);
    await leasedScan(observer, scanAt);
    assert.deepEqual((await observer.query('SELECT id,fire_identity,logical_local_date,state,terminal_reason FROM app_automation_fires WHERE definition_id=$1 ORDER BY logical_local_date', [definition.id])).rows, before);
    assert.deepEqual((await observer.query("SELECT id,data FROM job_queue WHERE name='app-automation-fire' AND data->>'definition_id'=$1", [definition.id])).rows, delivery);
    assert.equal((await observer.query('SELECT count(*)::int AS count FROM app_runs WHERE org_id=$1', [fixture.orgId])).rows[0].count, 0);
    assert.deepEqual(await fixture.effects(), []);
    console.log('A05_HISTORY_IDENTITY_RESULT', JSON.stringify({ logical_days: 30, skipped: 29, pending: 1,
      distinct_fire_identities: 30, delivery_identities: 1, first_pass_leased_slices: slices, replay_after_retention_loss: true }));
  } finally { await observer.end(); }
});
