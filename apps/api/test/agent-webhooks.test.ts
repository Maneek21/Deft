/**
 * Block 3.3 — agent webhooks tests.
 *
 * Run: pnpm --filter @deft/api exec tsx --env-file=../../.env --test test/agent-webhooks.test.ts
 *
 * Exercises both surfaces:
 *  - Authenticated management: create → list → delete.
 *  - Public HMAC dispatch: secret verification, enqueue on valid fire,
 *    reject bad/missing secret, reject disabled/unknown.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, and, sql } from 'drizzle-orm';
import {
  db, agentWebhooks, agentEmployees, orgs, users, orgMembers,
} from '@deft/db';
import { agentWebhookRoutes, publicAgentWebhookRoutes } from '../src/routes/agent-webhooks.js';
import { Hono } from 'hono';

let testOrgId: string;
let testUserId: string;
let testEmployeeId: string;

const authedApp = new Hono();
authedApp.use('*', async (c, next) => {
  c.set('user', { id: testUserId, org_id: testOrgId, email: 't@t.local' });
  await next();
});
authedApp.route('/api/agent-webhooks', agentWebhookRoutes);

const publicApp = new Hono();
publicApp.route('/api/agent-webhooks', publicAgentWebhookRoutes);

before(async () => {
  const existingOrg = await db.query.orgs.findFirst();
  testOrgId = existingOrg?.id ?? crypto.randomUUID();
  if (!existingOrg) await db.insert(orgs).values({ id: testOrgId, name: 'b33', slug: 'b33' });

  const existingUser = await db.query.users.findFirst();
  testUserId = existingUser?.id ?? crypto.randomUUID();
  if (!existingUser) await db.insert(users).values({ id: testUserId, email: `b33-${Date.now()}@t.local`, name: 'b33' });

  const mem = await db.query.orgMembers.findFirst({
    where: (m, { and, eq }) => and(eq(m.user_id, testUserId), eq(m.org_id, testOrgId)),
  });
  if (!mem) {
    await db.insert(orgMembers).values({ id: crypto.randomUUID(), org_id: testOrgId, user_id: testUserId, role: 'admin' });
  }

  testEmployeeId = crypto.randomUUID();
  await db.insert(agentEmployees).values({
    id: testEmployeeId, org_id: testOrgId, user_id: testUserId,
    slug: `b33-emp-${Date.now()}`, name: 'B33 Agent', system_prompt: 'test',
    kind: 'native', trust_level: 'standard',
    created_by: testUserId, role: 'project_manager',
  });
});

afterEach(async () => {
  await db.delete(agentWebhooks).where(eq(agentWebhooks.agent_employee_id, testEmployeeId));
  await db.execute(sql`DELETE FROM job_queue WHERE queue='agent-jobs' AND name='employee-trigger' AND (data->>'trigger_kind')='webhook'`);
});

after(async () => {
  await db.delete(agentEmployees).where(eq(agentEmployees.id, testEmployeeId));
});

async function createHook(label = 'test-hook') {
  const res = await authedApp.request('/api/agent-webhooks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent_employee_id: testEmployeeId, label }),
  });
  const body = await res.json() as any;
  return { res, body };
}

// ─── Authenticated surface ─────────────────────────────────────────────
test('POST /api/agent-webhooks creates a webhook + returns secret once', async () => {
  const { res, body } = await createHook();
  assert.equal(res.status, 201);
  assert.ok(body.webhook.id);
  assert.ok(body.webhook.slug && body.webhook.slug.length > 10);
  assert.ok(body.secret && body.secret.length > 20, 'secret returned');
  assert.match(body.post_url, /^\/api\/agent-webhooks\//);
});

test('POST /api/agent-webhooks returns 404 for unknown employee', async () => {
  const res = await authedApp.request('/api/agent-webhooks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent_employee_id: crypto.randomUUID() }),
  });
  assert.equal(res.status, 404);
});

test('GET /api/agent-webhooks lists without exposing the secret', async () => {
  await createHook('alpha');
  await createHook('beta');

  const res = await authedApp.request(`/api/agent-webhooks?employee_id=${testEmployeeId}`);
  const body = await res.json() as any;
  assert.equal(res.status, 200);
  assert.equal(body.webhooks.length, 2);
  for (const w of body.webhooks) {
    assert.ok(w.slug);
    assert.equal((w as any).secret_hash, undefined, 'hash not returned');
    assert.equal((w as any).secret, undefined, 'secret not returned');
  }
});

test('DELETE /api/agent-webhooks/:id revokes', async () => {
  const { body } = await createHook();
  const id = body.webhook.id;
  const res = await authedApp.request(`/api/agent-webhooks/${id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const rows = await db.select().from(agentWebhooks).where(eq(agentWebhooks.id, id));
  assert.equal(rows.length, 0);
});

// ─── Public surface ────────────────────────────────────────────────────
test('POST /api/agent-webhooks/:slug with correct secret enqueues a trigger', async () => {
  const { body } = await createHook('webhook-fire');
  const slug = body.webhook.slug;
  const secret = body.secret;

  const res = await publicApp.request(`/api/agent-webhooks/${slug}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-deft-webhook-secret': secret,
    },
    body: JSON.stringify({ event: 'order.created', order_id: 'ord_123' }),
  });
  const outcome = await res.json() as any;
  assert.equal(res.status, 200, JSON.stringify(outcome));
  assert.equal(outcome.accepted, true);

  // Job enqueued with payload
  const jobs = await db.execute(sql`
    SELECT data FROM job_queue WHERE queue='agent-jobs' AND name='employee-trigger'
    ORDER BY created_at DESC LIMIT 1
  `);
  const records = (jobs as any).rows ?? (jobs as any);
  const d = typeof records[0].data === 'string' ? JSON.parse(records[0].data) : records[0].data;
  assert.equal(d.trigger_kind, 'webhook');
  assert.equal(d.employee_id, testEmployeeId);
  assert.equal(d.context.payload.order_id, 'ord_123');

  // fire_count incremented
  const [row] = await db.select().from(agentWebhooks).where(eq(agentWebhooks.slug, slug));
  assert.equal(row!.fire_count, 1);
  assert.ok(row!.last_fired_at);
});

test('POST /:slug with wrong secret → 401', async () => {
  const { body } = await createHook();
  const res = await publicApp.request(`/api/agent-webhooks/${body.webhook.slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-deft-webhook-secret': 'nope' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 401);
});

test('POST /:slug with no secret → 401', async () => {
  const { body } = await createHook();
  const res = await publicApp.request(`/api/agent-webhooks/${body.webhook.slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 401);
});

test('POST /:slug with unknown slug → 404', async () => {
  const res = await publicApp.request(`/api/agent-webhooks/nonexistent-slug-xyz`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-deft-webhook-secret': 'whatever' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 404);
});

test('POST /:slug bearer token also accepted', async () => {
  const { body } = await createHook();
  const res = await publicApp.request(`/api/agent-webhooks/${body.webhook.slug}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${body.secret}`,
    },
    body: JSON.stringify({ hello: 'world' }),
  });
  assert.equal(res.status, 200);
});
