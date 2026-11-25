/**
 * Telemetry scrubber canary (telemetry contract, section 1).
 *
 * Errors whose messages, routes and stacks carry an email address, a setup
 * link, an invite link, an AI key, a JWT, message text in quotes, a file
 * name and the workspace's name go in through every capture path: a thrown
 * request error, a 5xx answer, a failed job, an uncaught process error, and
 * browser reports (a thrown error and a failed API call). What would leave
 * the cell is the request the reporter hands to the network. None of the
 * canaries may survive into it, in any form, and it may carry only the
 * contract's fields.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/telemetry-scrubber-canary.test.ts
 */
import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { Hono } from 'hono';
import { contentFreeErrorHandler } from '../src/lib/content-free-error-handler.js';
import { telemetryResponseCapture } from '../src/lib/telemetry/http-capture.js';
import {
  APP_ROOT,
  captureJobError,
  captureProcessError,
  flushErrorTelemetry,
  loadKnownValuesForTest,
} from '../src/lib/telemetry/error-reporter.js';
import { createTelemetryRoutes } from '../src/routes/telemetry.js';
import { CELL_ID, CONTROL_PLANE, EVENT_KEYS, FETCH_TOKEN, HOSTED_ENV, restoreErrorReporter, useApiRoutes, useErrorReporter } from './fixtures/telemetry.js';

const EMAIL = 'priya.sharma@acme-robotics.example';
const SETUP_TOKEN = 'Zx9kQ2mN7pL4vR8tY1wE3aS6dF0gH5jK';
const SETUP_LINK = `https://acme-robotics.deft.ing/signup#setup=${SETUP_TOKEN}`;
const INVITE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoiaW52aXRlZSJ9.aW52aXRlLXNpZ25hdHVyZQ';
const INVITE_LINK = `https://acme-robotics.deft.ing/invite#token=${INVITE_JWT}`;
const AI_KEY = 'sk-ant-api03-Q2FuYXJ5S2V5Rm9yVGVzdHM';
const SHORT_AI_KEY = 'sk-proj-c4n4ry';
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InVzZXItMSIsIm9yZ19pZCI6Im9yZy0xIn0.dGVzdHNpZ25hdHVyZQ';
const MESSAGE_TEXT = 'ship the launch plan by friday';
const FILE_NAME = 'Q3-board-report.pdf';
const WORKSPACE = 'Acme Robotics';
const WORKSPACE_SLUG = 'acme-robotics';
const PERSON = 'Priya Sharma';
// Ordinary text a person typed, unquoted, in a message the app wrote.
const NOTE_TEXT = 'move the blue chair';
// A workspace's own UUID, offered as a request ID: only references the cell issued may pass.
const WORKSPACE_UUID = '3c9d0f6e-2b1a-4c8d-9e7f-5a6b7c8d9e0f';

/** Every piece that must not leave the cell, checked without regard to case. */
const CANARIES = [
  EMAIL, 'priya', 'sharma', 'acme', 'robotics', SETUP_TOKEN, SETUP_LINK, INVITE_LINK, INVITE_JWT, 'eyJ', AI_KEY,
  'Q2FuYXJ5', SHORT_AI_KEY, 'c4n4ry', JWT, MESSAGE_TEXT, 'launch plan', 'friday', FILE_NAME, 'board-report', '.pdf',
  WORKSPACE, WORKSPACE_SLUG, 'deft.ing', 'signup#', 'invite#', 'setup=', 'token=', NOTE_TEXT, 'blue chair', WORKSPACE_UUID,
];

/** One message carrying every canary, quoted and unquoted. */
const LOADED_MESSAGE = `Upload of ${FILE_NAME} for ${EMAIL} in ${WORKSPACE} failed: "${MESSAGE_TEXT}" `
  + `while ${PERSON} opened ${SETUP_LINK} and ${INVITE_LINK} with key ${AI_KEY} (or ${SHORT_AI_KEY}) `
  + `and session ${JWT} on ${WORKSPACE_SLUG}`;

/** A stack whose frames name the canaries in function names and paths. */
function loadedStack(firstLine: string): string {
  return [
    firstLine,
    `    at notify_${EMAIL} (${APP_ROOT}/apps/api/src/routes/messages.ts:120:7)`,
    `    at ${WORKSPACE.replace(' ', '')}.upload (${APP_ROOT}/apps/api/src/lib/file-store.ts:44:3)`,
    `    at readFile (/home/${WORKSPACE_SLUG}/uploads/${FILE_NAME}:1:1)`,
    `    at openLink (${SETUP_LINK}:2:3)`,
    `    at Object.<anonymous> (${INVITE_LINK.replace('#', '/')}:4:5)`,
    `    at ${AI_KEY} (${APP_ROOT}/apps/api/src/lib/agent-llm.ts:9:9)`,
    `    at "${MESSAGE_TEXT}" (${APP_ROOT}/apps/api/src/lib/agent-runner.ts:3:3)`,
  ].join('\n');
}

