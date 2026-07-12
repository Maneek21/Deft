import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const SUFFIX = `cert-stability-${Date.now()}`;
const EMPLOYEE_ID = `employee-${SUFFIX}`;
const EMPLOYEE_SLUG = `employee-${SUFFIX}`;
const SHADOW_USER_ID = `shadow-${SUFFIX}`;
const ADMIN_USER_ID = `admin-${SUFFIX}`;
const CHALLENGE_ID = `challenge-${SUFFIX}`;
const NONCE = `nonce-${SUFFIX}`;
const REQUIRED_TOOLS = [
  'platform_context',
  'task_query',
  'ping_alive',
  'record_conversation_turn',
  'record_decision',
];

let testApp: Hono | null = null;

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

before(async () => {
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Certification Runtime', true),
              ($3, $4, 'Certification Admin', false)`,
      [SHADOW_USER_ID, `${SHADOW_USER_ID}@test.local`, ADMIN_USER_ID, `${ADMIN_USER_ID}@test.local`],
    );
    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'owner', true)`,
      [ORG_ID, ADMIN_USER_ID],
    );
    await client.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          runtime_kind, certification_status, last_verified_at, last_mcp_call_at,
          is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, 'Certification Runtime', $4, 'project_manager', 'test', 'standard',
         'hermes', 'verified', now(), now(), true, true, $3)`,
      [EMPLOYEE_ID, ORG_ID, SHADOW_USER_ID, EMPLOYEE_SLUG],
    );
    await client.query(
      `INSERT INTO agent_certification_challenges
         (id, org_id, employee_id, nonce, required_tools, status, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5::text[], 'completed', now() - interval '2 hours', now() - interval '90 minutes')`,
      [CHALLENGE_ID, ORG_ID, EMPLOYEE_ID, NONCE, REQUIRED_TOOLS],
    );

    for (const [index, tool] of REQUIRED_TOOLS.entries()) {
      await client.query(
        `INSERT INTO agent_mcp_call_audit
           (id, org_id, employee_id, tool_name, success, created_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, true, now() - interval '110 minutes' + ($4 * interval '1 second'))`,
        [ORG_ID, EMPLOYEE_ID, tool, index],
      );
    }
    await client.query(
      `INSERT INTO agent_cooperative_log
         (id, org_id, employee_id, kind, summary, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, 'decision', $3, now() - interval '109 minutes')`,
      [ORG_ID, EMPLOYEE_ID, `Certification evidence ${NONCE}`],
    );

    // Later normal traffic deliberately pushes certification calls beyond the
    // Developer page's 25-row diagnostics window.
    for (let index = 0; index < 35; index += 1) {
      await client.query(
        `INSERT INTO agent_mcp_call_audit
           (id, org_id, employee_id, tool_name, success, created_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, true, now() - ($4 * interval '1 second'))`,
        [ORG_ID, EMPLOYEE_ID, `later_tool_${index}`, index],
      );
    }
    for (let index = 0; index < 15; index += 1) {
      await client.query(
        `INSERT INTO agent_cooperative_log
           (id, org_id, employee_id, kind, summary, created_at)
         VALUES (gen_random_uuid()::text, $1, $2, 'outcome', $3, now() - ($4 * interval '1 second'))`,
        [ORG_ID, EMPLOYEE_ID, `Later runtime outcome ${index}`, index],
      );
    }
  });

  const { agentEmployeeRoutes } = await import('../src/routes/agent-employees.js');
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    c.set('user', {
      id: ADMIN_USER_ID,
      email: `${ADMIN_USER_ID}@test.local`,
      org_id: ORG_ID,
    } as any);
    await next();
  });
  testApp.route('/api/agent-employees', agentEmployeeRoutes);
});

after(async () => {
  await withClient(async (client) => {
    await client.query('DELETE FROM agent_cooperative_log WHERE employee_id = $1', [EMPLOYEE_ID]);
    await client.query('DELETE FROM agent_mcp_call_audit WHERE employee_id = $1', [EMPLOYEE_ID]);
    await client.query('DELETE FROM agent_certification_challenges WHERE employee_id = $1', [EMPLOYEE_ID]);
    await client.query('DELETE FROM agent_employees WHERE id = $1', [EMPLOYEE_ID]);
    await client.query('DELETE FROM org_members WHERE user_id = $1', [ADMIN_USER_ID]);
    await client.query('DELETE FROM users WHERE id IN ($1, $2)', [SHADOW_USER_ID, ADMIN_USER_ID]);
  });
});

function app(): Hono {
  if (!testApp) throw new Error('test app not initialized');
  return testApp;
}

test('completed certification remains fully passed after heavy later MCP traffic', async () => {
  const response = await app().request(`/api/agent-employees/${EMPLOYEE_ID}/developer`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;

  assert.equal(body.certification.status, 'completed');
  const stages = new Map(body.certification.stages.map((stage: any) => [stage.key, stage.status]));
  assert.equal(stages.get('required_tools_called'), 'pass');
  assert.equal(stages.get('cooperative_nonce_seen'), 'pass');
  assert.equal(stages.get('verified'), 'pass');
  assert.equal(body.diagnostics.recent_mcp_calls.length, 25);
  assert.ok(body.diagnostics.recent_mcp_calls.every((row: any) => row.tool_name.startsWith('later_tool_')));
});

test('certification detail endpoint uses the same stable evidence', async () => {
  const response = await app().request(`/api/agent-employees/${EMPLOYEE_ID}/certification`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  const stages = new Map(body.challenge.stages.map((stage: any) => [stage.key, stage.status]));
  assert.equal(stages.get('required_tools_called'), 'pass');
  assert.equal(stages.get('cooperative_nonce_seen'), 'pass');
  assert.equal(stages.get('verified'), 'pass');
});
