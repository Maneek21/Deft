import './fixtures/app-run-enabled-env.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { and, eq } from 'drizzle-orm';
import { appAutomationDefinitions, appAutomationFires, appRunReceipts, appRuns } from '@deft/db/schema';
import { mcpClientManager } from '@deft/mcp';
import { db, closeDb } from '../src/lib/db.js';
import { AppError } from '../src/lib/app-errors.js';
import { createReviewedAppAutomationDefinition, expireAppAutomationDefinition,
  pauseAppAutomationDefinition, persistAppAutomationFire, resumeAppAutomationDefinition,
  revokeAppAutomationDefinition } from '../src/lib/app-automation-definition-service.js';
import { runAppAutomationFire, runAppAutomationScan } from '../src/lib/app-automation-runtime.js';
import { completeJob, dequeueJob, QUEUE_NAMES } from '../src/lib/queues.js';
import { handleAppRunAttempt } from '../src/lib/app-run-worker-handler.js';
import { getAppRunRuntime, shutdownAppRunRuntime } from '../src/lib/app-run-runtime.js';
import { createAutomationRenewalFixture } from './fixtures/app-automation-renewal.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
if (!target || target !== process.env.DATABASE_URL
  || !/^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_automation_renewal(?:_v[0-9]+)?$/.test(target)) {
  throw new Error('A02 requires the exact dedicated synthetic renewal database in both environment variables');
}
process.env.DEFT_SELF_HOSTED = 'true';
process.env.DEFT_MCP_ENABLE_UNSAFE_STDIO = 'true';
process.env.MCP_STDIO_ALLOWED_COMMANDS = process.execPath;
after(async () => { await shutdownAppRunRuntime(); await mcpClientManager.shutdown(); await closeDb(); });

type Fixture = Awaited<ReturnType<typeof createAutomationRenewalFixture>>;
type Definition = Awaited<ReturnType<Fixture['create']>>['definition'];
type QueueJob = NonNullable<Awaited<ReturnType<typeof dequeueJob>>>;
const minute = () => Math.floor(Date.now() / 60_000) * 60_000;
const stale = (error: unknown) => error instanceof AppError && error.code === 'APP_STALE';
const jobData = (job: QueueJob) => ({ id: job.id, name: job.name, data: job.data,
  attempts: job.attempts, leaseExpiresAt: job.lockExpiresAt });
async function fireRows(f: Fixture, definition: Definition) {
  return db.select().from(appAutomationFires).where(and(eq(appAutomationFires.org_id, f.orgId),
    eq(appAutomationFires.definition_id, definition.id)));
}
async function fireJob(f: Fixture, definition: Definition) {
  const job = await dequeueJob(QUEUE_NAMES.SCHEDULED_JOBS, { lockedBy: 'a02-acceptance',
    orgId: f.orgId, jobName: 'app-automation-fire', dataMatch: { key: 'definition_id', value: definition.id } });
  assert.ok(job, 'actual scanner created a durable fire queue job');
  return job;
}
async function admit(f: Fixture, definition: Definition, scanAt: Date) {
  await runAppAutomationScan(scanAt);
  const job = await fireJob(f, definition);
  await runAppAutomationFire(jobData(job), scanAt);
  assert.equal(await completeJob(job.id, job.lockToken), true);
  const [fire] = (await fireRows(f, definition)).filter(row => row.id === job.data.fire_id);
  assert.equal(fire?.state, 'run_created');
  assert.ok(fire.app_run_id);
  const runtime = await getAppRunRuntime();
  let attempt = await dequeueJob(QUEUE_NAMES.AGENT_JOBS, { lockedBy: 'a02-attempt', orgId: f.orgId,
    jobName: 'app-run-attempt', dataMatch: { key: 'runId', value: fire.app_run_id } });
  if (!attempt) {
    assert.ok(await runtime.attemptRunner.prepareAttempt(f.orgId, fire.app_run_id));
    attempt = await dequeueJob(QUEUE_NAMES.AGENT_JOBS, { lockedBy: 'a02-attempt-rearm', orgId: f.orgId,
      jobName: 'app-run-attempt', dataMatch: { key: 'runId', value: fire.app_run_id } });
  }
  assert.ok(attempt);
  return { fire, attempt };
}
async function deliver(f: Fixture, admitted: Awaited<ReturnType<typeof admit>>) {
  await handleAppRunAttempt(jobData(admitted.attempt));
  await handleAppRunAttempt({ ...jobData(admitted.attempt), id: `${admitted.attempt.id}:duplicate` });
  assert.equal(await completeJob(admitted.attempt.id, admitted.attempt.lockToken), true);
  const [run] = await db.select().from(appRuns).where(and(eq(appRuns.org_id, f.orgId), eq(appRuns.id, admitted.fire.app_run_id!)));
  assert.equal(run?.state, 'succeeded');
  const receipts = await db.select().from(appRunReceipts).where(and(eq(appRunReceipts.org_id, f.orgId),
    eq(appRunReceipts.run_id, admitted.fire.app_run_id!)));
  assert.equal(receipts.length, 1);
  const runtime = await getAppRunRuntime();
  const verified = await runtime.receiptReader.readVerified(f.orgId, admitted.fire.app_run_id!);
  assert.equal(verified.length, 1);
  assert.equal(verified[0]!.verified, true);
  return receipts[0]!;
}
function occurrence(f: Fixture, definition: Definition, scheduledAt: Date, expectedEpoch = definition.definition_epoch) {
  return { organization_id: f.orgId, definition_id: definition.id, expected_epoch: expectedEpoch,
    logical_local_date: scheduledAt.toISOString().slice(0, 10),
    resolution: { kind: 'resolved' as const, resolved_at_utc: scheduledAt } };
}

