/**
 * task_update conservative-trust regression test.
 *
 * Background: Layer B audit scenario 6.38 observed that all 9 `task_update`
 * MCP calls landed with `approval_status='approved'` even though the calling
 * agent's trust level was set to `conservative`. Layer A scenario 5.28 had
 * verified that `task_create` (also `quick` tier) correctly queues at
 * conservative — so the issue, if real, is specific to the `task_update`
 * code path.
 *
 * This test reproduces the scenario in isolation: a freshly-issued bearer for
 * a brand-new ephemeral conservative-trust BYOA agent posts a single
 * `task_update` MCP call directly into the in-process Hono app, then asserts
 * the response is the queued-for-approval pseudo-result and the inserted
 * `agent_actions` row has `approval_status='pending'` / `action='task_update'`.
 *
 * If this passes, the platform behavior is correct in isolation and the bug
 * lives in the LLM loop / audit harness (likely a stale ResolvedGateway being
 * held across calls). If it fails, the bug is reproducible at the platform
 * layer and the trust-gating in `taskUpdate` is being bypassed somehow.
 *
 * Run: cd apps/api && pnpm exec tsx --test test/task-update-trust.test.ts
 *
 * Requires DATABASE_URL pointing at a Deft DB with the standard schema
 * (Phase 9+). The repo's root `.env` already configures this.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft_fresh';
const ORG_ID = process.env.TEST_ORG_ID || '760b7a2b-a4ce-4b75-897c-c86d8e5d8047';

const EMP_ID = 'test-task-update-trust-cons';
const EMP_SLUG = 'task-update-trust-cons';
const TEST_USER_ID = 'test-task-update-trust-user';
const TEST_PROJECT_PREFIX = 'TUTRT';

let TEST_PROJECT_ID: string | null = null;
let TEST_TASK_ID: string | null = null;
let BEARER_TOKEN: string | null = null;
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
    // Verify the org row actually exists — surfaces a clear error rather
    // than failing later inside an FK violation.
    const org = await c.query(`SELECT id FROM orgs WHERE id = $1`, [ORG_ID]);
    if (org.rows.length === 0) {
      throw new Error(
        `seedFixtures: org ${ORG_ID} not found in DATABASE_URL=${DATABASE_URL}. ` +
          'Set TEST_ORG_ID env var to a real org id or seed the test org first.',
      );
    }

    // Shadow user for the ephemeral employee.
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, `task-update-trust-${Date.now()}@test.local`, 'task_update trust test user'],
    );

    // Conservative-trust BYOA agent.
    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, 'project_manager', 'test', 'conservative',
         true, true, $3)
       ON CONFLICT (id) DO UPDATE SET
         trust_level = 'conservative',
         is_active = true`,
      [EMP_ID, ORG_ID, TEST_USER_ID, 'task_update trust regression', EMP_SLUG],
    );

    // Reuse first project in the org if present, else mint one.
    const proj = await c.query(
      `SELECT id FROM projects WHERE org_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [ORG_ID],
    );
    if (proj.rows.length > 0) {
      TEST_PROJECT_ID = proj.rows[0].id;
    } else {
      const r = await c.query(
        `INSERT INTO projects (org_id, name, prefix, lead_id, task_counter)
         VALUES ($1, 'task_update trust regression', $2, $3, 0)
         RETURNING id`,
        [ORG_ID, TEST_PROJECT_PREFIX, TEST_USER_ID],
      );
      TEST_PROJECT_ID = r.rows[0].id;
    }

    // Bump the project task counter and create the task we'll try to update.
    const counter = await c.query(
      `UPDATE projects SET task_counter = task_counter + 1
        WHERE id = $1 AND org_id = $2 RETURNING task_counter`,
      [TEST_PROJECT_ID, ORG_ID],
    );
    const taskNumber = Number(counter.rows[0].task_counter);
    const taskRow = await c.query(
      `INSERT INTO tasks
        (org_id, project_id, number, title, description, priority,
         created_by, status)
       VALUES ($1, $2, $3, $4, $5, 'p2', $6, 'todo')
       RETURNING id`,
      [
        ORG_ID,
        TEST_PROJECT_ID,
        taskNumber,
        `task_update trust regression target ${Date.now()}`,
        'created by task-update-trust regression test',
        TEST_USER_ID,
      ],
    );
    TEST_TASK_ID = taskRow.rows[0].id;
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    await c.query(
      `DELETE FROM action_receipts WHERE employee_id = $1
         OR action_id IN (SELECT id FROM agent_actions WHERE agent_employee_id = $1)`,
      [EMP_ID],
    );
    await c.query(`DELETE FROM agent_actions WHERE agent_employee_id = $1`, [EMP_ID]);
    if (TEST_TASK_ID) {
      await c.query(`DELETE FROM tasks WHERE id = $1`, [TEST_TASK_ID]);
    }
    await c.query(`DELETE FROM agent_employees WHERE id = $1`, [EMP_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [TEST_USER_ID]);
  });
}

before(async () => {
  await seedFixtures();
  const tokenModule = await import('../src/lib/mcp-token.js');
  const routeModule = await import('../src/routes/mcp-server-v1.js');
  testApp = new Hono();
  testApp.route('/api/mcp/v1', routeModule.mcpServerV1Routes);
  BEARER_TOKEN = await tokenModule.issueEmployeeToken(ORG_ID, EMP_ID);
});

after(async () => {
  await teardownFixtures();
});

function app(): Hono {
  if (!testApp) throw new Error('test app not initialized');
  return testApp;
}

async function mcpCall(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  if (!BEARER_TOKEN) throw new Error('bearer not issued');
  const res = await app().request('/api/mcp/v1/tools/call', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${BEARER_TOKEN}`,
    },
    body: JSON.stringify({ name: tool, arguments: args }),
  });
  const body = (await res.json()) as any;
  return { status: res.status, body };
}

function parseContent(body: any): any {
  if (!body?.content?.[0]?.text) return null;
  try {
    return JSON.parse(body.content[0].text);
  } catch {
    return body.content[0].text;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

test('task_update at conservative trust queues for approval (regression for 6.38)', async () => {
  // Sanity — confirm DB really sees this employee at conservative trust.
  await withClient(async (c) => {
    const r = await c.query(
      `SELECT trust_level FROM agent_employees WHERE id = $1`,
      [EMP_ID],
    );
    assert.equal(r.rows.length, 1, 'employee row exists');
    assert.equal(
      r.rows[0].trust_level,
      'conservative',
      'employee must be conservative for this test to mean anything',
    );
  });

  const { status, body } = await mcpCall('task_update', {
    caller_employee_slug: EMP_SLUG,
    task_id: TEST_TASK_ID,
    patch: { status: 'done' },
  });

  assert.equal(status, 200, 'tools/call should return 200');
  assert.ok(
    !body.isError,
    `task_update should not error at conservative: ${JSON.stringify(body)}`,
  );

  const parsed = parseContent(body);
  assert.equal(
    parsed?.status,
    'queued_for_approval',
    `task_update at conservative MUST queue, got: ${JSON.stringify(parsed)}`,
  );
  assert.ok(parsed?.approval_id, 'pseudo-result must include approval_id');

  // Verify the agent_actions row matches expectations.
  await withClient(async (c) => {
    const r = await c.query(
      `SELECT action, approval_status, approval_tier, agent_employee_id
         FROM agent_actions WHERE id = $1`,
      [parsed.approval_id],
    );
    assert.equal(r.rows.length, 1, 'agent_actions row should exist');
    assert.equal(r.rows[0].action, 'task_update');
    assert.equal(r.rows[0].approval_status, 'pending');
    assert.equal(r.rows[0].approval_tier, 'quick');
    assert.equal(r.rows[0].agent_employee_id, EMP_ID);

    // The task itself must NOT have been mutated.
    const t = await c.query(
      `SELECT status FROM tasks WHERE id = $1`,
      [TEST_TASK_ID],
    );
    assert.equal(t.rows.length, 1);
    assert.notEqual(
      t.rows[0].status,
      'done',
      'task status must not have changed since the update was queued',
    );
  });
});
