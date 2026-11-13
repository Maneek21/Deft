import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import { db, apiKeys, orgs, users } from '@deft/db';
import { apiKeyRoutes } from '../src/routes/api-keys.js';
import { mcpConnectionRoutes } from '../src/routes/mcp-connections.js';
import { uploadRoutes } from '../src/routes/upload.js';
import { localFileStore } from '../src/lib/file-store.js';
import { githubWebhookRoutes } from '../src/routes/webhooks/github.js';

type TestUser = { id: string; org_id: string; email: string; role: string } | null;

// Mount only the method handlers of a router, leaving out its `use('*')`
// middleware, so each handler's own checks are what is exercised.
function handlersOnly(router: Hono, base: string, user: TestUser) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (user) c.set('user', user as never);
    await next();
  });
  for (const route of router.routes) {
    if (route.method === 'ALL') continue;
    const path = route.path === '/' ? base : `${base}${route.path}`;
    app.on(route.method, path, route.handler);
  }
  return app;
}

const API_KEY_CALLS: Array<[string, string]> = [
  ['GET', '/api/api-keys'],
  ['POST', '/api/api-keys'],
  ['PUT', '/api/api-keys/key-1'],
  ['DELETE', '/api/api-keys/key-1'],
];

const MCP_CALLS: Array<[string, string]> = [
  ['GET', '/api/mcp-connections'],
  ['GET', '/api/mcp-connections/conn-1'],
  ['POST', '/api/mcp-connections'],
  ['PUT', '/api/mcp-connections/conn-1'],
  ['DELETE', '/api/mcp-connections/conn-1'],
  ['POST', '/api/mcp-connections/conn-1/test'],
  ['POST', '/api/mcp-connections/conn-1/refresh-tools'],
  ['PUT', '/api/mcp-connections/conn-1/tools/read_contact'],
];

const orgA = crypto.randomUUID();
const orgB = crypto.randomUUID();
const userA = crypto.randomUUID();
const userB = crypto.randomUUID();

before(async () => {
  await db.insert(orgs).values([
    { id: orgA, name: 'lane-f-a', slug: `lane-f-a-${orgA.slice(0, 8)}` },
    { id: orgB, name: 'lane-f-b', slug: `lane-f-b-${orgB.slice(0, 8)}` },
  ]);
  await db.insert(users).values({ id: userA, email: `lane-f-${userA}@t.local`, name: 'lane-f-a' });
});

after(async () => {
  await db.delete(apiKeys).where(inArray(apiKeys.org_id, [orgA, orgB]));
  await db.delete(users).where(eq(users.id, userA));
  await db.delete(orgs).where(inArray(orgs.id, [orgA, orgB]));
});

for (const [label, router, base, calls] of [
  ['API key', apiKeyRoutes, '/api/api-keys', API_KEY_CALLS],
  ['MCP connection', mcpConnectionRoutes, '/api/mcp-connections', MCP_CALLS],
] as const) {
  test(`${label} handlers refuse members and guests on their own`, async () => {
    for (const role of ['member', 'guest']) {
      const app = handlersOnly(router, base, { id: userA, org_id: orgA, email: 'm@t.local', role });
      for (const [method, path] of calls) {
        const res = await app.request(path, {
          method,
          headers: { 'content-type': 'application/json' },
          body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({ name: 'x', permissions: ['read'] }),
        });
        assert.equal(res.status, 403, `${role} ${method} ${path}`);
        assert.deepEqual(await res.json(), { error: 'Owner or admin role required', code: 'FORBIDDEN' });
      }
    }
  });

  test(`${label} handlers refuse a request with no user`, async () => {
    const app = handlersOnly(router, base, null);
    for (const [method, path] of calls) {
      const res = await app.request(path, { method });
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(((await res.json()) as { code: string }).code, 'NO_TOKEN');
    }
  });

  test(`${label} handlers still serve owners and admins`, async () => {
    for (const role of ['owner', 'admin']) {
      const app = handlersOnly(router, base, { id: userA, org_id: orgA, email: 'o@t.local', role });
      const res = await app.request(base);
      assert.equal(res.status, 200, role);
      assert.ok(Array.isArray(await res.json()));
    }
  });
}

test('an admin of another org cannot see or delete an API key', async () => {
  const [key] = await db.insert(apiKeys).values({
    org_id: orgA, name: 'org-a-key', key_hash: 'x', key_prefix: 'deft_test', permissions: ['read'], created_by: userA,
  }).returning();
  const otherAdmin = handlersOnly(apiKeyRoutes, '/api/api-keys', { id: userB, org_id: orgB, email: 'b@t.local', role: 'admin' });
  const list = (await (await otherAdmin.request('/api/api-keys')).json()) as Array<{ id: string }>;
  assert.equal(list.some((row) => row.id === key!.id), false);
  const del = await otherAdmin.request(`/api/api-keys/${key!.id}`, { method: 'DELETE' });
  assert.equal(del.status, 404);
  const [still] = await db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.id, key!.id));
  assert.ok(still);
});

test('the upload handler stores nothing when no user is set', async (t) => {
  let puts = 0;
  const original = localFileStore.put;
  localFileStore.put = async () => { puts += 1; };
  t.after(() => { localFileStore.put = original; });

  const app = new Hono();
  app.route('/api/upload', uploadRoutes);
  const form = new FormData();
  form.append('file', new File(['hello'], 'hello.txt', { type: 'text/plain' }));
  const res = await app.request('/api/upload', { method: 'POST', body: form });
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { code: string }).code, 'NO_TOKEN');
  assert.equal(puts, 0);
});

function signed(body: string, secret: string) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function webhookApp() {
  const app = new Hono();
  app.route('/api/webhooks', githubWebhookRoutes);
  return app;
}

const PING = JSON.stringify({ zen: 'ok' });

test('the GitHub webhook refuses every request when no signing secret is configured', async (t) => {
  const previous = process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.GITHUB_WEBHOOK_SECRET;
  t.after(() => { if (previous === undefined) delete process.env.GITHUB_WEBHOOK_SECRET; else process.env.GITHUB_WEBHOOK_SECRET = previous; });

  for (const headers of [
    { 'x-github-event': 'ping' },
    { 'x-github-event': 'ping', 'x-hub-signature-256': signed(PING, 'any-secret') },
  ]) {
    const res = await webhookApp().request('/api/webhooks/github', { method: 'POST', headers, body: PING });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'GitHub webhook is not configured', code: 'GITHUB_WEBHOOK_NOT_CONFIGURED' });
  }
});

test('the GitHub webhook accepts only a correct signature when a secret is configured', async (t) => {
  const previous = process.env.GITHUB_WEBHOOK_SECRET;
  process.env.GITHUB_WEBHOOK_SECRET = 'lane-f-secret';
  t.after(() => { if (previous === undefined) delete process.env.GITHUB_WEBHOOK_SECRET; else process.env.GITHUB_WEBHOOK_SECRET = previous; });

  const ok = await webhookApp().request('/api/webhooks/github', {
    method: 'POST', headers: { 'x-github-event': 'ping', 'x-hub-signature-256': signed(PING, 'lane-f-secret') }, body: PING,
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, skipped: 'event' });

  for (const headers of [
    { 'x-github-event': 'ping', 'x-hub-signature-256': signed(PING, 'wrong-secret') },
    { 'x-github-event': 'ping' },
  ]) {
    const res = await webhookApp().request('/api/webhooks/github', { method: 'POST', headers, body: PING });
    assert.equal(res.status, 401);
  }
});
