import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq, sql } from 'drizzle-orm';
import { jobQueue } from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import {
  cleanupStaleJobs,
  completeJob,
  dequeueJob,
  enqueue,
  ensureCronJob,
  failJob,
  pruneFinishedJobs,
  renewJobLease,
  type QueueName,
} from '../src/lib/queues.js';

// A private queue keeps these integration tests isolated from any worker that
// may be polling the normal agent/scheduled queues on a developer machine.
const TEST_QUEUE = `queue-reliability:${crypto.randomUUID()}` as QueueName;

after(async () => {
  await db.delete(jobQueue).where(eq(jobQueue.queue, TEST_QUEUE));
});

async function rowFor(name: string) {
  const [row] = await db.select()
    .from(jobQueue)
    .where(and(eq(jobQueue.queue, TEST_QUEUE), eq(jobQueue.name, name)))
    .orderBy(jobQueue.created_at)
    .limit(1);
  return row;
}

async function makeReady(id: string): Promise<void> {
  await db.update(jobQueue)
    .set({ run_at: new Date(Date.now() - 1_000) })
    .where(eq(jobQueue.id, id));
}

async function expireLease(id: string): Promise<void> {
  await db.update(jobQueue)
    .set({ lock_expires_at: new Date(Date.now() - 1_000) })
    .where(eq(jobQueue.id, id));
}

test('concurrent dequeue claims a job once with a unique ownership token', async () => {
  const name = `concurrent-claim:${crypto.randomUUID()}`;
  await enqueue(TEST_QUEUE, name, { marker: name });

  const claims = await Promise.all(
    Array.from({ length: 12 }, (_, index) => dequeueJob(TEST_QUEUE, {
      lockedBy: `test-worker-${index}`,
      leaseMs: 30_000,
    })),
  );
  const claimed = claims.filter((job) => job !== null);

  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]!.name, name);
  assert.match(claimed[0]!.lockToken, /^[0-9a-f-]{36}$/i);
  assert.equal(await completeJob(claimed[0]!.id, claimed[0]!.lockToken), true);
});

test('expired and superseded tokens cannot settle a reclaimed job', async () => {
  const name = `token-fence:${crypto.randomUUID()}`;
  await enqueue(TEST_QUEUE, name, {}, { maxAttempts: 3 });
  const first = await dequeueJob(TEST_QUEUE, { lockedBy: 'first-worker', leaseMs: 30_000 });
  assert.ok(first);

  await expireLease(first.id);
  assert.equal(await completeJob(first.id, first.lockToken), false, 'expired owner completed job');
  assert.equal(await failJob(first.id, first.lockToken, 'late failure'), false, 'expired owner failed job');

  assert.ok(await cleanupStaleJobs() >= 1);
  await makeReady(first.id);
  const second = await dequeueJob(TEST_QUEUE, { lockedBy: 'second-worker', leaseMs: 30_000 });
  assert.ok(second);
  assert.notEqual(second.lockToken, first.lockToken);
  assert.equal(await completeJob(second.id, first.lockToken), false, 'superseded token completed job');
  assert.equal(await failJob(second.id, first.lockToken, 'superseded failure'), false);
  assert.equal(await completeJob(second.id, second.lockToken), true);
});

test('only the live owner can renew a lease', async () => {
  const name = `lease-renewal:${crypto.randomUUID()}`;
  await enqueue(TEST_QUEUE, name, {});
  const claim = await dequeueJob(TEST_QUEUE, { lockedBy: 'lease-owner', leaseMs: 10_000 });
  assert.ok(claim);

  assert.equal(await renewJobLease(claim.id, crypto.randomUUID(), 60_000), false);
  assert.equal(await renewJobLease(claim.id, claim.lockToken, 60_000), true);

  const renewed = await rowFor(name);
  assert.ok(renewed?.lock_expires_at);
  assert.ok(renewed.lock_expires_at.getTime() > claim.lockExpiresAt.getTime());
  assert.equal(await completeJob(claim.id, claim.lockToken), true);
  assert.equal(await renewJobLease(claim.id, claim.lockToken), false, 'terminal job lease renewed');
});

test('expired leases retry once and terminal-fail after attempt exhaustion', async () => {
  const name = `stale-recovery:${crypto.randomUUID()}`;
  await enqueue(TEST_QUEUE, name, {}, { maxAttempts: 2 });

  const first = await dequeueJob(TEST_QUEUE);
  assert.ok(first);
  await expireLease(first.id);
  assert.ok(await cleanupStaleJobs() >= 1);

  const retrying = await rowFor(name);
  assert.equal(retrying?.status, 'pending');
  assert.equal(retrying?.attempts, 1);
  assert.equal(retrying?.lock_token, null);

  await makeReady(first.id);
  const second = await dequeueJob(TEST_QUEUE);
  assert.ok(second);
  assert.equal(second.attempts, 2);
  await expireLease(second.id);
  assert.ok(await cleanupStaleJobs() >= 1);

  const exhausted = await rowFor(name);
  assert.equal(exhausted?.status, 'failed');
  assert.ok(exhausted?.completed_at instanceof Date);
  assert.match(exhausted?.error ?? '', /lease expired/);
});

