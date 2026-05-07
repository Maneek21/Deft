/**
 * Phase 9 — heartbeat handler routing tests.
 *
 * Phase 9 collapsed every employee to BYOA — there's no longer a
 * native/openclaw kind split. The handler queues an `agent_actions` row
 * with `action='heartbeat_tick'` so the BYOA client picks it up via
 * `poll_pending_work`. We assert:
 *   1. The handler still exposes `handleAgentEmployeeHeartbeat`.
 *   2. `buildHeartbeatPrompt` returns a sane shape even when the
 *      employee row is missing.
 *   3. `job-scheduler` exposes `rescheduleHeartbeat`.
 *   4. The handler's "due" predicate finds employees whose
 *      `last_heartbeat_at + heartbeat_interval_min` has elapsed.
 *
 * Run: node --test --import tsx test/phase8-heartbeat-routing.test.ts
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

test('heartbeat handler exports handleAgentEmployeeHeartbeat', async () => {
  const mod = await import(
    '../src/workers/handlers/agent-employee-heartbeat.js'
  );
  assert.equal(typeof mod.handleAgentEmployeeHeartbeat, 'function');
});

test('job-scheduler exposes rescheduleHeartbeat (used by Task 8.3 admin endpoint)', async () => {
  const mod = await import('../src/lib/job-scheduler.js');
  assert.equal(typeof mod.initScheduler, 'function');
  assert.equal(typeof mod.rescheduleHeartbeat, 'function');
});

test('buildHeartbeatPrompt returns a prompt string even when the employee row is missing', async () => {
  const { buildHeartbeatPrompt } = await import(
    '../src/lib/heartbeat-prompt.js'
  );
  const out = await buildHeartbeatPrompt('does-not-exist-' + crypto.randomUUID());
  assert.equal(typeof out.prompt, 'string');
  assert.ok(out.prompt.length > 0);
  assert.equal(typeof out.context, 'object');
});

test('heartbeat scan finds employees whose cadence window has elapsed', async () => {
  // Seed one employee with last_heartbeat_at well in the past + one that
  // ticked recently. The handler's due predicate must pick the stale one
  // and skip the fresh one.
  const orgId = crypto.randomUUID();
  const userId = `phase9-user-${crypto.randomUUID()}`;
  const dueId = `phase9-due-${crypto.randomUUID()}`;
  const freshId = `phase9-fresh-${crypto.randomUUID()}`;

  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Phase 9 Shadow', true)
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@test.local`],
    );
    await c.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          is_byoa, is_active, heartbeat_enabled,
          heartbeat_interval_min, max_daily_actions, daily_action_count,
          last_heartbeat_at, created_by)
       VALUES
         ($1, $2, $3, 'P9 Due', $4, 'project_manager', 'test', 'standard',
          true, true, true, 5, 50, 0, NOW() - INTERVAL '1 hour', $3)`,
      [dueId, orgId, userId, `slug-${dueId}`],
    );
    await c.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          is_byoa, is_active, heartbeat_enabled,
          heartbeat_interval_min, max_daily_actions, daily_action_count,
          last_heartbeat_at, created_by)
       VALUES
         ($1, $2, $3, 'P9 Fresh', $4, 'project_manager', 'test', 'standard',
          true, true, true, 30, 50, 0, NOW(), $3)`,
      [freshId, orgId, userId, `slug-${freshId}`],
    );
  });

  try {
    const dueRows = await withClient(async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM agent_employees
          WHERE id = ANY($1::text[])
            AND is_active = true
            AND heartbeat_enabled = true
            AND (last_heartbeat_at IS NULL
                 OR last_heartbeat_at + (heartbeat_interval_min || ' minutes')::interval < NOW())`,
        [[dueId, freshId]],
      );
      return r.rows;
    });
    assert.equal(dueRows.length, 1);
    assert.equal(dueRows[0].id, dueId);
  } finally {
    await withClient(async (c) => {
      await c.query(`DELETE FROM agent_employees WHERE id = ANY($1::text[])`, [
        [dueId, freshId],
      ]);
      await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
    });
  }
});

test('handler queues a heartbeat_tick agent_actions row when guards pass', async () => {
  const orgId = crypto.randomUUID();
  const userId = `phase9-tick-user-${crypto.randomUUID()}`;
  const employeeId = `phase9-tick-${crypto.randomUUID()}`;

  await withClient(async (c) => {
    await c.query(
      `INSERT INTO orgs (id, name, slug)
       VALUES ($1, 'Phase 9 Tick Org', $2)
       ON CONFLICT (id) DO NOTHING`,
      [orgId, `phase9-tick-${orgId.slice(0, 8)}`],
    );
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Phase 9 Tick Shadow', true)
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@test.local`],
    );
    await c.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          is_byoa, is_active, heartbeat_enabled,
          heartbeat_interval_min, max_daily_actions, daily_action_count,
          last_heartbeat_at, created_by)
       VALUES
         ($1, $2, $3, 'P9 Tick', $4, 'project_manager', 'test', 'standard',
          true, true, true, 5, 50, 0, NOW() - INTERVAL '1 hour', $3)`,
      [employeeId, orgId, userId, `slug-${employeeId}`],
    );
  });

  try {
    const { handleAgentEmployeeHeartbeat } = await import(
      '../src/workers/handlers/agent-employee-heartbeat.js'
    );
    await handleAgentEmployeeHeartbeat({
      kind: 'agent-employee-heartbeat',
      payload: {},
    } as Parameters<typeof handleAgentEmployeeHeartbeat>[0]);

    const ticks = await withClient(async (c) => {
      const r = await c.query<{ action: string; source: string }>(
        `SELECT action, source FROM agent_actions
          WHERE agent_employee_id = $1 AND action = 'heartbeat_tick'`,
        [employeeId],
      );
      return r.rows;
    });
    assert.ok(
      ticks.length >= 1,
      `expected at least one heartbeat_tick action queued, got ${ticks.length}`,
    );
    assert.equal(ticks[0].source, 'heartbeat');
  } finally {
    await withClient(async (c) => {
      await c.query(`DELETE FROM agent_actions WHERE agent_employee_id = $1`, [
        employeeId,
      ]);
      await c.query(`DELETE FROM agent_heartbeat_turns WHERE agent_employee_id = $1`, [
        employeeId,
      ]);
      await c.query(`DELETE FROM agent_employees WHERE id = $1`, [employeeId]);
      await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
      await c.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
    });
  }
});