test('A02 reviewed renewal creates new authority while expired definitions and old queued fires stay inert', async () => {
  const f = await createAutomationRenewalFixture();
  const base = minute();
  const oldDue = new Date(base - 2 * 60_000);
  const old = await f.create(oldDue, new Date(base - 4 * 60_000), 180);
  await runAppAutomationScan(new Date(oldDue.getTime() + 10_000));
  const queuedOld = await fireJob(f, old.definition);
  const expired = await expireAppAutomationDefinition(f.actor, { definition_id: old.definition.id,
    expected_epoch: old.definition.definition_epoch }, { now: () => new Date(base - 60_000) });
  assert.equal(expired.state, 'expired');
  assert.equal(expired.definition_epoch, 2);
  assert.ok(expired.valid_until.getTime() <= Date.now(), 'old approval window has actually elapsed');
  await assert.rejects(resumeAppAutomationDefinition(f.actor, { definition_id: expired.id, expected_epoch: 2 }), stale);
  await assert.rejects(pauseAppAutomationDefinition(f.actor, { definition_id: expired.id, expected_epoch: 1 }), stale);
  await assert.rejects(persistAppAutomationFire(occurrence(f, old.definition, oldDue)), stale);
  const newDue = new Date(base);
  const newInput = f.inputFor(newDue);
  await assert.rejects(createReviewedAppAutomationDefinition(f.actor, { ...newInput,
    expected_review_digest: old.review.review_digest, accept_code_owned_policy: true }), stale);
  const renewed = await f.create(newDue, new Date(newDue.getTime() - 10_000));
  assert.notEqual(renewed.definition.id, old.definition.id);
  assert.notEqual(renewed.definition.definition_digest, old.definition.definition_digest);
  assert.notEqual(renewed.review.review_digest, old.review.review_digest);
  assert.equal(renewed.definition.definition_epoch, 1);
  assert.equal(renewed.definition.approved_by_user_id, f.userId);
  await runAppAutomationFire(jobData(queuedOld));
  assert.equal(await completeJob(queuedOld.id, queuedOld.lockToken), true);
  const [oldFire] = await fireRows(f, old.definition);
  assert.equal(oldFire?.state, 'skipped');
  assert.equal(oldFire.terminal_reason, 'definition_ineligible');
  assert.equal(oldFire.app_run_id, null);
  assert.equal((await f.effects()).length, 0);
  const admitted = await admit(f, renewed.definition, new Date());
  const receipt = await deliver(f, admitted);
  await runAppAutomationFire(jobData(queuedOld));
  await runAppAutomationScan(new Date());
  assert.equal((await f.effects()).length, 1);
  assert.equal((await fireRows(f, old.definition)).length, 1);
  assert.equal((await fireRows(f, renewed.definition)).length, 1);
  const [stillExpired] = await db.select().from(appAutomationDefinitions).where(eq(appAutomationDefinitions.id, expired.id));
  assert.equal(stillExpired?.state, 'expired');
  console.log('A02_RENEWAL', JSON.stringify({ org_id: f.orgId, old_definition: expired.id,
    new_definition: renewed.definition.id, old_fire: oldFire.state, effects: 1,
    receipt_id: receipt.id, outbox: f.outboxRoot }));
});

test('A02 permanent revocation blocks already admitted work and cannot be resumed with any epoch', async () => {
  const f = await createAutomationRenewalFixture();
  const base = minute();
  const due = new Date(base - 60_000);
  const original = await f.create(due, new Date(base - 3 * 60_000));
  const admitted = await admit(f, original.definition, new Date());
  const revoked = await revokeAppAutomationDefinition(f.actor, { definition_id: original.definition.id, expected_epoch: 1 });
  assert.equal(revoked.state, 'revoked');
  assert.equal(revoked.definition_epoch, 2);
  assert.ok(revoked.revoked_at);
  for (const epoch of [1, 2, 3]) {
    await assert.rejects(resumeAppAutomationDefinition(f.actor, { definition_id: revoked.id, expected_epoch: epoch }), stale);
    await assert.rejects(pauseAppAutomationDefinition(f.actor, { definition_id: revoked.id, expected_epoch: epoch }), stale);
    await assert.rejects(persistAppAutomationFire(occurrence(f, revoked, due, epoch)), stale);
  }
  await handleAppRunAttempt(jobData(admitted.attempt));
  await handleAppRunAttempt({ ...jobData(admitted.attempt), id: `${admitted.attempt.id}:replayed` });
  assert.equal(await completeJob(admitted.attempt.id, admitted.attempt.lockToken), true);
  await runAppAutomationScan(new Date(due.getTime() + 24 * 60 * 60_000 + 10_000));
  assert.equal((await f.effects()).length, 0);
  assert.equal((await fireRows(f, revoked)).length, 1);
  const receipts = await db.select().from(appRunReceipts).where(eq(appRunReceipts.org_id, f.orgId));
  assert.equal(receipts.length, 0);
  const [run] = await db.select().from(appRuns).where(eq(appRuns.id, admitted.fire.app_run_id!));
  assert.notEqual(run?.state, 'succeeded');
  console.log('A02_REVOCATION', JSON.stringify({ org_id: f.orgId, definition_id: revoked.id,
    epoch: revoked.definition_epoch, admitted_run_state: run?.state, effects: 0, receipts: 0, outbox: f.outboxRoot }));
});

