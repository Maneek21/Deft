/**
 * Phase 7 Task 7.2 — OpenClaw heartbeat regression suite.
 *
 * The heartbeat handler's native-vs-openclaw routing and cadence split land
 * in Phase 8 (task 8.1). This file locks in:
 *
 *   (a) the current contract — `handleAgentEmployeeHeartbeat` is a callable
 *       `JobHandler` and imports cleanly from the handler module;
 *   (b) the behavior Phase 8 MUST preserve/introduce, authored as `todo`
 *       tests so they show up in the runner as visible-but-not-failing
 *       placeholders until the implementation lands.
 *
 * When Task 8.1 ships, the `todo`s can be replaced with real assertions
 * without restructuring the file.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/openclaw-heartbeat.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import type { JobData, JobHandler } from '../src/workers/types.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// Contract tests — these exercise CURRENT behavior (pre-Phase-8) and must
// pass today.
// ─────────────────────────────────────────────────────────────────────────────

test('handleAgentEmployeeHeartbeat is an async JobHandler exported from its module', async () => {
  const mod = await import('../src/workers/handlers/agent-employee-heartbeat.js');
  assert.equal(typeof mod.handleAgentEmployeeHeartbeat, 'function');

  // Structural check: the handler accepts a JobData-shaped argument and
  // returns a Promise. We do NOT invoke it here — invoking would iterate
  // every heartbeat-enabled employee in the DB and potentially hit
  // Anthropic for unrelated production rows. Phase 8 (task 8.1) introduces
  // a dispatcher layer that can be invoked in isolation; the todo tests
  // below capture the assertions that suite must make.
  const handler: JobHandler = mod.handleAgentEmployeeHeartbeat;
  assert.equal(typeof handler, 'function');
  assert.equal(
    handler.constructor.name,
    'AsyncFunction',
    'heartbeat handler must be async',
  );

  // Sanity-check the JobData type alignment by constructing one.
  const job: JobData = { id: 'contract-check', name: 'agent-employee-heartbeat', data: {} };
  assert.equal(job.name, 'agent-employee-heartbeat');
});

test('agent_employees schema exposes the cadence + health columns the Phase 8 dispatcher needs', async () => {
  // The Phase 8 dispatcher routes by `kind` and throttles via the health
  // columns. Lock in their presence so a schema regression surfaces here
  // before it breaks the dispatcher.
  const REQUIRED_COLUMNS = [
    'kind',
    'connection_status',
    'heartbeat_enabled',
    'heartbeat_interval_min',
    'daily_action_count',
    'max_daily_actions',
    'last_heartbeat_at',
    'last_gateway_ping_at',
    'gateway_ping_fail_count',
  ];

  const found = await withClient(async (c) => {
    const r = await c.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'agent_employees'
          AND column_name = ANY($1::text[])`,
      [REQUIRED_COLUMNS],
    );
    return new Set(r.rows.map((row) => row.column_name));
  });

  for (const col of REQUIRED_COLUMNS) {
    assert.ok(
      found.has(col),
      `agent_employees.${col} is required by the Phase 8 heartbeat dispatcher`,
    );
  }
});

test('native and openclaw employees can coexist with distinct heartbeat_interval_min defaults', async () => {
  // Today the column default is 30min (see schema.ts). Phase 8 will override
  // to 5min for native employees via job-scheduler or seeding; this test
  // locks in that the COLUMN accepts both values so the dispatcher's cadence
  // split can be enforced by writes, not schema gymnastics.
  const orgId = crypto.randomUUID();
  const userId = `heartbeat-user-${crypto.randomUUID()}`;
  const nativeId = `heartbeat-native-${crypto.randomUUID()}`;
  const openclawId = `heartbeat-openclaw-${crypto.randomUUID()}`;

  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Heartbeat Shadow', true)
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@test.local`],
    );

    await c.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          kind, connection_status, is_active, heartbeat_enabled,
          heartbeat_interval_min, created_by)
       VALUES
         ($1, $2, $3, 'Heartbeat Native', $4, 'project_manager', 'test',
          'standard', 'native', 'connected', true, true, 5, $3)`,
      [nativeId, orgId, userId, nativeId],
    );

    await c.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          kind, connection_status, is_active, heartbeat_enabled,
          heartbeat_interval_min, created_by)
       VALUES
         ($1, $2, $3, 'Heartbeat OpenClaw', $4, 'project_manager', 'test',
          'standard', 'openclaw', 'connected', true, true, 30, $3)`,
      [openclawId, orgId, userId, openclawId],
    );
  });

  try {
    const rows = await withClient(async (c) => {
      const r = await c.query<{
        id: string;
        kind: string;
        heartbeat_interval_min: number;
      }>(
        `SELECT id, kind, heartbeat_interval_min
           FROM agent_employees
          WHERE id = ANY($1::text[])
          ORDER BY kind`,
        [[nativeId, openclawId]],
      );
      return r.rows;
    });

    assert.equal(rows.length, 2);
    const native = rows.find((r) => r.kind === 'native');
    const openclaw = rows.find((r) => r.kind === 'openclaw');
    assert.ok(native, 'native employee row must exist');
    assert.ok(openclaw, 'openclaw employee row must exist');
    assert.equal(native!.heartbeat_interval_min, 5);
    assert.equal(openclaw!.heartbeat_interval_min, 30);
  } finally {
    await withClient(async (c) => {
      await c.query(
        `DELETE FROM agent_employees WHERE id = ANY($1::text[])`,
        [[nativeId, openclawId]],
      );
      await c.query(`DELETE FROM users WHERE id = $1`, [userId]);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8-dependent assertions — authored as `todo` placeholders. The current
// handler in `agent-employee-heartbeat.ts` is a single-path runner that calls
// `runAgentQuery` for every due employee regardless of kind; Phase 8 (task
// 8.1) introduces the dispatcher split + cadence override + unhealthy guard.
// ─────────────────────────────────────────────────────────────────────────────

test('openclaw heartbeat cadence defaults to 30 minutes, native to 5 minutes', { todo: 'Phase 8.1' }, () => {
  // When task 8.1 lands, the scheduler/seed will stamp heartbeat_interval_min
  // to 5 for kind='native' and 30 for kind='openclaw' at create time, and
  // permit override via the deploy-wizard / agent-employees route.
});

test('heartbeat dispatcher routes native → runAgentQuery, openclaw → dispatchViaOpenClaw', { todo: 'Phase 8.1' }, () => {
  // The replacement handler must switch on `employee.kind`:
  //   - 'native'        → runAgentQuery({ mode: 'background', ... })
  //   - 'openclaw'      → dispatchViaOpenClaw({ overrideTrigger: { kind: 'cron:heartbeat', ... } })
  //   - 'claude_sdk'    → runAgentQuery (treated as native for dispatch)
  //   - 'custom_mcp'    → dispatchViaOpenClaw (gateway-shaped)
  // Current implementation always uses runAgentQuery. Do not enable until
  // the dispatcher branch ships.
});

test('heartbeat skips employees with connection_status=error (unhealthy)', { todo: 'Phase 8.1' }, () => {
  // Today the handler only gates on `is_active` + `heartbeat_enabled` +
  // the time-since-last-heartbeat SQL. Phase 8 adds an `unhealthy` guard:
  // openclaw employees with connection_status='error' or
  // gateway_ping_fail_count >= 3 must be skipped (their Gateway is down,
  // so firing a heartbeat would either fail outright or spam errors).
});

test('heartbeat skips employees at or above daily_action_count >= max_daily_actions', { todo: 'Phase 8.1' }, () => {
  // The CURRENT handler already has this guard (see agent-employee-heartbeat.ts
  // line ~26). Phase 8 keeps the guard but moves it behind the dispatcher so
  // it applies uniformly to native and openclaw paths. A non-todo assertion
  // requires mocking runAgentQuery + dispatchViaOpenClaw, deferred to 8.1.
});

test('heartbeat_interval_min override persists and is honored by the due-filter SQL', { todo: 'Phase 8.1' }, () => {
  // Task 8.1 exposes a per-employee interval override (e.g. 60min for a
  // "weekend-mode" employee). The existing SQL filter already reads
  // heartbeat_interval_min, so this is primarily an API + seeding test.
});
