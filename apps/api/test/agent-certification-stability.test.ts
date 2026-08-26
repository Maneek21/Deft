import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';
import bcrypt from 'bcryptjs';

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
const AUTH_CHANNEL_BEARER = `deft-channel-${SUFFIX}`;
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
  const channelTokenHash = await bcrypt.hash(AUTH_CHANNEL_BEARER, 10);
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
          runtime_kind, certification_status, is_byoa, is_active, mcp_token_hash, created_by)
       VALUES ($1, $2, $3, $4, $5, 'project_manager', 'test', 'standard',
         'hermes', 'token_issued', true, true, 'test-mcp-hash', $6)`,
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
      `INSERT INTO agent_channel_tokens
         (id, org_id, agent_employee_id, name, token_hash, token_prefix, scopes, is_active, created_by)
       VALUES (gen_random_uuid()::text, $1, $2, 'Certification channel', $4, 'deft_channel',
          '["channel:read","channel:write"]'::jsonb, true, $3)`,
      [ORG_ID, AUTH_EMPLOYEE_ID, ADMIN_USER_ID, channelTokenHash],
    );
    await client.query(
      `INSERT INTO agent_channel_connections
         (id, org_id, agent_employee_id, runtime_kind, status, protocol_version, last_seen_at, metadata)
       VALUES (gen_random_uuid()::text, $1, $2, 'hermes', 'connected', 'deft.agent_channel.v2', now(), $3::jsonb)`,
      [ORG_ID, AUTH_EMPLOYEE_ID, JSON.stringify({
        worker_id: 'certification-worker-1',
        restart_count: 0,
        adapter_mode: 'autonomous_platform',
        runtime_capabilities: [
          'autonomous_platform_adapter_v1',
          'accepted_event_rehydration_v1',
        ],
      })],
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

  const [{ agentEmployeeRoutes }, { agentChannelRoutes }] = await Promise.all([
    import('../src/routes/agent-employees.js'),
    import('../src/routes/agent-channel.js'),
  ]);
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
  testApp.route('/api/agent-channel/v1', agentChannelRoutes);
});

after(async () => {
  await withClient(async (client) => {
    await client.query('DELETE FROM agent_channel_events WHERE agent_employee_id = $1', [AUTH_EMPLOYEE_ID]);
    await client.query(
      'DELETE FROM space_members WHERE user_id IN ($1, $2, $3, $4)',
      [SHADOW_USER_ID, ADMIN_USER_ID, MEMBER_USER_ID, AUTH_SHADOW_USER_ID],
    );
    await client.query(
      'DELETE FROM messages WHERE org_id = $1 AND user_id = $2',
      [ORG_ID, AUTH_SHADOW_USER_ID],
    );
    await client.query(
      "DELETE FROM spaces WHERE org_id = $1 AND created_by = $2 AND type = 'agent_conversation'",
      [ORG_ID, ADMIN_USER_ID],
    );
    await client.query(
      'DELETE FROM agent_cooperative_log WHERE employee_id IN ($1, $2)',
      [EMPLOYEE_ID, AUTH_EMPLOYEE_ID],
    );
    await client.query(
      'DELETE FROM agent_mcp_call_audit WHERE employee_id IN ($1, $2)',
      [EMPLOYEE_ID, AUTH_EMPLOYEE_ID],
    );
    await client.query('DELETE FROM action_receipts WHERE employee_id = $1', [AUTH_EMPLOYEE_ID]);
    await client.query(
      'DELETE FROM agent_actions WHERE org_id = $1 AND (agent_employee_id = $2 OR user_id = $3)',
      [ORG_ID, AUTH_EMPLOYEE_ID, AUTH_SHADOW_USER_ID],
    );
    await client.query('DELETE FROM agent_certification_challenges WHERE employee_id IN ($1, $2)', [EMPLOYEE_ID, AUTH_EMPLOYEE_ID]);
    await client.query('DELETE FROM wiki_pages WHERE agent_employee_id = $1', [AUTH_EMPLOYEE_ID]);
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

function autonomousCompatibilityQuery(workerId: string) {
  return new URLSearchParams({
    protocol_version: 'deft.agent_channel.v2',
    adapter_version: '0.2.0',
    capabilities: 'autonomous_platform_adapter_v1,accepted_event_rehydration_v1',
    worker_id: workerId,
    caller_employee_slug: AUTH_EMPLOYEE_SLUG,
  }).toString();
}

test('historical status alone cannot grandfather incomplete certification proof', async () => {
  const response = await app().request(`/api/agent-employees/${EMPLOYEE_ID}/developer`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;

  assert.equal(body.certification.status, 'pending');
  const stages = new Map(body.certification.stages.map((stage: any) => [stage.key, stage.status]));
  assert.equal(stages.get('required_tools_called'), 'pass');
  assert.equal(stages.get('cooperative_nonce_seen'), 'pass');
  assert.equal(stages.get('verified'), 'pending');
  assert.equal(body.diagnostics.recent_mcp_calls.length, 25);
  assert.ok(body.diagnostics.recent_mcp_calls.every((row: any) => row.tool_name.startsWith('later_tool_')));

  const checkResponse = await app().request(
    `/api/agent-employees/${EMPLOYEE_ID}/certification/check`,
    { method: 'POST' },
  );
  const checkBody = await checkResponse.json() as any;
  assert.equal(checkResponse.status, 200, JSON.stringify(checkBody));
  assert.equal(checkBody.completed, false);
  await withClient(async (client) => {
    const invalidated = await client.query(
      `SELECT challenge.status, challenge.completed_at,
              employee.certification_status, employee.last_verified_at
       FROM agent_certification_challenges challenge
       JOIN agent_employees employee
         ON employee.id = challenge.employee_id AND employee.org_id = challenge.org_id
       WHERE challenge.id = $1 AND challenge.org_id = $2`,
      [CHALLENGE_ID, ORG_ID],
    );
    assert.equal(invalidated.rows[0].status, 'pending');
    assert.equal(invalidated.rows[0].completed_at, null);
    assert.equal(invalidated.rows[0].certification_status, 'challenge_issued');
    assert.equal(invalidated.rows[0].last_verified_at, null);
  });
});

test('certification detail keeps old tool evidence but requires the full proof', async () => {
  const response = await app().request(`/api/agent-employees/${EMPLOYEE_ID}/certification`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as any;
  assert.equal(body.challenge.status, 'pending');
  const stages = new Map(body.challenge.stages.map((stage: any) => [stage.key, stage.status]));
  assert.equal(stages.get('required_tools_called'), 'pass');
  assert.equal(stages.get('cooperative_nonce_seen'), 'pass');
  assert.equal(stages.get('verified'), 'pending');
});

test('supervised certification proof still requires a terminal session-bound reply', async () => {
  const challengeId = `supervised-${SUFFIX}`;
  const eventId = `supervised-event-${SUFFIX}`;
  const nonce = `supervised-nonce-${SUFFIX}`;
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO agent_certification_challenges
         (id, org_id, employee_id, nonce, required_tools, status, started_at)
       VALUES ($1, $2, $3, $4, '{}'::text[], 'pending', now())`,
      [challengeId, ORG_ID, EMPLOYEE_ID, nonce],
    );
    await client.query(
      `INSERT INTO agent_channel_events
         (id, org_id, agent_employee_id, kind, source_kind, source_id, payload,
          idempotency_key, status, delivery_count, delivered_at, acked_at,
          completed_at, work_outcome, outcome_at, runtime_session_key)
       VALUES ($1, $2, $3, 'certification.challenge', 'certification', $4, '{}'::jsonb,
         $5, 'completed', 1, now(), now(), now(), 'completed', now(), 'supervised-session')`,
      [eventId, ORG_ID, EMPLOYEE_ID, challengeId, `supervised-certification:${challengeId}`],
    );
    await client.query(
      `INSERT INTO agent_channel_delivery_attempts
         (id, org_id, agent_employee_id, event_id, direction, idempotency_key,
          status, request_json, response_json)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'inbound_reply', $4,
         'completed', $5::jsonb, $6::jsonb)`,
      [
        ORG_ID,
        EMPLOYEE_ID,
        eventId,
        `supervised-reply:${challengeId}`,
        JSON.stringify({
          adapter_mode: 'supervised_runtime',
          content: `Supervised certification ${nonce}`,
          runtime_session_key: 'supervised-session',
        }),
        JSON.stringify({
          content: 'Durable supervised reply without the proof token',
          created_at: new Date().toISOString(),
        }),
      ],
    );
  });

  const mismatchedResponse = await app().request(`/api/agent-employees/${EMPLOYEE_ID}/certification`);
  const mismatchedBody = await mismatchedResponse.json() as any;
  assert.equal(mismatchedResponse.status, 200, JSON.stringify(mismatchedBody));
  assert.equal(
    mismatchedBody.challenge.stages.find((stage: any) => stage.key === 'channel_reply_verified')?.status,
    'pending',
    'request text cannot substitute for the durable message when proving the nonce',
  );

  await withClient(async (client) => {
    await client.query(
      `UPDATE agent_channel_delivery_attempts
       SET response_json = $1::jsonb, updated_at = now()
       WHERE org_id = $2 AND agent_employee_id = $3 AND idempotency_key = $4`,
      [
        JSON.stringify({
          content: `Durable supervised certification ${nonce}`,
          created_at: new Date().toISOString(),
        }),
        ORG_ID,
        EMPLOYEE_ID,
        `supervised-reply:${challengeId}`,
      ],
    );
  });
  const passingResponse = await app().request(`/api/agent-employees/${EMPLOYEE_ID}/certification`);
  const passingBody = await passingResponse.json() as any;
  assert.equal(passingResponse.status, 200, JSON.stringify(passingBody));
  assert.equal(
    passingBody.challenge.stages.find((stage: any) => stage.key === 'runtime_inference')?.status,
    'pass',
  );

  await withClient(async (client) => {
    await client.query(
      `INSERT INTO agent_channel_delivery_attempts
         (id, org_id, agent_employee_id, event_id, direction, idempotency_key, status, request_json)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'inbound_reply', $4, 'completed', $5::jsonb)`,
      [
        ORG_ID,
        EMPLOYEE_ID,
        eventId,
        `supervised-duplicate-reply:${challengeId}`,
        JSON.stringify({
          adapter_mode: 'supervised_runtime',
          content: `Duplicate supervised certification ${nonce}`,
          runtime_session_key: 'supervised-session',
        }),
      ],
    );
  });
  const duplicateReplyResponse = await app().request(`/api/agent-employees/${EMPLOYEE_ID}/certification`);
  const duplicateReplyBody = await duplicateReplyResponse.json() as any;
  assert.equal(duplicateReplyResponse.status, 200, JSON.stringify(duplicateReplyBody));
  assert.equal(
    duplicateReplyBody.challenge.stages.find((stage: any) => stage.key === 'runtime_inference')?.status,
    'pending',
    'multiple successful final replies must invalidate runtime proof',
  );

  await withClient(async (client) => {
    await client.query(
      'DELETE FROM agent_channel_delivery_attempts WHERE idempotency_key = $1',
      [`supervised-duplicate-reply:${challengeId}`],
    );
    await client.query(
      'UPDATE agent_channel_events SET runtime_session_key = NULL WHERE id = $1',
      [eventId],
    );
  });
  const missingSessionResponse = await app().request(`/api/agent-employees/${EMPLOYEE_ID}/certification`);
  const missingSessionBody = await missingSessionResponse.json() as any;
  assert.equal(missingSessionResponse.status, 200, JSON.stringify(missingSessionBody));
  assert.equal(
    missingSessionBody.challenge.stages.find((stage: any) => stage.key === 'runtime_inference')?.status,
    'pending',
  );
});

