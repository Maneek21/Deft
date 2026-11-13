import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import {
  installRequestGate,
  isPublicApiRequest,
  type GateAuthenticate,
} from '../src/middleware/request-gate.js';

const ODD_SUFFIXES = [
  '%0A', '%0a', '%0D', '%0d', '%09', '%00', '%5C', '%5c', '%1F', '%7F', '%7f',
  'x%0A', 'x%0d%0A', 'abc%0A', '%E2%80%A8%0A', '%250A', '%252F', '%252f', '..%5C..',
];

function buildApp() {
  const ran: string[] = [];
  // Deliberately NO auth middleware: the gate alone must keep handlers from running.
  const app = new Hono();
  app.get('/api/tasks/:id', (c) => { ran.push(c.req.path); return c.json({ id: c.req.param('id') }); });
  app.post('/api/tasks/:id/comments', (c) => { ran.push(c.req.path); return c.json({ ok: true }, 201); });
  app.get('/api/spaces/:id/messages', (c) => { ran.push(c.req.path); return c.json([]); });
  app.delete('/api/files/:id', (c) => { ran.push(c.req.path); return c.json({ ok: true }); });
  app.get('/api/inbox', (c) => { ran.push(c.req.path); return c.json([]); });
  app.post('/api/agent-webhooks', (c) => { ran.push(c.req.path); return c.json({ ok: true }, 201); });
  app.post('/api/agent-webhooks/:slug', (c) => { ran.push(c.req.path); return c.json({ ok: true }); });
  app.get('/api/ics/feed/:token', (c) => { ran.push(c.req.path); return c.text('BEGIN:VCALENDAR'); });
  app.get('/api/ics/subscriptions', (c) => { ran.push(c.req.path); return c.json([]); });
  app.get('/api/invites/preview/:token', (c) => { ran.push(c.req.path); return c.json({ ok: true }); });
  app.get('/health', (c) => c.json({ status: 'ok' }));
  const authenticate: GateAuthenticate = async (request) =>
    request.headers.get('authorization') === 'Bearer good'
      ? { ok: true }
      : { ok: false, status: 401, error: 'Unauthorized', code: 'NO_TOKEN' };
  installRequestGate(app, { isPublic: isPublicApiRequest, authenticate });
  return { app, ran };
}

test('requests without a session never reach a non-public API handler, with no auth middleware registered', async () => {
  const { app, ran } = buildApp();
  const cases: Array<[string, string]> = [
    ['GET', '/api/tasks/t1'],
    ['POST', '/api/tasks/t1/comments'],
    ['GET', '/api/spaces/s1/messages'],
    ['DELETE', '/api/files/f1'],
    ['GET', '/api/inbox'],
    ['POST', '/api/agent-webhooks'],
    ['GET', '/api/agent-webhooks/slug'],
    ['GET', '/api/ics/subscriptions'],
    ['HEAD', '/api/tasks/t1'],
  ];
  for (const [method, path] of cases) {
    const res = await app.request(path, { method });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  const bad = await app.request('/api/tasks/t1', { headers: { authorization: 'Bearer bad' } });
  assert.equal(bad.status, 401);
  assert.deepEqual(ran, []);
});

test('every path encoding of a non-public API route is refused without running the handler', async () => {
  const { app, ran } = buildApp();
  for (const suffix of ODD_SUFFIXES) {
    for (const path of [`/api/tasks/${suffix}`, `/api/tasks/t1${suffix}`, `/api/inbox/${suffix}`, `/api/spaces/${suffix}/messages`]) {
      for (const headers of [{}, { authorization: 'Bearer bad' }]) {
        const res = await app.request(path, { headers });
        assert.ok(res.status === 400 || res.status === 401, `${path} -> ${res.status}`);
      }
    }
  }
  assert.deepEqual(ran, []);
});

test('paths with control characters or backslashes are refused with 400 on every route', async () => {
  const { app, ran } = buildApp();
  const paths = [
    '/api/tasks/%0A', '/api/tasks/t1%0d', '/api/tasks/%09x', '/api/tasks/%00', '/api/tasks/a%5Cb',
    '/api/tasks/a%5cb', '/api/tasks/t1%0A', '/api/ics/feed/tok%0A', '/api/invites/preview/%0a',
    '/api/agent-webhooks/slug%0D', '/health%0A', '/api/tasks/%7F',
  ];
  for (const path of paths) {
    for (const headers of [{}, { authorization: 'Bearer good' }]) {
      const res = await app.request(path, { method: path.includes('agent-webhooks') ? 'POST' : 'GET', headers });
      assert.equal(res.status, 400, path);
      assert.deepEqual(await res.json(), { error: 'Invalid request path', code: 'INVALID_PATH' });
    }
  }
  assert.deepEqual(ran, []);
});

test('a valid session reaches the handler, including odd but well-formed encodings', async () => {
  const { app, ran } = buildApp();
  const headers = { authorization: 'Bearer good' };
  assert.equal((await app.request('/api/tasks/t1', { headers })).status, 200);
  const res = await app.request('/api/tasks/a%252Fb', { headers });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: 'a%2Fb' });
  assert.equal(ran.length, 2);
});

