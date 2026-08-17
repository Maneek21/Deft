import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  _startWorkersForTest,
  getWorkerStatus,
  stopWorkers,
} from '../src/workers/index.js';

test('worker lifecycle start/stop is idempotent and bounded without dispatching work', async () => {
  await stopWorkers({ timeoutMs: 10 });
  await Promise.all([_startWorkersForTest(), _startWorkersForTest(), _startWorkersForTest()]);
  const started = getWorkerStatus();
  assert.equal(started.running, true);
  assert.equal(typeof started.startedAt, 'string');
  assert.equal(started.lastPollAt, null);
  assert.equal(started.inFlight, 0);

  await _startWorkersForTest();
  assert.equal(getWorkerStatus().startedAt, started.startedAt, 'idempotent start reset timestamp');

  const stopStarted = performance.now();
  await Promise.all([
    stopWorkers({ timeoutMs: 100 }),
    stopWorkers({ timeoutMs: 100 }),
    stopWorkers({ timeoutMs: 100 }),
  ]);
  assert.ok(performance.now() - stopStarted < 500, 'idle shutdown exceeded its bound');
  assert.deepEqual(getWorkerStatus(), {
    running: false,
    startedAt: null,
    lastPollAt: null,
    inFlight: 0,
  });
});