test('A02 pause resume rejects stale epochs and missed occurrences without forbidden backfill', async () => {
  const f = await createAutomationRenewalFixture();
  const base = minute();
  const due = new Date(base - 2 * 60_000);
  const original = await f.create(due, new Date(due.getTime() - 2 * 24 * 60 * 60_000));
  const paused = await pauseAppAutomationDefinition(f.actor, { definition_id: original.definition.id, expected_epoch: 1 },
    { now: () => new Date(due.getTime() - 30_000) });
  await runAppAutomationScan(new Date(due.getTime() + 10_000));
  assert.equal((await fireRows(f, paused)).length, 0);
  await assert.rejects(resumeAppAutomationDefinition(f.actor, { definition_id: paused.id, expected_epoch: 1 }), stale);
  const resumed = await resumeAppAutomationDefinition(f.actor, { definition_id: paused.id, expected_epoch: 2 },
    { now: () => new Date(due.getTime() + 30_000) });
  assert.equal(resumed.definition_epoch, 3);
  for (const epoch of [1, 2, 3]) {
    await assert.rejects(persistAppAutomationFire(occurrence(f, resumed, due, epoch)), stale);
  }
  await runAppAutomationScan(new Date());
  assert.equal((await fireRows(f, resumed)).length, 0, 'resuming inside catch-up window never backfills pre-resume occurrence');
  assert.equal((await f.effects()).length, 0);
  const nextDue = new Date(due.getTime() + 24 * 60 * 60_000);
  const admitted = await admit(f, resumed, new Date(nextDue.getTime() + 10_000));
  assert.equal(admitted.fire.definition_epoch, 3);
  assert.equal(admitted.fire.logical_local_date, nextDue.toISOString().slice(0, 10));
  await deliver(f, admitted);
  assert.equal((await f.effects()).length, 1);
  assert.equal((await fireRows(f, resumed)).length, 1);
  await revokeAppAutomationDefinition(f.actor, { definition_id: resumed.id, expected_epoch: 3 });
  console.log('A02_PAUSE_RESUME', JSON.stringify({ org_id: f.orgId, definition_id: resumed.id,
    resumed_epoch: 3, missed_fires: 0, next_due_fires: 1, effects: 1, outbox: f.outboxRoot }));
});
test('A02 queued fires from an earlier definition epoch cannot execute after pause and resume', async () => {
  const f = await createAutomationRenewalFixture();
  const base = minute();
  const due = new Date(base - 60_000);
  const original = await f.create(due, new Date(base - 3 * 60_000));
  await runAppAutomationScan(new Date());
  const oldJob = await fireJob(f, original.definition);
  assert.equal(oldJob.data.definition_epoch, 1);
  const paused = await pauseAppAutomationDefinition(f.actor, { definition_id: original.definition.id, expected_epoch: 1 });
  const resumed = await resumeAppAutomationDefinition(f.actor, { definition_id: paused.id, expected_epoch: 2 });
  assert.equal(resumed.state, 'active');
  assert.equal(resumed.definition_epoch, 3);
  await assert.rejects(revokeAppAutomationDefinition(f.actor, { definition_id: resumed.id, expected_epoch: 1 }), stale);
  await runAppAutomationFire(jobData(oldJob));
  await runAppAutomationFire({ ...jobData(oldJob), id: `${oldJob.id}:replayed` });
  assert.equal(await completeJob(oldJob.id, oldJob.lockToken), true);
  await runAppAutomationScan(new Date());
  const rows = await fireRows(f, resumed);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.definition_epoch, 1);
  assert.equal(rows[0]!.state, 'skipped');
  assert.equal(rows[0]!.terminal_reason, 'definition_ineligible');
  assert.equal(rows[0]!.app_run_id, null);
  assert.equal((await db.select().from(appRuns).where(eq(appRuns.org_id, f.orgId))).length, 0);
  assert.equal((await db.select().from(appRunReceipts).where(eq(appRunReceipts.org_id, f.orgId))).length, 0);
  assert.equal((await f.effects()).length, 0);
  console.log('A02_STALE_DELIVERY', JSON.stringify({ org_id: f.orgId, definition_id: resumed.id,
    current_epoch: 3, queued_epoch: 1, old_fire: rows[0]!.state, runs: 0, effects: 0, outbox: f.outboxRoot }));
});