test('deliberately public routes answer without a session', async () => {
  const { app, ran } = buildApp();
  assert.equal((await app.request('/api/agent-webhooks/my-hook', { method: 'POST' })).status, 200);
  assert.equal((await app.request('/api/ics/feed/tok')).status, 200);
  assert.equal((await app.request('/api/ics/feed/tok', { method: 'HEAD' })).status, 200);
  assert.equal((await app.request('/api/invites/preview/tok')).status, 200);
  assert.equal((await app.request('/health')).status, 200);
  assert.equal(ran.length, 4);
});

test('CORS preflight is not refused by the session gate', async () => {
  const { app } = buildApp();
  const res = await app.request('/api/tasks/t1', { method: 'OPTIONS' });
  assert.notEqual(res.status, 401);
});

test('public classification is segment-aware', () => {
  assert.equal(isPublicApiRequest('GET', '/api/auth/me'), true);
  assert.equal(isPublicApiRequest('GET', '/api/authx'), false);
  assert.equal(isPublicApiRequest('POST', '/api/app-data/runtime/authority'), true);
  assert.equal(isPublicApiRequest('POST', '/api/app-data/connections/c1/requests'), false);
  assert.equal(isPublicApiRequest('GET', '/api/app-resource-access/grants/g1/resource'), false);
  assert.equal(isPublicApiRequest('GET', '/api/apps/x'), false);
  assert.equal(isPublicApiRequest('GET', '/api/app-data-other'), false);
  assert.equal(isPublicApiRequest('POST', '/api/agent-webhooks/slug'), true);
  assert.equal(isPublicApiRequest('DELETE', '/api/agent-webhooks/slug'), false);
  assert.equal(isPublicApiRequest('POST', '/api/agent-webhooks/slug/extra'), false);
  assert.equal(isPublicApiRequest('POST', '/api/ics/feed/tok'), false);
  assert.equal(isPublicApiRequest('GET', '/api/ics/my-feed-url'), false);
  assert.equal(isPublicApiRequest('GET', '/api/tasks'), false);
});

test('routes under /api/apps, including private Defty, need a session', () => {
  assert.equal(isPublicApiRequest('POST', '/api/apps/private-defty/review'), false);
  assert.equal(isPublicApiRequest('GET', '/api/apps/private-defty/spaces/s1/history'), false);
  assert.equal(isPublicApiRequest('GET', '/api/apps/private-defty'), false);
  assert.equal(isPublicApiRequest('POST', '/api/agent-webhooks/'), false);
  assert.equal(isPublicApiRequest('GET', '/api/ics/feed//x'), false);
});

test('the gate ends per-request reuse of the auth result once the request is answered', async () => {
  const released: Request[] = [];
  const app = new Hono();
  app.get('/api/tasks/:id', (c) => c.json({ ok: true }));
  installRequestGate(app, {
    isPublic: isPublicApiRequest,
    authenticate: async () => ({ ok: true }),
    release: (request) => { released.push(request); },
  });
  const request = new Request('http://localhost/api/tasks/t1');
  assert.equal((await app.fetch(request)).status, 200);
  assert.deepEqual(released, [request]);
});
