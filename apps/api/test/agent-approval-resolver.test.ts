/**
 * Phase 6.5 — agent-approval-resolver unit tests.
 *
 * Run: pnpm --filter @deft/api test -- agent-approval-resolver
 *
 * Covers:
 *   1. Approving a pending task_create action runs the executor and marks approved
 *   2. Approving an already-approved action is idempotent (no double-execute)
 *   3. Rejecting a pending action marks rejected without executing
 *   4. Approving by a user not in the org returns 403
 *   5. Approving a non-existent action returns 404
 *   6. Approve then reject returns "already approved" without changing state
 *   7. Inner function is called with the original ctx.trust_level (NOT elevated)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

// Fixture ids — all prefixed so cleanup is safe even across aborted runs.
const EMP_ID = 'test-resolver-emp';
const EMP_SLUG = 'resolver-emp';
const SHADOW_USER_ID = 'test-resolver-shadow-user';
const APPROVER_USER_ID = 'test-resolver-approver';
const APPROVER_EMAIL = 'resolver-approver@test.local';
const OTHER_ORG_ID = '00000000-0000-0000-0000-000000000999';
const OUTSIDER_USER_ID = 'test-resolver-outsider';
const OUTSIDER_EMAIL = 'resolver-outsider@test.local';

let TEST_PROJECT_ID: string | null = null;
let TEST_SPACE_ID: string | null = null;

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
    // Shadow user for the agent employee.
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (id) DO NOTHING`,
      [SHADOW_USER_ID, 'resolver-shadow@test.local', 'Resolver Shadow User'],
    );

    // Approver — real user, member of ORG_ID.
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Resolver Approver', false)
       ON CONFLICT (id) DO NOTHING`,
      [APPROVER_USER_ID, APPROVER_EMAIL],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, APPROVER_USER_ID],
    );

    // Outsider — exists but is NOT a member of ORG_ID (will be added to
    // a dummy "other org" if needed; for the permission check we just
    // need them absent from ORG_ID's org_members).
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Resolver Outsider', false)
       ON CONFLICT (id) DO NOTHING`,
      [OUTSIDER_USER_ID, OUTSIDER_EMAIL],
    );

    // Conservative-trust employee — important for test 7 (inner function
    // must be called with conservative trust despite approval).
    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, 'Resolver Test Employee', $4,
         'project_manager', 'test resolver employee', 'conservative',
         true, true, $3)
       ON CONFLICT (id) DO UPDATE SET
         trust_level = 'conservative',
         is_active = true`,
      [EMP_ID, ORG_ID, SHADOW_USER_ID, EMP_SLUG],
    );

    // Project for task_create dispatch.
    const proj = await c.query(
      `SELECT id FROM projects WHERE org_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [ORG_ID],
    );
    if (proj.rows.length > 0) {
      TEST_PROJECT_ID = proj.rows[0].id;
    } else {
      const r = await c.query(
        `INSERT INTO projects (org_id, name, prefix, lead_id, task_counter)
         VALUES ($1, 'Resolver Test Project', 'RSLV', $2, 0)
         RETURNING id`,
        [ORG_ID, SHADOW_USER_ID],
      );
      TEST_PROJECT_ID = r.rows[0].id;
    }

    // Space for message_post dispatch.
    const sp = await c.query(
      `SELECT id FROM spaces WHERE org_id = $1 AND is_archived = false
       ORDER BY created_at ASC LIMIT 1`,
      [ORG_ID],
    );
    if (sp.rows.length > 0) {
      TEST_SPACE_ID = sp.rows[0].id;
    }
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    // Phase 7 — clear receipts first to satisfy FK constraints.
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
      `DELETE FROM messages WHERE user_id = $1`,
      [SHADOW_USER_ID],
    );
    await c.query(
      `DELETE FROM org_members WHERE user_id IN ($1, $2, $3)`,
      [APPROVER_USER_ID, OUTSIDER_USER_ID, SHADOW_USER_ID],
    );
    await c.query(
      `DELETE FROM agent_employees WHERE id = $1`,
      [EMP_ID],
    );
    await c.query(
      `DELETE FROM users WHERE id IN ($1, $2, $3)`,
      [SHADOW_USER_ID, APPROVER_USER_ID, OUTSIDER_USER_ID],
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
});

after(async () => {
  await teardownFixtures();
});

// ─────────────────────────────────────────────────────────────────────────────

test('1. approving a pending task_create runs executor and marks approved', async () => {
  const title = `resolver-test-1-${Date.now()}`;
  const actionId = await insertPendingTaskCreate(title);

  const { approveAction } = await import('../src/lib/agent-approval-resolver.js');
  const result = await approveAction(actionId, APPROVER_USER_ID);

  assert.equal(result.status, 'approved', `expected approved: ${JSON.stringify(result)}`);
  // @ts-expect-error narrow
  assert.ok(result.result, 'result payload should be present');

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT approval_status, approved_at, executed_at, result, error
       FROM agent_actions WHERE id = $1`,
      [actionId],
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].approval_status, 'approved');
    assert.ok(r.rows[0].approved_at, 'approved_at should be set');
    assert.ok(r.rows[0].executed_at, 'executed_at should be set');
    assert.equal(r.rows[0].error, null);

    const t = await c.query(
      `SELECT title FROM tasks WHERE title = $1`,
      [title],
    );
    assert.equal(t.rows.length, 1, 'task row should have been created');
  });
});

test('2. approving an already-approved action is idempotent', async () => {
  const title = `resolver-test-2-${Date.now()}`;
  const actionId = await insertPendingTaskCreate(title);

  const { approveAction } = await import('../src/lib/agent-approval-resolver.js');

  const first = await approveAction(actionId, APPROVER_USER_ID);
  assert.equal(first.status, 'approved');

  // Count tasks with this title BEFORE the second call.
  const beforeCount = await withClient((c) =>
    c.query(`SELECT COUNT(*)::int AS n FROM tasks WHERE title = $1`, [title]),
  );
  assert.equal(beforeCount.rows[0].n, 1);

  const second = await approveAction(actionId, APPROVER_USER_ID);
  assert.equal(second.status, 'approved');
  assert.match(
    // @ts-expect-error narrow
    second.message ?? '',
    /already/i,
    'second approve should surface an already-approved message',
  );

  // No duplicate task rows — the inner executor must NOT have fired twice.
  const afterCount = await withClient((c) =>
    c.query(`SELECT COUNT(*)::int AS n FROM tasks WHERE title = $1`, [title]),
  );
  assert.equal(afterCount.rows[0].n, 1, 'idempotency: no double-execute');
});

test('3. rejecting a pending action marks rejected without executing', async () => {
  const title = `resolver-test-3-${Date.now()}`;
  const actionId = await insertPendingTaskCreate(title);

  const { rejectAction } = await import('../src/lib/agent-approval-resolver.js');
  const result = await rejectAction(actionId, APPROVER_USER_ID, 'not safe');
  assert.equal(result.status, 'rejected');

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT approval_status, error FROM agent_actions WHERE id = $1`,
      [actionId],
    );
    assert.equal(r.rows[0].approval_status, 'rejected');
    assert.equal(r.rows[0].error, 'not safe');
    const t = await c.query(
      `SELECT COUNT(*)::int AS n FROM tasks WHERE title = $1`,
      [title],
    );
    assert.equal(t.rows[0].n, 0, 'reject must not create a task row');
  });
});

test('4. approving by a user not in the org returns FORBIDDEN', async () => {
  const title = `resolver-test-4-${Date.now()}`;
  const actionId = await insertPendingTaskCreate(title);

  const { approveAction } = await import('../src/lib/agent-approval-resolver.js');
  const result = await approveAction(actionId, OUTSIDER_USER_ID);

  assert.equal(result.status, 'error');
  // @ts-expect-error narrow
  assert.equal(result.code, 'FORBIDDEN');

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT approval_status FROM agent_actions WHERE id = $1`,
      [actionId],
    );
    assert.equal(
      r.rows[0].approval_status,
      'pending',
      'row must stay pending when approver is not in the org',
    );
  });
});

test('5. approving a non-existent action returns NOT_FOUND', async () => {
  const { approveAction } = await import('../src/lib/agent-approval-resolver.js');
  const result = await approveAction(
    'ghost-action-that-does-not-exist',
    APPROVER_USER_ID,
  );
  assert.equal(result.status, 'error');
  // @ts-expect-error narrow
  assert.equal(result.code, 'NOT_FOUND');
});

test('6. approve-then-reject returns already-approved without changing state', async () => {
  const title = `resolver-test-6-${Date.now()}`;
  const actionId = await insertPendingTaskCreate(title);

  const { approveAction, rejectAction } = await import(
    '../src/lib/agent-approval-resolver.js'
  );
  const approved = await approveAction(actionId, APPROVER_USER_ID);
  assert.equal(approved.status, 'approved');

  const rejected = await rejectAction(
    actionId,
    APPROVER_USER_ID,
    'second thoughts',
  );
  assert.equal(rejected.status, 'approved', 'reject after approve returns approved');
  // @ts-expect-error narrow
  assert.match(rejected.message ?? '', /already approved/i);

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT approval_status FROM agent_actions WHERE id = $1`,
      [actionId],
    );
    assert.equal(r.rows[0].approval_status, 'approved');
  });
});

test('7. inner executor is called with the employee\'s original trust_level', async () => {
  // The conservative employee's write was queued because shouldAutoExecute
  // returned false. When the user approves it, the inner executor must NOT
  // re-gate on trust_level — if it did, approved writes from conservative
  // employees would bounce back to pending and nothing would ever execute.
  //
  // We exercise this by approving a pending task_create and confirming the
  // task row was actually inserted (i.e. the inner executor ran) despite
  // the employee still being at trust_level='conservative'.
  const title = `resolver-test-7-${Date.now()}`;
  const actionId = await insertPendingTaskCreate(title);

  await withClient(async (c) => {
    // Sanity: employee is still conservative.
    const r = await c.query(
      `SELECT trust_level FROM agent_employees WHERE id = $1`,
      [EMP_ID],
    );
    assert.equal(r.rows[0].trust_level, 'conservative');
  });

  const { approveAction } = await import('../src/lib/agent-approval-resolver.js');
  const result = await approveAction(actionId, APPROVER_USER_ID);
  assert.equal(result.status, 'approved');

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT id FROM tasks WHERE title = $1`,
      [title],
    );
    assert.equal(
      r.rows.length,
      1,
      'conservative employee approved write must still land — no re-gating',
    );
    // And the employee's trust_level remains conservative (not elevated).
    const emp = await c.query(
      `SELECT trust_level FROM agent_employees WHERE id = $1`,
      [EMP_ID],
    );
    assert.equal(emp.rows[0].trust_level, 'conservative');
  });
});
