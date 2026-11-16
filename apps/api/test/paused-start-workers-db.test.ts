/**
 * Paused start: the real startWorkers() claims no queued job and does not
 * re-queue jobs left `running` (stale-job recovery would re-send work after a
 * restore). With the setting off, both happen as before.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { _setPausedStartForTest } from '../src/lib/paused-start.js';
import { startWorkers, stopWorkers, getWorkerStatus } from '../src/workers/index.js';
import { initScheduler } from '../src/lib/job-scheduler.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const RUN = crypto.randomUUID();
const PENDING_NAME = `paused-start-probe-pending-${RUN}`;
const STALE_NAME = `paused-start-probe-stale-${RUN}`;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function seedJobs(): Promise<void> {
  await withClient(async (c) => {
    await c.query(`DELETE FROM job_queue WHERE name IN ($1, $2)`, [PENDING_NAME, STALE_NAME]);
    await c.query(`INSERT INTO job_queue (id, queue, name, data, status, attempts, max_attempts, run_at)
      VALUES ($1, 'scheduled-jobs', $2, '{}'::jsonb, 'pending', 0, 3, now() - interval '1 minute')`,
      [crypto.randomUUID(), PENDING_NAME]);
    await c.query(`INSERT INTO job_queue (id, queue, name, data, status, attempts, max_attempts, run_at, started_at,
        locked_by, lock_token, lock_expires_at)
      VALUES ($1, 'scheduled-jobs', $2, '{}'::jsonb, 'running', 1, 3, now() - interval '1 hour', now() - interval '1 hour',
        'old-worker', $3, now() - interval '30 minutes')`,
      [crypto.randomUUID(), STALE_NAME, crypto.randomUUID()]);
  });
}

async function jobStates(): Promise<{ pending: string; pendingAttempts: number; stale: string }> {
  return withClient(async (c) => {
    const { rows } = await c.query(`SELECT name, status, attempts FROM job_queue WHERE name IN ($1, $2)`, [PENDING_NAME, STALE_NAME]);
    const by = new Map(rows.map((r) => [r.name as string, r]));
    return {
      pending: by.get(PENDING_NAME)?.status,
      pendingAttempts: Number(by.get(PENDING_NAME)?.attempts),
      stale: by.get(STALE_NAME)?.status,
    };
  });
}

async function cronCount(): Promise<number> {
  return withClient(async (c) => Number((await c.query(
    `SELECT count(*)::int AS n FROM job_queue WHERE cron_key = 'cron:standup' AND status IN ('pending', 'running')`,
  )).rows[0].n));
}

after(async () => {
  _setPausedStartForTest(false);
  await stopWorkers({ timeoutMs: 2_000 });
  await withClient((c) => c.query(`DELETE FROM job_queue WHERE name IN ($1, $2)`, [PENDING_NAME, STALE_NAME]));
  const { closeDb } = await import('../src/lib/db.js');
  await closeDb();
});

test('paused: startWorkers claims nothing, re-queues nothing, and the scheduler registers nothing', async () => {
  await stopWorkers({ timeoutMs: 1_000 });
  await seedJobs();
  await withClient((c) => c.query(`DELETE FROM job_queue WHERE cron_key = 'cron:standup' AND status = 'pending'`));
  _setPausedStartForTest(true);
  await startWorkers();
  await initScheduler();
  assert.equal(getWorkerStatus().running, true);
  // Several poll intervals (1s default) pass without a claim.
  await delay(2_500);
  const states = await jobStates();
  assert.equal(states.pending, 'pending', 'a queued job was claimed while paused');
  assert.equal(states.pendingAttempts, 0);
  assert.equal(states.stale, 'running', 'stale-job recovery re-queued a running job while paused');
  assert.equal(await cronCount(), 0, 'the scheduler registered cron work while paused');
  await stopWorkers({ timeoutMs: 1_000 });
});

test('not paused: startup recovers the stale job and the poller claims the queued one', async () => {
  await stopWorkers({ timeoutMs: 1_000 });
  await seedJobs();
  _setPausedStartForTest(false);
  await startWorkers();
  let states = await jobStates();
  assert.notEqual(states.stale, 'running', 'startup must still recover stale jobs when not paused');
  for (let i = 0; i < 50 && states.pendingAttempts === 0; i++) {
    await delay(100);
    states = await jobStates();
  }
  assert.ok(states.pendingAttempts > 0, 'the poller must still claim queued jobs when not paused');
  await stopWorkers({ timeoutMs: 2_000 });
});
