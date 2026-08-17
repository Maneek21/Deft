import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { jobQueue } from '@deft/db/schema';
import { db } from '../src/lib/db.js';
import {
  QUEUE_WORKER_STALE_AFTER_MS,
  getQueueHealthSnapshot,
  summarizeQueueHealth,
} from '../src/lib/queue-health.js';

const NOW = new Date('2026-08-17T12:00:00.000Z');

test('queue health normalizes aggregate values and reports a live worker', () => {
  const snapshot = summarizeQueueHealth(
    {
      pending: '3',
      running: 2,
      completed: '20',
      failed: 1,
      oldest_ready_lag_seconds: '4.5',
      expired_leases: '0',
      recent_terminal_failures: '1',
    },
    {
      running: true,
      startedAt: '2026-08-17T11:00:00.000Z',
      lastPollAt: new Date(NOW.getTime() - 1_000),
      inFlight: 2,
    },
    NOW,
  );

  assert.equal(snapshot.status, 'ok');
  assert.deepEqual(
    {
      pending: snapshot.pending,
      running: snapshot.running,
      completed: snapshot.completed,
      failed: snapshot.failed,
    },
    { pending: 3, running: 2, completed: 20, failed: 1 },
  );
  assert.equal(snapshot.oldest_ready_lag_seconds, 4.5);
  assert.equal(snapshot.recent_terminal_failures, 1);
  assert.equal(snapshot.worker.heartbeat_age_seconds, 1);
  assert.equal(snapshot.worker.heartbeat_stale, false);
  assert.equal(snapshot.worker.last_poll_at, '2026-08-17T11:59:59.000Z');
});

test('queue health degrades for an expired lease', () => {
  const snapshot = summarizeQueueHealth(
    { expired_leases: 1 },
    {
      running: true,
      startedAt: NOW,
      lastPollAt: NOW,
      inFlight: 0,
    },
    NOW,
  );

  assert.equal(snapshot.status, 'degraded');
  assert.equal(snapshot.expired_leases, 1);
  assert.equal(snapshot.worker.heartbeat_stale, false);
});

test('queue health degrades for stopped, missing, or stale worker heartbeats', () => {
  const stopped = summarizeQueueHealth(
    {},
    { running: false, startedAt: null, lastPollAt: null, inFlight: 0 },
    NOW,
  );
  assert.equal(stopped.status, 'degraded');
  assert.equal(stopped.worker.heartbeat_stale, true);

  const stale = summarizeQueueHealth(
    {},
    {
      running: true,
      startedAt: NOW,
      lastPollAt: new Date(NOW.getTime() - QUEUE_WORKER_STALE_AFTER_MS - 1),
      inFlight: 0,
    },
    NOW,
  );
  assert.equal(stale.status, 'degraded');
  assert.equal(stale.worker.heartbeat_stale, true);
});

test('queue health safely normalizes missing, negative, and invalid aggregates', () => {
  const snapshot = summarizeQueueHealth(
    {
      pending: null,
      running: '-2',
      completed: 'not-a-number',
      oldest_ready_lag_seconds: -10,
    },
    { running: true, startedAt: NOW, lastPollAt: NOW, inFlight: -1 },
    NOW,
  );

  assert.equal(snapshot.pending, 0);
  assert.equal(snapshot.running, 0);
  assert.equal(snapshot.completed, 0);
  assert.equal(snapshot.oldest_ready_lag_seconds, 0);
  assert.equal(snapshot.worker.in_flight, 0);
});

test('queue health query surfaces ready lag, expired leases, and recent terminal failures', async () => {
  const queue = `queue-health:${crypto.randomUUID()}`;
  const now = new Date();
  await db.insert(jobQueue).values([
    {
      queue,
      name: 'health-ready',
      data: {},
      status: 'pending',
      run_at: new Date(now.getTime() - 2_000),
    },
    {
      queue,
      name: 'health-expired',
      data: {},
      status: 'running',
      started_at: new Date(now.getTime() - 5_000),
      lock_token: crypto.randomUUID(),
      locked_by: 'health-test',
      lock_expires_at: new Date(now.getTime() - 1_000),
    },
    {
      queue,
      name: 'health-failed',
      data: {},
      status: 'failed',
      completed_at: now,
      error: 'health fixture',
    },
  ]);

  try {
    const snapshot = await getQueueHealthSnapshot({
      running: true,
      startedAt: now,
      lastPollAt: now,
      inFlight: 0,
    }, now);
    assert.ok(snapshot.pending >= 1);
    assert.ok(snapshot.oldest_ready_lag_seconds >= 1);
    assert.ok(snapshot.expired_leases >= 1);
    assert.ok(snapshot.recent_terminal_failures >= 1);
    assert.equal(snapshot.status, 'degraded');
  } finally {
    await db.delete(jobQueue).where(eq(jobQueue.queue, queue));
  }
});
