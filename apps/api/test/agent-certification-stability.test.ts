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
const MEMBER_USER_ID = `member-${SUFFIX}`;
const AUTH_SHADOW_USER_ID = `auth-shadow-${SUFFIX}`;
const AUTH_EMPLOYEE_ID = `auth-employee-${SUFFIX}`;
const AUTH_EMPLOYEE_SLUG = `auth-employee-${SUFFIX}`;
const AUTH_EMPLOYEE_NAME = 'Runtime $(touch /tmp/deft-pwn) \\"; whoami; #';
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
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Certification Member', false),
              ($3, $4, 'Authorization Runtime', true)`,
      [MEMBER_USER_ID, `${MEMBER_USER_ID}@test.local`, AUTH_SHADOW_USER_ID, `${AUTH_SHADOW_USER_ID}@test.local`],
    );
    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'owner', true),
              (gen_random_uuid()::text, $1, $3, 'member', true)`,
      [ORG_ID, ADMIN_USER_ID, MEMBER_USER_ID],
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
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          runtime_kind, certification_status, is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, 'project_manager', 'test', 'standard',
         'hermes', 'token_issued', true, true, $6)`,
      [
        AUTH_EMPLOYEE_ID,
        ORG_ID,
        AUTH_SHADOW_USER_ID,
        AUTH_EMPLOYEE_NAME,
        AUTH_EMPLOYEE_SLUG,
        ADMIN_USER_ID,
      ],
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
    const asMember = c.req.header('x-test-user') === 'member';
    const userId = asMember ? MEMBER_USER_ID : ADMIN_USER_ID;
    c.set('user', {
      id: userId,
      email: `${userId}@test.local`,
      org_id: ORG_ID,
    } as any);
    await next();
  });
  testApp.route('/api/agent-employees', agentEmployeeRoutes);
});

after(async () => {
  await withClient(async (client) => {
    await client.query('DELETE FROM agent_channel_events WHERE agent_employee_id = $1', [AUTH_EMPLOYEE_ID]);
    await client.query(
      'DELETE FROM space_members WHERE user_id IN ($1, $2, $3, $4)',
      [SHADOW_USER_ID, ADMIN_USER_ID, MEMBER_USER_ID, AUTH_SHADOW_USER_ID],
    );
    await client.query(
      "DELETE FROM spaces WHERE org_id = $1 AND created_by = $2 AND type = 'agent_conversation'",
      [ORG_ID, ADMIN_USER_ID],
    );
    await client.query('DELETE FROM agent_cooperative_log WHERE employee_id = $1', [EMPLOYEE_ID]);
    await client.query('DELETE FROM agent_mcp_call_audit WHERE employee_id = $1', [EMPLOYEE_ID]);
    await client.query('DELETE FROM agent_certification_challenges WHERE employee_id IN ($1, $2)', [EMPLOYEE_ID, AUTH_EMPLOYEE_ID]);
    await client.query('DELETE FROM agent_employees WHERE id IN ($1, $2)', [EMPLOYEE_ID, AUTH_EMPLOYEE_ID]);
    await client.query('DELETE FROM org_members WHERE user_id IN ($1, $2)', [ADMIN_USER_ID, MEMBER_USER_ID]);
    await client.query(
      'DELETE FROM users WHERE id IN ($1, $2, $3, $4)',
      [SHADOW_USER_ID, ADMIN_USER_ID, MEMBER_USER_ID, AUTH_SHADOW_USER_ID],
    );
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

test('member cannot access developer, certification, or channel-test routes', async () => {
  const routes: Array<{ method: 'GET' | 'POST'; path: string }> = [
    { method: 'GET', path: 'developer' },
    { method: 'GET', path: 'certification' },
    { method: 'POST', path: 'certification/start' },
    { method: 'POST', path: 'certification/check' },
    { method: 'POST', path: 'certification/reset' },
    { method: 'POST', path: 'channel-test/start' },
    { method: 'POST', path: 'regenerate-token' },
    { method: 'POST', path: 'regenerate-channel-token' },
    { method: 'POST', path: 'clone' },
  ];

  for (const route of routes) {
    const response = await app().request(
      `/api/agent-employees/${AUTH_EMPLOYEE_ID}/${route.path}`,
      {
        method: route.method,
        headers: { 'x-test-user': 'member' },
      },
    );
    assert.equal(response.status, 403, `${route.method} ${route.path}`);
    assert.equal((await response.json() as any).code, 'FORBIDDEN');
  }

  const createResponse = await app().request('/api/agent-employees', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user': 'member' },
    body: JSON.stringify({}),
  });
  assert.equal(createResponse.status, 403);
  assert.equal((await createResponse.json() as any).code, 'FORBIDDEN');

  const updateResponse = await app().request(
    `/api/agent-employees/${AUTH_EMPLOYEE_ID}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-test-user': 'member' },
      body: JSON.stringify({ name: 'Unauthorized rename' }),
    },
  );
  assert.equal(updateResponse.status, 403);
  assert.equal((await updateResponse.json() as any).code, 'FORBIDDEN');
});

