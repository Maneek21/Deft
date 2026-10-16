import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, mock, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { enqueue, QUEUE_NAMES, type QueueName } from '../src/lib/queues.js';
import { _pollQueueBatchForTest, _startWorkersForTest, getWorkerStatus, stopWorkers } from '../src/workers/index.js';

const target = process.env.DEFT_TEST_DATABASE_URL;
const safe = !!target && target === process.env.DATABASE_URL
  && /^postgresql:\/\/gate_g_test@127\.0\.0\.1:55435\/gate_g_20260926_c10_worker_slots_test(?:_v[0-9]+)?$/.test(target);
after(async () => { if (safe) { await stopWorkers({ timeoutMs: 100 }); await closeDb(); } });
const queue = () => `a05-slot:${randomUUID()}` as QueueName;
function latch() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}
async function eventually(check: () => boolean, message: string) {
  for (let i = 0; i < 100; i++) { if (check()) return; await delay(10); }
  assert.fail(message);
}

test('worker capacity retains five ignored-abort handlers and tops up only settled spare slots', { skip: !safe }, async () => {
  const q = queue();
  const holds = Array.from({ length: 5 }, latch);
  let entered = 0; let active = 0; let peak = 0;
  for (let i = 0; i < 5; i++) await enqueue(q, 'held', {});
  const overrides = { timeoutMs: 30, resolveHandler: async () => async () => {
    const index = entered++; peak = Math.max(peak, ++active);
    try { if (index < 5) await holds[index]!.pending; }
    finally { active--; }
  } };
  try {
    await _pollQueueBatchForTest(q, overrides);
    assert.equal(entered, 5); assert.equal(getWorkerStatus().inFlight, 5);
    const lastProgress = getWorkerStatus().lastPollAt;
    for (let i = 0; i < 3; i++) await enqueue(q, 'later', {});
    await _pollQueueBatchForTest(q, overrides);
    assert.equal(entered, 5, 'terminal delivery timeout must not free an ignored handler slot');
    assert.equal(getWorkerStatus().lastPollAt, lastProgress, 'full-capacity skip is not a heartbeat');
    holds[0]!.release(); await eventually(() => getWorkerStatus().inFlight === 4, 'first slot did not settle');
    await _pollQueueBatchForTest(q, overrides);
    assert.equal(entered, 6, 'only one spare row may be claimed'); assert.equal(peak, 5);
    for (const hold of holds) hold.release();
    await eventually(() => getWorkerStatus().inFlight === 0, 'late work did not release capacity');
    await _pollQueueBatchForTest(q, overrides);
    assert.equal(entered, 8); assert.equal(peak, 5);
    await eventually(() => getWorkerStatus().inFlight === 0, 'healthy completion did not settle');
  } finally { for (const hold of holds) hold.release(); }
});

test('scheduled attention grouping reserves all twenty-five claimed rows until the late grouped handler settles', { skip: !safe }, async () => {
  const group = latch(); const organization = randomUUID();
  let groupCalls = 0; let ordinaryCalls = 0; let notifications: unknown[] = [];
  for (let i = 0; i < 25; i++) await enqueue(QUEUE_NAMES.SCHEDULED_JOBS, 'notification-attention-sync',
    { orgId: organization, notificationIds: [`notification-${i}`] });
  const overrides = { timeoutMs: 30, resolveHandler: async (_q: string, name: string) => async (job: { data: Record<string, unknown> }) => {
    if (name === 'notification-attention-sync') {
      groupCalls++; notifications = job.data.notificationIds as unknown[]; await group.pending;
    } else ordinaryCalls++;
  } };
  try {
    await _pollQueueBatchForTest(QUEUE_NAMES.SCHEDULED_JOBS, overrides);
    assert.equal(groupCalls, 1); assert.equal(notifications.length, 25); assert.equal(getWorkerStatus().inFlight, 25);
    await enqueue(QUEUE_NAMES.SCHEDULED_JOBS, 'later-ordinary', {});
    await _pollQueueBatchForTest(QUEUE_NAMES.SCHEDULED_JOBS, overrides);
    assert.equal(ordinaryCalls, 0, 'one merged callback still occupies twenty-five row slots');
    group.release(); await eventually(() => getWorkerStatus().inFlight === 0, 'group capacity remained after actual settlement');
    await _pollQueueBatchForTest(QUEUE_NAMES.SCHEDULED_JOBS, overrides);
    assert.equal(ordinaryCalls, 1); assert.equal(groupCalls, 1);
  } finally { group.release(); }
});

