/**
 * The cell heartbeat (telemetry contract v1.1, section 1b).
 *
 * - Exactly `{ cell_id, release, seats_used, sent_at }`, to
 *   `<control plane>/v1/cells/telemetry/heartbeat`, with the seat fetch token.
 * - Hosted production cells only: never self-hosted, never from a development
 *   build, never with a control-plane setting missing, DEFT_TELEMETRY=off or
 *   a paused start.
 * - Once 30 to 90 seconds after start, then every 55 to 65 minutes.
 * - A failure is dropped and counted: one attempt, no retry, no error.
 * - seats_used is the seat limit's own count (seat-limit.ts countSeatsInUse);
 *   seat-limit-db.test.ts covers who counts.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/telemetry-heartbeat.test.ts
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import {
  FIRST_DELAY_MS,
  INTERVAL_MS,
  heartbeatCounters,
  heartbeatDeps,
  resetHeartbeatForTest,
  sendHeartbeat,
  startCellHeartbeat,
  stopCellHeartbeat,
} from '../src/lib/telemetry/heartbeat.js';
import { CELL_ID, CONTROL_PLANE, FETCH_TOKEN, HOSTED_ENV, SELF_HOSTED_ENV, recordingFetch } from './fixtures/telemetry.js';

const saved = { ...heartbeatDeps };
afterEach(() => {
  resetHeartbeatForTest();
  Object.assign(heartbeatDeps, saved);
});

function useHeartbeat(env: NodeJS.ProcessEnv, options: { status?: number | 'throw'; seats?: number; random?: number } = {}) {
  const network = recordingFetch(options.status ?? 204);
  Object.assign(heartbeatDeps, {
    env,
    fetch: network.fetch,
    now: () => Date.parse('2026-11-25T10:00:00.000Z'),
    random: () => options.random ?? 0.5,
    seatsUsed: async () => options.seats ?? 7,
    release: async () => '0.3.0-preview.152',
    isPaused: () => false,
  });
  return network;
}

test('the body is exactly the contract, to the control plane with the seat fetch token', async () => {
  const network = useHeartbeat(HOSTED_ENV, { seats: 7 });
  await sendHeartbeat();
  assert.equal(network.sent.length, 1);
  const [request] = network.sent;
  assert.equal(request!.url, `${CONTROL_PLANE}/v1/cells/telemetry/heartbeat`);
  assert.equal(request!.init.method, 'POST');
  assert.equal(request!.init.redirect, 'error');
  const headers = new Headers(request!.init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${FETCH_TOKEN}`);
  assert.deepEqual(request!.body, { cell_id: CELL_ID, release: '0.3.0-preview.152', seats_used: 7, sent_at: '2026-11-25T10:00:00.000Z' });
  assert.deepEqual(heartbeatCounters(), { sent: 1, failed: 0 });
});

test('a release that is not a plain version is sent as unknown', async () => {
  const network = useHeartbeat(HOSTED_ENV);
  heartbeatDeps.release = async () => '0.3.0-acme-custom';
  await sendHeartbeat();
  assert.equal((network.sent[0]!.body as { release: string }).release, 'unknown');
});

test('never self-hosted, from a development build, with a setting missing, switched off or paused', async () => {
  const cases: NodeJS.ProcessEnv[] = [
    SELF_HOSTED_ENV,
    { ...HOSTED_ENV, NODE_ENV: 'development' },
    { ...HOSTED_ENV, DEFT_SEAT_FETCH_TOKEN: undefined },
    { ...HOSTED_ENV, DEFT_SEAT_STATEMENT_URL: 'http://control.test.invalid/v1/cells/x/seat-statement' },
    { ...HOSTED_ENV, DEFT_TELEMETRY: 'off' },
  ];
  for (const env of cases) {
    const network = useHeartbeat(env);
    await sendHeartbeat();
    startCellHeartbeat();
    assert.equal(network.sent.length, 0, JSON.stringify(env));
    stopCellHeartbeat();
  }
  const network = useHeartbeat(HOSTED_ENV);
  heartbeatDeps.isPaused = () => true;
  await sendHeartbeat();
  assert.equal(network.sent.length, 0, 'paused');
});

test('once 30 to 90 seconds after start, then every 55 to 65 minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const network = useHeartbeat(HOSTED_ENV, { random: 0.5 });
  const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  startCellHeartbeat();
  startCellHeartbeat();
  const first = (FIRST_DELAY_MS.min + FIRST_DELAY_MS.max) / 2;
  t.mock.timers.tick(first - 1);
  await settle();
  assert.equal(network.sent.length, 0, 'not before the first delay');
  t.mock.timers.tick(1);
  await settle();
  assert.equal(network.sent.length, 1, 'once shortly after start, however often start is called');
  const interval = (INTERVAL_MS.min + INTERVAL_MS.max) / 2;
  t.mock.timers.tick(interval - 1);
  await settle();
  assert.equal(network.sent.length, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(network.sent.length, 2, 'then hourly');
  stopCellHeartbeat();
  t.mock.timers.tick(INTERVAL_MS.max * 3);
  await settle();
  assert.equal(network.sent.length, 2, 'nothing after stop');
});

for (const [random, first, next] of [[0, 30_000, 55 * 60_000], [1, 90_000, 65 * 60_000]] as const) {
  test(`at the ${random === 0 ? 'low' : 'high'} end of the jitter: first at ${first / 1000} s, next ${next / 60_000} min later`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const network = useHeartbeat(HOSTED_ENV, { random });
    const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
    startCellHeartbeat();
    t.mock.timers.tick(first - 1);
    await settle();
    assert.equal(network.sent.length, 0);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(network.sent.length, 1);
    t.mock.timers.tick(next - 1);
    await settle();
    assert.equal(network.sent.length, 1);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(network.sent.length, 2);
  });
}

test('a failed heartbeat is dropped and counted: one attempt, no retry, no error', async () => {
  for (const status of [500, 429, 'throw'] as const) {
    resetHeartbeatForTest();
    const network = useHeartbeat(HOSTED_ENV, { status });
    await assert.doesNotReject(sendHeartbeat());
    assert.equal(network.sent.length, 1, String(status));
    assert.deepEqual(heartbeatCounters(), { sent: 0, failed: 1 });
  }
  // A seat count that cannot be read sends nothing rather than a wrong number.
  const network = useHeartbeat(HOSTED_ENV);
  heartbeatDeps.seatsUsed = async () => { throw new Error('database down'); };
  await assert.doesNotReject(sendHeartbeat());
  assert.equal(network.sent.length, 0);
});

test('a send still out when the heartbeat is stopped and restarted never leaves a stray timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const network = useHeartbeat(HOSTED_ENV, { random: 0 });
  const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  let release!: (seats: number) => void;
  heartbeatDeps.seatsUsed = () => new Promise<number>((resolve) => { release = resolve; });
  startCellHeartbeat();
  t.mock.timers.tick(FIRST_DELAY_MS.min);
  await settle();
  // The first send is out (waiting on the seat count). Stop, then start again.
  stopCellHeartbeat();
  startCellHeartbeat();
  heartbeatDeps.seatsUsed = async () => 7;
  release(7);
  await settle();
  // The final stop must leave nothing behind.
  stopCellHeartbeat();
  t.mock.timers.tick(INTERVAL_MS.max * 5);
  await settle();
  assert.equal(network.sent.length, 1, 'only the send that was already out');
});

test('no single workspace to count: nothing is sent', async () => {
  const network = useHeartbeat(HOSTED_ENV);
  heartbeatDeps.seatsUsed = async () => null;
  await sendHeartbeat();
  assert.equal(network.sent.length, 0);
});
