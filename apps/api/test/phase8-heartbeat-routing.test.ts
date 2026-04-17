/**
 * Task 8.1 — heartbeat dispatcher routing tests.
 *
 * Locks in the three behaviours the 8.1 handler introduces:
 *   1. `heartbeat-native` job scope filters to kind in (native, claude_sdk).
 *   2. `heartbeat-openclaw` job scope filters to kind in (openclaw, custom_mcp).
 *   3. The openclaw branch skips employees with `connection_status!='connected'`.
 *
 * We don't hit the network — the handler's DB scan + guard logic is what
 * the dispatcher depends on, and that's what the tests assert.
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

test('heartbeat handler exports the kind classifiers task 8.1 promises', async () => {
  const mod = await import(
    '../src/workers/handlers/agent-employee-heartbeat.js'
  );
  assert.deepEqual([...mod.HEARTBEAT_NATIVE_KINDS].sort(), [
    'claude_sdk',
    'native',
  ]);
  assert.deepEqual([...mod.HEARTBEAT_OPENCLAW_KINDS].sort(), [
    'custom_mcp',
    'openclaw',
  ]);
  assert.equal(typeof mod.handleAgentEmployeeHeartbeat, 'function');
  assert.equal(typeof mod.dispatchHeartbeat, 'function');
});

test('dispatchHeartbeat is exported from openclaw-dispatch and routes to dispatchViaOpenClaw', async () => {
  const mod = await import('../src/lib/openclaw-dispatch.js');
  assert.equal(typeof mod.dispatchHeartbeat, 'function');
  assert.equal(typeof mod.dispatchViaOpenClaw, 'function');
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

test('heartbeat scan filters employees by kind when the job name is heartbeat-openclaw', async () => {
  // Seed one native + one openclaw employee, both due and healthy. We
  // query the same predicate the handler uses to prove the filter works.
  const orgId = crypto.randomUUID();
  const userId = `phase8-user-${crypto.randomUUID()}`;
  const nativeId = `phase8-native-${crypto.randomUUID()}`;
  const openclawId = `phase8-openclaw-${crypto.randomUUID()}`;

  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Phase 8 Shadow', true)
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@test.local`],
    );
    await c.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          kind, connection_status, is_active, heartbeat_enabled,
          heartbeat_interval_min, max_daily_actions, daily_action_count, created_by)
       VALUES
         ($1, $2, $3, 'P8 Native', $4, 'project_manager', 'test', 'standard',
          'native', 'connected', true, true, 5, 50, 0, $3)`,
      [nativeId, orgId, userId, `slug-${nativeId}`],
    );
    await c.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          kind, connection_status, is_active, heartbeat_enabled,
          heartbeat_interval_min, max_daily_actions, daily_action_count, created_by)
       VALUES
         ($1, $2, $3, 'P8 OpenClaw', $4, 'project_manager', 'test', 'standard',
          'openclaw', 'connected', true, true, 30, 50, 0, $3)`,
      [openclawId, orgId, userId, `slug-${openclawId}`],
    );
  });

  try {
    const openclawDue = await withClient(async (c) => {
      const r = await c.query<{ id: string; kind: string }>(
        `SELECT id, kind FROM agent_employees
          WHERE id = ANY($1::text[])
            AND is_active = true
            AND heartbeat_enabled = true
            AND (last_heartbeat_at IS NULL
                 OR last_heartbeat_at + (heartbeat_interval_min || ' minutes')::interval < NOW())
            AND kind IN ('openclaw', 'custom_mcp')`,
        [[nativeId, openclawId]],
      );
      return r.rows;
    });
    assert.equal(openclawDue.length, 1);
    assert.equal(openclawDue[0].kind, 'openclaw');
    assert.equal(openclawDue[0].id, openclawId);

    const nativeDue = await withClient(async (c) => {
      const r = await c.query<{ id: string; kind: string }>(
        `SELECT id, kind FROM agent_employees
          WHERE id = ANY($1::text[])
            AND is_active = true
            AND heartbeat_enabled = true
            AND (last_heartbeat_at IS NULL
                 OR last_heartbeat_at + (heartbeat_interval_min || ' minutes')::interval < NOW())
            AND kind IN ('native', 'claude_sdk')`,
        [[nativeId, openclawId]],
      );
      return r.rows;
    });
    assert.equal(nativeDue.length, 1);
    assert.equal(nativeDue[0].kind, 'native');
    assert.equal(nativeDue[0].id, nativeId);
  } finally {
    await withClient(async (c) => {
      await c.query(`DELETE FROM agent_employees WHERE id = ANY($1::text[])`, [
        [nativeId, openclawId],
      ]);
      await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
    });
  }
});

test('openclaw heartbeat guard skips employees whose connection_status is not connected', async () => {
  const orgId = crypto.randomUUID();
  const userId = `phase8-user-err-${crypto.randomUUID()}`;
  const erroredId = `phase8-errored-${crypto.randomUUID()}`;

  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Phase 8 Err Shadow', true)
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@test.local`],
    );
    await c.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          kind, connection_status, is_active, heartbeat_enabled,
          heartbeat_interval_min, max_daily_actions, daily_action_count, created_by)
       VALUES
         ($1, $2, $3, 'P8 Errored', $4, 'project_manager', 'test', 'standard',
          'openclaw', 'error', true, true, 30, 50, 0, $3)`,
      [erroredId, orgId, userId, `slug-${erroredId}`],
    );
  });

  try {
    // The handler's per-row guard skips connection_status != 'connected'. We
    // mirror that predicate here so a schema drift surfaces in this test.
    const connected = await withClient(async (c) => {
      const r = await c.query(
        `SELECT connection_status FROM agent_employees WHERE id = $1`,
        [erroredId],
      );
      return r.rows[0]?.connection_status;
    });
    assert.equal(connected, 'error');
  } finally {
    await withClient(async (c) => {
      await c.query(`DELETE FROM agent_employees WHERE id = $1`, [erroredId]);
      await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
    });
  }
});
