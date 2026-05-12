/**
 * Phase 6.5 — HTTP route tests for approve / reject / pending endpoints.
 *
 * Run: pnpm --filter @deft/api test -- agent-actions-routes
 *
 * These tests exercise the Hono routes via app.request() so the route
 * handlers, JSON parsing, and error codes are all covered end-to-end. We
 * skip the real JWT middleware by mounting agentRoutes into a bare Hono
 * instance with a small shim that sets c.var.user, matching what the
 * production authMiddleware would do on a valid token.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const EMP_ID = 'test-actions-routes-emp';
const EMP_SLUG = 'actions-routes-emp';
const SHADOW_USER_ID = 'test-actions-routes-shadow';
const APPROVER_USER_ID = 'test-actions-routes-approver';
const APPROVER_EMAIL = 'actions-routes-approver@test.local';

let TEST_PROJECT_ID: string | null = null;
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
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, 'actions-routes-shadow@test.local', 'Actions Shadow', true)
       ON CONFLICT (id) DO NOTHING`,
      [SHADOW_USER_ID],
    );

    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Actions Approver', false)
       ON CONFLICT (id) DO NOTHING`,
      [APPROVER_USER_ID, APPROVER_EMAIL],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, APPROVER_USER_ID],
    );

    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, 'Actions Route Employee', $4,
         'project_manager', 'test', 'standard',
         true, true, $3)
       ON CONFLICT (id) DO UPDATE SET is_active = true, trust_level = 'standard'`,
      [EMP_ID, ORG_ID, SHADOW_USER_ID, EMP_SLUG],
    );

    const proj = await c.query(
      `SELECT id FROM projects WHERE org_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [ORG_ID],
    );
    if (proj.rows.length > 0) {
      TEST_PROJECT_ID = proj.rows[0].id;
    } else {
      const r = await c.query(
        `INSERT INTO projects (org_id, name, prefix, lead_id, task_counter)
         VALUES ($1, 'Actions Routes Test Project', 'ART', $2, 0)
         RETURNING id`,
        [ORG_ID, SHADOW_USER_ID],
      );
      TEST_PROJECT_ID = r.rows[0].id;
    }
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    // Phase 7 — receipts FK to agent_actions + agent_employees, so delete
    // them first so the subsequent cascade doesn't bounce off the FK.
    await c.query(
      `DELETE FROM action_receipts
       WHERE action_id IN (SELECT id FROM agent_actions WHERE user_id = $1)
          OR employee_id = $2`,
      [SHADOW_USER_ID, EMP_ID],
    );
    await c.query(
      `DELETE FROM agent_actions WHERE user_id = $1`,
      [SHADOW_USER_ID],
    );
    if (TEST_PROJECT_ID) {
      await c.query(
        `DELETE FROM tasks WHERE project_id = $1 AND created_by = $2`,
        [TEST_PROJECT_ID, SHADOW_USER_ID],
      );
    }
    await c.query(
      `DELETE FROM org_members WHERE user_id = $1`,
      [APPROVER_USER_ID],
    );
    await c.query(
      `DELETE FROM agent_employees WHERE id = $1`,
      [EMP_ID],
    );
    await c.query(
      `DELETE FROM users WHERE id IN ($1, $2)`,
      [SHADOW_USER_ID, APPROVER_USER_ID],
    );
  });
}

async function insertPendingTaskCreate(title: string): Promise<string> {
  return withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO agent_actions
        (id, org_id, user_id, agent_employee_id, source, action, params,
         approval_tier, approval_status)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'mcp', 'task_create', $4::jsonb, 'quick', 'pending')
       RETURNING id`,
      [
        ORG_ID,
        SHADOW_USER_ID,
        EMP_ID,
        JSON.stringify({
          caller_employee_slug: EMP_SLUG,
          title,
          project_id: TEST_PROJECT_ID,
          priority: 'p2',
        }),
      ],
    );
    return r.rows[0].id as string;
  });
}

before(async () => {
  await seedFixtures();

  // Build a test Hono app that sets the authenticated user context before
  // mounting agentRoutes. This sidesteps the JWT middleware so we don't
  // need to mint tokens in the test.
  const { agentRoutes } = await import('../src/routes/agent.js');
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    c.set('user', {
      id: APPROVER_USER_ID,
      email: APPROVER_EMAIL,
      org_id: ORG_ID,
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

test('GET /api/agent/actions/pending returns MCP-queued actions', async () => {
  const title = `routes-pending-${Date.now()}`;
  await insertPendingTaskCreate(title);

  const res = await app().request('/api/agent/actions/pending', { method: 'GET' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.actions), 'expected { actions: [...] }');

  const match = body.actions.find(
    (a: any) => a.action === 'task_create' && a.params?.title === title,
  );
  assert.ok(match, 'seeded pending action should appear in list');
  assert.equal(match.proposer, 'employee');
  assert.equal(match.employee_slug, EMP_SLUG);
});

test('POST /api/agent/actions/:id/approve executes the write', async () => {
  const title = `routes-approve-${Date.now()}`;
  const actionId = await insertPendingTaskCreate(title);

  const res = await app().request(`/api/agent/actions/${actionId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'approved', `body: ${JSON.stringify(body)}`);

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT approval_status, executed_at FROM agent_actions WHERE id = $1`,
      [actionId],
    );
    assert.equal(r.rows[0].approval_status, 'approved');
    assert.ok(r.rows[0].executed_at);

    const t = await c.query(`SELECT title FROM tasks WHERE title = $1`, [title]);
    assert.equal(t.rows.length, 1);
  });
});

test('POST /api/agent/actions/:id/reject with reason records reason', async () => {
  const title = `routes-reject-${Date.now()}`;
  const actionId = await insertPendingTaskCreate(title);

  const res = await app().request(`/api/agent/actions/${actionId}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'looks unsafe' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'rejected');

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT approval_status, error FROM agent_actions WHERE id = $1`,
      [actionId],
    );
    assert.equal(r.rows[0].approval_status, 'rejected');
    assert.equal(r.rows[0].error, 'looks unsafe');
    const t = await c.query(`SELECT id FROM tasks WHERE title = $1`, [title]);
    assert.equal(t.rows.length, 0, 'reject must not create a task');
  });
});

test('POST approve on unknown action returns 404', async () => {
  const res = await app().request(
    '/api/agent/actions/ghost-action-id/approve',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
  // The existing agent.ts handler filters by org_id first so unknown ids
  // return 404 from the outer check, not the resolver.
  assert.equal(res.status, 404);
});

test('double approve is idempotent via HTTP', async () => {
  const title = `routes-double-${Date.now()}`;
  const actionId = await insertPendingTaskCreate(title);

  const first = await app().request(
    `/api/agent/actions/${actionId}/approve`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
  assert.equal(first.status, 200);

  const second = await app().request(
    `/api/agent/actions/${actionId}/approve`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
  assert.equal(second.status, 200, 'second approve should be idempotent 200');
  const body = await second.json();
  assert.equal(body.status, 'approved');

  await withClient(async (c) => {
    const t = await c.query(
      `SELECT COUNT(*)::int AS n FROM tasks WHERE title = $1`,
      [title],
    );
    assert.equal(t.rows[0].n, 1, 'no double task insert');
  });
});
