import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerStartup } from '../src/lib/worker-startup.js';

const instant = async () => {};
test('transient startup maintenance failure retries serially and starts one poller', async () => {
  const lifecycle = new WorkerStartup(); lifecycle.require();
  let calls = 0, pollers = 0, concurrent = 0, maximum = 0; const delays: number[] = [];
  const start = async () => { maximum = Math.max(maximum, ++concurrent); try { if (++calls === 1) throw Error('transient'); pollers++; } finally { concurrent--; } };
  const pending = lifecycle.start(start, { wait: async ms => { delays.push(ms); } });
  assert.equal(lifecycle.isReady(), false);
  assert.equal(lifecycle.start(start), pending);
  assert.equal(await pending, true);
  assert.equal(calls, 2); assert.equal(pollers, 1); assert.equal(maximum, 1); assert.deepEqual(delays, [1000]);
  assert.equal(lifecycle.isReady(), true);
});
test('permanent failure exhausts bounded backoff and stays not ready', async () => {
  const lifecycle = new WorkerStartup(); lifecycle.require(); const delays: number[] = [];
  assert.equal(await lifecycle.start(async () => { throw Error('offline'); }, { wait: async ms => { delays.push(ms); } }), false);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  assert.deepEqual(lifecycle.snapshot(), { required: true, phase: 'failed', attempts: 5 });
  assert.equal(lifecycle.isReady(), false);
});
test('scheduler failure after worker success does not duplicate the idempotent poller', async () => {
  const lifecycle = new WorkerStartup(); lifecycle.require(); let workerRunning = false, pollers = 0, schedules = 0;
  assert.equal(await lifecycle.start(async () => { if (!workerRunning) { workerRunning = true; pollers++; } if (++schedules === 1) throw Error('scheduler'); }, { wait: instant }), true);
  assert.equal(pollers, 1); assert.equal(schedules, 2); assert.equal(lifecycle.isReady(), true);
});
test('shutdown aborts backoff and prevents late startup success from becoming ready', async () => {
  const lifecycle = new WorkerStartup(); lifecycle.require(); let finish!: () => void;
  const pending = lifecycle.start(() => new Promise<void>(resolve => { finish = resolve; }));
  lifecycle.stop(); finish(); assert.equal(await pending, false); assert.equal(lifecycle.isReady(), false);
  const retrying = new WorkerStartup(); retrying.require(); let attempts = 0;
  const retry = retrying.start(async () => { attempts++; throw Error('offline'); }, { wait: async (_ms, signal) => { retrying.stop(); signal.throwIfAborted(); } });
  assert.equal(await retry, false); assert.equal(attempts, 1); assert.equal(retrying.snapshot().phase, 'stopping');
});

test('real readiness route returns 503 when required startup exhausts despite a ready schema', async t => {
  const [{ app }, { workerStartup }, { closeDb }] = await Promise.all([
    import('../src/index.js'), import('../src/lib/worker-startup.js'), import('../src/lib/db.js'),
  ]);
  t.after(async () => { await closeDb(); });
  const baseline = await app.request('/health/ready');
  assert.equal(baseline.status, 200);
  workerStartup.require();
  await workerStartup.start(async () => { throw Error('synthetic startup dependency'); }, { wait: instant });
  const response = await app.request('/health/ready');
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.checks.agent_channel_v2_schema, true);
  assert.equal(body.checks.wiki_memory_sync, true);
  assert.equal(body.checks.job_workers, false);
  assert.equal(body.status, 'not_ready');
});
