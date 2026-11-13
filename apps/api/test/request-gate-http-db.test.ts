import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const stamp = Date.now();
const USER_ID = `gate-user-${stamp}`;
const USER_EMAIL = `gate-user-${stamp}@test.local`;

type App = typeof import('../src/index.js')['app'];
let app: App;
let authMiddleware: unknown;
let isPublicApiRequest: (method: string, path: string) => boolean;
let exemptRoutes: ReadonlyArray<{ methods?: readonly string[]; path: string }>;
let accessToken: string;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function effectCounts() {
  return withClient(async (c) => {
    const { rows } = await c.query(`SELECT
      (SELECT count(*) FROM tasks)::int AS tasks,
      (SELECT count(*) FROM messages)::int AS messages,
      (SELECT count(*) FROM spaces)::int AS spaces,
      (SELECT count(*) FROM job_queue)::int AS jobs`);
    return rows[0];
  });
}

before(async () => {
  await withClient(async (c) => {
    await c.query(`INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, 'Gate User', false)
      ON CONFLICT (id) DO NOTHING`, [USER_ID, USER_EMAIL]);
    await c.query(`INSERT INTO org_members (id, org_id, user_id, role, is_active)
      VALUES (gen_random_uuid()::text, $1, $2, 'member', true) ON CONFLICT (org_id, user_id) DO NOTHING`, [ORG_ID, USER_ID]);
  });
  ({ app } = await import('../src/index.js'));
  ({ authMiddleware } = await import('../src/middleware/auth.js'));
  ({ isPublicApiRequest, SESSION_EXEMPT_ROUTES: exemptRoutes } = await import('../src/middleware/request-gate.js'));
  const { createWebSession } = await import('../src/lib/web-sessions.js');
  ({ accessToken } = await createWebSession({ id: USER_ID, email: USER_EMAIL, org_id: ORG_ID }));});

after(async () => {
  await withClient(async (c) => {
    await c.query('DELETE FROM web_sessions WHERE user_id = $1', [USER_ID]);
    await c.query('DELETE FROM org_members WHERE user_id = $1', [USER_ID]);
    await c.query('DELETE FROM users WHERE id = $1', [USER_ID]);
  });
});

const ROUTES: Array<[string, string]> = [
  ['GET', '/api/tasks/{x}'],
  ['PATCH', '/api/tasks/{x}'],
  ['POST', '/api/tasks'],
  ['GET', '/api/spaces/{x}/messages'],
  ['POST', '/api/spaces/{x}/messages'],
  ['GET', '/api/spaces/{x}'],
  ['GET', '/api/messages/{x}'],
  ['GET', '/api/files/{x}'],
  ['DELETE', '/api/files/{x}'],
  ['GET', '/api/members/{x}'],
  ['GET', '/api/agent/actions/{x}'],
  ['GET', '/api/inbox/{x}'],
  ['GET', '/api/modules/{x}'],
];
const SUFFIXES = ['abc', '%0A', '%0a', 'abc%0A', '%0D', '%0d%0a', '%09', '%00', '%5C', '%5c', '%252F', '%252f', '%250A', 'abc%0A%0A'];

test('requests without a session are refused on every API route, whatever the path encoding', async () => {
  const beforeCounts = await effectCounts();
  for (const [method, template] of ROUTES) {
    for (const suffix of SUFFIXES) {
      const path = template.replace('{x}', suffix);
      for (const headers of [{}, { authorization: 'Bearer not-a-token' }]) {
        const res = await app.request(path, { method, headers: { ...headers, 'content-type': 'application/json' },
          body: method === 'GET' || method === 'DELETE' ? undefined : '{"title":"gate","content":"gate"}' });
        assert.ok(res.status === 400 || res.status === 401, `${method} ${path} -> ${res.status}`);
      }
    }
  }
  assert.deepEqual(await effectCounts(), beforeCounts);
});

test('control characters and backslashes in the path are refused with 400', async () => {
  for (const path of ['/api/tasks/%0A', '/api/tasks/x%0d', '/api/inbox/%09', '/api/auth/me%0A', '/api/invites/preview/%5C', '/health%00']) {
    const res = await app.request(path, { headers: { authorization: `Bearer ${accessToken}` } });
    assert.equal(res.status, 400, path);
  }
});

test('a valid session still reaches routes, and odd well-formed paths still pass the rate limiter', async () => {
  const headers = { authorization: `Bearer ${accessToken}` };
  const inbox = await app.request('/api/inbox?count_only=1', { headers });
  assert.equal(inbox.status, 200);
  const odd = await app.request('/api/tasks/a%252Fb', { headers });
  assert.notEqual(odd.status, 401);
  assert.ok(odd.status < 500, `status ${odd.status}`);
  assert.ok(odd.headers.get('ratelimit') || odd.headers.get('ratelimit-policy'), 'rate limit headers present');
});

