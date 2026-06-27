/**
 * Phase 6.5 — HTTP route tests for approve / reject / pending endpoints.
 *
 * Run: pnpm --filter @deft/api test -- agent-actions-routes
 *
 * These tests exercise the Hono routes via app.request() so the route
 * handlers, JSON parsing, and error codes are all covered end-to-end. We
 * skip the real JWT middleware by mounting agentRoutes into a bare Hono
 * instance with a small shim that sets c.var.user, matching what the
 * production authMiddleware would do on a valid token.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const EMP_ID = 'test-actions-routes-emp';
const EMP_SLUG = 'actions-routes-emp';
const SHADOW_USER_ID = 'test-actions-routes-shadow';
const APPROVER_USER_ID = 'test-actions-routes-approver';
const APPROVER_EMAIL = 'actions-routes-approver@test.local';
const VISIBLE_SPACE_ID = 'test-actions-routes-visible-space';
const HIDDEN_SPACE_ID = 'test-actions-routes-hidden-space';

let TEST_PROJECT_ID: string | null = null;
let testApp: Hono | null = null;
let createdTestOrg = false;

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
    const org = await c.query(
      `INSERT INTO orgs (id, name, slug)
       VALUES ($1, 'Actions Routes Test Org', 'actions-routes-test-org')
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [ORG_ID],
    );
    createdTestOrg = org.rows.length > 0;

    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, 'actions-routes-shadow@test.local', 'Actions Shadow', true)
       ON CONFLICT (id) DO NOTHING`,
      [SHADOW_USER_ID],
    );

    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Actions Approver', false)
       ON CONFLICT (id) DO NOTHING`,
      [APPROVER_USER_ID, APPROVER_EMAIL],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, APPROVER_USER_ID],
    );

    await c.query(
      `INSERT INTO spaces (id, org_id, name, type, created_by)
       VALUES
         ($1, $3, 'Actions Routes Visible', 'private', $4),
         ($2, $3, 'Actions Routes Hidden', 'private', $4)
       ON CONFLICT (id) DO UPDATE
         SET org_id = EXCLUDED.org_id,
             name = EXCLUDED.name,
             type = EXCLUDED.type,
             created_by = EXCLUDED.created_by,
             is_archived = false`,
      [VISIBLE_SPACE_ID, HIDDEN_SPACE_ID, ORG_ID, APPROVER_USER_ID],
    );
    await c.query(
      `INSERT INTO space_members (id, space_id, user_id)
       VALUES (gen_random_uuid()::text, $1, $2)
       ON CONFLICT (space_id, user_id) DO NOTHING`,
      [VISIBLE_SPACE_ID, APPROVER_USER_ID],
    );

    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, 'Actions Route Employee', $4,
         'project_manager', 'test', 'standard',
         true, true, $3)
       ON CONFLICT (id) DO UPDATE SET is_active = true, trust_level = 'standard'`,
      [EMP_ID, ORG_ID, SHADOW_USER_ID, EMP_SLUG],
    );

    const proj = await c.query(
      `SELECT id FROM projects WHERE org_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [ORG_ID],
    );
    if (proj.rows.length > 0) {
      TEST_PROJECT_ID = proj.rows[0].id;
    } else {
      const r = await c.query(
        `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
         VALUES (gen_random_uuid()::text, $1, 'Actions Routes Test Project', 'ART', $2, 0)
         RETURNING id`,
        [ORG_ID, SHADOW_USER_ID],
      );
      TEST_PROJECT_ID = r.rows[0].id;
    }
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    // Phase 7 — receipts FK to agent_actions + agent_employees, so delete
    // them first so the subsequent cascade doesn't bounce off the FK.
    await c.query(
      `DELETE FROM action_receipts
       WHERE action_id IN (SELECT id FROM agent_actions WHERE user_id = $1)
          OR employee_id = $2`,
      [SHADOW_USER_ID, EMP_ID],
    );
    await c.query(
      `DELETE FROM work_intents
       WHERE org_id = $1
          OR agent_employee_id = $2
          OR source_user_id IN ($3, $4)`,
      [ORG_ID, EMP_ID, SHADOW_USER_ID, APPROVER_USER_ID],
    );
    await c.query(
      `DELETE FROM agent_actions WHERE user_id = $1`,
      [SHADOW_USER_ID],
    );
    await c.query(
      `DELETE FROM messages WHERE space_id IN ($1, $2)`,
      [VISIBLE_SPACE_ID, HIDDEN_SPACE_ID],
    );
    await c.query(
      `DELETE FROM space_members WHERE space_id IN ($1, $2)`,
      [VISIBLE_SPACE_ID, HIDDEN_SPACE_ID],
    );
    await c.query(
      `DELETE FROM spaces WHERE id IN ($1, $2)`,
      [VISIBLE_SPACE_ID, HIDDEN_SPACE_ID],
    );
    if (TEST_PROJECT_ID) {
      await c.query(
        `DELETE FROM task_activity
         WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1 AND created_by = $2)`,
        [TEST_PROJECT_ID, SHADOW_USER_ID],
      );
      await c.query(
        `DELETE FROM tasks WHERE project_id = $1 AND created_by = $2`,
        [TEST_PROJECT_ID, SHADOW_USER_ID],
      );
    }
    await c.query(
      `DELETE FROM org_members WHERE user_id = $1`,
      [APPROVER_USER_ID],
    );
    await c.query(
      `DELETE FROM agent_employees WHERE id = $1`,
      [EMP_ID],
    );
    // FK cluster fix: a project may have been created with lead_id =
    // SHADOW_USER_ID in seedFixtures() when the org had no existing
    // project. Drop the FK reference (null-out lead_id) so the user
    // delete below succeeds.
    await c.query(
      `UPDATE projects SET lead_id = NULL WHERE lead_id IN ($1, $2)`,
      [SHADOW_USER_ID, APPROVER_USER_ID],
    );
    await c.query(
      `DELETE FROM users WHERE id IN ($1, $2)`,
      [SHADOW_USER_ID, APPROVER_USER_ID],
    );
    if (createdTestOrg) {
      await c.query(
        `DELETE FROM orgs WHERE id = $1 AND slug = 'actions-routes-test-org'`,
        [ORG_ID],
      );
    }
  });
}

async function insertPendingTaskCreate(title: string): Promise<string> {
  return withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO agent_actions
        (id, org_id, user_id, agent_employee_id, source, action, params,
         approval_tier, approval_status)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'mcp', 'task_create', $4::jsonb, 'quick', 'pending')
       RETURNING id`,
      [
        ORG_ID,
        SHADOW_USER_ID,
        EMP_ID,
        JSON.stringify({
          caller_employee_slug: EMP_SLUG,
          title,
          project_id: TEST_PROJECT_ID,
          priority: 'p2',
        }),
      ],
    );
    return r.rows[0].id as string;
  });
}

async function insertLegacyCreateTaskWithoutProject(title: string): Promise<string> {
  return withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO agent_actions
        (id, org_id, user_id, source, action, params,
         approval_tier, approval_status)
       VALUES (gen_random_uuid()::text, $1, $2, 'blocked_classifier', 'create_task', $3::jsonb, 'quick', 'pending')
       RETURNING id`,
      [
        ORG_ID,
        SHADOW_USER_ID,
        JSON.stringify({
          title,
          description: 'Legacy create_task rows need a resolvable project_name.',
        }),
      ],
    );
    return r.rows[0].id as string;
  });
}

async function insertDeftyTaskCreateWithIntent(title: string): Promise<{ actionId: string; intentId: string }> {
  return withClient(async (c) => {
    const dedupeKey = `routes-work-intent:${crypto.randomUUID()}`;
    const intent = await c.query(
      `INSERT INTO work_intents
        (id, org_id, source_user_id, agent_employee_id, kind, status, title,
         summary, proposed_action, proposed_params, dedupe_key)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'task_candidate', 'proposed',
         $4, $5, 'task_create', $6::jsonb, $7)
       RETURNING id`,
      [
        ORG_ID,
        APPROVER_USER_ID,
        EMP_ID,
        title,
        `Create ${title}`,
        JSON.stringify({
          title,
          project_id: TEST_PROJECT_ID,
          priority: 'p2',
        }),
        dedupeKey,
      ],
    );
    const intentId = intent.rows[0].id as string;
    const action = await c.query(
      `INSERT INTO agent_actions
        (id, org_id, user_id, agent_employee_id, source, action, params,
         approval_tier, approval_status)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'defty_capture', 'task_create', $4::jsonb, 'quick', 'pending')
       RETURNING id`,
      [
        ORG_ID,
        SHADOW_USER_ID,
        EMP_ID,
        JSON.stringify({
          caller_employee_slug: EMP_SLUG,
          title,
          project_id: TEST_PROJECT_ID,
          priority: 'p2',
          work_intent_id: intentId,
          work_intent_status: 'proposed',
          capture_kind: 'task_candidate',
          proposed_by: 'defty',
          dedupe_key: dedupeKey,
        }),
      ],
    );
    return { actionId: action.rows[0].id as string, intentId };
  });
}

async function insertWorkIntentWithSource(params: {
  title: string;
  spaceId: string;
  messageSpaceId?: string;
  messageContent: string;
  status?: 'proposed' | 'failed';
}): Promise<{ intentId: string; messageId: string }> {
  return withClient(async (c) => {
    const messageId = `routes-work-intent-msg-${crypto.randomUUID()}`;
    const messageSpaceId = params.messageSpaceId ?? params.spaceId;
    await c.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content)
       VALUES ($1, $2, $3, $4, $5)`,
      [messageId, ORG_ID, messageSpaceId, APPROVER_USER_ID, params.messageContent],
    );

    const intent = await c.query(
      `INSERT INTO work_intents
        (id, org_id, space_id, source_message_id, source_user_id,
         agent_employee_id, kind, status, title, summary, proposed_action,
         proposed_params, dedupe_key, failure_reason)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5,
         'task_candidate', $6, $7, $8, 'task_create', $9::jsonb, $10, $11)
       RETURNING id`,
      [
        ORG_ID,
        params.spaceId,
        messageId,
        APPROVER_USER_ID,
        EMP_ID,
        params.status ?? 'proposed',
        params.title,
        `Summary ${params.title}`,
        JSON.stringify({
          title: params.title,
          project_id: TEST_PROJECT_ID,
          priority: 'p2',
        }),
        `routes-work-intent-source:${crypto.randomUUID()}`,
        params.status === 'failed' ? 'Project not found' : null,
      ],
    );
    return { intentId: intent.rows[0].id as string, messageId };
  });
}

async function insertDeftyCaptureActionWithSource(params: {
  title: string;
  spaceId: string;
  messageContent: string;
}): Promise<{ actionId: string; messageId: string }> {
  return withClient(async (c) => {
    const messageId = `routes-capture-action-msg-${crypto.randomUUID()}`;
    await c.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content)
       VALUES ($1, $2, $3, $4, $5)`,
      [messageId, ORG_ID, params.spaceId, APPROVER_USER_ID, params.messageContent],
    );

    const action = await c.query(
      `INSERT INTO agent_actions
        (id, org_id, user_id, agent_employee_id, source, action, message_id,
         params, approval_tier, approval_status)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'defty_capture',
         'task_create', $4, $5::jsonb, 'quick', 'pending')
       RETURNING id`,
      [
        ORG_ID,
        SHADOW_USER_ID,
        EMP_ID,
        messageId,
        JSON.stringify({
          caller_employee_slug: EMP_SLUG,
          title: params.title,
          project_id: TEST_PROJECT_ID,
          priority: 'p2',
          source_message_id: messageId,
          source_space_id: params.spaceId,
          capture_kind: 'task_candidate',
          proposed_by: 'defty',
          dedupe_key: `routes-capture-action:${crypto.randomUUID()}`,
        }),
      ],
    );
    return { actionId: action.rows[0].id as string, messageId };
  });
}

async function insertFailedDeftyTaskIntent(title: string): Promise<{
  actionId: string;
  dedupeKey: string;
  intentId: string;
}> {
  return withClient(async (c) => {
    const dedupeKey = `routes-work-intent-failed:${crypto.randomUUID()}`;
    const intent = await c.query(
      `INSERT INTO work_intents
        (id, org_id, source_user_id, agent_employee_id, kind, status, title,
         summary, proposed_action, proposed_params, dedupe_key, failure_reason)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'task_candidate', 'failed',
         $4, $5, 'task_create', $6::jsonb, $7, 'Project not found')
       RETURNING id`,
      [
        ORG_ID,
        APPROVER_USER_ID,
        EMP_ID,
        title,
        `Create ${title}`,
        JSON.stringify({
          title,
          project_id: TEST_PROJECT_ID,
          priority: 'p2',
        }),
        dedupeKey,
      ],
    );
    const intentId = intent.rows[0].id as string;
    const action = await c.query(
      `INSERT INTO agent_actions
        (id, org_id, user_id, agent_employee_id, source, action, params,
         approval_tier, approval_status, approved_at, executed_at, error)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'defty_capture', 'task_create',
         $4::jsonb, 'quick', 'approved', NOW(), NOW(), 'Project not found')
       RETURNING id`,
      [
        ORG_ID,
        SHADOW_USER_ID,
        EMP_ID,
        JSON.stringify({
          caller_employee_slug: EMP_SLUG,
          title,
          project_id: TEST_PROJECT_ID,
          priority: 'p2',
          work_intent_id: intentId,
          work_intent_status: 'failed',
          capture_kind: 'task_candidate',
          proposed_by: 'defty',
          dedupe_key: dedupeKey,
        }),
      ],
    );
    const actionId = action.rows[0].id as string;
    await c.query(
      `UPDATE work_intents SET converted_action_id = $1 WHERE id = $2`,
      [actionId, intentId],
    );
    return { actionId, dedupeKey, intentId };
  });
}

before(async () => {
  await seedFixtures();

  // Build a test Hono app that sets the authenticated user context before
  // mounting agentRoutes. This sidesteps the JWT middleware so we don't
  // need to mint tokens in the test.
  const { agentRoutes } = await import('../src/routes/agent.js');
  const { workIntentRoutes } = await import('../src/routes/work-intents.js');
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    c.set('user', {
      id: APPROVER_USER_ID,
      email: APPROVER_EMAIL,
      org_id: ORG_ID,
    } as any);
    await next();
  });
  testApp.route('/api/agent', agentRoutes);
  testApp.route('/api/work-intents', workIntentRoutes);
});

after(async () => {
  await teardownFixtures();
});

function app(): Hono {
  if (!testApp) throw new Error('test app not initialized');
  return testApp;
}

// ─────────────────────────────────────────────────────────────────────────────

test('GET /api/agent/actions/pending returns MCP-queued actions', async () => {
  const title = `routes-pending-${Date.now()}`;
  await insertPendingTaskCreate(title);

  const res = await app().request('/api/agent/actions/pending', { method: 'GET' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.actions), 'expected { actions: [...] }');

  const match = body.actions.find(
    (a: any) => a.action === 'task_create' && a.params?.title === title,
  );
  assert.ok(match, 'seeded pending action should appear in list');
  assert.equal(match.proposer, 'employee');
  assert.equal(match.employee_slug, EMP_SLUG);
});

test('GET /api/work-intents lists proposed Defty work captures', async () => {
  const title = `routes-intent-list-${Date.now()}`;
  const { intentId } = await insertDeftyTaskCreateWithIntent(title);

  const res = await app().request('/api/work-intents?status=proposed', { method: 'GET' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.intents), 'expected { intents: [...] }');

  const match = body.intents.find((intent: any) => intent.id === intentId);
  assert.ok(match, 'seeded intent should appear in the proposed list');
  assert.equal(match.title, title);
  assert.equal(match.status, 'proposed');
  assert.equal(match.kind, 'task_candidate');
  assert.equal(match.proposed_action, 'task_create');
});

test('GET /api/work-intents filters hidden and mismatched source messages', async () => {
  const visible = await insertWorkIntentWithSource({
    title: `routes-intent-visible-${Date.now()}`,
    spaceId: VISIBLE_SPACE_ID,
    messageContent: 'visible source message',
  });
  const hidden = await insertWorkIntentWithSource({
    title: `routes-intent-hidden-${Date.now()}`,
    spaceId: HIDDEN_SPACE_ID,
    messageContent: 'hidden source message',
  });
  const mismatched = await insertWorkIntentWithSource({
    title: `routes-intent-redacted-${Date.now()}`,
    spaceId: VISIBLE_SPACE_ID,
    messageSpaceId: HIDDEN_SPACE_ID,
    messageContent: 'redacted source message',
  });

  const res = await app().request('/api/work-intents?status=proposed', { method: 'GET' });
  assert.equal(res.status, 200);
  const body = await res.json();

  const visibleMatch = body.intents.find((intent: any) => intent.id === visible.intentId);
  assert.ok(visibleMatch, 'visible-space intent should appear');
  assert.equal(visibleMatch.source_message_content, 'visible source message');
  assert.equal(visibleMatch.space_name, 'Actions Routes Visible');

  const hiddenMatch = body.intents.find((intent: any) => intent.id === hidden.intentId);
  assert.equal(hiddenMatch, undefined, 'hidden-space intent should not appear');

  const mismatchedMatch = body.intents.find((intent: any) => intent.id === mismatched.intentId);
  assert.equal(
    mismatchedMatch,
    undefined,
    'intent with a source message outside its claimed space should not appear',
  );

  const hiddenDetail = await app().request(`/api/work-intents/${hidden.intentId}`, {
    method: 'GET',
  });
  assert.equal(hiddenDetail.status, 404);
});

test('GET /api/agent action surfaces hide Defty captures from private spaces', async () => {
  const visible = await insertDeftyCaptureActionWithSource({
    title: `routes-visible-capture-action-${Date.now()}`,
    spaceId: VISIBLE_SPACE_ID,
    messageContent: 'visible capture action source',
  });
  const hidden = await insertDeftyCaptureActionWithSource({
    title: `routes-hidden-capture-action-${Date.now()}`,
    spaceId: HIDDEN_SPACE_ID,
    messageContent: 'hidden capture action source',
  });

  const pendingRes = await app().request('/api/agent/actions/pending', { method: 'GET' });
  assert.equal(pendingRes.status, 200);
  const pendingBody = await pendingRes.json();
  assert.ok(
    pendingBody.actions.some((action: any) => action.id === visible.actionId),
    'visible capture action should appear in pending approvals',
  );
  assert.equal(
    pendingBody.actions.some((action: any) => action.id === hidden.actionId),
    false,
    'hidden capture action should not appear in pending approvals',
  );

  const recentRes = await app().request('/api/agent/actions/recent?limit=50', { method: 'GET' });
  assert.equal(recentRes.status, 200);
  const recentBody = await recentRes.json();
  assert.ok(
    recentBody.actions.some((action: any) => action.id === visible.actionId),
    'visible capture action should appear in recent activity',
  );
  assert.equal(
    recentBody.actions.some((action: any) => action.id === hidden.actionId),
    false,
    'hidden capture action should not appear in recent activity',
  );

  const historyRes = await app().request('/api/agent/actions', { method: 'GET' });
  assert.equal(historyRes.status, 200);
  const historyBody = await historyRes.json();
  assert.ok(
    historyBody.some((action: any) => action.id === visible.actionId),
    'visible capture action should appear in action history',
  );
  assert.equal(
    historyBody.some((action: any) => action.id === hidden.actionId),
    false,
    'hidden capture action should not appear in action history',
  );
});

test('GET /api/agent/actions/:id/receipt respects hidden Defty capture ACL', async () => {
  const visible = await insertDeftyCaptureActionWithSource({
    title: `routes-visible-receipt-${Date.now()}`,
    spaceId: VISIBLE_SPACE_ID,
    messageContent: 'visible receipt source',
  });
  const hidden = await insertDeftyCaptureActionWithSource({
    title: `routes-hidden-receipt-${Date.now()}`,
    spaceId: HIDDEN_SPACE_ID,
    messageContent: 'hidden receipt source',
  });

  await withClient(async (c) => {
    for (const actionId of [visible.actionId, hidden.actionId]) {
      await c.query(
        `INSERT INTO action_receipts
          (id, org_id, action_id, employee_id, proposer, proposer_id, approver_id,
           decision, action_name, action_params_json, result_json, signature_hmac)
         VALUES (gen_random_uuid()::text, $1, $2, $3, 'defty', $4, $5,
           'rejected', 'task_create', '{}'::jsonb, NULL, 'test-signature')`,
        [ORG_ID, actionId, EMP_ID, SHADOW_USER_ID, APPROVER_USER_ID],
      );
    }
  });

  const visibleRes = await app().request(`/api/agent/actions/${visible.actionId}/receipt`, {
    method: 'GET',
  });
  assert.equal(visibleRes.status, 200);

  const hiddenRes = await app().request(`/api/agent/actions/${hidden.actionId}/receipt`, {
    method: 'GET',
  });
  assert.equal(hiddenRes.status, 404);
});

test('GET /api/agent expiry pass does not mutate hidden Defty captures', async () => {
  const hidden = await insertDeftyCaptureActionWithSource({
    title: `routes-hidden-stale-capture-${Date.now()}`,
    spaceId: HIDDEN_SPACE_ID,
    messageContent: 'hidden stale capture action source',
  });

  await withClient(async (c) => {
    await c.query(
      `UPDATE agent_actions
          SET created_at = NOW() - INTERVAL '25 hours',
              conversation_id = $2
        WHERE id = $1`,
      [hidden.actionId, HIDDEN_SPACE_ID],
    );
  });

  const pendingRes = await app().request('/api/agent/actions/pending', { method: 'GET' });
  assert.equal(pendingRes.status, 200);
  const pendingBody = await pendingRes.json();
  assert.equal(
    pendingBody.actions.some((action: any) => action.id === hidden.actionId),
    false,
    'hidden stale capture should not appear in pending approvals',
  );

  const conversationRes = await app().request(
    `/api/agent/conversations/${HIDDEN_SPACE_ID}/messages`,
    { method: 'GET' },
  );
  assert.equal(conversationRes.status, 404);

  const historyRes = await app().request('/api/agent/actions', { method: 'GET' });
  assert.equal(historyRes.status, 200);
  const historyBody = await historyRes.json();
  assert.equal(
    historyBody.some((action: any) => action.id === hidden.actionId),
    false,
    'hidden stale capture should not appear in action history',
  );

  await withClient(async (c) => {
    const action = await c.query(
      `SELECT approval_status FROM agent_actions WHERE id = $1`,
      [hidden.actionId],
    );
    assert.equal(
      action.rows[0].approval_status,
      'pending',
      'hidden stale capture must not be expired by a viewer who cannot see its source',
    );
  });
});

test('GET /api/agent/actions/pending expires linked proposed work intents', async () => {
  const title = `routes-intent-expire-${Date.now()}`;
  const { actionId, intentId } = await insertDeftyTaskCreateWithIntent(title);

  await withClient(async (c) => {
    await c.query(
      `UPDATE agent_actions
          SET created_at = NOW() - INTERVAL '25 hours'
        WHERE id = $1`,
      [actionId],
    );
  });

  const res = await app().request('/api/agent/actions/pending', { method: 'GET' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(
    body.actions.some((action: any) => action.id === actionId),
    false,
    'expired action should not remain pending',
  );

  await withClient(async (c) => {
    const action = await c.query(
      `SELECT approval_status FROM agent_actions WHERE id = $1`,
      [actionId],
    );
    assert.equal(action.rows[0].approval_status, 'expired');

    const intent = await c.query(
      `SELECT status, failure_reason FROM work_intents WHERE id = $1`,
      [intentId],
    );
    assert.equal(intent.rows[0].status, 'expired');
    assert.equal(intent.rows[0].failure_reason, 'Approval expired');
  });
});

test('POST /api/work-intents/:id/retry reopens failed capture as a fresh proposal', async () => {
  const title = `routes-intent-retry-${Date.now()}`;
  const failed = await insertFailedDeftyTaskIntent(title);

  const retryRes = await app().request(`/api/work-intents/${failed.intentId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(retryRes.status, 200);
  const retryBody = await retryRes.json();
  assert.equal(retryBody.success, true);
  assert.equal(retryBody.intent.retry_of_work_intent_id, failed.intentId);
  assert.ok(retryBody.intent.id);
  assert.ok(retryBody.action.id);

  const secondRetryRes = await app().request(`/api/work-intents/${failed.intentId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(secondRetryRes.status, 200);
  const secondRetryBody = await secondRetryRes.json();
  assert.equal(secondRetryBody.intent.id, retryBody.intent.id);
  assert.equal(secondRetryBody.action.id, retryBody.action.id);

  await withClient(async (c) => {
    const original = await c.query(
      `SELECT status, converted_action_id, failure_reason
         FROM work_intents
        WHERE id = $1`,
      [failed.intentId],
    );
    assert.equal(original.rows[0].status, 'failed');
    assert.equal(original.rows[0].converted_action_id, failed.actionId);
    assert.equal(original.rows[0].failure_reason, 'Project not found');

    const reopened = await c.query(
      `SELECT status, dedupe_key, metadata, proposed_params
         FROM work_intents
        WHERE id = $1`,
      [retryBody.intent.id],
    );
    assert.equal(reopened.rows[0].status, 'proposed');
    assert.notEqual(reopened.rows[0].dedupe_key, failed.dedupeKey);
    assert.equal(reopened.rows[0].metadata.retry_of_work_intent_id, failed.intentId);

    const action = await c.query(
      `SELECT approval_status, approval_tier, source, params
         FROM agent_actions
        WHERE id = $1`,
      [retryBody.action.id],
    );
    assert.equal(action.rows[0].approval_status, 'pending');
    assert.equal(action.rows[0].approval_tier, 'quick');
    assert.equal(action.rows[0].source, 'defty_capture');
    assert.equal(action.rows[0].params.work_intent_id, retryBody.intent.id);
    assert.equal(action.rows[0].params.retry_of_work_intent_id, failed.intentId);

    const retryIntentCount = await c.query(
      `SELECT COUNT(*)::int AS count
         FROM work_intents
        WHERE org_id = $1
          AND metadata->>'retry_of_work_intent_id' = $2`,
      [ORG_ID, failed.intentId],
    );
    assert.equal(retryIntentCount.rows[0].count, 1);

    const retryActionCount = await c.query(
      `SELECT COUNT(*)::int AS count
         FROM agent_actions
        WHERE org_id = $1
          AND params->>'retry_of_work_intent_id' = $2`,
      [ORG_ID, failed.intentId],
    );
    assert.equal(retryActionCount.rows[0].count, 1);
  });

  const approveRes = await app().request(`/api/agent/actions/${retryBody.action.id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(approveRes.status, 200);
  const approveBody = await approveRes.json();
  assert.equal(approveBody.status, 'approved', `body: ${JSON.stringify(approveBody)}`);

  await withClient(async (c) => {
    const original = await c.query(
      `SELECT status FROM work_intents WHERE id = $1`,
      [failed.intentId],
    );
    assert.equal(original.rows[0].status, 'failed');

    const reopened = await c.query(
      `SELECT status, converted_action_id, converted_task_id, converted_by
         FROM work_intents
        WHERE id = $1`,
      [retryBody.intent.id],
    );
    assert.equal(reopened.rows[0].status, 'converted');
    assert.equal(reopened.rows[0].converted_action_id, retryBody.action.id);
    assert.ok(reopened.rows[0].converted_task_id);
    assert.equal(reopened.rows[0].converted_by, APPROVER_USER_ID);

    const task = await c.query(
      `SELECT title FROM tasks WHERE id = $1`,
      [reopened.rows[0].converted_task_id],
    );
    assert.equal(task.rows[0].title, title);
  });

  const duplicateRetryRes = await app().request(`/api/work-intents/${failed.intentId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(duplicateRetryRes.status, 409);
  const duplicateRetryBody = await duplicateRetryRes.json();
  assert.equal(duplicateRetryBody.code, 'RETRY_ALREADY_CONVERTED');
});

test('POST /api/work-intents/:id/retry creates a fresh proposal after a retry is rejected', async () => {
  const title = `routes-intent-retry-terminal-${Date.now()}`;
  const failed = await insertFailedDeftyTaskIntent(title);

  const firstRetryRes = await app().request(`/api/work-intents/${failed.intentId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(firstRetryRes.status, 200);
  const firstRetryBody = await firstRetryRes.json();

  const rejectRes = await app().request(`/api/agent/actions/${firstRetryBody.action.id}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'still too noisy' }),
  });
  assert.equal(rejectRes.status, 200);

  const secondRetryRes = await app().request(`/api/work-intents/${failed.intentId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(secondRetryRes.status, 200);
  const secondRetryBody = await secondRetryRes.json();

  assert.notEqual(secondRetryBody.intent.id, firstRetryBody.intent.id);
  assert.notEqual(secondRetryBody.action.id, firstRetryBody.action.id);

  await withClient(async (c) => {
    const intents = await c.query(
      `SELECT id, status, failure_reason
         FROM work_intents
        WHERE org_id = $1
          AND metadata->>'retry_of_work_intent_id' = $2
        ORDER BY created_at ASC`,
      [ORG_ID, failed.intentId],
    );
    assert.equal(intents.rows.length, 2);
    assert.equal(intents.rows[0].id, firstRetryBody.intent.id);
    assert.equal(intents.rows[0].status, 'dismissed');
    assert.equal(intents.rows[0].failure_reason, 'still too noisy');
    assert.equal(intents.rows[1].id, secondRetryBody.intent.id);
    assert.equal(intents.rows[1].status, 'proposed');

    const firstAction = await c.query(
      `SELECT approval_status FROM agent_actions WHERE id = $1`,
      [firstRetryBody.action.id],
    );
    assert.equal(firstAction.rows[0].approval_status, 'rejected');

    const secondAction = await c.query(
      `SELECT approval_status, params
         FROM agent_actions
        WHERE id = $1`,
      [secondRetryBody.action.id],
    );
    assert.equal(secondAction.rows[0].approval_status, 'pending');
    assert.equal(secondAction.rows[0].params.work_intent_id, secondRetryBody.intent.id);
    assert.equal(secondAction.rows[0].params.retry_of_work_intent_id, failed.intentId);
  });
});

test('POST /api/agent/actions/:id/approve executes the write', async () => {
  const title = `routes-approve-${Date.now()}`;
  const actionId = await insertPendingTaskCreate(title);

  const res = await app().request(`/api/agent/actions/${actionId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'approved', `body: ${JSON.stringify(body)}`);

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT approval_status, executed_at FROM agent_actions WHERE id = $1`,
      [actionId],
    );
    assert.equal(r.rows[0].approval_status, 'approved');
    assert.ok(r.rows[0].executed_at);

    const t = await c.query(`SELECT title FROM tasks WHERE title = $1`, [title]);
    assert.equal(t.rows.length, 1);
  });
});

test('POST approve task_create repairs stale project counter before insert', async () => {
  const title = `routes-counter-drift-${Date.now()}`;
  let projectId: string | null = null;
  let actionId: string | null = null;

  try {
    await withClient(async (c) => {
      const project = await c.query(
        `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
         VALUES (gen_random_uuid()::text, $1, $2, 'DRIFT', $3, 0)
         RETURNING id`,
        [ORG_ID, `Counter Drift ${Date.now()}`, SHADOW_USER_ID],
      );
      projectId = project.rows[0].id as string;

      await c.query(
        `INSERT INTO tasks
           (id, org_id, project_id, number, title, status, priority, created_by, is_deleted)
         VALUES (gen_random_uuid()::text, $1, $2, 7, 'Existing high-number task', 'todo', 'p2', $3, false)`,
        [ORG_ID, projectId, SHADOW_USER_ID],
      );

      const action = await c.query(
        `INSERT INTO agent_actions
          (id, org_id, user_id, agent_employee_id, source, action, params,
           approval_tier, approval_status)
         VALUES (gen_random_uuid()::text, $1, $2, $3, 'mcp', 'task_create', $4::jsonb, 'quick', 'pending')
         RETURNING id`,
        [
          ORG_ID,
          SHADOW_USER_ID,
          EMP_ID,
          JSON.stringify({
            caller_employee_slug: EMP_SLUG,
            title,
            project_id: projectId,
            priority: 'p2',
          }),
        ],
      );
      actionId = action.rows[0].id as string;
    });

    const res = await app().request(`/api/agent/actions/${actionId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'approved', `body: ${JSON.stringify(body)}`);
    assert.equal(body.result.number, 8);

    await withClient(async (c) => {
      const created = await c.query(
        `SELECT number FROM tasks WHERE project_id = $1 AND title = $2`,
        [projectId, title],
      );
      assert.equal(created.rows.length, 1);
      assert.equal(created.rows[0].number, 8);

      const project = await c.query(
        `SELECT task_counter FROM projects WHERE id = $1`,
        [projectId],
      );
      assert.equal(project.rows[0].task_counter, 8);
    });
  } finally {
    await withClient(async (c) => {
      if (actionId) {
        await c.query(`DELETE FROM action_receipts WHERE action_id = $1`, [actionId]);
        await c.query(`DELETE FROM agent_actions WHERE id = $1`, [actionId]);
      }
      if (projectId) {
        await c.query(
          `DELETE FROM task_activity
           WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)`,
          [projectId],
        );
        await c.query(`DELETE FROM tasks WHERE project_id = $1`, [projectId]);
        await c.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
      }
    });
  }
});

test('POST approve on Defty work capture converts the work intent', async () => {
  const title = `routes-intent-approve-${Date.now()}`;
  const { actionId, intentId } = await insertDeftyTaskCreateWithIntent(title);

  const res = await app().request(`/api/agent/actions/${actionId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'approved', `body: ${JSON.stringify(body)}`);

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT status, converted_action_id, converted_task_id, converted_by, converted_at
         FROM work_intents
        WHERE id = $1`,
      [intentId],
    );
    assert.equal(r.rows[0].status, 'converted');
    assert.equal(r.rows[0].converted_action_id, actionId);
    assert.ok(r.rows[0].converted_task_id, 'converted intent should link to the created task');
    assert.equal(r.rows[0].converted_by, APPROVER_USER_ID);
    assert.ok(r.rows[0].converted_at);

    const task = await c.query(
      `SELECT title FROM tasks WHERE id = $1`,
      [r.rows[0].converted_task_id],
    );
    assert.equal(task.rows[0].title, title);
  });
});

test('POST reject after Defty work capture approval leaves the intent converted', async () => {
  const title = `routes-intent-late-reject-${Date.now()}`;
  const { actionId, intentId } = await insertDeftyTaskCreateWithIntent(title);

  const approveRes = await app().request(`/api/agent/actions/${actionId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(approveRes.status, 200);

  const rejectRes = await app().request(`/api/agent/actions/${actionId}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'too late' }),
  });
  assert.equal(rejectRes.status, 200);
  const rejectBody = await rejectRes.json();
  assert.equal(rejectBody.status, 'approved');

  await withClient(async (c) => {
    const intent = await c.query(
      `SELECT status, converted_action_id, dismissed_by, failure_reason
         FROM work_intents
        WHERE id = $1`,
      [intentId],
    );
    assert.equal(intent.rows[0].status, 'converted');
    assert.equal(intent.rows[0].converted_action_id, actionId);
    assert.equal(intent.rows[0].dismissed_by, null);
    assert.equal(intent.rows[0].failure_reason, null);

    const tasks = await c.query(
      `SELECT COUNT(*)::int AS count FROM tasks WHERE title = $1`,
      [title],
    );
    assert.equal(tasks.rows[0].count, 1, 'late reject must not duplicate or delete the task');
  });
});

test('POST approve on failed legacy action returns non-2xx and leaves it pending', async () => {
  const title = `routes-legacy-fail-${Date.now()}`;
  const actionId = await insertLegacyCreateTaskWithoutProject(title);

  const res = await app().request(`/api/agent/actions/${actionId}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.code, 'EXECUTE_FAILED');
  assert.equal(body.success, false);

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT approval_status, error FROM agent_actions WHERE id = $1`,
      [actionId],
    );
    assert.equal(r.rows[0].approval_status, 'pending');
    assert.equal(r.rows[0].error, 'Project not found');

    const t = await c.query(`SELECT id FROM tasks WHERE title = $1`, [title]);
    assert.equal(t.rows.length, 0, 'failed legacy approve must not create a task');
  });
});

test('POST /api/agent/actions/:id/reject with reason records reason', async () => {
  const title = `routes-reject-${Date.now()}`;
  const actionId = await insertPendingTaskCreate(title);

  const res = await app().request(`/api/agent/actions/${actionId}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'looks unsafe' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'rejected');

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT approval_status, error FROM agent_actions WHERE id = $1`,
      [actionId],
    );
    assert.equal(r.rows[0].approval_status, 'rejected');
    assert.equal(r.rows[0].error, 'looks unsafe');
    const t = await c.query(`SELECT id FROM tasks WHERE title = $1`, [title]);
    assert.equal(t.rows.length, 0, 'reject must not create a task');
  });
});

test('POST reject on Defty work capture dismisses the work intent', async () => {
  const title = `routes-intent-reject-${Date.now()}`;
  const { actionId, intentId } = await insertDeftyTaskCreateWithIntent(title);

  const res = await app().request(`/api/agent/actions/${actionId}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'not actually work' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'rejected');

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT status, converted_action_id, dismissed_by, dismissed_at, failure_reason
         FROM work_intents
        WHERE id = $1`,
      [intentId],
    );
    assert.equal(r.rows[0].status, 'dismissed');
    assert.equal(r.rows[0].converted_action_id, actionId);
    assert.equal(r.rows[0].dismissed_by, APPROVER_USER_ID);
    assert.ok(r.rows[0].dismissed_at);
    assert.equal(r.rows[0].failure_reason, 'not actually work');

    const task = await c.query(`SELECT id FROM tasks WHERE title = $1`, [title]);
    assert.equal(task.rows.length, 0, 'reject must not create a task');
  });
});

test('POST approve on unknown action returns 404', async () => {
  const res = await app().request(
    '/api/agent/actions/ghost-action-id/approve',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
  // The existing agent.ts handler filters by org_id first so unknown ids
  // return 404 from the outer check, not the resolver.
  assert.equal(res.status, 404);
});

test('double approve is idempotent via HTTP', async () => {
  const title = `routes-double-${Date.now()}`;
  const actionId = await insertPendingTaskCreate(title);

  const first = await app().request(
    `/api/agent/actions/${actionId}/approve`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
  assert.equal(first.status, 200);

  const second = await app().request(
    `/api/agent/actions/${actionId}/approve`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
  assert.equal(second.status, 200, 'second approve should be idempotent 200');
  const body = await second.json();
  assert.equal(body.status, 'approved');

  await withClient(async (c) => {
    const t = await c.query(
      `SELECT COUNT(*)::int AS n FROM tasks WHERE title = $1`,
      [title],
    );
    assert.equal(t.rows[0].n, 1, 'no double task insert');
  });
});
