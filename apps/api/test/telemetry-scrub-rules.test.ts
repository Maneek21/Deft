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
  assert.equal(sent, 'Unexpected token in JSON');
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
  assert.equal(eventMessage({ message: 'Unexpected token x, buy cheap pills at evil.com is not valid JSON' }), 'Unexpected token in JSON');
  assert.equal(eventMessage({ message: 'Cannot read properties of undefined (reading buy cheap pills now)' }), 'Cannot read properties of undefined (reading <quoted>)');
  assert.equal(eventMessage({ message: 'Converting circular structure to JSON and visit evil.com' }), 'Converting circular structure to JSON');
  assert.equal(eventMessage({ message: 'Invalid regular expression: /launch plan/: Unterminated group' }), '');
  assert.equal(eventMessage({ message: 'visit.evil.com is not a function' }), '<expr> is not a function');
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

// Confirmation round: values V8 prints unquoted, and every other form, leave only as fixed text.
test('a runtime value V8 prints unquoted never leaves: only fixed text', () => {
  const inOperator = thrownBy(() => 'type' in ('hunter2' as unknown as object));
  assert.equal(eventMessage({ message: inOperator.message }), "Cannot use 'in' operator to search for <quoted> in <expr>");
  const construct = thrownBy(() => Reflect.construct('s3cretword' as unknown as new () => object, []));
  assert.equal(eventMessage({ message: construct.message }), '<expr> is not a constructor');
  const key = "x' blue chair https://example.invalid";
  const read = thrownBy(() => (undefined as unknown as Record<string, unknown>)[key]);
  assert.equal(eventMessage({ message: read.message }), 'Cannot read properties of undefined (reading <quoted>)');
  for (const message of [inOperator, construct, read].map((error) => eventMessage({ message: error.message }))) {
    assert.doesNotMatch(message, /hunter2|s3cret|blue|chair|example/);
  }
});

test('only real error codes leave, whole', () => {
  assert.equal(eventMessage({ message: 'x', code: 'ECONNREFUSED' }), 'code ECONNREFUSED');
  assert.equal(eventMessage({ message: 'x', code: 'ENOTFOUND' }), 'code ENOTFOUND');
  assert.equal(eventMessage({ message: 'x', code: 'ERR_STREAM_PREMATURE_CLOSE' }), 'code ERR_STREAM_PREMATURE_CLOSE');
  assert.equal(eventMessage({ message: 'x', code: 'UND_ERR_CONNECT_TIMEOUT' }), 'code UND_ERR_CONNECT_TIMEOUT');
  for (const sqlstate of ['23505', '42P01', 'XX000', '57P01', 'P0001']) assert.equal(eventMessage({ message: 'x', code: sqlstate }), `code ${sqlstate}`);
  for (const junk of ['HELLO', 'ACMEX', 'EACMEROBOTICS', 'SEAT_LIMIT_REACHED', 'hunter2', 'ERR_']) {
    assert.equal(eventMessage({ message: 'x', code: junk }), '', junk);
  }
});

test('a long code survives the last pass before sending', async () => {
  const network = useErrorReporter(HOSTED_ENV, { known: ['Priya Raman'] });
  await loadKnownValuesForTest();
  captureJobError('stream', Object.assign(new Error('premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
  await flushErrorTelemetry();
  assert.equal((network.sent[0]!.body as { events: { message: string }[] }).events[0]!.message, 'code ERR_STREAM_PREMATURE_CLOSE');
});

test('pages are the app\'s own patterns, whatever the browser sends', async () => {
  const { webPageTemplate } = await import('../src/lib/telemetry/route-templates.js');
  for (const page of ['/modules/billing', '/modules/:orchid', '/modules/chat', '/modules/:slug']) {
    assert.equal(webPageTemplate(page), '/modules/:slug', page);
  }
  assert.equal(webPageTemplate('/settings/agent-employees/emp_1/heartbeats'), '/settings/agent-employees/:id/heartbeats');
  assert.equal(webPageTemplate('/settings/agent-employees/create'), '/settings/agent-employees/create', 'a fixed page beats a dynamic one');
  assert.equal(webPageTemplate('/chat?space=abc#setup=x'), '/chat');
  assert.equal(webPageTemplate('/made/up/page'), null);
  assert.equal(webPageTemplate('/notes/my-launch-plan'), null);
});

test('bundle paths: only real folders, decoded, with chunk names and hashes replaced', async () => {
  const { webBundlePath } = await import('../src/lib/telemetry/web-paths.js');
  assert.equal(webBundlePath('/_next/static/chunks/app/(orchid)/page-0123456789abcdef.js'), null, 'no such route group');
  assert.equal(webBundlePath('/_next/static/chunks/app/(app)/settings/[evil_site]/page.js'), null, 'no such dynamic folder');
  assert.equal(webBundlePath('/_next/static/chunks/app/(app)/settings/agent-employees/%5Bid%5D/page-0123456789abcdef.js'),
    '_next/static/chunks/app/(app)/settings/agent-employees/[id]/page-<hash>.js');
  assert.equal(webBundlePath('/_next/static/chunks/fd9d1056-0123456789abcdef.js'), '_next/static/chunks/<chunk>-<hash>.js');
  assert.equal(webBundlePath('/_next/static/chunks/1234-0123456789abcdef.js'), '_next/static/chunks/<chunk>-<hash>.js');
  assert.equal(webBundlePath('/_next/static/chunks/buy-pills.js'), null);
});

test('a release label outside Deft\'s channels is unknown', async () => {
  const { releaseLabel } = await import('../src/lib/telemetry/scrub.js');
  for (const ok of ['0.3.0-preview.152', '1.0.0', '1.1.0-rc.2', '2.0.0-beta.1']) assert.equal(releaseLabel(ok), ok);
  for (const bad of ['0.3.0-exampleco.1', '0.3.0-acme.2', 'v1.0.0', '1.0']) assert.equal(releaseLabel(bad), 'unknown', bad);
});

test('the 60-second floor counts from the send, even when preparing a batch is slow', async () => {
  let now = Date.parse('2026-11-25T10:00:00.000Z');
  const network = useErrorReporter(HOSTED_ENV, { now: () => now });
  // The names query takes 59 seconds; the first batch leaves at 59 s.
  errorReporterDeps.knownValues = async () => { now += 59_000; return { whole: [], parts: [] }; };
  captureJobError('first', 'x');
  await flushErrorTelemetry();
  captureJobError('second', 'x');
  now += 2_000;
  await flushErrorTelemetryBeforeExit(500);
  assert.equal(network.sent.length, 1, 'not two seconds later, even on the way out');
  assert.equal(bufferedEventsForTest().length, 1, 'the second event waits');
});