test('deliberately public routes still answer without a session', async () => {
  assert.equal((await app.request('/health')).status, 200);
  const hasWorkspace = await app.request('/api/auth/has-workspace');
  assert.notEqual(hasWorkspace.status, 401);
  for (const [method, path] of [
    ['GET', '/api/invites/preview/not-a-token'],
    ['GET', '/api/ics/feed/not-a-token'],
    ['POST', '/api/agent-webhooks/no-such-hook'],
  ] as const) {
    const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    const body = await res.text();
    assert.ok(res.status < 500, `${method} ${path} -> ${res.status}`);
    assert.doesNotMatch(body, /NO_TOKEN|INVALID_TOKEN/, `${method} ${path}`);
  }
});


test('refusals before routing carry the CORS and security headers', async () => {
  const origin = 'http://localhost:3000';
  const res = await app.request('/api/tasks/t1', { headers: { origin } });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('access-control-allow-origin'), origin);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const bad = await app.request('/api/tasks/%0A', { headers: { origin } });
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get('access-control-allow-origin'), origin);
  const preflight = await app.request('/api/tasks/t1', { method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'PATCH' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  const badPreflight = await app.request('/api/tasks/%0A', { method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'GET' } });
  assert.equal(badPreflight.status, 400);
  assert.equal(badPreflight.headers.get('access-control-allow-origin'), origin);
  const owner = await app.request('/api/app-local-jobs/connections/c1/schedule', { method: 'POST', body: '{' });
  assert.equal(owner.status, 401);
  const head = await app.fetch(new Request('http://localhost/api/tasks/t1', { method: 'HEAD' }));
  assert.equal(head.status, 401);
  assert.equal(await head.text(), '');
});

test('the exported fetch refuses a reused request after its session is revoked', async () => {
  const { createWebSession } = await import('../src/lib/web-sessions.js');
  const pair = await createWebSession({ id: USER_ID, email: USER_EMAIL, org_id: ORG_ID });
  const sid = JSON.parse(Buffer.from(pair.accessToken.split('.')[1]!, 'base64url').toString()).sid;
  const request = new Request('http://localhost/api/inbox?count_only=1', { headers: { authorization: `Bearer ${pair.accessToken}` } });
  assert.equal((await app.fetch(request)).status, 200);
  await withClient((c) => c.query('UPDATE web_sessions SET revoked_at = now() WHERE id = $1', [sid]));
  assert.equal((await app.fetch(request)).status, 401);
  assert.equal((await app.fetch(new Request('http://localhost/api/inbox'))).status, 401);
});

const WEB_SESSION_ROUTERS = ['/api/apps/private-defty/', '/api/app-resource-sync-management/', '/api/private-resources/',
  '/api/app-resource-private/', '/api/app-resource-access/', '/api/app-private-mcp/', '/api/app-connection-sessions/',
  '/api/app-connection-forms/', '/api/app-local-jobs/', '/api/app-data/', '/api/app-integration-tools/', '/api/app-resource-observations/'];

function templateSegments(path: string): string[] {
  return path.replace(/\{[^}]*\}/g, '').split('/').slice(1);
}

function templatesIntersect(a: string, b: string): boolean {
  const x = templateSegments(a);
  const y = templateSegments(b);
  for (let i = 0; ; i++) {
    const s = x[i];
    const t = y[i];
    if ((s === '*' && i === x.length - 1) || (t === '*' && i === y.length - 1)) return true;
    if (s === undefined || t === undefined) return s === t;
    if (s.startsWith(':') || t.startsWith(':')) continue;
    if (s !== t) return false;
  }
}

test('session-exempt routes are exactly the routes mounted ahead of the session middleware', () => {
  const routes = app.routes;
  const authIndex = routes.findIndex((r) => r.handler === authMiddleware);
  assert.ok(authIndex > 0, 'session middleware is registered');
  const sample = (path: string) => path.replace(/:[^/{]+(\{[^}]*\})?\??/g, 'x').replace(/\*/g, 'x');
  const sameMethod = (methods: readonly string[] | undefined, method: string) =>
    !methods || methods.includes(method) || (method === 'GET' && methods.includes('HEAD'));
  const mismatches: string[] = [];
  const apiRoute = (path: string) => path === '/api' || path.startsWith('/api/');
  routes.forEach((r, index) => {
    if (r.method === 'ALL' || !apiRoute(r.path)) return;
    // Owner routes mounted early that verify the same web session themselves;
    // their /runtime/ routes take Runtime or operator credentials and must stay exempt.
    const sessionRequired = !r.path.includes('/runtime/') && WEB_SESSION_ROUTERS.some((prefix) => r.path.startsWith(prefix));
    if (index < authIndex && !sessionRequired && !isPublicApiRequest(r.method, sample(r.path))) {
      mismatches.push(`pre-session route not exempt: ${r.method} ${r.path}`);
    }
    if (index > authIndex) {
      for (const exempt of exemptRoutes) {
        if (sameMethod(exempt.methods, r.method) && templatesIntersect(exempt.path, r.path)) {
          mismatches.push(`session route overlaps exemption ${exempt.path}: ${r.method} ${r.path}`);
        }
      }
    }
  });
  assert.deepEqual(mismatches, []);
  assert.equal(routes.some((r) => r.method === 'OPTIONS'), false, 'no route answers OPTIONS itself');
});
