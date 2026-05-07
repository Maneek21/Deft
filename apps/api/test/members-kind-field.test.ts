/**
 * Verifies /api/members returns the `kind` field on each member.
 * Phase 1 of agent-chat unification.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/members-kind-field.test.ts
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const HUMAN_USER_ID = `test-member-human-${Date.now()}`;
const HUMAN_EMAIL = `human-mk-${Date.now()}@test.local`;
const AGENT_USER_ID = `test-member-agent-${Date.now()}`;
const REQUESTER_USER_ID = `test-member-requester-${Date.now()}`;
const REQUESTER_EMAIL = `requester-mk-${Date.now()}@test.local`;

let testApp: Hono | null = null;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function seedFixtures() {
  await withClient(async (c) => {
    // Create a human user
    await c.query(
      `INSERT INTO users (id, email, name, kind, is_agent, email_verified)
       VALUES ($1, $2, 'Test Human Member', 'human', false, true)
       ON CONFLICT (id) DO NOTHING`,
      [HUMAN_USER_ID, HUMAN_EMAIL],
    );

    // Create an agent user
    await c.query(
      `INSERT INTO users (id, name, kind, is_agent, email_verified)
       VALUES ($1, 'Test Agent Member', 'agent', true, true)
       ON CONFLICT (id) DO NOTHING`,
      [AGENT_USER_ID],
    );

    // Create requester user (to make the API calls)
    await c.query(
      `INSERT INTO users (id, email, name, kind, is_agent, email_verified)
       VALUES ($1, $2, 'Test Requester', 'human', false, true)
       ON CONFLICT (id) DO NOTHING`,
      [REQUESTER_USER_ID, REQUESTER_EMAIL],
    );

    // Add all users to the org
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'owner', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, REQUESTER_USER_ID],
    );

    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, HUMAN_USER_ID],
    );

    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, AGENT_USER_ID],
    );
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    await c.query(
      `DELETE FROM org_members WHERE org_id = $1 AND user_id IN ($2, $3, $4)`,
      [ORG_ID, HUMAN_USER_ID, AGENT_USER_ID, REQUESTER_USER_ID],
    );
    await c.query(
      `DELETE FROM users WHERE id IN ($1, $2, $3)`,
      [HUMAN_USER_ID, AGENT_USER_ID, REQUESTER_USER_ID],
    );
  });
}

before(async () => {
  await seedFixtures();

  // Build a test Hono app that sets the authenticated user context before
  // mounting memberRoutes. This sidesteps the JWT middleware so we don't
  // need to mint tokens in the test.
  const { memberRoutes } = await import('../src/routes/members.js');
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    c.set('user', {
      id: REQUESTER_USER_ID,
      email: REQUESTER_EMAIL,
      org_id: ORG_ID,
    } as any);
    await next();
  });
  testApp.route('/api/members', memberRoutes);
});

after(async () => {
  await teardownFixtures();
});

function app(): Hono {
  if (!testApp) throw new Error('test app not initialized');
  return testApp;
}

// ─────────────────────────────────────────────────────────────────────────────

test('GET /api/members returns kind field for human members', async () => {
  const res = await app().request('/api/members', { method: 'GET' });
  assert.equal(res.status, 200);
  const members = await res.json();
  assert.ok(Array.isArray(members), 'expected array response');

  const humanMember = members.find((m: any) => m.id === HUMAN_USER_ID);
  assert.ok(humanMember, `human member ${HUMAN_USER_ID} should be in list`);
  assert.equal(
    humanMember.kind,
    'human',
    `human member should have kind='human', got ${humanMember.kind}`,
  );
});

test('GET /api/members returns kind=agent for agent members', async () => {
  const res = await app().request('/api/members', { method: 'GET' });
  assert.equal(res.status, 200);
  const members = await res.json();
  assert.ok(Array.isArray(members), 'expected array response');

  const agentMember = members.find((m: any) => m.id === AGENT_USER_ID);
  assert.ok(agentMember, `agent member ${AGENT_USER_ID} should be in list`);
  assert.equal(
    agentMember.kind,
    'agent',
    `agent member should have kind='agent', got ${agentMember.kind}`,
  );
});

test('GET /api/members/:id returns kind field for human member', async () => {
  const res = await app().request(`/api/members/${HUMAN_USER_ID}`, {
    method: 'GET',
  });
  assert.equal(res.status, 200);
  const member = await res.json();

  assert.equal(member.id, HUMAN_USER_ID);
  assert.equal(
    member.kind,
    'human',
    `single member endpoint should return kind='human', got ${member.kind}`,
  );
});

test('GET /api/members/:id returns kind field for agent member', async () => {
  const res = await app().request(`/api/members/${AGENT_USER_ID}`, {
    method: 'GET',
  });
  assert.equal(res.status, 200);
  const member = await res.json();

  assert.equal(member.id, AGENT_USER_ID);
  assert.equal(
    member.kind,
    'agent',
    `single member endpoint should return kind='agent', got ${member.kind}`,
  );
});
