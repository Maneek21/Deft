/**
 * Telemetry scrubbing, rule by rule (lib/telemetry/scrub.ts), and the
 * reporter's fail-closed paths. The end-to-end canary is
 * telemetry-scrubber-canary.test.ts.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/telemetry-scrub-rules.test.ts
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { Hono } from 'hono';
import {
  APP_ROOT,
  bufferedEventsForTest,
  captureClientError,
  captureJobError,
  errorReporterDeps,
  flushErrorTelemetry,
  flushErrorTelemetryBeforeExit,
  loadKnownValuesForTest,
  nameParts,
} from '../src/lib/telemetry/error-reporter.js';
import { eventMessage, knownValuesPattern, parseStack, scrubMessage, scrubRouteTemplate } from '../src/lib/telemetry/scrub.js';
import { setApiRouteTemplates } from '../src/lib/telemetry/route-templates.js';
import { createTelemetryRoutes } from '../src/routes/telemetry.js';
import { HOSTED_ENV, WEB_ORIGIN, restoreErrorReporter, useErrorReporter } from './fixtures/telemetry.js';

after(() => restoreErrorReporter());

function thrownBy(fn: () => unknown): Error {
  try { fn(); } catch (error) { return error as Error; }
  throw new Error('did not throw');
}

test('quotes nested in a quoted value hide nothing', () => {
  const parse = thrownBy(() => JSON.parse('my "secret merger" plan'));
  const sent = eventMessage({ message: parse.message });
  assert.match(sent, /^Unexpected token <quoted>/);
  assert.doesNotMatch(sent, /secret|merger|plan/);
  for (const raw of [
    'invalid input syntax for type integer: "my "secret launch plan" text"',
    '{"text":"he said \\"merger with Globex on Friday\\" ok"}',
    "Cannot read properties of undefined (reading 'it's my 'private' note')",
  ]) {
    assert.doesNotMatch(scrubMessage(raw), /secret|launch|Globex|merger|Friday|private|note/, raw);
  }
  // An apostrophe inside a word is not a quote.
  assert.equal(scrubMessage("can't access property <quoted>, x is undefined"), "can't access property <quoted>, x is undefined");
});

test('addresses in any script, credentials after their scheme, card and phone numbers', () => {
  assert.equal(scrubMessage('from josé@acme.com'), 'from <email>');
  assert.equal(scrubMessage('to bob@münchen.de now'), 'to <email> now');
  assert.equal(scrubMessage('Authorization: Bearer abcDEF123456'), 'Authorization: Bearer <redacted>');
  assert.equal(scrubMessage('Basic dXNlcjpwYXNz'), 'Basic <redacted>');
  assert.equal(scrubMessage('card 4242 4242 4242 4242 declined'), 'card <n> declined');
  assert.equal(scrubMessage('call 415-555-0199'), 'call <n>');
  // Line numbers and versions are not personal numbers.
  assert.equal(scrubMessage('at line 120:7 in 0.3.0'), 'at line 120:7 in 0.3.0');
});

test('names are split into their parts on spaces, dots, underscores and dashes', () => {
  assert.deepEqual(nameParts(['Priya Raman', 'acme-robotics', 'jo.ann_smith', 'Søren  Kierkegaard']), [
    'Priya', 'Raman', 'acme', 'robotics', 'jo', 'ann', 'smith', 'Søren', 'Kierkegaard',
  ]);
});

test('through the reporter, a known name\'s parts never leave in a message', async () => {
  const network = useErrorReporter(HOSTED_ENV, { known: ['Priya Raman'] });
  await loadKnownValuesForTest();
  captureJobError('dm', thrownBy(() => { (undefined as unknown as Record<string, () => void>).Raman!(); }));
  await flushErrorTelemetry();
  const wire = String(network.sent[0]!.init.body);
  assert.doesNotMatch(wire, /Raman|Priya/);
});

test('name parts are removed as whole words; a member called "apps" blanks no frame', () => {
  const known = knownValuesPattern(['Priya Raman', 'apps'], ['Priya', 'Raman', 'apps']);
  assert.equal(scrubMessage('Cannot DM Priya: Raman left', known), 'Cannot DM <name>: <name> left');
  const frames = parseStack(`Error\n    at sendDm (${APP_ROOT}/apps/api/src/routes/messages.ts:10:2)`, { appRoot: APP_ROOT }, known);
  assert.deepEqual(frames, [{ file: 'apps/api/src/routes/messages.ts', line: 10, fn: 'sendDm' }]);
});

test('only runtime-written messages leave, and none of their forms admits prose', () => {
  assert.equal(eventMessage({ message: 'Could not save note: move the blue chair' }), '');
  assert.equal(eventMessage({ message: 'Unexpected token x, buy cheap pills at evil.com is not valid JSON' }), '');
  assert.equal(eventMessage({ message: 'Cannot read properties of undefined (reading buy cheap pills now)' }), '');
  assert.equal(eventMessage({ message: 'Converting circular structure to JSON and visit evil.com' }), '');
  assert.equal(eventMessage({ message: 'Invalid regular expression: /launch plan/: Unterminated group' }), '');
  assert.equal(eventMessage({ message: 'visit.evil.com is not a function' }), '<host> is not a function');
  assert.equal(eventMessage({ message: "Cannot read properties of undefined (reading 'title')" }), 'Cannot read properties of undefined (reading <quoted>)');
  assert.equal(eventMessage({ message: 'connect ECONNREFUSED 10.0.0.5:5432', code: 'ECONNREFUSED' }), 'code ECONNREFUSED');
  assert.equal(eventMessage({ message: 'duplicate key value violates unique constraint', code: '23505' }), 'code 23505');
});

test('a route template keeps only words the API routes or web pages have', () => {
  setApiRouteTemplates([{ method: 'GET', path: '/api/wiki/:slug' }]);
  assert.equal(scrubRouteTemplate('/api/wiki/acme-pricing-strategy'), '/api/wiki/:param');
  assert.equal(scrubRouteTemplate('/api/wiki/:slug'), '/api/wiki/:slug');
  assert.equal(scrubRouteTemplate('/api/wiki/tz4a98xxat96iws9zmbrgj3a'), '/api/wiki/:param');
  assert.equal(scrubRouteTemplate('/settings/members'), '/settings/members');
});

test('a browser report cannot carry its own class names, function names or hosts', () => {
  useErrorReporter(HOSTED_ENV);
  captureClientError({
    errorClass: 'visit.evil.com',
    message: 'PayInvoiceAt.evil.com is not a function',
    stack: `TypeError: x\n    at PayInvoiceAt.evil.com (${WEB_ORIGIN}/_next/static/chunks/app/(app)/chat/page-0123456789abcdef.js:1:2)\n    at x (https://evil.example/_next/static/chunks/main.js:1:1)`,
    route: '/chat',
  });
  const [event] = bufferedEventsForTest();
  assert.equal(event!.error_class, 'Error');
  assert.deepEqual(event!.frames, [{ file: '_next/static/chunks/app/(app)/chat/page-<hash>.js', line: 1, fn: '<anonymous>' }]);
  assert.doesNotMatch(JSON.stringify(event), /evil|PayInvoice/);
});

test('the open route takes only JSON, and only from the web app\'s own address when a browser says where it is', async () => {
  useErrorReporter(HOSTED_ENV);
  const app = new Hono().route('/api/telemetry', createTelemetryRoutes({ webOrigins: () => [WEB_ORIGIN] }));
  const post = (headers: Record<string, string>) => app.request('/api/telemetry/client-error', {
    method: 'POST', headers, body: JSON.stringify({ type: 'error', error_class: 'TypeError', message: 'x' }),
  });
  assert.equal((await post({ 'content-type': 'text/plain' })).status, 415, 'a cross-site simple POST');
  assert.equal((await post({ 'content-type': 'application/json', origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ 'content-type': 'application/json', origin: WEB_ORIGIN })).status, 200);
  assert.equal((await post({ 'content-type': 'application/json; charset=utf-8' })).status, 200, 'no Origin: not a browser on another site');
});

test('until the names have loaded once, no message leaves', async () => {
  const network = useErrorReporter(HOSTED_ENV);
  errorReporterDeps.knownValues = async () => { throw new Error('database down'); };
  captureJobError('sync', thrownBy(() => (undefined as unknown as { x: number }).x));
  await flushErrorTelemetry();
  const [event] = (network.sent[0]!.body as { events: { message: string; error_class: string }[] }).events;
  assert.equal(event!.message, '');
  assert.equal(event!.error_class, 'TypeError', 'the rest of the event still goes');
});

test('a fatal exit does not wait on the database for names', async () => {
  const network = useErrorReporter(HOSTED_ENV);
  errorReporterDeps.knownValues = () => new Promise(() => undefined);
  captureJobError('crash', thrownBy(() => (undefined as unknown as { x: number }).x));
  const started = Date.now();
  await flushErrorTelemetryBeforeExit(1_500);
  assert.ok(Date.now() - started < 1_000, 'sent without waiting for the names query');
  assert.equal(network.sent.length, 1);
  assert.equal((network.sent[0]!.body as { events: { message: string }[] }).events[0]!.message, '', 'and with no message, since names never loaded');
});
