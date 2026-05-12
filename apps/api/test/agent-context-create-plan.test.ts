/**
 * Task 0.5 — create_plan tool handler integration test.
 *
 * Run: pnpm --filter @deft/api test -- agent-context-create-plan
 *
 * Covers:
 *   1. executeToolCall('create_plan', ...) returns { plan_id, status: 'draft' }
 *   2. A row exists in agent_plans with the correct title, status, and steps
 *   3. Missing required fields (title / steps) return an error without inserting
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

// Use the existing dev org and user so FK constraints are satisfied.
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
// A shadow user we'll insert/delete ourselves.
const USER_ID = 'test-create-plan-user';
const USER_EMAIL = 'create-plan-test@test.local';

// IDs of plan rows created during the tests — cleaned up in `after`.
const createdPlanIds: string[] = [];

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

before(async () => {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Create Plan Test User', false)
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID, USER_EMAIL],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, USER_ID],
    );
  });
});

after(async () => {
  await withClient(async (c) => {
    if (createdPlanIds.length > 0) {
      await c.query(
        `DELETE FROM agent_plans WHERE id = ANY($1::text[])`,
        [createdPlanIds],
      );
    }
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [USER_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

test('1. create_plan returns plan_id and status draft', async () => {
  const { executeToolCall } = await import('../src/lib/agent-context.js');

  const title = `test-plan-${Date.now()}`;
  const steps = [
    { id: 'step1', description: 'Do thing A', tool: 'search_tasks', params: { query: 'foo' } },
    { id: 'step2', description: 'Do thing B', tool: 'get_task_detail', params: { task_id: '$step.step1.result.id' }, depends_on: ['step1'] },
  ];

  const { result } = await executeToolCall(
    'create_plan',
    { title, steps },
    ORG_ID,
    USER_ID,
  );

  assert.ok(result.plan_id, 'result.plan_id should be present');
  assert.equal(result.status, 'draft', 'status should be draft');

  createdPlanIds.push(result.plan_id);

  // Verify the row in the database
  await withClient(async (c) => {
    const r = await c.query(
      `SELECT title, status, steps, current_step, context FROM agent_plans WHERE id = $1`,
      [result.plan_id],
    );
    assert.equal(r.rows.length, 1, 'plan row should exist in DB');
    assert.equal(r.rows[0].title, title);
    assert.equal(r.rows[0].status, 'draft');
    assert.equal(r.rows[0].current_step, 0);
    const dbSteps = r.rows[0].steps as any[];
    assert.equal(dbSteps.length, 2);
    assert.equal(dbSteps[0]!.id, 'step1');
    assert.equal(dbSteps[0]!.status, 'pending');
  });
});

test('2. create_plan with description and optional fields stores them', async () => {
  const { executeToolCall } = await import('../src/lib/agent-context.js');

  const title = `test-plan-optional-${Date.now()}`;
  const description = 'A plan that does complex things';
  const steps = [
    { id: 's1', description: 'First step', tool: 'search_messages', params: { query: 'hello' } },
  ];

  const { result } = await executeToolCall(
    'create_plan',
    { title, description, steps },
    ORG_ID,
    USER_ID,
  );

  assert.ok(result.plan_id, 'result.plan_id should be present');
  assert.equal(result.status, 'draft');

  createdPlanIds.push(result.plan_id);

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT description FROM agent_plans WHERE id = $1`,
      [result.plan_id],
    );
    assert.equal(r.rows[0].description, description);
  });
});

test('3. create_plan with missing title returns error without inserting', async () => {
  const { executeToolCall } = await import('../src/lib/agent-context.js');

  const steps = [
    { id: 's1', description: 'Step', tool: 'search_tasks', params: {} },
  ];

  const { result } = await executeToolCall(
    'create_plan',
    { steps },  // no title
    ORG_ID,
    USER_ID,
  );

  assert.ok(result.error, 'should return an error when title is missing');
  assert.ok(!result.plan_id, 'should not return a plan_id on error');
});

test('4. create_plan with missing steps returns error without inserting', async () => {
  const { executeToolCall } = await import('../src/lib/agent-context.js');

  const { result } = await executeToolCall(
    'create_plan',
    { title: 'No steps plan' },  // no steps
    ORG_ID,
    USER_ID,
  );

  assert.ok(result.error, 'should return an error when steps is missing');
  assert.ok(!result.plan_id, 'should not return a plan_id on error');
});
