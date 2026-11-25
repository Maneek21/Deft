/**
 * Hosted error events: aggregation, batching and backing off (telemetry
 * contract, section 1). Events are grouped by fingerprint; at most one batch
 * leaves per minute, of at most 50 events and 64 KB; a failed batch is
 * dropped and counted, never retried, and failures (or a 429) pause sending.
 * And the browser route's limits per session and per client address.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/telemetry-error-batching.test.ts
 */
import assert from 'node:assert/strict';
import test, { after, mock } from 'node:test';
import { Hono } from 'hono';
import {
  BATCH_MAX_BYTES,
  BATCH_MAX_EVENTS,
  BUFFER_MAX_CLIENT_FINGERPRINTS,
  BUFFER_MAX_FINGERPRINTS,
  FLUSH_INTERVAL_MS,
  APP_ROOT,
  bufferedEventsForTest,
  captureJobError,
  captureRequestError,
  errorTelemetryCounters,
  flushErrorTelemetry,
} from '../src/lib/telemetry/error-reporter.js';
import { createTelemetryRoutes } from '../src/routes/telemetry.js';
import { HOSTED_ENV, restoreErrorReporter, useApiRoutes, useErrorReporter } from './fixtures/telemetry.js';

after(() => restoreErrorReporter());

/** An error with a fixed stack, so repeated captures share one fingerprint. */
function fixedError(message: string, fn = 'loadSpace'): Error {
  const error = new TypeError(message);
  error.stack = `TypeError: ${message}\n    at ${fn} (${APP_ROOT}/apps/api/src/routes/spaces.ts:42:7)`;
  return error;
}

const REF = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('the same error is one event with a count, first and last seen, and up to ten request IDs', async () => {
  let now = Date.parse('2026-11-25T10:00:00.000Z');
  const network = useErrorReporter(HOSTED_ENV, { now: () => now });
  for (let i = 0; i < 12; i += 1) {
    captureRequestError(fixedError('boom'), { route: '/api/spaces/:id', method: 'GET', status: 500, requestId: REF(i) });
    now += 1_000;
  }
  const buffered = bufferedEventsForTest();
  assert.equal(buffered.length, 1);
  assert.equal(buffered[0]!.count, 12);
  assert.equal(buffered[0]!.first_seen_at, '2026-11-25T10:00:00.000Z');
  assert.equal(buffered[0]!.last_seen_at, '2026-11-25T10:00:11.000Z');
  assert.deepEqual(buffered[0]!.request_ids, Array.from({ length: 10 }, (_, i) => REF(i + 2)), 'the ten most recent');
  // A different place in the code is a different event.
  captureRequestError(fixedError('boom', 'saveSpace'), { route: '/api/spaces/:id', method: 'GET', status: 500 });
  assert.equal(bufferedEventsForTest().length, 2);
  await flushErrorTelemetry();
  assert.equal(network.sent.length, 1);
  assert.equal(bufferedEventsForTest().length, 0, 'sent events leave the buffer');
});

test('a batch holds at most 50 events; the rest wait for the next minute', async () => {
  const network = useErrorReporter(HOSTED_ENV);
  for (let i = 0; i < 60; i += 1) captureJobError(`job-${i}`, 'not an Error object');
  assert.equal(bufferedEventsForTest().length, 60);
  await flushErrorTelemetry();
  assert.equal((network.sent[0]!.body as { events: unknown[] }).events.length, BATCH_MAX_EVENTS);
  assert.equal(bufferedEventsForTest().length, 10);
  await flushErrorTelemetry();
  assert.equal((network.sent[1]!.body as { events: unknown[] }).events.length, 10);
});

test('a batch is at most 64 KB: what does not fit is dropped and counted', async () => {
  const network = useErrorReporter(HOSTED_ENV);
  const frames = Array.from({ length: 20 }, (_, i) => `    at handler${'Long'.repeat(15)}${i} (${APP_ROOT}/apps/api/src/routes/${'nested/'.repeat(20)}file${i}.ts:${i + 1}:1)`).join('\n');
  for (let i = 0; i < 50; i += 1) {
    const error = new Error(`${'word '.repeat(100)}${i}`);
    error.name = `BigError${i}`;
    error.stack = `${error.name}: x\n${frames}`;
    captureJobError(`big-${i}`, error);
  }
  await flushErrorTelemetry();
  assert.equal(network.sent.length, 1);
  const wire = String(network.sent[0]!.init.body);
  assert.ok(Buffer.byteLength(wire) <= BATCH_MAX_BYTES, `batch is ${Buffer.byteLength(wire)} bytes`);
  const sentCount = (network.sent[0]!.body as { events: unknown[] }).events.length;
  assert.ok(sentCount > 0 && sentCount < 50);
  assert.equal(errorTelemetryCounters().events_dropped, 50 - sentCount);
});

test('at most 200 fingerprints wait between batches; more are dropped and counted', () => {
  useErrorReporter(HOSTED_ENV);
  for (let i = 0; i < BUFFER_MAX_FINGERPRINTS + 25; i += 1) captureJobError(`job-${i}`, 'x');
  assert.equal(bufferedEventsForTest().length, BUFFER_MAX_FINGERPRINTS);
  assert.equal(errorTelemetryCounters().dropped_buffer_full, 25);
});

