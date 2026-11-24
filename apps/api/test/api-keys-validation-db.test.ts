import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, apiKeys, orgs, users } from '@deft/db';
import { apiKeyRoutes } from '../src/routes/api-keys.js';

// A malformed body to the API key routes is a 400 with the usual validation
// shape, never a 500 (SFX1 item 4).

const orgId = crypto.randomUUID();
const adminId = crypto.randomUUID();

// Only the method handlers: the router's `use('*')` reads org_members, and
// the handlers' own admin check reads the role set here.
function adminApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: adminId, org_id: orgId, email: 'admin@t.local', role: 'admin' } as never);
    await next();
  });
  for (const route of apiKeyRoutes.routes) {
    if (route.method === 'ALL') continue;
    app.on(route.method, route.path === '/' ? '/api/api-keys' : `/api/api-keys${route.path}`, route.handler);
  }
  return app;
}

before(async () => {
  await db.insert(orgs).values({ id: orgId, name: 'api-key-validation', slug: `api-key-validation-${orgId.slice(0, 8)}` });
  await db.insert(users).values({ id: adminId, email: `api-key-validation-${adminId}@t.local`, name: 'Key Admin' });
});

after(async () => {
  await db.delete(apiKeys).where(eq(apiKeys.org_id, orgId));
  await db.delete(users).where(eq(users.id, adminId));
  await db.delete(orgs).where(eq(orgs.id, orgId));
});

async function send(method: 'POST' | 'PUT', path: string, body: string) {
  return adminApp().request(path, { method, headers: { 'content-type': 'application/json' }, body });
}

const MALFORMED: Array<[string, string]> = [
  ['not JSON', '{"name": "half'],
  ['an empty body', ''],
  ['a JSON array', '[]'],
  ['a JSON string', '"key"'],
  ['no permissions', JSON.stringify({ name: 'k' })],
  ['an empty name', JSON.stringify({ name: '', permissions: ['read'] })],
  ['a non-string permission', JSON.stringify({ name: 'k', permissions: [1] })],
  ['a negative rate limit', JSON.stringify({ name: 'k', permissions: ['read'], rate_limit_per_minute: -1 })],
  ['an unreadable expiry date', JSON.stringify({ name: 'k', permissions: ['read'], expires_at: 'not a date' })],
];

test('POST /api/api-keys answers a malformed body with 400 VALIDATION_ERROR', async () => {
  for (const [label, body] of MALFORMED) {
    const res = await send('POST', '/api/api-keys', body);
    assert.equal(res.status, 400, label);
    const json = await res.json() as { error: string; code: string };
    assert.equal(json.error, 'Invalid input', label);
    assert.equal(json.code, 'VALIDATION_ERROR', label);
  }
  const stored = await db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.org_id, orgId));
  assert.equal(stored.length, 0, 'no key is stored for a refused body');
});

test('PUT /api/api-keys/:id answers a malformed body with 400 VALIDATION_ERROR', async () => {
  const [key] = await db.insert(apiKeys).values({
    org_id: orgId, name: 'existing', key_hash: 'x', key_prefix: 'deft_test', permissions: ['read'], created_by: adminId,
  }).returning();
  for (const [label, body] of [
    ['not JSON', '{"name":'],
    ['an empty body', ''],
    ['an empty name', JSON.stringify({ name: '' })],
    ['a non-boolean is_active', JSON.stringify({ is_active: 'yes' })],
    ['an unreadable expiry date', JSON.stringify({ expires_at: '2026-13-45T99:99' })],
  ] as const) {
    const res = await send('PUT', `/api/api-keys/${key!.id}`, body);
    assert.equal(res.status, 400, label);
    assert.equal((await res.json() as { code: string }).code, 'VALIDATION_ERROR', label);
  }
  const [unchanged] = await db.select({ name: apiKeys.name }).from(apiKeys).where(eq(apiKeys.id, key!.id));
  assert.equal(unchanged?.name, 'existing');
});

test('a well-formed body still creates and updates a key', async () => {
  const created = await send('POST', '/api/api-keys', JSON.stringify({
    name: 'valid', permissions: ['read'], expires_at: '2027-01-01T00:00:00.000Z',
  }));
  assert.equal(created.status, 201);
  const key = await created.json() as { id: string; raw_key: string; expires_at: string };
  assert.match(key.raw_key, /^deft_/);
  assert.equal(new Date(key.expires_at).toISOString(), '2027-01-01T00:00:00.000Z');

  const updated = await send('PUT', `/api/api-keys/${key.id}`, JSON.stringify({ name: 'renamed', expires_at: null }));
  assert.equal(updated.status, 200);
  const body = await updated.json() as { name: string; expires_at: string | null };
  assert.equal(body.name, 'renamed');
  assert.equal(body.expires_at, null);
});
