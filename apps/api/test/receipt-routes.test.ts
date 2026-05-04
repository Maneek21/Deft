/**
 * Phase 7 — HTTP route tests for GET /api/agent/actions/:id/receipt.
 *
 * Run: pnpm --filter @deft/api test -- receipt-routes
 *
 * Covers:
 *   1. 200 with verified=true for a valid receipt
 *   2. 404 for an action with no receipt
 *   3. 403 for a user not in the action's org
 *   4. verified=false when params_json is tampered
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const OTHER_ORG_ID = '00000000-0000-0000-0000-000000000aaa';

const EMP_ID = 'test-receipt-routes-emp';
const EMP_SLUG = 'receipt-routes-emp';
const SHADOW_USER_ID = 'test-receipt-routes-shadow';
const MEMBER_USER_ID = 'test-receipt-routes-member';
const MEMBER_EMAIL = 'receipt-routes-member@test.local';
const OUTSIDER_USER_ID = 'test-receipt-routes-outsider';
const OUTSIDER_EMAIL = 'receipt-routes-outsider@test.local';

let testApp: Hono | null = null;
let currentUserId = MEMBER_USER_ID;

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
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, 'receipt-routes-shadow@test.local', 'Receipt Shadow', true)
       ON CONFLICT (id) DO NOTHING`,
      [SHADOW_USER_ID],
    );
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Receipt Member', false)
       ON CONFLICT (id) DO NOTHING`,
      [MEMBER_USER_ID, MEMBER_EMAIL],
    );
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Receipt Outsider', false)
       ON CONFLICT (id) DO NOTHING`,
      [OUTSIDER_USER_ID, OUTSIDER_EMAIL],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, MEMBER_USER_ID],
    );

    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, 'Receipt Route Emp', $4,
         'project_manager', 'test', 'standard',
         true, true, $3)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
      [EMP_ID, ORG_ID, SHADOW_USER_ID, EMP_SLUG],
    );
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    await c.query(
      `DELETE FROM action_receipts WHERE employee_id = $1`,
      [EMP_ID],
    );
    await c.query(
      `DELETE FROM agent_actions WHERE user_id = $1`,
      [SHADOW_USER_ID],
    );
    await c.query(
      `DELETE FROM org_members WHERE user_id IN ($1, $2)`,
      [MEMBER_USER_ID, OUTSIDER_USER_ID],
    );
    await c.query(
      `DELETE FROM agent_employees WHERE id = $1`,
      [EMP_ID],
    );
    await c.query(
      `DELETE FROM users WHERE id IN ($1, $2, $3)`,
      [SHADOW_USER_ID, MEMBER_USER_ID, OUTSIDER_USER_ID],
    );
  });
}

async function insertApprovedAction(action: string, params: unknown): Promise<string> {
  return withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO agent_actions
        (id, org_id, user_id, agent_employee_id, source, action, params,
         approval_tier, approval_status, approved_at, executed_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'mcp', $4, $5::jsonb,
         'quick', 'approved', now(), now())
       RETURNING id`,
      [ORG_ID, SHADOW_USER_ID, EMP_ID, action, JSON.stringify(params)],
    );
    return r.rows[0].id as string;
  });
}

before(async () => {
  await seedFixtures();

  const { agentRoutes } = await import('../src/routes/agent.js');
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    const uid = currentUserId;
    const email = uid === MEMBER_USER_ID ? MEMBER_EMAIL : OUTSIDER_EMAIL;
    const orgId = uid === MEMBER_USER_ID ? ORG_ID : OTHER_ORG_ID;
    c.set('user', {
      id: uid,
      email,
      org_id: orgId,
    } as any);
    await next();
  });
  testApp.route('/api/agent', agentRoutes);
});

after(async () => {
  await teardownFixtures();
});

function app(): Hono {
  if (!testApp) throw new Error('test app not initialized');
  return testApp;
}

// ─────────────────────────────────────────────────────────────────────────────

test('1. GET receipt returns 200 with verified=true for a valid receipt', async () => {
  currentUserId = MEMBER_USER_ID;
  const actionId = await insertApprovedAction('task_create', {
    caller_employee_slug: EMP_SLUG,
    title: 'receipt routes test 1',
  });

  const { generateReceipt } = await import('../src/lib/receipts.js');
  const receipt = await generateReceipt({
    actionId,
    orgId: ORG_ID,
    employeeId: EMP_ID,
    proposer: 'employee',
    decision: 'auto_executed',
    actionName: 'task_create',
    actionParams: { caller_employee_slug: EMP_SLUG, title: 'receipt routes test 1' },
    resultJson: { id: 'task-1' },
  });
  assert.ok(receipt, 'receipt generation should have succeeded');

  const res = await app().request(`/api/agent/actions/${actionId}/receipt`, {
    method: 'GET',
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.ok(body.receipt, 'response should contain a receipt');
  assert.equal(body.receipt.action_id, actionId);
  assert.equal(body.verified, true, 'valid signature should verify');
  assert.equal(body.receipt.action_name, 'task_create');
});

test('2. GET receipt returns 404 for an action with no receipt', async () => {
  currentUserId = MEMBER_USER_ID;
  const actionId = await insertApprovedAction('task_update', {
    caller_employee_slug: EMP_SLUG,
    task_id: 'nope',
    patch: { status: 'done' },
  });
  // No receipt inserted.
  const res = await app().request(`/api/agent/actions/${actionId}/receipt`, {
    method: 'GET',
  });
  assert.equal(res.status, 404);
});

test('3. GET receipt returns 403 for a user not in the action org', async () => {
  currentUserId = MEMBER_USER_ID;
  const actionId = await insertApprovedAction('task_create', {
    caller_employee_slug: EMP_SLUG,
    title: 'cross-org test',
  });
  const { generateReceipt } = await import('../src/lib/receipts.js');
  await generateReceipt({
    actionId,
    orgId: ORG_ID,
    employeeId: EMP_ID,
    proposer: 'employee',
    decision: 'auto_executed',
    actionName: 'task_create',
    actionParams: { caller_employee_slug: EMP_SLUG, title: 'cross-org test' },
  });

  // Flip the current user to an outsider whose user.org_id is OTHER_ORG_ID.
  currentUserId = OUTSIDER_USER_ID;
  const res = await app().request(`/api/agent/actions/${actionId}/receipt`, {
    method: 'GET',
  });
  assert.equal(res.status, 403, `expected 403, got ${res.status}`);
});

test('4. GET receipt returns verified=false when params_json is tampered', async () => {
  currentUserId = MEMBER_USER_ID;
  const actionId = await insertApprovedAction('message_post', {
    caller_employee_slug: EMP_SLUG,
    space_id: 'sp-1',
    content: 'original',
  });
  const { generateReceipt } = await import('../src/lib/receipts.js');
  const receipt = await generateReceipt({
    actionId,
    orgId: ORG_ID,
    employeeId: EMP_ID,
    proposer: 'employee',
    decision: 'auto_executed',
    actionName: 'message_post',
    actionParams: { caller_employee_slug: EMP_SLUG, space_id: 'sp-1', content: 'original' },
  });
  assert.ok(receipt);

  // Tamper the params_json in place.
  await withClient(async (c) => {
    await c.query(
      `UPDATE action_receipts SET action_params_json = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ space_id: 'sp-1', content: 'TAMPERED' }), receipt!.id],
    );
  });

  const res = await app().request(`/api/agent/actions/${actionId}/receipt`, {
    method: 'GET',
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.verified, false, 'tampered receipt must report verified=false');
});
