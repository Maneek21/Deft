/**
 * Hosted against self-hosted (telemetry contract, principles):
 *
 * - A hosted production cell with its control-plane settings sends error
 *   events to `<base>/v1/cells/telemetry/errors` with its seat fetch token.
 * - Self-hosted Deft, a hosted cell missing any setting, a paused start, a
 *   development build, or DEFT_TELEMETRY=off: nothing is captured and nothing
 *   is sent; the browser route answers `{ enabled: false }`.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/telemetry-modes.test.ts
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { Hono } from 'hono';
import {
  bufferedEventsForTest,
  captureJobError,
  errorReporterDeps,
  flushErrorTelemetry,
  isErrorTelemetryEnabled,
} from '../src/lib/telemetry/error-reporter.js';
import {
  controlPlaneBaseUrl,
  controlPlaneTarget,
  isInstallPingEnabled,
  isTelemetrySwitchedOff,
  problemReportTarget,
  selfHostedSupportEmail,
} from '../src/lib/telemetry/settings.js';
import { createTelemetryRoutes } from '../src/routes/telemetry.js';
import { CELL_ID, CONTROL_PLANE, FETCH_TOKEN, HOSTED_ENV, SELF_HOSTED_ENV, restoreErrorReporter, useErrorReporter } from './fixtures/telemetry.js';

after(() => restoreErrorReporter());

async function browserReport(): Promise<unknown> {
  const app = new Hono().route('/api/telemetry', createTelemetryRoutes());
  const res = await app.request('/api/telemetry/client-error', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'error', error_class: 'TypeError', message: 'x', page: '/chat' }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function capturesAndSends(env: NodeJS.ProcessEnv): Promise<{ buffered: number; sent: number; browser: unknown }> {
  const network = useErrorReporter(env);
  captureJobError('agent-reply', new Error('boom'));
  const browser = await browserReport();
  const buffered = bufferedEventsForTest().length;
  await flushErrorTelemetry();
  return { buffered, sent: network.sent.length, browser };
}

test('a hosted production cell sends to its control plane with its seat fetch token', async () => {
  const network = useErrorReporter(HOSTED_ENV);
  assert.equal(isErrorTelemetryEnabled(), true);
  captureJobError('agent-reply', new Error('boom'));
  assert.deepEqual(await browserReport(), { enabled: true });
  await flushErrorTelemetry();
  assert.equal(network.sent.length, 1);
  const [request] = network.sent;
  assert.equal(request!.url, `${CONTROL_PLANE}/v1/cells/telemetry/errors`);
  assert.equal(request!.init.method, 'POST');
  assert.equal(request!.init.redirect, 'error');
  const headers = new Headers(request!.init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${FETCH_TOKEN}`);
  assert.equal(headers.get('content-type'), 'application/json');
  assert.ok(request!.init.signal, 'a timeout');
  const body = request!.body as { cell_id: string; events: { kind: string }[] };
  assert.equal(body.cell_id, CELL_ID);
  assert.deepEqual(body.events.map((event) => event.kind).sort(), ['client', 'job']);
});

test('self-hosted Deft captures nothing and sends nothing', async () => {
  assert.deepEqual(await capturesAndSends(SELF_HOSTED_ENV), { buffered: 0, sent: 0, browser: { enabled: false } });
  assert.deepEqual(await capturesAndSends({ ...SELF_HOSTED_ENV, DEFT_HOSTED: 'false' }), { buffered: 0, sent: 0, browser: { enabled: false } });
});

test('a hosted cell missing any control-plane setting sends nothing', async () => {
  for (const missing of ['DEFT_CELL_ID', 'DEFT_SEAT_PUBLIC_KEYS', 'DEFT_SEAT_STATEMENT_URL', 'DEFT_SEAT_FETCH_TOKEN']) {
    const env = { ...HOSTED_ENV };
    delete env[missing];
    assert.deepEqual(await capturesAndSends(env), { buffered: 0, sent: 0, browser: { enabled: false } }, missing);
  }
  // A control plane over plain http is not used: the token would travel in clear text.
  assert.deepEqual(
    await capturesAndSends({ ...HOSTED_ENV, DEFT_SEAT_STATEMENT_URL: 'http://control.test.invalid/v1/cells/x/seat-statement' }),
    { buffered: 0, sent: 0, browser: { enabled: false } },
  );
});

test('DEFT_TELEMETRY=off, a development build and a paused start send no error events', async () => {
  for (const value of ['off', 'OFF', 'false', '0', 'no', 'of']) {
    assert.deepEqual(await capturesAndSends({ ...HOSTED_ENV, DEFT_TELEMETRY: value }), { buffered: 0, sent: 0, browser: { enabled: false } }, value);
  }
  assert.deepEqual(await capturesAndSends({ ...HOSTED_ENV, NODE_ENV: 'development' }), { buffered: 0, sent: 0, browser: { enabled: false } });
  const network = useErrorReporter(HOSTED_ENV);
  errorReporterDeps.isPaused = () => true;
  captureJobError('agent-reply', new Error('boom'));
  await flushErrorTelemetry();
  assert.equal(network.sent.length, 0);
});

test('DEFT_TELEMETRY: on when unset, empty, "on", "true", "1" or "yes" in a production build; off otherwise', () => {
  for (const value of [undefined, '', 'on', 'ON', 'true', '1', 'yes', ' on ']) {
    assert.equal(isTelemetrySwitchedOff({ NODE_ENV: 'production', DEFT_TELEMETRY: value }), false, String(value));
  }
  for (const value of ['off', 'false', '0', 'no', 'disabled', 'of', 'nope']) {
    assert.equal(isTelemetrySwitchedOff({ NODE_ENV: 'production', DEFT_TELEMETRY: value }), true, value);
  }
  assert.equal(isTelemetrySwitchedOff({ DEFT_TELEMETRY: 'on' }), true, 'not a production build');
});

test('the control plane base address comes from the seat statement address', () => {
  assert.equal(controlPlaneBaseUrl('https://deft-control-plane.fly.dev/v1/cells/cell-1/seat-statement'), 'https://deft-control-plane.fly.dev');
  assert.equal(controlPlaneBaseUrl('https://cp.example/prefix/v1/cells/cell-1/seat-statement'), 'https://cp.example/prefix');
  assert.equal(controlPlaneBaseUrl('https://cp.example/v1/seat-statement'), 'https://cp.example');
  assert.equal(controlPlaneBaseUrl('http://cp.example/v1/cells/x/seat-statement'), null);
  assert.equal(controlPlaneBaseUrl('https://user:pw@cp.example/v1/cells/x/seat-statement'), null);
  assert.equal(controlPlaneBaseUrl('not a url'), null);
});

test('problem reports: hosted and configured only; the off switch does not stop a report a person asked to send', () => {
  assert.ok(problemReportTarget(HOSTED_ENV));
  assert.ok(problemReportTarget({ ...HOSTED_ENV, DEFT_TELEMETRY: 'off' }));
  assert.equal(problemReportTarget(SELF_HOSTED_ENV), null);
  assert.equal(problemReportTarget({ ...HOSTED_ENV, DEFT_SEAT_FETCH_TOKEN: undefined }), null);
  assert.deepEqual(controlPlaneTarget(HOSTED_ENV), { cellId: CELL_ID, baseUrl: CONTROL_PLANE, token: FETCH_TOKEN });
});

test('the install ping is self-hosted only; the support address is self-hosted only', () => {
  assert.equal(isInstallPingEnabled(SELF_HOSTED_ENV), true);
  assert.equal(isInstallPingEnabled(HOSTED_ENV), false);
  assert.equal(isInstallPingEnabled({ ...SELF_HOSTED_ENV, DEFT_TELEMETRY: 'off' }), false);
  assert.equal(selfHostedSupportEmail({ DEFT_SUPPORT_EMAIL: 'help@example.test' }), 'help@example.test');
  assert.equal(selfHostedSupportEmail({ DEFT_SUPPORT_EMAIL: 'not an address' }), null);
  assert.equal(selfHostedSupportEmail({ ...HOSTED_ENV, DEFT_SUPPORT_EMAIL: 'help@example.test' }), null);
  assert.equal(selfHostedSupportEmail({}), null);
});