test('owner can use guarded routes without exposing a prompt-bearing shell command', async () => {
  const developerResponse = await app().request(
    `/api/agent-employees/${AUTH_EMPLOYEE_ID}/developer`,
  );
  assert.equal(developerResponse.status, 200);
  const developerBody = (await developerResponse.json()) as any;
  const interactiveCommand = developerBody.runtime_setup.commands.find(
    (command: any) => command.label === 'Open an interactive certification chat',
  );
  assert.equal(interactiveCommand?.command, 'hermes chat --cli --max-turns 20');
  assert.ok(!interactiveCommand.command.includes(AUTH_EMPLOYEE_NAME));
  assert.ok(!interactiveCommand.command.includes('$('));
  assert.ok(developerBody.runtime_setup.certification_prompt.includes(AUTH_EMPLOYEE_NAME));

  const certificationResponse = await app().request(
    `/api/agent-employees/${AUTH_EMPLOYEE_ID}/certification`,
  );
  assert.equal(certificationResponse.status, 200);

  const startResponse = await app().request(
    `/api/agent-employees/${AUTH_EMPLOYEE_ID}/certification/start`,
    { method: 'POST' },
  );
  assert.equal(startResponse.status, 201);
  const startBody = await startResponse.json() as any;
  assert.equal(startBody.channel_event.kind, 'certification.challenge');
  assert.equal(startBody.channel_event.source_id, startBody.challenge.id);
  assert.equal(startBody.channel_event.space_id, startBody.challenge.id);
  assert.ok(startBody.challenge.required_tools.includes('memory_recall'));
  assert.ok(startBody.challenge.required_tools.includes('memory_write'));
  assert.ok(startBody.challenge.required_tools.includes('module_list'));
  assert.match(startBody.instructions, /allowed_next_statuses/);
  assert.match(startBody.instructions, /module_schema_get/);
  assert.match(startBody.runtime_setup.certification_prompt, /final reply.*nonce/i);

  await withClient(async (client) => {
    for (const tool of startBody.challenge.required_tools) {
      await client.query(
        `INSERT INTO agent_mcp_call_audit
           (id, org_id, employee_id, tool_name, success, created_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, true, now())`,
        [ORG_ID, AUTH_EMPLOYEE_ID, tool],
      );
    }
    await client.query(
      `INSERT INTO agent_cooperative_log
         (id, org_id, employee_id, kind, summary, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, 'decision', $3, now())`,
      [ORG_ID, AUTH_EMPLOYEE_ID, `Certification ${startBody.challenge.nonce}`],
    );
  });

  const mcpOnlyCheck = await app().request(
    `/api/agent-employees/${AUTH_EMPLOYEE_ID}/certification/check`,
    { method: 'POST' },
  );
  assert.equal(mcpOnlyCheck.status, 200);
  const mcpOnlyBody = await mcpOnlyCheck.json() as any;
  assert.equal(mcpOnlyBody.completed, false, 'MCP evidence alone must not certify an employee');
  assert.equal(mcpOnlyBody.channel_completed, false);

  await withClient(async (client) => {
    await client.query(
      `UPDATE agent_channel_events
       SET status = 'completed', delivery_count = 1, delivered_at = now(), acked_at = now(),
           completed_at = now(), work_outcome = 'completed', outcome_at = now(),
           runtime_session_key = 'hermes:certification:test'
       WHERE id = $1`,
      [startBody.channel_event.id],
    );
    await client.query(
      `INSERT INTO agent_channel_delivery_attempts
         (id, org_id, agent_employee_id, event_id, direction, idempotency_key, status, request_json)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'inbound_reply', $4, 'completed', $5::jsonb)`,
      [
        ORG_ID,
        AUTH_EMPLOYEE_ID,
        startBody.channel_event.id,
        `certification-reply-${startBody.challenge.id}`,
        JSON.stringify({ content: `Certification complete ${startBody.challenge.nonce}` }),
      ],
    );
  });

  const deepCheckResponse = await app().request(
    `/api/agent-employees/${AUTH_EMPLOYEE_ID}/certification/check`,
    { method: 'POST' },
  );
  assert.equal(deepCheckResponse.status, 200);
  const deepCheckBody = await deepCheckResponse.json() as any;
  assert.equal(deepCheckBody.completed, true);
  assert.equal(deepCheckBody.single_delivery, true);
  assert.equal(deepCheckBody.channel_reply_nonce_seen, true);

  const resetResponse = await app().request(
    `/api/agent-employees/${AUTH_EMPLOYEE_ID}/certification/reset`,
    { method: 'POST' },
  );
  assert.equal(resetResponse.status, 200);

  const channelTestResponse = await app().request(
    `/api/agent-employees/${AUTH_EMPLOYEE_ID}/channel-test/start`,
    { method: 'POST' },
  );
  assert.equal(channelTestResponse.status, 201);

  const invalidTenantReference = await app().request(
    `/api/agent-employees/${AUTH_EMPLOYEE_ID}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ space_ids: ['space-outside-current-org'] }),
    },
  );
  assert.equal(invalidTenantReference.status, 400);
  assert.equal((await invalidTenantReference.json() as any).code, 'VALIDATION_ERROR');
});