test('supervised certification recovery settles a durable reply from the original attempt', async () => {
  const challengeId = `supervised-recovery-${SUFFIX}`;
  const eventId = `supervised-recovery-event-${SUFFIX}`;
  const spaceId = `supervised-recovery-space-${SUFFIX}`;
  const claimToken = `supervised-recovery-claim-${SUFFIX}`;
  const messageId = `agent-channel-certification-reply:${eventId}`;
  const attemptKey = `certification-reply:${eventId}:final`;
  const durableContent = `Durable supervised recovery ${SUFFIX}`;
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO agent_certification_challenges
         (id, org_id, employee_id, nonce, required_tools, status, started_at)
       VALUES ($1, $2, $3, $4, '{}'::text[], 'pending', now())`,
      [challengeId, ORG_ID, AUTH_EMPLOYEE_ID, `supervised-recovery-nonce-${SUFFIX}`],
    );
    await client.query(
      `INSERT INTO spaces (id, org_id, name, type, created_by)
       VALUES ($1, $2, 'Supervised recovery', 'agent_conversation', $3)`,
      [spaceId, ORG_ID, ADMIN_USER_ID],
    );
    await client.query(
      `INSERT INTO space_members (id, space_id, user_id)
       VALUES (gen_random_uuid()::text, $1, $2)`,
      [spaceId, AUTH_SHADOW_USER_ID],
    );
    await client.query(
      `INSERT INTO agent_channel_events
         (id, org_id, agent_employee_id, kind, source_kind, source_id, space_id,
          payload, idempotency_key, status, delivery_count, claim_owner, claim_token,
          claimed_at, lease_expires_at, delivered_at)
       VALUES ($1, $2, $3, 'certification.challenge', 'certification', $4, $5,
         '{}'::jsonb, $6, 'delivered', 1, 'supervised-worker', $7,
         now(), now() + interval '5 minutes', now())`,
      [eventId, ORG_ID, AUTH_EMPLOYEE_ID, challengeId, spaceId, `supervised-recovery:${challengeId}`, claimToken],
    );
    await client.query(
      `INSERT INTO agent_channel_delivery_attempts
         (id, org_id, agent_employee_id, event_id, direction, idempotency_key,
          status, request_json, response_json, error)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'inbound_reply', $4,
         'failed', $5::jsonb, '{"error":"post-write bookkeeping failed"}'::jsonb,
         'post-write bookkeeping failed')`,
      [
        ORG_ID,
        AUTH_EMPLOYEE_ID,
        eventId,
        attemptKey,
        JSON.stringify({
          event_id: eventId,
          content: durableContent,
          thread_id: null,
          outcome: 'completed',
          adapter_mode: 'supervised_runtime',
          summary: 'Original supervised result',
          runtime_session_key: 'supervised-recovery-session',
          runtime_request_key: null,
          runtime_response_id: null,
        }),
      ],
    );
    await client.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content, parent_id)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [messageId, ORG_ID, spaceId, AUTH_SHADOW_USER_ID, durableContent],
    );
  });

  const response = await app().request('/api/agent-channel/v1/reply', {
    method: 'POST',
    headers: { authorization: `Bearer ${AUTH_CHANNEL_BEARER}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: eventId,
      content: 'Regenerated text that must not replace the durable reply',
      claim_token: claimToken,
      outcome: 'blocked',
      summary: 'Regenerated summary',
      runtime_session_key: 'regenerated-session',
      caller_employee_slug: AUTH_EMPLOYEE_SLUG,
    }),
  });
  const body = await response.json() as any;
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.idempotent, true);
  assert.equal(body.reconciled, true);
  assert.equal(body.result.content, durableContent);

  await withClient(async (client) => {
    const settled = await client.query(
      `SELECT status, work_outcome, outcome_detail, completed_at, lease_expires_at,
              runtime_session_key
       FROM agent_channel_events
       WHERE id = $1 AND org_id = $2 AND agent_employee_id = $3`,
      [eventId, ORG_ID, AUTH_EMPLOYEE_ID],
    );
    assert.equal(settled.rows[0].status, 'completed');
    assert.equal(settled.rows[0].work_outcome, 'completed');
    assert.equal(settled.rows[0].outcome_detail, 'Original supervised result');
    assert.ok(settled.rows[0].completed_at);
    assert.equal(settled.rows[0].lease_expires_at, null);
    assert.equal(settled.rows[0].runtime_session_key, 'supervised-recovery-session');

    await client.query('DELETE FROM agent_channel_events WHERE id = $1', [eventId]);
    await client.query('DELETE FROM messages WHERE id = $1', [messageId]);
    await client.query('DELETE FROM space_members WHERE space_id = $1', [spaceId]);
    await client.query('DELETE FROM spaces WHERE id = $1', [spaceId]);
    await client.query('DELETE FROM agent_certification_challenges WHERE id = $1', [challengeId]);
  });
});