test('browser reports hold at most half the buffer, so the open route cannot crowd out server errors', async () => {
  useErrorReporter(HOSTED_ENV);
  const { captureClientError } = await import('../src/lib/telemetry/error-reporter.js');
  for (let i = 0; i < BUFFER_MAX_FINGERPRINTS; i += 1) {
    captureClientError({ errorClass: `Junk${i}`, message: 'x', stack: undefined, route: '/chat' });
  }
  assert.equal(bufferedEventsForTest().filter((event) => event.kind === 'client').length, BUFFER_MAX_CLIENT_FINGERPRINTS);
  for (let i = 0; i < 50; i += 1) captureJobError(`job-${i}`, 'x');
  assert.equal(bufferedEventsForTest().filter((event) => event.kind === 'job').length, 50, 'server-side errors still fit');
});

test('only the minute timer sends: nothing before 60 seconds, one batch at 60, and concurrent flushes share it', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const network = useErrorReporter(HOSTED_ENV);
  captureJobError('first', 'x');
  t.mock.timers.tick(FLUSH_INTERVAL_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(network.sent.length, 0, 'nothing before a minute');
  t.mock.timers.tick(1);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(network.sent.length, 1, 'one batch at a minute');
  captureJobError('second', 'x');
  const flushes = [flushErrorTelemetry(), flushErrorTelemetry(), flushErrorTelemetry()];
  await Promise.all(flushes);
  assert.equal(network.sent.length, 2, 'concurrent flushes share one send');
});

test('a failed batch is dropped and counted, never retried, and sending pauses', async () => {
  let now = Date.parse('2026-11-25T10:00:00.000Z');
  const network = useErrorReporter(HOSTED_ENV, { status: 'throw', now: () => now });
  captureJobError('fails', 'x');
  await flushErrorTelemetry();
  assert.equal(network.sent.length, 1);
  assert.equal(bufferedEventsForTest().length, 0, 'the failed batch is not kept for a retry');
  assert.deepEqual(
    { failed: errorTelemetryCounters().batches_failed, dropped: errorTelemetryCounters().events_dropped },
    { failed: 1, dropped: 1 },
  );
  captureJobError('next', 'x');
  now += 30_000;
  await flushErrorTelemetry();
  assert.equal(network.sent.length, 1, 'paused after a failure');
  now += 31_000;
  await flushErrorTelemetry();
  assert.equal(network.sent.length, 2, 'sends again after the pause');
});

test('a 429 from the control plane pauses sending for five minutes', async () => {
  let now = Date.parse('2026-11-25T10:00:00.000Z');
  const network = useErrorReporter(HOSTED_ENV, { status: 429, now: () => now });
  captureJobError('a', 'x');
  await flushErrorTelemetry();
  captureJobError('b', 'x');
  for (const step of [60_000, 60_000, 60_000, 60_000]) {
    now += step;
    await flushErrorTelemetry();
  }
  assert.equal(network.sent.length, 1, 'no send within five minutes of a 429');
  now += 61_000;
  await flushErrorTelemetry();
  assert.equal(network.sent.length, 2);
});

test('capturing never waits on the network, even when a send hangs', async () => {
  useErrorReporter(HOSTED_ENV);
  const { errorReporterDeps } = await import('../src/lib/telemetry/error-reporter.js');
  let calls = 0;
  errorReporterDeps.fetch = () => { calls += 1; return new Promise<Response>(() => undefined); };
  captureJobError('hangs', 'x');
  const hanging = flushErrorTelemetry();
  const started = Date.now();
  for (let i = 0; i < 100; i += 1) captureJobError(`more-${i % 3}`, 'x');
  assert.ok(Date.now() - started < 500, 'captures return at once');
  assert.equal(flushErrorTelemetry(), hanging, 'a second flush joins the one in flight');
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, 'one send in flight, no second one');
});

test('the browser route is limited per session and per client address', async () => {
  useErrorReporter(HOSTED_ENV);
  useApiRoutes();
  const app = new Hono().route('/api/telemetry', createTelemetryRoutes({ perSession: 3, perAddress: 5, perServer: 100 }));
  const post = (session: string | null) => app.request('/api/telemetry/client-error', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session}` } : {}) },
    body: JSON.stringify({ type: 'error', error_class: 'TypeError', message: 'x', page: '/chat' }),
  });
  const statuses = async (session: string | null, n: number) => {
    const out: number[] = [];
    for (let i = 0; i < n; i += 1) out.push((await post(session)).status);
    return out;
  };
  // Per session: the fourth report in a minute from one session is refused.
  assert.deepEqual(await statuses('session-a', 4), [200, 200, 200, 429]);
  // Per address: another session from the same address gets only what is left of five.
  assert.deepEqual(await statuses('session-b', 2), [200, 429]);
  const refused = await post('session-c');
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { error: 'Too many requests.', code: 'RATE_LIMITED' });
});

test('the browser route refuses a body over 24 KB and anything that is not a report', async () => {
  useErrorReporter(HOSTED_ENV);
  const app = new Hono().route('/api/telemetry', createTelemetryRoutes());
  const big = await app.request('/api/telemetry/client-error', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'error', stack: 'x'.repeat(30 * 1024) }),
  });
  assert.equal(big.status, 413);
  const wrong = await app.request('/api/telemetry/client-error', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'something-else' }),
  });
  assert.equal(wrong.status, 400);
  assert.equal(bufferedEventsForTest().length, 0);
});

mock.reset();
