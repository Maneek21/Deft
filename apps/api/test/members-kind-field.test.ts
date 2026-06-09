/**
 * Verifies /api/members returns the `kind` field on each member.
 * Phase 1 of agent-chat unification.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/members-kind-field.test.ts
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { db } from '../src/lib/db.js';
import { users, orgs, orgMembers, agentEmployees } from '@deft/db/schema';
import { eq, inArray } from 'drizzle-orm';

let testOrgId: string;
let humanUserId: string;
let agentUserId: string;
let staleAgentUserId: string;
let requesterUserId: string;
let requesterEmail: string;
let testApp: Hono | null = null;

before(async () => {
  const ts = Date.now();
  const orgSlug = `mk-test-${ts}`;

  const [org] = await db.insert(orgs).values({
    name: 'Members Kind Test',
    slug: orgSlug,
  }).returning();
  testOrgId = org!.id;

  requesterEmail = `mk-requester-${ts}@test.local`;
  const [requester] = await db.insert(users).values({
    email: requesterEmail,
    name: 'Test Requester',
    kind: 'human',
    is_agent: false,
    email_verified: true,
  }).returning();
  requesterUserId = requester!.id;

  const [human] = await db.insert(users).values({
    email: `mk-human-${ts}@test.local`,
    name: 'Test Human',
    kind: 'human',
    is_agent: false,
    email_verified: true,
  }).returning();
  humanUserId = human!.id;

  const [agentUser] = await db.insert(users).values({
    name: 'Test Agent (Members Kind)',
    kind: 'agent',
    is_agent: true,
    email_verified: true,
  }).returning();
  agentUserId = agentUser!.id;

  const [staleAgentUser] = await db.insert(users).values({
    name: 'Deleted Agent Shadow (Members Kind)',
    kind: 'agent',
    is_agent: false,
    email_verified: true,
  }).returning();
  staleAgentUserId = staleAgentUser!.id;

  await db.insert(orgMembers).values([
    { org_id: testOrgId, user_id: requesterUserId, role: 'owner' },
    { org_id: testOrgId, user_id: humanUserId, role: 'member' },
    { org_id: testOrgId, user_id: agentUserId, role: 'member' },
    { org_id: testOrgId, user_id: staleAgentUserId, role: 'member' },
  ]);

  await db.insert(agentEmployees).values({
    org_id: testOrgId,
    user_id: agentUserId,
    slug: `members-kind-agent-${ts}`,
    name: 'Test Agent (Members Kind)',
    system_prompt: 'test',
    is_byoa: true,
    trust_level: 'standard',
    role: 'custom',
    created_by: requesterUserId,
  });

  // Mount memberRoutes into a bare Hono with a c.var.user shim.
  // The shim sets c.var.user = { id, email, org_id } so org filtering
  // works without real JWT auth — mirrors agent-actions-routes.test.ts.
  const { memberRoutes } = await import('../src/routes/members.js');
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    c.set('user', {
      id: requesterUserId,
      email: requesterEmail,
      org_id: testOrgId,
    } as any);
    await next();
  });
  testApp.route('/api/members', memberRoutes);
});

after(async () => {
  try {
    await db.delete(agentEmployees).where(eq(agentEmployees.org_id, testOrgId));
    await db.delete(orgMembers).where(eq(orgMembers.org_id, testOrgId));
    await db.delete(users).where(
      inArray(users.id, [requesterUserId, humanUserId, agentUserId, staleAgentUserId]),
    );
    await db.delete(orgs).where(eq(orgs.id, testOrgId));
  } catch (err) {
    console.error('cleanup error', err);
  }
});

function app(): Hono {
  if (!testApp) throw new Error('test app not initialized');
  return testApp;
}

// ─────────────────────────────────────────────────────────────────────────────

test('GET /api/members returns kind=human for human members', async () => {
  const res = await app().request('/api/members', { method: 'GET' });
  assert.equal(res.status, 200);
  const members = await res.json();
  assert.ok(Array.isArray(members), 'expected array response');

  const human = members.find((m: any) => m.id === humanUserId);
  assert.ok(human, `human member ${humanUserId} should be in list`);
  assert.equal(human.kind, 'human', `human member should have kind='human', got ${human.kind}`);
});

test('GET /api/members returns kind=agent for agent members', async () => {
  const res = await app().request('/api/members', { method: 'GET' });
  assert.equal(res.status, 200);
  const members = await res.json();
  assert.ok(Array.isArray(members), 'expected array response');

  const agent = members.find((m: any) => m.id === agentUserId);
  assert.ok(agent, `agent member ${agentUserId} should be in list`);
  assert.equal(agent.kind, 'agent', `agent member should have kind='agent', got ${agent.kind}`);
});

test('GET /api/members hides deleted agent shadow users without an active employee', async () => {
  const res = await app().request('/api/members', { method: 'GET' });
  assert.equal(res.status, 200);
  const members = await res.json();
  assert.ok(Array.isArray(members), 'expected array response');

  const stale = members.find((m: any) => m.id === staleAgentUserId);
  assert.equal(stale, undefined, 'deleted agent shadow user should not be in member list');
});

test('GET /api/members/:id returns kind field for human member', async () => {
  const res = await app().request(`/api/members/${humanUserId}`, { method: 'GET' });
  assert.equal(res.status, 200);
  const member = await res.json();
  assert.equal(member.id, humanUserId);
  assert.equal(member.kind, 'human', `single member endpoint should return kind='human', got ${member.kind}`);
});

test('GET /api/members/:id returns kind field for agent member', async () => {
  const res = await app().request(`/api/members/${agentUserId}`, { method: 'GET' });
  assert.equal(res.status, 200);
  const member = await res.json();
  assert.equal(member.id, agentUserId);
  assert.equal(member.kind, 'agent', `single member endpoint should return kind='agent', got ${member.kind}`);
});

test('GET /api/members/:id returns 404 for deleted agent shadow user', async () => {
  const res = await app().request(`/api/members/${staleAgentUserId}`, { method: 'GET' });
  assert.equal(res.status, 404);
});
