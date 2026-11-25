/**
 * Hosted error events: aggregation, batching and backing off (telemetry
 * contract, section 1). Events are grouped by fingerprint; at most one batch
 * leaves per 60 seconds (a fatal exit included), of at most 50 events and
 * 64 KB, server and job errors first; what does not fit waits for the next
 * batch; a failed batch is dropped and counted, never retried, and failures
 * (or a 429) pause sending. And the browser route's limits.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/telemetry-error-batching.test.ts
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { Hono } from 'hono';
import {
  APP_ROOT,
  BATCH_MAX_BYTES,
  BATCH_MAX_CLIENT_EVENTS,
  BATCH_MAX_EVENTS,
  BUFFER_MAX_CLIENT_FINGERPRINTS,
  BUFFER_MAX_FINGERPRINTS,
  FLUSH_INTERVAL_MS,
  allowNextBatchForTest,
  bufferedEventsForTest,
  captureClientError,
  captureJobError,
  captureRequestError,
  errorReporterDeps,
  errorTelemetryCounters,
  flushErrorTelemetry,
  flushErrorTelemetryBeforeExit,
} from '../src/lib/telemetry/error-reporter.js';
import { rememberIssuedReference } from '../src/lib/telemetry/scrub.js';
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
const events = (request: { body: unknown }) => (request.body as { events: { kind: string }[] }).events;

test('the same error is one event with a count, first and last seen, and up to ten issued request IDs', async () => {
  let now = Date.parse('2026-11-25T10:00:00.000Z');
  const network = useErrorReporter(HOSTED_ENV, { now: () => now });
  for (let i = 0; i < 12; i += 1) {
    rememberIssuedReference(REF(i), now);
    captureRequestError(fixedError('boom'), { route: '/api/spaces/:id', method: 'GET', status: 500, requestId: REF(i) });
    now += 1_000;
  }
  // A UUID the cell never issued is not a request ID.
  captureRequestError(fixedError('boom'), { route: '/api/spaces/:id', method: 'GET', status: 500, requestId: REF(99) });
  const buffered = bufferedEventsForTest();
  assert.equal(buffered.length, 1);
  assert.equal(buffered[0]!.count, 13);
  assert.equal(buffered[0]!.first_seen_at, '2026-11-25T10:00:00.000Z');
  assert.equal(buffered[0]!.last_seen_at, '2026-11-25T10:00:12.000Z');
  assert.deepEqual(buffered[0]!.request_ids, Array.from({ length: 10 }, (_, i) => REF(i + 2)), 'the ten most recent issued ones');
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
  assert.equal(events(network.sent[0]!).length, BATCH_MAX_EVENTS);
  assert.equal(bufferedEventsForTest().length, 10);
  allowNextBatchForTest();
  await flushErrorTelemetry();
  assert.equal(events(network.sent[1]!).length, 10);
});

test('a batch is at most 64 KB; what does not fit waits for the next batch', async () => {
  const network = useErrorReporter(HOSTED_ENV);
  const frames = Array.from({ length: 20 }, (_, i) => `    at handler${'Long'.repeat(15)}${i} (${APP_ROOT}/apps/api/src/routes/${'nested/'.repeat(20)}file${i}.ts:${i + 1}:1)`).join('\n');
  for (let i = 0; i < 50; i += 1) {
    const error = new Error('x');
    error.name = `BigError${i}`;
    error.stack = `${error.name}: x\n${frames}`;
    captureJobError(`big-${i}`, error);
  }
  await flushErrorTelemetry();
  assert.equal(network.sent.length, 1);
  const wire = String(network.sent[0]!.init.body);
  assert.ok(Buffer.byteLength(wire) <= BATCH_MAX_BYTES, `batch is ${Buffer.byteLength(wire)} bytes`);
  const sentCount = events(network.sent[0]!).length;
  assert.ok(sentCount > 0 && sentCount < 50);
  assert.equal(errorTelemetryCounters().events_dropped, 0, 'nothing dropped');
  assert.equal(bufferedEventsForTest().length, 50 - sentCount, 'the rest wait');
});

test('server and job errors go first; browser reports take at most 25 places in a batch', async () => {
  const network = useErrorReporter(HOSTED_ENV);
  // Browser reports first, so they are the oldest.
  for (let i = 0; i < 40; i += 1) captureClientError({ errorClass: 'Error', message: 'x', stack: undefined, route: `/chat/:p${i}` });
  for (let i = 0; i < 40; i += 1) captureJobError(`job-${i}`, 'x');
  await flushErrorTelemetry();
  const kinds = events(network.sent[0]!).map((event) => event.kind);
  assert.equal(kinds.length, BATCH_MAX_EVENTS);
  assert.equal(kinds.filter((kind) => kind === 'job').length, 40, 'every job error in the first batch');
  assert.equal(kinds.filter((kind) => kind === 'client').length, 10);
  allowNextBatchForTest();
  await flushErrorTelemetry();
  assert.equal(events(network.sent[1]!).filter((event) => event.kind === 'client').length, BATCH_MAX_CLIENT_EVENTS);
});

test('at most 200 fingerprints wait between batches, browser reports at most half; more are dropped and counted', () => {
  useErrorReporter(HOSTED_ENV);
  for (let i = 0; i < BUFFER_MAX_FINGERPRINTS; i += 1) captureClientError({ errorClass: 'Error', message: 'x', stack: undefined, route: `/chat/:p${i}` });
  assert.equal(bufferedEventsForTest().length, BUFFER_MAX_CLIENT_FINGERPRINTS, 'browser reports stop at half');
  for (let i = 0; i < BUFFER_MAX_FINGERPRINTS; i += 1) captureJobError(`job-${i}`, 'x');
  assert.equal(bufferedEventsForTest().filter((event) => event.kind === 'job').length, BUFFER_MAX_FINGERPRINTS - BUFFER_MAX_CLIENT_FINGERPRINTS, 'server errors still fit');
  assert.equal(bufferedEventsForTest().length, BUFFER_MAX_FINGERPRINTS);
  assert.equal(errorTelemetryCounters().dropped_buffer_full, (BUFFER_MAX_FINGERPRINTS - BUFFER_MAX_CLIENT_FINGERPRINTS) * 2);
});

test('only the timer sends, never twice within 60 seconds; concurrent flushes share one send', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const network = useErrorReporter(HOSTED_ENV);
  captureJobError('first', 'x');
  t.mock.timers.tick(FLUSH_INTERVAL_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(network.sent.length, 0, 'nothing before the timer');
  t.mock.timers.tick(1);
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(network.sent.length, 1, 'one batch at the timer');
  captureJobError('second', 'x');
  await flushErrorTelemetry();
  assert.equal(network.sent.length, 1, 'not again within 60 seconds');
  allowNextBatchForTest();
  await Promise.all([flushErrorTelemetry(), flushErrorTelemetry(), flushErrorTelemetry()]);
  assert.equal(network.sent.length, 2, 'concurrent flushes share one send');
});

test('a fatal exit sends no second batch within 60 seconds, and keeps a 429 pause', async () => {
  let now = Date.parse('2026-11-25T10:00:00.000Z');
  const network = useErrorReporter(HOSTED_ENV, { now: () => now });
  captureJobError('a', 'x');
  await flushErrorTelemetry();
  captureJobError('b', 'x');
  now += 10_000;
  await flushErrorTelemetryBeforeExit(500);
  assert.equal(network.sent.length, 1, 'no second batch within the minute, even on the way out');

  const refused = useErrorReporter(HOSTED_ENV, { status: 429, now: () => now });
  captureJobError('c', 'x');
  await flushErrorTelemetry();
  captureJobError('d', 'x');
  now += 120_000;
  await flushErrorTelemetryBeforeExit(500);
  assert.equal(refused.sent.length, 1, 'the 429 pause holds on the way out');
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

test('a thrown value with hostile getters cannot break the job that failed, with telemetry on or off', () => {
  const hostile = new Error('x');
  Object.defineProperty(hostile, 'stack', { get() { throw new Error('getter'); } });
  Object.defineProperty(hostile, 'message', { get() { throw new Error('getter'); } });
  useErrorReporter(HOSTED_ENV);
  assert.doesNotThrow(() => captureJobError('job', hostile));
  useErrorReporter({ NODE_ENV: 'production' });
  assert.doesNotThrow(() => captureJobError('job', hostile));
});

const post = (app: Hono, session: string | null, address = 'address-1') => app.request('/api/telemetry/client-error', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-test-address': address, ...(session ? { authorization: `Bearer ${session}` } : {}) },
  body: JSON.stringify({ type: 'error', error_class: 'TypeError', message: 'x', page: '/chat' }),
});

function limitedApp(limits: { perSession: number; perAddress: number; perServer: number }) {
  return new Hono().route('/api/telemetry', createTelemetryRoutes({
    ...limits,
    sessionOf: async (request) => request.headers.get('authorization')?.slice(7) ?? null,
    addressOf: async (c) => c.req.header('x-test-address') ?? 'unknown',
  }));
}

async function statuses(app: Hono, session: string | null, n: number, address?: string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push((await post(app, session, address)).status);
  return out;
}

test('the browser route is limited per session and per client address', async () => {
  useErrorReporter(HOSTED_ENV);
  useApiRoutes();
  const app = limitedApp({ perSession: 3, perAddress: 5, perServer: 100 });
  // Per session: the fourth report in a minute from one session is refused.
  assert.deepEqual(await statuses(app, 'session-a', 4), [200, 200, 200, 429]);
  // Per address: another session from the same address gets only what is left of five.
  assert.deepEqual(await statuses(app, 'session-b', 2), [200, 429]);
  const refused = await post(app, 'session-c');
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { error: 'Too many requests.', code: 'RATE_LIMITED' });
});

test('one noisy address cannot use up the whole server\'s allowance', async () => {
  useErrorReporter(HOSTED_ENV);
  const app = limitedApp({ perSession: 100, perAddress: 2, perServer: 3 });
  assert.deepEqual(await statuses(app, null, 10, 'noisy'), [200, 200, 429, 429, 429, 429, 429, 429, 429, 429]);
  // Only the noisy address's two admitted reports counted against the server's three.
  assert.deepEqual(await statuses(app, null, 1, 'quiet'), [200]);
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