test('operator reset clears the complete claim shape on an active certification event', async () => {
  const eventId = `claimed-reset-event-${SUFFIX}`;
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO agent_channel_events
         (id, org_id, agent_employee_id, kind, source_kind, source_id, payload,
          idempotency_key, status, delivery_count, claim_owner, claim_token,
          claimed_at, lease_expires_at, delivered_at)
       VALUES ($1, $2, $3, 'certification.challenge', 'certification', $4,
         '{}'::jsonb, $5, 'delivered', 1, 'claimed-reset-worker', $6,
         now(), now() + interval '5 minutes', now())`,
      [
        eventId,
        ORG_ID,
        AUTH_EMPLOYEE_ID,
        `claimed-reset-challenge-${SUFFIX}`,
        `claimed-reset:${SUFFIX}`,
        `claimed-reset-token-${SUFFIX}`,
      ],
    );
  });

  const response = await app().request(
    `/api/agent-employees/${AUTH_EMPLOYEE_ID}/certification/reset`,
    { method: 'POST' },
  );
  assert.equal(response.status, 200, await response.text());
  await withClient(async (client) => {
    const result = await client.query(
      `SELECT status, work_outcome, claim_owner, claim_token, claimed_at, lease_expires_at
       FROM agent_channel_events WHERE id = $1 AND org_id = $2`,
      [eventId, ORG_ID],
    );
    assert.equal(result.rows[0].status, 'cancelled');
    assert.equal(result.rows[0].work_outcome, 'cancelled');
    assert.equal(result.rows[0].claim_owner, null);
    assert.equal(result.rows[0].claim_token, null);
    assert.equal(result.rows[0].claimed_at, null);
    assert.equal(result.rows[0].lease_expires_at, null);
    await client.query('DELETE FROM agent_channel_events WHERE id = $1', [eventId]);
  });
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
  let originalCompletedAt = '';
  let originalVerifiedAt = '';
  const developerResponse = await app().request(
    `/api/agent-employees/${AUTH_EMPLOYEE_ID}/developer`,
  );
  assert.equal(developerResponse.status, 200);
  const developerBody = (await developerResponse.json()) as any;
  assert.equal(developerBody.onboarding_preflight.ready, true);
  assert.deepEqual(
    developerBody.onboarding_preflight.checks
      .filter((check: any) => ['hermes_runtime', 'hermes_skills', 'hermes_model'].includes(check.key))
      .map((check: any) => [check.key, check.status]),
    [
      ['hermes_runtime', 'warning'],
      ['hermes_skills', 'warning'],
      ['hermes_model', 'warning'],
    ],
  );
  const interactiveCommand = developerBody.runtime_setup.commands.find(
    (command: any) => command.label === 'Open an interactive certification chat',
  );
  assert.equal(interactiveCommand?.command, 'hermes chat --cli --max-turns 20');
  assert.ok(!interactiveCommand.command.includes(AUTH_EMPLOYEE_NAME));
  assert.ok(!interactiveCommand.command.includes('$('));
  assert.ok(developerBody.runtime_setup.certification_prompt.includes(AUTH_EMPLOYEE_NAME));

  const nativeConnect = await app().request(
    `/api/agent-channel/v1/connect?${autonomousCompatibilityQuery('certification-worker-1')}`,
    { headers: { authorization: `Bearer ${AUTH_CHANNEL_BEARER}` } },
  );
  assert.equal(nativeConnect.status, 200, await nativeConnect.text());

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
  const validRestartPingId = `cert-restart-ping-${SUFFIX}`;
  assert.equal(startBody.channel_event.kind, 'certification.challenge');
  assert.equal(startBody.channel_event.source_id, startBody.challenge.id);
  assert.equal(startBody.channel_event.space_id, startBody.challenge.id);
  assert.ok(startBody.challenge.required_tools.includes('memory_recall'));
  assert.ok(startBody.challenge.required_tools.includes('memory_write'));
  assert.ok(startBody.challenge.required_tools.includes('module_list'));
  assert.match(startBody.instructions, /allowed_next_statuses/);
  assert.match(startBody.instructions, /module_schema_get/);
  assert.match(startBody.instructions, /restart the Hermes gateway/i);
  assert.doesNotMatch(startBody.instructions, /restart the (?:Hermes )?channel bridge/i);
  assert.match(startBody.runtime_setup.certification_prompt, /final reply.*nonce/i);

  await withClient(async (client) => {
    for (const tool of startBody.challenge.required_tools) {
      await client.query(
        `INSERT INTO agent_mcp_call_audit
           (id, org_id, employee_id, tool_name, success, created_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, true, now())`,
        [ORG_ID, AUTH_EMPLOYEE_ID, tool],
      );
      if (tool === 'memory_write') {
        await client.query(
          `INSERT INTO agent_mcp_call_audit
             (id, org_id, employee_id, tool_name, success, metadata, created_at)
           VALUES (gen_random_uuid()::text, $1, $2, $3, true, $4::jsonb, now())`,
          [
            ORG_ID,
            AUTH_EMPLOYEE_ID,
            tool,
            JSON.stringify({
              memory_page_id: `cert-memory-${startBody.challenge.id}`,
              memory_replayed: true,
            }),
          ],
        );
      }
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
  assert.equal(mcpOnlyBody.private_memory_verified, false);
  assert.equal(
    mcpOnlyBody.stages.find((stage: any) => stage.key === 'private_memory_round_trip')?.status,
    'pending',
  );

  const firstPoll = await app().request(
    `/api/agent-channel/v1/events?limit=100&lease_ms=30000&${autonomousCompatibilityQuery('certification-worker-1')}`,
    { headers: { authorization: `Bearer ${AUTH_CHANNEL_BEARER}` } },
  );
  const firstPollBody = await firstPoll.json() as any;
  assert.equal(firstPoll.status, 200, JSON.stringify(firstPollBody));
  const firstClaim = firstPollBody.events.find((event: any) => event.id === startBody.channel_event.id);
  assert.ok(firstClaim?.claim_token, JSON.stringify(firstPollBody));

  const firstAccept = await app().request('/api/agent-channel/v1/accept', {
    method: 'POST',
    headers: { authorization: `Bearer ${AUTH_CHANNEL_BEARER}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: firstClaim.id,
      claim_token: firstClaim.claim_token,
      caller_employee_slug: AUTH_EMPLOYEE_SLUG,
    }),
  });
  assert.equal(firstAccept.status, 200, await firstAccept.text());

  const acceptedWithoutFreshEvidence = await app().request(
    `/api/agent-employees/${AUTH_EMPLOYEE_ID}/certification/check`,
    { method: 'POST' },
  );
  const acceptedWithoutFreshEvidenceBody = await acceptedWithoutFreshEvidence.json() as any;
  assert.equal(acceptedWithoutFreshEvidence.status, 200, JSON.stringify(acceptedWithoutFreshEvidenceBody));
  assert.equal(acceptedWithoutFreshEvidenceBody.completed, false);
  assert.ok(
    acceptedWithoutFreshEvidenceBody.missing_tools.length > 0,
    'tool calls made before native acceptance must not satisfy the challenge',
  );
  assert.equal(acceptedWithoutFreshEvidenceBody.nonce_seen, false);
  assert.equal(acceptedWithoutFreshEvidenceBody.private_memory_verified, false);

  // The identical pre-accept calls above are deliberately insufficient. The
  // qualifying tool, nonce, and memory evidence must be causally bounded
  // between native transport acceptance and the one final reply.
  await withClient(async (client) => {
    for (const tool of startBody.challenge.required_tools) {
      await client.query(
        `INSERT INTO agent_mcp_call_audit
           (id, org_id, employee_id, tool_name, success, created_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, true, now())`,
        [ORG_ID, AUTH_EMPLOYEE_ID, tool],
      );
      if (tool === 'memory_write') {
        await client.query(
          `INSERT INTO agent_mcp_call_audit
             (id, org_id, employee_id, tool_name, success, metadata, created_at)
           VALUES (gen_random_uuid()::text, $1, $2, $3, true, $4::jsonb, now())`,
          [
            ORG_ID,
            AUTH_EMPLOYEE_ID,
            tool,
            JSON.stringify({
              memory_page_id: `cert-memory-${startBody.challenge.id}`,
              memory_replayed: true,
            }),
          ],
        );
      }
    }
    await client.query(
      `INSERT INTO agent_cooperative_log
         (id, org_id, employee_id, kind, summary, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, 'decision', $3, now())`,
      [ORG_ID, AUTH_EMPLOYEE_ID, `Certification ${startBody.challenge.nonce}`],
    );
    const pageId = `cert-memory-${startBody.challenge.id}`;
    await client.query(
      `INSERT INTO wiki_pages
         (id, org_id, scope, agent_employee_id, type, title, slug, summary, content,
          confidence, version, is_deleted, created_via, created_at, updated_at)
       VALUES ($1, $2, 'user', $3, 'fact', $4, $5, $4, $4,
         0.8, 1, false, 'hermes_memory_sync', now(), now())`,
      [pageId, ORG_ID, AUTH_EMPLOYEE_ID, `Certification ${startBody.challenge.nonce}`, `cert-memory-${startBody.challenge.id}`],
    );
    await client.query(
      `INSERT INTO wiki_memory_syncs
         (id, org_id, agent_employee_id, idempotency_key, content_digest, page_id,
          page_version, runtime_session_id, provenance, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 1, 'certification-test', '{}'::jsonb, now(), now())`,
      [ORG_ID, AUTH_EMPLOYEE_ID, `certification:${startBody.challenge.nonce}`, 'test-digest', pageId],
    );
  });

  await withClient(async (client) => {
    await client.query(
      'DELETE FROM space_members WHERE space_id = $1 AND user_id = $2',
      [startBody.challenge.id, AUTH_SHADOW_USER_ID],
    );
  });
  const failedFirstReply = await app().request('/api/agent-channel/v1/reply', {
    method: 'POST',
    headers: { authorization: `Bearer ${AUTH_CHANNEL_BEARER}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: firstClaim.id,
      content: `First generated certification reply ${startBody.challenge.nonce}`,
      idempotency_key: `certification-reply-${startBody.challenge.id}`,
      adapter_mode: 'autonomous_platform',
      caller_employee_slug: AUTH_EMPLOYEE_SLUG,
    }),
  });
  const failedFirstReplyBody = await failedFirstReply.json() as any;
  assert.equal(failedFirstReply.status, 500, JSON.stringify(failedFirstReplyBody));
  assert.equal(failedFirstReplyBody.ok, false);
  assert.equal(failedFirstReplyBody.idempotent, false);
  await withClient(async (client) => {
    const attempts = await client.query(
      `SELECT status FROM agent_channel_delivery_attempts
       WHERE org_id = $1 AND agent_employee_id = $2 AND event_id = $3
         AND direction = 'inbound_reply'`,
      [ORG_ID, AUTH_EMPLOYEE_ID, firstClaim.id],
    );
    assert.deepEqual(attempts.rows.map((row) => row.status), ['failed']);
    await client.query(
      `INSERT INTO space_members (id, space_id, user_id)
       VALUES (gen_random_uuid()::text, $1, $2)`,
      [startBody.challenge.id, AUTH_SHADOW_USER_ID],
    );
  });
  const reconnectAfterFailedReply = await app().request(
    `/api/agent-channel/v1/connect?${autonomousCompatibilityQuery('certification-worker-1')}`,
    { headers: { authorization: `Bearer ${AUTH_CHANNEL_BEARER}` } },
  );
  assert.equal(reconnectAfterFailedReply.status, 200, await reconnectAfterFailedReply.text());

  const firstReply = await app().request('/api/agent-channel/v1/reply', {
    method: 'POST',
    headers: { authorization: `Bearer ${AUTH_CHANNEL_BEARER}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: firstClaim.id,
      content: `Certification complete ${startBody.challenge.nonce}`,
      idempotency_key: `certification-reply-${startBody.challenge.id}`,
      adapter_mode: 'autonomous_platform',
      caller_employee_slug: AUTH_EMPLOYEE_SLUG,
    }),
  });
  const firstReplyBody = await firstReply.json() as any;
  assert.equal(firstReply.status, 200, JSON.stringify(firstReplyBody));
  assert.equal(firstReplyBody.idempotent, false);
  assert.equal(firstReplyBody.business_outcome, null);

  const firstReplyReplay = await app().request('/api/agent-channel/v1/reply', {
    method: 'POST',
    headers: { authorization: `Bearer ${AUTH_CHANNEL_BEARER}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: firstClaim.id,
      content: `Certification complete ${startBody.challenge.nonce}`,
      idempotency_key: `certification-reply-${startBody.challenge.id}`,
      adapter_mode: 'autonomous_platform',
      caller_employee_slug: AUTH_EMPLOYEE_SLUG,
    }),
  });
  const firstReplyReplayBody = await firstReplyReplay.json() as any;
  assert.equal(firstReplyReplay.status, 200, JSON.stringify(firstReplyReplayBody));
  assert.equal(firstReplyReplayBody.idempotent, true);

  const deepCheckResponse = await app().request(
    `/api/agent-employees/${AUTH_EMPLOYEE_ID}/certification/check`,
    { method: 'POST' },
  );
  assert.equal(deepCheckResponse.status, 200);
  const deepCheckBody = await deepCheckResponse.json() as any;
  assert.equal(deepCheckBody.completed, false, 'verification waits for a restart and fresh post-restart work');
  assert.equal(deepCheckBody.single_delivery, true);
  assert.equal(deepCheckBody.single_reply, true);
  assert.equal(deepCheckBody.channel_reply_nonce_seen, true);
  assert.equal(deepCheckBody.channel_completed, false);
  assert.equal(deepCheckBody.runtime_session_seen, false);
  assert.equal(deepCheckBody.runtime_execution_seen, true);
  assert.equal(deepCheckBody.runtime_execution_proof, 'autonomous_source_reply');
  assert.equal(deepCheckBody.private_memory_verified, true);
  assert.equal(deepCheckBody.restart_detected, false);

  const restartedConnect = await app().request(
    `/api/agent-channel/v1/connect?${autonomousCompatibilityQuery('certification-worker-2')}`,
    { headers: { authorization: `Bearer ${AUTH_CHANNEL_BEARER}` } },
  );
  assert.equal(restartedConnect.status, 200, await restartedConnect.text());
  const restartCheckResponse = await app().request(
    `/api/agent-employees/${AUTH_EMPLOYEE_ID}/certification/check`,
    { method: 'POST' },
  );
  const restartCheckBody = await restartCheckResponse.json() as any;
  assert.equal(restartCheckBody.restart_detected, true);
  assert.equal(restartCheckBody.restart_proof_event_seen, false);

  const restartPoll = await app().request(
    `/api/agent-channel/v1/events?limit=100&lease_ms=30000&${autonomousCompatibilityQuery('certification-worker-2')}`,
    { headers: { authorization: `Bearer ${AUTH_CHANNEL_BEARER}` } },
  );
  const restartPollBody = await restartPoll.json() as any;
  assert.equal(restartPoll.status, 200, JSON.stringify(restartPollBody));
  const restartClaim = restartPollBody.events.find((event: any) => event.kind === 'certification.restart_proof');
  assert.ok(restartClaim?.claim_token, JSON.stringify(restartPollBody));
  const durableRestartMessageId = `agent-channel-certification-reply:${restartClaim.id}`;

  const restartAccept = await app().request('/api/agent-channel/v1/accept', {
    method: 'POST',
    headers: { authorization: `Bearer ${AUTH_CHANNEL_BEARER}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: restartClaim.id,
      claim_token: restartClaim.claim_token,
      caller_employee_slug: AUTH_EMPLOYEE_SLUG,
    }),
  });
  assert.equal(restartAccept.status, 200, await restartAccept.text());

  const preProofPingCheck = await app().request(
    `/api/agent-employees/${AUTH_EMPLOYEE_ID}/certification/check`,
    { method: 'POST' },
  );
  const preProofPingBody = await preProofPingCheck.json() as any;
  assert.equal(preProofPingCheck.status, 200, JSON.stringify(preProofPingBody));
  assert.equal(preProofPingBody.restart_proof_ping_seen, false, 'the initial ping must not satisfy post-restart work');
  assert.equal(preProofPingBody.restart_proof_nonce_seen, false);

  await withClient(async (client) => {
    await client.query(
      `INSERT INTO agent_mcp_call_audit
         (id, org_id, employee_id, tool_name, success, created_at)
       VALUES ($1, $2, $3, 'ping_alive', true, now())`,
      [validRestartPingId, ORG_ID, AUTH_EMPLOYEE_ID],
    );
    await client.query(
      `INSERT INTO agent_cooperative_log
         (id, org_id, employee_id, kind, summary, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, 'decision', $3, now())`,
      [ORG_ID, AUTH_EMPLOYEE_ID, `Post-restart certification ${startBody.challenge.nonce}`],
    );
    await client.query(
      `INSERT INTO agent_channel_delivery_attempts
         (id, org_id, agent_employee_id, event_id, direction, idempotency_key,
          status, request_json, response_json, error)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'inbound_reply', $4,
         'failed', $5::jsonb, '{"error":"post-write bookkeeping failed"}'::jsonb,
         'post-write bookkeeping failed')`,
      [
        ORG_ID,
        AUTH_EMPLOYEE_ID,
        restartClaim.id,
        `certification-reply:${restartClaim.id}:final`,
        JSON.stringify({
          event_id: restartClaim.id,
          content: `Persisted before reply bookkeeping ${startBody.challenge.nonce}`,
          adapter_mode: 'autonomous_platform',
        }),
      ],
    );
    await client.query(
      `INSERT INTO messages
         (id, org_id, space_id, user_id, content, parent_id)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [
        durableRestartMessageId,
        ORG_ID,
        startBody.challenge.id,
        AUTH_SHADOW_USER_ID,
        `Persisted before reply bookkeeping ${startBody.challenge.nonce}`,
      ],
    );
  });

  const restartReply = await app().request('/api/agent-channel/v1/reply', {
    method: 'POST',
    headers: { authorization: `Bearer ${AUTH_CHANNEL_BEARER}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: restartClaim.id,
      content: 'Regenerated restart response after bookkeeping recovery',
      idempotency_key: `certification-restart-reply-${startBody.challenge.id}`,
      adapter_mode: 'autonomous_platform',
      caller_employee_slug: AUTH_EMPLOYEE_SLUG,
    }),
  });
  const restartReplyBody = await restartReply.json() as any;
  assert.equal(restartReply.status, 200, JSON.stringify(restartReplyBody));
  assert.equal(restartReplyBody.idempotent, true);
  assert.equal(restartReplyBody.reconciled, true);
  assert.equal(restartReplyBody.business_outcome, null);

  const restartReplyReplay = await app().request('/api/agent-channel/v1/reply', {
    method: 'POST',
    headers: { authorization: `Bearer ${AUTH_CHANNEL_BEARER}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: restartClaim.id,
      content: `Restart proof ${startBody.challenge.nonce}`,
      idempotency_key: `certification-restart-reply-${startBody.challenge.id}`,
      adapter_mode: 'autonomous_platform',
      caller_employee_slug: AUTH_EMPLOYEE_SLUG,
    }),
  });
  const restartReplyReplayBody = await restartReplyReplay.json() as any;
  assert.equal(restartReplyReplay.status, 200, JSON.stringify(restartReplyReplayBody));
  assert.equal(restartReplyReplayBody.idempotent, true);

  const finalCheckResponse = await app().request(
    `/api/agent-employees/${AUTH_EMPLOYEE_ID}/certification/check`,
    { method: 'POST' },
  );
  const finalCheckBody = await finalCheckResponse.json() as any;
  assert.equal(finalCheckBody.completed, true);
  assert.equal(finalCheckBody.restart_proof_completed, true);
  assert.equal(finalCheckBody.restart_proof_ping_seen, true);
  assert.equal(finalCheckBody.restart_proof_nonce_seen, true);
  assert.equal(finalCheckBody.restart_proof_reply_nonce_seen, true);
  assert.equal(finalCheckBody.restart_proof_single_reply, true);
  assert.equal(finalCheckBody.restart_execution_proof, 'autonomous_source_reply');
  assert.equal(finalCheckBody.private_memory_verified, true);

  await withClient(async (client) => {
    const nativeEvents = await client.query(
      `SELECT status, work_outcome, completed_at, claim_token, claim_owner, lease_expires_at
       FROM agent_channel_events
       WHERE org_id = $1 AND agent_employee_id = $2 AND source_kind = 'certification'
         AND source_id = $3
       ORDER BY created_at`,
      [ORG_ID, AUTH_EMPLOYEE_ID, startBody.challenge.id],
    );
    assert.equal(nativeEvents.rows.length, 2);
    for (const event of nativeEvents.rows) {
      assert.equal(event.status, 'acknowledged');
      assert.equal(event.work_outcome, null);
      assert.equal(event.completed_at, null);
      assert.equal(event.claim_token, null);
      assert.equal(event.claim_owner, null);
      assert.equal(event.lease_expires_at, null);
    }
    const proofTimestamps = await client.query(
      `SELECT challenge.completed_at, employee.last_verified_at
       FROM agent_certification_challenges challenge
       JOIN agent_employees employee
         ON employee.id = challenge.employee_id AND employee.org_id = challenge.org_id
       WHERE challenge.id = $1 AND challenge.org_id = $2`,
      [startBody.challenge.id, ORG_ID],
    );
    assert.equal(proofTimestamps.rows.length, 1);
    originalCompletedAt = proofTimestamps.rows[0].completed_at.toISOString();
    originalVerifiedAt = proofTimestamps.rows[0].last_verified_at.toISOString();
  });

  const regeneratedLateReply = await app().request('/api/agent-channel/v1/reply', {
    method: 'POST',
    headers: { authorization: `Bearer ${AUTH_CHANNEL_BEARER}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: restartClaim.id,
      content: `Regenerated restart proof ${startBody.challenge.nonce}`,
      idempotency_key: `different-certification-restart-reply-${startBody.challenge.id}`,
      adapter_mode: 'autonomous_platform',
      caller_employee_slug: AUTH_EMPLOYEE_SLUG,
    }),
  });
  const regeneratedLateReplyBody = await regeneratedLateReply.json() as any;
  assert.equal(regeneratedLateReply.status, 200, JSON.stringify(regeneratedLateReplyBody));
  assert.equal(regeneratedLateReplyBody.idempotent, true);

  await new Promise((resolve) => setTimeout(resolve, 20));
  const persistedCheckResponse = await app().request(
    `/api/agent-employees/${AUTH_EMPLOYEE_ID}/certification/check`,
    { method: 'POST' },
  );
  const persistedCheckBody = await persistedCheckResponse.json() as any;
  assert.equal(persistedCheckResponse.status, 200, JSON.stringify(persistedCheckBody));
  assert.equal(persistedCheckBody.completed, true, 'the recorded certification result remains durable');
  assert.equal(persistedCheckBody.channel_completed, false, 'native transport must remain nonterminal');
  assert.equal(persistedCheckBody.runtime_session_seen, false, 'adapter diagnostics are not execution proof');
  assert.equal(persistedCheckBody.runtime_execution_proof, 'autonomous_source_reply');
  assert.equal(persistedCheckBody.restart_proof_ping_seen, true);
  assert.equal(persistedCheckBody.restart_proof_nonce_seen, true);
  assert.equal(persistedCheckBody.restart_proof_completed, true);
  assert.doesNotMatch(
    persistedCheckBody.stages.find((stage: any) => stage.key === 'runtime_inference')?.detail ?? '',
    /terminal supervised/i,
  );
  await withClient(async (client) => {
    const proofTimestamps = await client.query(
      `SELECT challenge.completed_at, employee.last_verified_at
       FROM agent_certification_challenges challenge
       JOIN agent_employees employee
         ON employee.id = challenge.employee_id AND employee.org_id = challenge.org_id
       WHERE challenge.id = $1 AND challenge.org_id = $2`,
      [startBody.challenge.id, ORG_ID],
    );
    assert.equal(proofTimestamps.rows[0].completed_at.toISOString(), originalCompletedAt);
    assert.equal(proofTimestamps.rows[0].last_verified_at.toISOString(), originalVerifiedAt);
    const successfulRestartReplies = await client.query(
      `SELECT count(*)::int AS count
       FROM agent_channel_delivery_attempts
       WHERE org_id = $1 AND agent_employee_id = $2 AND event_id = $3
         AND direction = 'inbound_reply' AND status = 'completed'`,
      [ORG_ID, AUTH_EMPLOYEE_ID, restartClaim.id],
    );
    assert.equal(successfulRestartReplies.rows[0].count, 1);
    const durableRestartMessages = await client.query(
      `SELECT content FROM messages
       WHERE id = $1 AND org_id = $2 AND space_id = $3`,
      [durableRestartMessageId, ORG_ID, startBody.challenge.id],
    );
    assert.equal(durableRestartMessages.rows.length, 1);
    assert.match(durableRestartMessages.rows[0].content, new RegExp(startBody.challenge.nonce));

    await client.query(
      `WITH durable_reply AS (
         SELECT created_at FROM messages WHERE id = $1 AND org_id = $2
       )
       UPDATE agent_channel_delivery_attempts attempt
       SET updated_at = durable_reply.created_at + interval '2 seconds'
       FROM durable_reply
       WHERE attempt.org_id = $2
         AND attempt.agent_employee_id = $3
         AND attempt.event_id = $4
         AND attempt.direction = 'inbound_reply'
         AND attempt.status = 'completed'`,
      [durableRestartMessageId, ORG_ID, AUTH_EMPLOYEE_ID, restartClaim.id],
    );
    await client.query(
      `WITH durable_reply AS (
         SELECT created_at FROM messages WHERE id = $1 AND org_id = $2
       )
       UPDATE agent_mcp_call_audit audit
       SET created_at = durable_reply.created_at + interval '1 second'
       FROM durable_reply
       WHERE audit.id = $3 AND audit.org_id = $2`,
      [durableRestartMessageId, ORG_ID, validRestartPingId],
    );
    await client.query(
      `WITH durable_reply AS (
         SELECT created_at FROM messages WHERE id = $1 AND org_id = $2
       )
       UPDATE agent_cooperative_log cooperative
       SET created_at = durable_reply.created_at + interval '1 second'
       FROM durable_reply
       WHERE cooperative.org_id = $2
         AND cooperative.employee_id = $3
         AND cooperative.kind = 'decision'
         AND cooperative.summary = $4`,
      [
        durableRestartMessageId,
        ORG_ID,
        AUTH_EMPLOYEE_ID,
        `Post-restart certification ${startBody.challenge.nonce}`,
      ],
    );
  });

  const mutableBookkeepingCutoffResponse = await app().request(
    `/api/agent-employees/${AUTH_EMPLOYEE_ID}/certification/check`,
    { method: 'POST' },
  );
  const mutableBookkeepingCutoffBody = await mutableBookkeepingCutoffResponse.json() as any;
  assert.equal(
    mutableBookkeepingCutoffResponse.status,
    200,
    JSON.stringify(mutableBookkeepingCutoffBody),
  );
  assert.equal(mutableBookkeepingCutoffBody.completed, false);
  assert.equal(
    mutableBookkeepingCutoffBody.restart_proof_ping_seen,
    false,
    'evidence committed after the durable message cannot be admitted by a later bookkeeping update',
  );
  assert.equal(mutableBookkeepingCutoffBody.restart_proof_nonce_seen, false);

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