function loadedError(name = 'Error'): Error {
  const error = new Error(LOADED_MESSAGE);
  error.name = name;
  error.stack = loadedStack(`${name}: ${LOADED_MESSAGE}`);
  return error;
}

beforeEach(() => {
  useApiRoutes();
});

after(() => {
  restoreErrorReporter();
});

test('no canary survives any capture path into the batch that leaves the cell', async () => {
  // The workspace's names and people's names, as the cell loads them from its database.
  const network = useErrorReporter(HOSTED_ENV, { known: [WORKSPACE, WORKSPACE_SLUG, PERSON], webOrigins: [`https://${WORKSPACE_SLUG}.deft.ing`] });

  // 1. A request error, thrown from a route reached by a raw path full of canaries.
  const app = new Hono();
  app.onError(contentFreeErrorHandler);
  app.use('*', telemetryResponseCapture);
  app.post('/api/spaces/:id/files/:name', () => { throw loadedError(); });
  // 2. A 5xx answer without an exception.
  app.get('/api/spaces/:id/export', (c) => c.json({ error: 'Export failed', code: 'INTERNAL_ERROR' }, 500));
  // An app message with a person's text, unquoted, even under an engine class name.
  app.get('/api/notes/:id', function saveNote() { throw new TypeError(`Could not save note: ${NOTE_TEXT}`); });
  // A real engine error: its message is useful and safe once scrubbed.
  app.get('/api/tasks/:id', function readTask() { const task = undefined as unknown as { title: { trim(): string } }; return new Response(task.title.trim()); });
  const thrown = await app.request(`/api/spaces/${WORKSPACE_SLUG}/files/${FILE_NAME}?email=${EMAIL}&token=${JWT}`, { method: 'POST' });
  assert.equal(thrown.status, 500);
  const answered = await app.request(`/api/spaces/${WORKSPACE_SLUG}/export?q=${encodeURIComponent(MESSAGE_TEXT)}`);
  assert.equal(answered.status, 500);
  assert.equal((await app.request('/api/notes/n1')).status, 500);
  assert.equal((await app.request('/api/tasks/t1')).status, 500);

  // 3. A failed job, and 4. an uncaught process error, with a class name that is data.
  captureJobError('agent-reply', loadedError());
  captureJobError('note-save', (function saveNoteJob() { return new Error(`Could not save note: ${NOTE_TEXT}`); })());
  // A system error: only its code leaves, never the address in its message.
  captureJobError('imap-sync', Object.assign((function syncMailbox() { return new Error(`connect ECONNREFUSED mail.${WORKSPACE_SLUG}.example:993 for ${EMAIL}`); })(), { code: 'ECONNREFUSED' }));
  captureProcessError(loadedError(WORKSPACE));
  captureProcessError(loadedError(EMAIL));

  // 5. Browser reports, to the cell's own route, after the known names are loaded.
  await loadKnownValuesForTest();
  const routes = new Hono().route('/api/telemetry', createTelemetryRoutes());
  const post = (body: unknown) => routes.request('/api/telemetry/client-error', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${JWT}` },
    body: JSON.stringify(body),
  });
  const browserStack = [
    `TypeError: ${LOADED_MESSAGE}`,
    `    at onSubmit (https://${WORKSPACE_SLUG}.deft.ing/_next/static/chunks/app/(app)/chat/page-0123456789abcdef.js?email=${EMAIL}:1:2345)`,
    `    at ${PERSON.replace(' ', '_')} (https://${WORKSPACE_SLUG}.deft.ing/_next/static/chunks/${FILE_NAME}.js:1:1)`,
    `    at chrome-extension://${WORKSPACE_SLUG}/${FILE_NAME}:1:1`,
    `uploadFile@https://${WORKSPACE_SLUG}.deft.ing/${FILE_NAME}:3:4`,
  ].join('\n');
  for (const body of [
    { type: 'error', error_class: 'TypeError', message: LOADED_MESSAGE, stack: browserStack, page: `/chat/${WORKSPACE_SLUG}/${FILE_NAME}?email=${EMAIL}#setup=${SETUP_TOKEN}` },
    { type: 'rejection', error_class: EMAIL, message: `Uncaught (in promise) ${LOADED_MESSAGE}`, stack: browserStack, page: `/invite#token=${INVITE_JWT}` },
    { type: 'api', method: 'GET', api_path: `/api/spaces/${WORKSPACE_SLUG}/messages?q=${encodeURIComponent(MESSAGE_TEXT)}&key=${AI_KEY}`, status: 502, request_id: WORKSPACE_UUID, page: `/settings/${EMAIL}` },
    { type: 'api', method: 'GET', api_path: `/api/files/${FILE_NAME}`, status: 500, page: `/notes/${WORKSPACE_SLUG}` },
    { type: 'error', error_class: 'TypeError', message: "Cannot read properties of undefined (reading 'title')", page: '/tasks/:id' },
    { type: 'error', error_class: 'Error', message: `Could not save note: ${NOTE_TEXT}`, page: '/notes/:id' },
  ]) {
    const res = await post(body);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { enabled: true });
  }

  await flushErrorTelemetry();
  assert.equal(network.sent.length, 1, 'one batch');
  const [request] = network.sent;
  assert.equal(request!.url, `${CONTROL_PLANE}/v1/cells/telemetry/errors`);
  assert.equal(new Headers(request!.init.headers).get('authorization'), `Bearer ${FETCH_TOKEN}`);

  const wire = String(request!.init.body);
  const lower = wire.toLowerCase();

  const survivors = CANARIES.filter((canary) => lower.includes(canary.toLowerCase()));
  assert.deepEqual(survivors, [], `canaries survived into the payload: ${survivors.join(', ')}`);

  // Only the contract's fields.
  const body = request!.body as { cell_id: string; release: string; events: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(body).sort(), ['cell_id', 'events', 'release']);
  assert.equal(body.cell_id, CELL_ID);
  assert.equal(body.release, '0.3.0-preview.152');
  assert.ok(body.events.length >= 7, `expected every capture path, got ${body.events.length}`);
  for (const event of body.events) {
    assert.deepEqual(Object.keys(event).sort(), EVENT_KEYS);
    assert.match(String(event.fingerprint), /^[0-9a-f]{64}$/);
    assert.ok(String(event.message).length <= 300);
    assert.ok(String(event.error_class).length <= 100);
    for (const frame of event.frames as Record<string, unknown>[]) {
      assert.deepEqual(Object.keys(frame).sort(), ['file', 'fn', 'line']);
      assert.ok(!String(frame.file).startsWith('/') && !/^[A-Za-z]:/.test(String(frame.file)), 'frames are relative to the app root');
    }
    if (event.route !== null) assert.match(String(event.route), /^\/[a-z0-9/:_.*()-]*$/, 'routes are templates');
  }
  const kinds = new Set(body.events.map((event) => event.kind));
  assert.deepEqual([...kinds].sort(), ['client', 'job', 'server']);
  const routes_ = new Set(body.events.map((event) => event.route));
  for (const expected of ['/api/spaces/:id/files/:name', '/api/spaces/:id/export', '/chat/:param/:param', '/invite', '/api/spaces/:id/messages']) {
    assert.ok(routes_.has(expected), `route template ${expected} in ${[...routes_].join(' ')}`);
  }
  // Messages: a runtime message stays (scrubbed); an app's own text does not; a system error is its code.
  const messages = body.events.map((event) => event.message);
  assert.ok(messages.includes('Cannot read properties of undefined (reading <quoted>)'), messages.join(' | '));
  assert.ok(messages.includes('code ECONNREFUSED'), messages.join(' | '));
  assert.ok(body.events.filter((event) => event.route === '/api/notes/:id' || event.job === 'note-save').every((event) => event.message === ''));
  // A path the API has no route for is not a template: no route at all.
  assert.ok(body.events.some((event) => event.kind === 'client' && event.method === 'GET' && event.status === 500 && event.route === null));
  // The thrown request error carries the reference the person was shown.
  const reference = thrown.headers.get('X-Deft-Error-Reference');
  assert.ok(reference && body.events.some((event) => (event.request_ids as string[]).includes(reference)));
});

test('the canary holds before the names are loaded: the batch is scrubbed again on the way out', async () => {
  const network = useErrorReporter(HOSTED_ENV, { known: [WORKSPACE, WORKSPACE_SLUG, PERSON] });
  // Captured before the known names have ever been loaded.
  captureJobError('daily-standup', loadedError());
  await flushErrorTelemetry();
  assert.equal(network.sent.length, 1);
  const lower = String(network.sent[0]!.init.body).toLowerCase();
  assert.deepEqual(CANARIES.filter((canary) => lower.includes(canary.toLowerCase())), []);
});
