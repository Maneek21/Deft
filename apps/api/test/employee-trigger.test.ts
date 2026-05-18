/**
 * Phase 9 — employee-trigger worker tests.
 *
 * Run: pnpm --filter @deft/api test -- employee-trigger
 *
 * Phase 9 collapsed every employee to BYOA. The trigger handler no
 * longer pushes a turn at the runtime; it queues an `agent_actions`
 * row with `action='trigger_dispatch'` so the BYOA client picks up
 * the work via `poll_pending_work`.
 *
 * Covers:
 *   1. Trigger dispatch queues an `agent_actions` row tagged with
 *      `source='trigger'` and `action='trigger_dispatch'`.
 *   2. `trigger_kind`, goal, context, and target_space_id are persisted
 *      verbatim into the params payload.
 *   3. Employees over the daily action budget are skipped.
 *   4. Inactive / missing employees are no-ops.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const TEST_USER_ID = 'test-phase9-trigger-user';
const EMP_ID = 'test-phase9-trigger-emp';
const EMP_SLUG = 'phase9-trigger-emp';
const BUDGET_EMP_ID = 'test-phase9-trigger-budget-emp';
const BUDGET_EMP_SLUG = 'phase9-trigger-budget-emp';

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
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, 'phase9-trigger@test.local', 'Phase9 Trigger Test User'],
    );

    const sp = await c.query(
      `SELECT id FROM spaces WHERE org_id = $1 AND is_archived = false
       ORDER BY created_at ASC LIMIT 1`,
      [ORG_ID],
    );
    if (sp.rows.length > 0) {
      TEST_SPACE_ID = sp.rows[0].id;
    } else {
      const r = await c.query(
        `INSERT INTO spaces (id, org_id, name, type, created_by)
         VALUES (gen_random_uuid()::text, $1, 'phase9-trigger-test-space', 'public', $2)
         RETURNING id`,
        [ORG_ID, TEST_USER_ID],
      );
      TEST_SPACE_ID = r.rows[0].id;
    }

    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         is_byoa, is_active, max_daily_actions, daily_action_count, created_by)
       VALUES ($1, $2, $3, $4, $5, 'project_manager', 'test', 'standard',
         true, true, 50, 0, $3)
       ON CONFLICT (id) DO UPDATE SET
         is_active = true,
         daily_action_count = 0,
         max_daily_actions = 50`,
      [EMP_ID, ORG_ID, TEST_USER_ID, 'Phase9 Trigger Employee', EMP_SLUG],
    );

    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         is_byoa, is_active, max_daily_actions, daily_action_count, created_by)
       VALUES ($1, $2, $3, $4, $5, 'project_manager', 'test', 'standard',
         true, true, 5, 5, $3)
       ON CONFLICT (id) DO UPDATE SET
         is_active = true,
         daily_action_count = 5,
         max_daily_actions = 5`,
      [BUDGET_EMP_ID, ORG_ID, TEST_USER_ID, 'Phase9 Trigger Budget Employee', BUDGET_EMP_SLUG],
    );
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    const empIds = [EMP_ID, BUDGET_EMP_ID];
    await c.query(
      `DELETE FROM action_receipts
       WHERE employee_id = ANY($1::text[])
          OR action_id IN (SELECT id FROM agent_actions WHERE user_id = $2)`,
      [empIds, TEST_USER_ID],
    );
    await c.query(
      `DELETE FROM agent_actions WHERE user_id = $1`,
      [TEST_USER_ID],
    );
    await c.query(`DELETE FROM messages WHERE user_id = $1`, [TEST_USER_ID]);
    await c.query(
      `DELETE FROM agent_employees WHERE id = ANY($1::text[])`,
      [empIds],
    );
    await c.query(`DELETE FROM users WHERE id = $1`, [TEST_USER_ID]);
  });
}

before(async () => {
  await seedFixtures();
});

after(async () => {
  await teardownFixtures();
  // Force-exit: db pool keeps the test runner alive after all assertions.
  setTimeout(() => process.exit(0), 100).unref();
});

// ─────────────────────────────────────────────────────────────────────────────

test('1. trigger queues agent_actions row tagged source=trigger action=trigger_dispatch', async () => {
  const { handleEmployeeTrigger } = await import(
    '../src/workers/handlers/employee-trigger.js'
  );

  await handleEmployeeTrigger({
    id: 'test-job-1',
    name: 'employee-trigger',
    data: {
      employee_id: EMP_ID,
      trigger_kind: 'cron:standup',
      context: { when: 'test' },
      goal: 'generate a test standup reply',
      target_space_id: TEST_SPACE_ID!,
    },
  } as any);

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT source, action, approval_tier, approval_status, params
         FROM agent_actions
        WHERE agent_employee_id = $1 AND action = 'trigger_dispatch'
        ORDER BY created_at DESC LIMIT 1`,
      [EMP_ID],
    );
    assert.ok(r.rows.length >= 1, 'trigger_dispatch action row must exist');
    assert.equal(r.rows[0].source, 'trigger');
    assert.equal(r.rows[0].action, 'trigger_dispatch');
    assert.equal(r.rows[0].approval_tier, 'auto');
    assert.equal(r.rows[0].approval_status, 'pending');
    assert.equal(r.rows[0].params.trigger_kind, 'cron:standup');
    assert.equal(r.rows[0].params.goal, 'generate a test standup reply');
    assert.equal(r.rows[0].params.target_space_id, TEST_SPACE_ID);
    assert.deepEqual(r.rows[0].params.trigger_payload, { when: 'test' });
  });
});

test('2. distinct trigger_kind values are persisted verbatim per invocation', async () => {
  const { handleEmployeeTrigger } = await import(
    '../src/workers/handlers/employee-trigger.js'
  );
  await handleEmployeeTrigger({
    id: 'test-job-2',
    name: 'employee-trigger',
    data: {
      employee_id: EMP_ID,
      trigger_kind: 'webhook:pr-merged',
      context: { pr_url: 'https://example.com/pr/42' },
      goal: 'acknowledge the merged PR',
      target_space_id: TEST_SPACE_ID!,
    },
  } as any);

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT params FROM agent_actions
        WHERE agent_employee_id = $1 AND params->>'trigger_kind' = 'webhook:pr-merged'
        ORDER BY created_at DESC LIMIT 1`,
      [EMP_ID],
    );
    assert.ok(r.rows.length >= 1, 'webhook trigger row must exist');
    assert.equal(r.rows[0].params.trigger_kind, 'webhook:pr-merged');
    assert.equal(r.rows[0].params.trigger_payload.pr_url, 'https://example.com/pr/42');
  });
});

test('3. employees at the daily action cap are skipped (no row queued)', async () => {
  const { handleEmployeeTrigger } = await import(
    '../src/workers/handlers/employee-trigger.js'
  );

  // Snapshot row count before.
  const before = await withClient(async (c) => {
    const r = await c.query(
      `SELECT count(*)::int AS n FROM agent_actions WHERE agent_employee_id = $1`,
      [BUDGET_EMP_ID],
    );
    return r.rows[0].n as number;
  });

  await handleEmployeeTrigger({
    id: 'test-job-3',
    name: 'employee-trigger',
    data: {
      employee_id: BUDGET_EMP_ID,
      trigger_kind: 'cron:standup',
      context: {},
      goal: 'should be skipped',
      target_space_id: TEST_SPACE_ID!,
    },
  } as any);

  const after = await withClient(async (c) => {
    const r = await c.query(
      `SELECT count(*)::int AS n FROM agent_actions WHERE agent_employee_id = $1`,
      [BUDGET_EMP_ID],
    );
    return r.rows[0].n as number;
  });
  assert.equal(after, before, 'budget-exhausted employee must not get a new row');
});

test('4. unknown employee id is a clean no-op', async () => {
  const { handleEmployeeTrigger } = await import(
    '../src/workers/handlers/employee-trigger.js'
  );
  // No throw — handler logs and returns.
  await handleEmployeeTrigger({
    id: 'test-job-4',
    name: 'employee-trigger',
    data: {
      employee_id: 'employee-that-does-not-exist-zzz',
      trigger_kind: 'cron:standup',
      context: {},
      goal: 'noop',
    },
  } as any);
  // Nothing else to assert — absence of throw is the contract.
  assert.ok(true);
});
