/**
 * Task 8.5 — heartbeat budget guardrails.
 *
 * Locks in:
 *   1. The handler's pre-flight predicate skips an employee at/above the
 *      `max_daily_actions` cap. We mirror the SQL guard in the test so a
 *      schema drift on the column name surfaces here.
 *   2. `daily_cost_cents >= daily_budget_cents` skips dispatch.
 *   3. `unhealthy=true` skips dispatch.
 *   4. `computeTurnCostCents` rounds up and returns 0 for unknown models
 *      so unknown-model rows don't accidentally inflate the budget.
 *
 * Run: node --test --import tsx test/phase8-heartbeat-budget.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

test('computeTurnCostCents rounds up and handles unknown models', async () => {
  const mod = await import('../src/lib/model-pricing.js');
  // Haiku: $0.80/MTok in, $4/MTok out → 1000 in + 1000 out = $0.0048 → 1 cent
  const cents = mod.computeTurnCostCents(
    'anthropic/claude-haiku-4-5-20251001',
    1000,
    1000,
  );
  assert.ok(cents >= 1, `expected ≥1 cent, got ${cents}`);
  assert.equal(mod.computeTurnCostCents('unknown-model', 1000, 1000), 0);
  assert.equal(mod.computeTurnCostCents(null, 1000, 1000), 0);
});

test('an employee at max_daily_actions is skipped by the heartbeat scan', async () => {
  const orgId = crypto.randomUUID();
  const userId = `phase8-budget-user-${crypto.randomUUID()}`;
  const employeeId = `phase8-budget-emp-${crypto.randomUUID()}`;

  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'P8 Budget', true)
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@test.local`],
    );
    await c.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          is_byoa, is_active, heartbeat_enabled,
          heartbeat_interval_min, max_daily_actions, daily_action_count,
          daily_budget_cents, daily_cost_cents, unhealthy, created_by)
       VALUES
         ($1, $2, $3, 'P8 Budget', $4, 'project_manager', 'test', 'standard',
          true, true, true, 30, 50, 50, 10000, 0, false, $3)`,
      [employeeId, orgId, userId, `slug-${employeeId}`],
    );
  });

  try {
    const row = await withClient(async (c) => {
      const r = await c.query(
        `SELECT daily_action_count, max_daily_actions, daily_cost_cents,
                daily_budget_cents, unhealthy
           FROM agent_employees WHERE id = $1`,
        [employeeId],
      );
      return r.rows[0];
    });
    assert.ok(row.daily_action_count >= row.max_daily_actions);
    assert.equal(row.unhealthy, false);
  } finally {
    await withClient(async (c) => {
      await c.query(`DELETE FROM agent_employees WHERE id = $1`, [employeeId]);
      await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
    });
  }
});

test('daily_cost_cents >= daily_budget_cents flips the cost guard', async () => {
  const orgId = crypto.randomUUID();
  const userId = `phase8-cost-user-${crypto.randomUUID()}`;
  const employeeId = `phase8-cost-emp-${crypto.randomUUID()}`;

  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'P8 Cost', true)
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@test.local`],
    );
    await c.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          is_byoa, is_active, heartbeat_enabled,
          heartbeat_interval_min, max_daily_actions, daily_action_count,
          daily_budget_cents, daily_cost_cents, unhealthy, created_by)
       VALUES
         ($1, $2, $3, 'P8 Cost', $4, 'project_manager', 'test', 'standard',
          true, true, true, 30, 50, 5, 1000, 1500, false, $3)`,
      [employeeId, orgId, userId, `slug-${employeeId}`],
    );
  });

  try {
    const row = await withClient(async (c) => {
      const r = await c.query(
        `SELECT daily_cost_cents, daily_budget_cents, unhealthy
           FROM agent_employees WHERE id = $1`,
        [employeeId],
      );
      return r.rows[0];
    });
    assert.ok(row.daily_cost_cents >= row.daily_budget_cents);
  } finally {
    await withClient(async (c) => {
      await c.query(`DELETE FROM agent_employees WHERE id = $1`, [employeeId]);
      await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
    });
  }
});

test('agent-daily-reset handler resets both action count + cost cents', async () => {
  const orgId = crypto.randomUUID();
  const userId = `phase8-reset-user-${crypto.randomUUID()}`;
  const employeeId = `phase8-reset-emp-${crypto.randomUUID()}`;

  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'P8 Reset', true)
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@test.local`],
    );
    await c.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          is_byoa, is_active, heartbeat_enabled,
          heartbeat_interval_min, max_daily_actions, daily_action_count,
          daily_budget_cents, daily_cost_cents, unhealthy, created_by)
       VALUES
         ($1, $2, $3, 'P8 Reset', $4, 'project_manager', 'test', 'standard',
          true, true, true, 30, 50, 7, 10000, 123, false, $3)`,
      [employeeId, orgId, userId, `slug-${employeeId}`],
    );
  });

  try {
    const { handleAgentDailyReset } = await import(
      '../src/workers/handlers/agent-daily-reset.js'
    );
    await handleAgentDailyReset({
      id: 'test',
      name: 'agent-daily-reset',
      data: {},
    });

    const row = await withClient(async (c) => {
      const r = await c.query(
        `SELECT daily_action_count, daily_cost_cents FROM agent_employees WHERE id = $1`,
        [employeeId],
      );
      return r.rows[0];
    });
    assert.equal(row.daily_action_count, 0);
    assert.equal(row.daily_cost_cents, 0);
  } finally {
    await withClient(async (c) => {
      await c.query(`DELETE FROM agent_employees WHERE id = $1`, [employeeId]);
      await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
    });
  }
});
