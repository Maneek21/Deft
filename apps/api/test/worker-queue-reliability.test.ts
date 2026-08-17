import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { jobQueue } from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import {
  dequeueJob,
  enqueue,
  ensureCronJob,
  type QueueName,
} from '../src/lib/queues.js';
import {
  _processDequeuedJobForTest,
  getWorkerStatus,
  stopWorkers,
} from '../src/workers/index.js';

const TEST_QUEUE = `worker-reliability:${crypto.randomUUID()}` as QueueName;

after(async () => {
  await stopWorkers({ timeoutMs: 100 });
  await db.delete(jobQueue).where(eq(jobQueue.queue, TEST_QUEUE));
});

async function rowsFor(name: string) {
  return db.select()
    .from(jobQueue)
    .where(and(eq(jobQueue.queue, TEST_QUEUE), eq(jobQueue.name, name)))
    .orderBy(jobQueue.created_at);
}

test('unknown jobs terminal-fail instead of being silently completed or retried', async () => {
  const name = `unknown:${crypto.randomUUID()}`;
  await enqueue(TEST_QUEUE, name, {}, { maxAttempts: 5 });
  const claim = await dequeueJob(TEST_QUEUE, { leaseMs: 10_000 });
  assert.ok(claim);

  await _processDequeuedJobForTest(TEST_QUEUE, claim);

  const [row] = await rowsFor(name);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.attempts, 1);
  assert.ok(row?.completed_at instanceof Date);
  assert.match(row?.error ?? '', /Unknown .* job/);
});

test('timeout aborts the handler and late resolution cannot complete the terminal job', async () => {
  const name = `timeout:${crypto.randomUUID()}`;
  await enqueue(TEST_QUEUE, name, {}, { maxAttempts: 5 });
  const claim = await dequeueJob(TEST_QUEUE, { leaseMs: 10_000 });
  assert.ok(claim);
  let observedAbort = false;
  let resolveLate!: () => void;
  const late = new Promise<void>((resolve) => {
    resolveLate = resolve;
  });

  await _processDequeuedJobForTest(TEST_QUEUE, claim, {
    timeoutMs: 20,
    leaseMs: 10_000,
    renewIntervalMs: 5_000,
    resolveHandler: async () => async (job: any) => {
      job.signal?.addEventListener('abort', () => {
        observedAbort = true;
      }, { once: true });
      await late;
    },
  });
  assert.equal(observedAbort, true, 'handler did not receive abort signal at timeout');
  assert.equal(getWorkerStatus().inFlight, 1, 'late handler disappeared from worker health');

  resolveLate();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(getWorkerStatus().inFlight, 0);

  const [row] = await rowsFor(name);
  assert.equal(row?.status, 'failed');
  assert.equal(row?.attempts, 1, 'timeout must not enqueue an overlapping retry');
  assert.match(row?.error ?? '', /timed out/);
  assert.ok(row?.completed_at instanceof Date);
});

test('a terminally failed recurring occurrence schedules one successor', async () => {
  const name = 'nudge-check';
  const cronKey = `cron:worker-failure:${crypto.randomUUID()}`;
  await ensureCronJob(TEST_QUEUE, name, cronKey);
  const [seed] = await db.select({ id: jobQueue.id })
    .from(jobQueue)
    .where(eq(jobQueue.cron_key, cronKey));
  assert.ok(seed);
  await db.update(jobQueue)
    .set({ max_attempts: 1 })
    .where(eq(jobQueue.id, seed.id));

  const claim = await dequeueJob(TEST_QUEUE, { leaseMs: 10_000 });
  assert.ok(claim);
  await _processDequeuedJobForTest(TEST_QUEUE, claim, {
    resolveHandler: async () => async () => {
      throw new Error('recurring handler failed');
    },
  });

  const rows = await db.select({ status: jobQueue.status })
    .from(jobQueue)
    .where(eq(jobQueue.cron_key, cronKey));
  assert.equal(rows.filter((row) => row.status === 'failed').length, 1);
  assert.equal(rows.filter((row) => row.status === 'pending').length, 1);
});