test('handler failures back off and terminal-fail at max attempts', async () => {
  const name = `retry-exhaustion:${crypto.randomUUID()}`;
  await enqueue(TEST_QUEUE, name, {}, { maxAttempts: 2 });

  const first = await dequeueJob(TEST_QUEUE);
  assert.ok(first);
  assert.equal(await failJob(first.id, first.lockToken, 'first failure'), true);
  const retrying = await rowFor(name);
  assert.equal(retrying?.status, 'pending');
  assert.ok((retrying?.run_at.getTime() ?? 0) > Date.now() - 100);

  await makeReady(first.id);
  const second = await dequeueJob(TEST_QUEUE);
  assert.ok(second);
  assert.equal(await failJob(second.id, second.lockToken, 'last failure'), true);

  const exhausted = await rowFor(name);
  assert.equal(exhausted?.status, 'failed');
  assert.equal(exhausted?.error, 'last failure');
  assert.ok(exhausted?.completed_at instanceof Date);
});

test('concurrent enqueue deduplicates tenant and system jobs', async () => {
  for (const orgId of [crypto.randomUUID(), null]) {
    const name = `enqueue-dedupe:${orgId ?? 'system'}:${crypto.randomUUID()}`;
    const dedupeKey = `dedupe:${crypto.randomUUID()}`;
    await Promise.all(Array.from({ length: 16 }, () => enqueue(
      TEST_QUEUE,
      name,
      { orgId },
      { orgId, dedupeKey },
    )));

    const rows = await db.select({ id: jobQueue.id })
      .from(jobQueue)
      .where(and(
        eq(jobQueue.queue, TEST_QUEUE),
        eq(jobQueue.dedupe_key, dedupeKey),
        orgId === null ? sql`${jobQueue.org_id} IS NULL` : eq(jobQueue.org_id, orgId),
      ));
    assert.equal(rows.length, 1, `dedupe failed for org ${orgId ?? '<system>'}`);
  }
});

test('concurrent cron registration keeps one active occurrence', async () => {
  const name = `cron-race:${crypto.randomUUID()}`;
  const cronKey = `cron:test:${crypto.randomUUID()}`;
  await Promise.all(Array.from({ length: 16 }, () =>
    ensureCronJob(TEST_QUEUE, name, cronKey, {}, 0)));

  const activeCount = async () => {
    const [row] = await db.select({ count: sql<number>`count(*)::int` })
      .from(jobQueue)
      .where(and(
        eq(jobQueue.cron_key, cronKey),
        sql`${jobQueue.status} IN ('pending', 'running')`,
      ));
    return Number(row?.count ?? 0);
  };
  assert.equal(await activeCount(), 1);

  const claim = await dequeueJob(TEST_QUEUE);
  assert.ok(claim);
  await ensureCronJob(TEST_QUEUE, name, cronKey);
  assert.equal(await activeCount(), 1, 'running occurrence must block startup duplicate');

  assert.equal(await failJob(claim.id, claim.lockToken, 'terminal cron test', { terminal: true }), true);
  await ensureCronJob(TEST_QUEUE, name, cronKey);
  assert.equal(await activeCount(), 1, 'terminal occurrence must permit exactly one successor');
});

test('retention prunes only sufficiently old terminal jobs', async () => {
  const oldCompletedId = crypto.randomUUID();
  const oldFailedId = crypto.randomUUID();
  const recentCompletedId = crypto.randomUUID();
  const pendingId = crypto.randomUUID();
  // Use an intentionally ancient timestamp and a century-long retention
  // window so a focused local run cannot prune real queue history.
  const old = new Date('1900-01-01T00:00:00.000Z');
  const recent = new Date(Date.now() - 1_000);

  await db.insert(jobQueue).values([
    {
      id: oldCompletedId,
      queue: TEST_QUEUE,
      name: `prune-old-completed:${oldCompletedId}`,
      data: {},
      status: 'completed',
      completed_at: old,
    },
    {
      id: oldFailedId,
      queue: TEST_QUEUE,
      name: `prune-old-failed:${oldFailedId}`,
      data: {},
      status: 'failed',
      completed_at: old,
    },
    {
      id: recentCompletedId,
      queue: TEST_QUEUE,
      name: `prune-recent:${recentCompletedId}`,
      data: {},
      status: 'completed',
      completed_at: recent,
    },
    {
      id: pendingId,
      queue: TEST_QUEUE,
      name: `prune-pending:${pendingId}`,
      data: {},
      status: 'pending',
      completed_at: old,
    },
  ]);

  assert.equal(await pruneFinishedJobs(100 * 365 * 24 * 60 * 60_000), 2);
  const survivors = await db.select({ id: jobQueue.id })
    .from(jobQueue)
    .where(sql`${jobQueue.id} IN (${recentCompletedId}, ${pendingId})`);
  assert.deepEqual(new Set(survivors.map((row) => row.id)), new Set([recentCompletedId, pendingId]));
});