test('worker shutdown sees a claim settling after shutdown starts and retains late capacity across restart', { skip: !safe, timeout: 10_000 }, async () => {
  const q = queue(); const claim = latch(); const work = latch(); const claimed = latch(); const entered = latch();
  await enqueue(q, 'shutdown-race', {});
  const original = pg.Client.prototype.query;
  let intercepted = false; let observedAbort = false;
  const intercept = mock.method(pg.Client.prototype, 'query', function (this: pg.Client, ...args: unknown[]) {
    const query = args[0]; const text = typeof query === 'string' ? query : (query as { text?: string }).text ?? '';
    if (!intercepted && text.includes('FOR UPDATE SKIP LOCKED')) {
      intercepted = true;
      const callback = args.at(-1);
      if (typeof callback === 'function') {
        args[args.length - 1] = (...completed: unknown[]) => {
          claimed.release();
          void claim.pending.then(() => Reflect.apply(callback, this, completed));
        };
        return Reflect.apply(original, this, args);
      }
      const result = Reflect.apply(original, this, args);
      return result.then(async (value: unknown) => { claimed.release(); await claim.pending; return value; });
    }
    return Reflect.apply(original, this, args);
  });
  try {
    await _startWorkersForTest();
    const polling = _pollQueueBatchForTest(q, { timeoutMs: 5_000, resolveHandler: async () => async job => {
      entered.release(); job.signal?.addEventListener('abort', () => { observedAbort = true; }, { once: true });
      await work.pending;
    } });
    await claimed.pending;
    let stopped = false;
    const stopping = stopWorkers({ timeoutMs: 300 }).then(() => { stopped = true; });
    await delay(30); assert.equal(stopped, false, 'shutdown dropped the in-flight claim');
    claim.release(); await entered.pending; await stopping; await polling;
    assert.equal(observedAbort, true); assert.equal(getWorkerStatus().inFlight, 1);
    await _startWorkersForTest(); assert.equal(getWorkerStatus().inFlight, 1, 'restart discarded prior late capacity');
    work.release(); await eventually(() => getWorkerStatus().inFlight === 0, 'late shutdown handler never settled');
    await stopWorkers({ timeoutMs: 100 });
  } finally { claim.release(); work.release(); intercept.mock.restore(); }
});

test('failed or empty queue claims release reservations without leaking concurrency capacity', { skip: !safe, timeout: 10_000 }, async () => {
  const q = queue(); const original = pg.Client.prototype.query;
  const intercept = mock.method(pg.Client.prototype, 'query', function (this: pg.Client, ...args: unknown[]) {
    const query = args[0]; const text = typeof query === 'string' ? query : (query as { text?: string }).text ?? '';
    if (text.includes('FOR UPDATE SKIP LOCKED')) {
      const error = new Error('A05 exact claim failure');
      const callback = args.at(-1);
      if (typeof callback === 'function') { queueMicrotask(() => Reflect.apply(callback, this, [error])); return; }
      return Promise.reject(error);
    }
    return Reflect.apply(original, this, args);
  });
  try {
    await assert.rejects(_pollQueueBatchForTest(q), error => error instanceof Error
      && (/A05 exact claim failure/.test(error.message) || String(error.cause).includes('A05 exact claim failure')));
    assert.equal(getWorkerStatus().inFlight, 0);
  } finally { intercept.mock.restore(); }
  await _pollQueueBatchForTest(q); assert.equal(getWorkerStatus().inFlight, 0);
});
