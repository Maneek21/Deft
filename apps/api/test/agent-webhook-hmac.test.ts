/**
 * Fix #7 — webhook HMAC-SHA256 auth.
 *
 * Run: cd apps/api && pnpm exec tsx --env-file=../../.env --test test/agent-webhook-hmac.test.ts
 *
 * Exercises the dual-auth window:
 *  - Create webhook returns BOTH legacy `secret` and new `hmac_key`.
 *  - Dispatch with valid HMAC signature → 200 (auth_method=hmac).
 *  - Dispatch with INVALID signature → 401.
 *  - Dispatch with TAMPERED body (signed for original) → 401.
 *  - Dispatch with legacy raw secret still works (auth_method=legacy +
 *    deprecation warning logged).
 *  - Dispatch with neither header → 401.
 *  - Pre-existing webhook (NULL hmac_key_encrypted) still authenticates
 *    via legacy header.
 */
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
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
  c.set('user', { id: testUserId, org_id: testOrgId, email: 'hmac-t@t.local' });
  await next();
});
authedApp.route('/api/agent-webhooks', agentWebhookRoutes);

const publicApp = new Hono();
publicApp.route('/api/agent-webhooks', publicAgentWebhookRoutes);

before(async () => {
  const existingOrg = await db.query.orgs.findFirst();
  testOrgId = existingOrg?.id ?? crypto.randomUUID();
  if (!existingOrg) await db.insert(orgs).values({ id: testOrgId, name: 'hmac', slug: 'hmac' });

  const existingUser = await db.query.users.findFirst();
  testUserId = existingUser?.id ?? crypto.randomUUID();
  if (!existingUser) await db.insert(users).values({ id: testUserId, email: `hmac-${Date.now()}@t.local`, name: 'hmac' });

  const mem = await db.query.orgMembers.findFirst({
    where: (m, { and, eq }) => and(eq(m.user_id, testUserId), eq(m.org_id, testOrgId)),
  });
  if (!mem) {
    await db.insert(orgMembers).values({ id: crypto.randomUUID(), org_id: testOrgId, user_id: testUserId, role: 'admin' });
  }

  testEmployeeId = crypto.randomUUID();
  await db.insert(agentEmployees).values({
    id: testEmployeeId, org_id: testOrgId, user_id: testUserId,
    slug: `hmac-emp-${Date.now()}`, name: 'HMAC Agent', system_prompt: 'test',
    is_byoa: true, trust_level: 'standard',
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

async function createHook(label = 'hmac-test') {
  const res = await authedApp.request('/api/agent-webhooks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent_employee_id: testEmployeeId, label }),
  });
  const body = await res.json() as any;
  return { res, body };
}

function sign(body: string, key: string): string {
  return `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;
}

test('create webhook returns hmac_key alongside legacy secret', async () => {
  const { res, body } = await createHook();
  assert.equal(res.status, 201);
  assert.ok(body.secret && body.secret.length > 20, 'legacy secret returned');
  assert.ok(body.hmac_key && body.hmac_key.length > 20, 'hmac_key returned');
  assert.ok(body.auth_instructions, 'auth_instructions present');
  assert.match(body.auth_instructions, /HMAC-SHA256/);
});

test('dispatch with valid HMAC signature → 200 + auth_method=hmac', async () => {
  const { body } = await createHook();
  const slug = body.webhook.slug;
  const payload = JSON.stringify({ event: 'order.created', order_id: 'ord_456' });
  const res = await publicApp.request(`/api/agent-webhooks/${slug}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-deft-webhook-signature': sign(payload, body.hmac_key),
    },
    body: payload,
  });
  const out = await res.json() as any;
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.accepted, true);
  assert.equal(out.auth_method, 'hmac');
});

test('dispatch with HMAC accepts a bare hex signature (no sha256= prefix)', async () => {
  const { body } = await createHook();
  const slug = body.webhook.slug;
  const payload = JSON.stringify({ ok: true });
  const sigPrefixed = sign(payload, body.hmac_key);
  const sigBare = sigPrefixed.slice(7);
  const res = await publicApp.request(`/api/agent-webhooks/${slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-deft-webhook-signature': sigBare },
    body: payload,
  });
  assert.equal(res.status, 200);
});

test('dispatch with invalid HMAC signature → 401', async () => {
  const { body } = await createHook();
  const slug = body.webhook.slug;
  const payload = JSON.stringify({ x: 1 });
  const res = await publicApp.request(`/api/agent-webhooks/${slug}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-deft-webhook-signature': 'sha256=deadbeef',
    },
    body: payload,
  });
  assert.equal(res.status, 401);
});

test('tampered body → signature mismatch → 401', async () => {
  const { body } = await createHook();
  const slug = body.webhook.slug;
  const original = JSON.stringify({ amount: 100 });
  const tampered = JSON.stringify({ amount: 9999 });
  const sig = sign(original, body.hmac_key);
  const res = await publicApp.request(`/api/agent-webhooks/${slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-deft-webhook-signature': sig },
    body: tampered,
  });
  assert.equal(res.status, 401, 'signature for original must NOT validate tampered body');
});

test('legacy x-deft-webhook-secret still works during transition', async () => {
  const { body } = await createHook();
  const slug = body.webhook.slug;
  const original = console.warn;
  let warned = '';
  console.warn = (msg: any) => { warned += String(msg); };
  try {
    const res = await publicApp.request(`/api/agent-webhooks/${slug}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-deft-webhook-secret': body.secret },
      body: JSON.stringify({ legacy: true }),
    });
    const out = await res.json() as any;
    assert.equal(res.status, 200);
    assert.equal(out.auth_method, 'legacy');
    assert.match(warned, /DEPRECATED auth/, 'deprecation warning logged');
  } finally {
    console.warn = original;
  }
});

test('no auth header at all → 401', async () => {
  const { body } = await createHook();
  const res = await publicApp.request(`/api/agent-webhooks/${body.webhook.slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x: 1 }),
  });
  assert.equal(res.status, 401);
});

test('pre-existing webhook (NULL hmac_key_encrypted) authenticates via legacy', async () => {
  // Simulate a row that pre-dates migration 0060 by clearing the encrypted key.
  const { body } = await createHook();
  await db
    .update(agentWebhooks)
    .set({ hmac_key_encrypted: null })
    .where(eq(agentWebhooks.id, body.webhook.id));

  const res = await publicApp.request(`/api/agent-webhooks/${body.webhook.slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-deft-webhook-secret': body.secret },
    body: JSON.stringify({ legacy_only: true }),
  });
  const out = await res.json() as any;
  assert.equal(res.status, 200);
  assert.equal(out.auth_method, 'legacy');
});

test('HMAC header on a pre-existing webhook (NULL hmac_key) falls through to legacy', async () => {
  // If an attacker sends a forged HMAC header on a row that never had a
  // key, we must NOT accept it — the HMAC branch should skip and the
  // request should fail (no legacy secret either).
  const { body } = await createHook();
  await db
    .update(agentWebhooks)
    .set({ hmac_key_encrypted: null })
    .where(eq(agentWebhooks.id, body.webhook.id));

  const res = await publicApp.request(`/api/agent-webhooks/${body.webhook.slug}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-deft-webhook-signature': 'sha256=deadbeef',
    },
    body: JSON.stringify({ x: 1 }),
  });
  assert.equal(res.status, 401);
});
