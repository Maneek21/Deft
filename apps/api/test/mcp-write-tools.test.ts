/**
 * Phase 4 — MCP write tools + approval gating tests.
 *
 * Run: pnpm --filter @deft/api test -- mcp-write-tools
 *
 * Covers:
 *   1. task_create with standard-trust employee auto-executes
 *   2. task_create with conservative-trust employee queues for approval
 *   3. message_post with standard trust returns pseudo-result (full-review tier)
 *   4. message_post with autonomous trust auto-executes (full-tier unlocked)
 *   5. memory_update rejects cross-employee updates
 *   6. memory_update scope promotion returns pseudo-result for conservative
 *   7. space_memory_set → space_memory_get round-trip
 *   8. delegation_self_report auto-executes to agent_actions
 *   9. Cache invalidation: platform_context → task_create → platform_context no cache
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

// Three employees, one per trust level. Phase 9: every employee has its
// own bearer token (Defty has no row, BYOA agents resolve 1:1).
const EMP_CONSERVATIVE_ID = 'test-mcp-phase4-cons';
const EMP_CONSERVATIVE_SLUG = 'mcp-phase4-cons';
const EMP_STANDARD_ID = 'test-mcp-phase4-std';
const EMP_STANDARD_SLUG = 'mcp-phase4-std';
const EMP_AUTONOMOUS_ID = 'test-mcp-phase4-auto';
const EMP_AUTONOMOUS_SLUG = 'mcp-phase4-auto';
const TEST_USER_ID = 'test-mcp-phase4-user';
const OTHER_EMP_ID = 'test-mcp-phase4-other';
const OTHER_EMP_SLUG = 'mcp-phase4-other';

const TOKENS_BY_SLUG = new Map<string, string>();
let testApp: Hono | null = null;
let TEST_PROJECT_ID: string | null = null;
let TEST_SPACE_ID: string | null = null;
let OTHER_EMP_WIKI_SLUG: string | null = null;

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
    // Shadow user for all test employees
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, 'mcp-phase4@test.local', 'MCP Phase 4 Test User']
    );

    // Three BYOA employees with three different trust levels. Each gets
    // its own bearer token in the before() hook below.
    const emps: Array<[string, string, string, string]> = [
      [EMP_CONSERVATIVE_ID, EMP_CONSERVATIVE_SLUG, 'conservative', 'Phase4 Conservative'],
      [EMP_STANDARD_ID, EMP_STANDARD_SLUG, 'standard', 'Phase4 Standard'],
      [EMP_AUTONOMOUS_ID, EMP_AUTONOMOUS_SLUG, 'autonomous', 'Phase4 Autonomous'],
    ];
    for (const [id, slug, trust, name] of emps) {
      await c.query(
        `INSERT INTO agent_employees
          (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
           is_byoa, is_active, created_by)
         VALUES ($1, $2, $3, $4, $5, 'project_manager', 'test', $6,
           true, true, $3)
         ON CONFLICT (id) DO UPDATE SET
           trust_level = $6,
           is_active = true`,
        [id, ORG_ID, TEST_USER_ID, name, slug, trust]
      );
    }

    // An unrelated employee used to test memory_update cross-employee reject.
    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, 'Other Phase4', $4, 'project_manager', 'test', 'standard',
         true, true, $3)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
      [OTHER_EMP_ID, ORG_ID, TEST_USER_ID, OTHER_EMP_SLUG]
    );

    // Grab a project for task_create (creates one if seed hasn't run)
    const proj = await c.query(
      `SELECT id FROM projects WHERE org_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [ORG_ID]
    );
    if (proj.rows.length > 0) {
      TEST_PROJECT_ID = proj.rows[0].id;
    } else {
      const r = await c.query(
        `INSERT INTO projects (org_id, name, prefix, lead_id, task_counter)
         VALUES ($1, 'MCP Phase4 Test Project', 'MCPP4', $2, 0)
         RETURNING id`,
        [ORG_ID, TEST_USER_ID]
      );
      TEST_PROJECT_ID = r.rows[0].id;
    }

    // Grab a space for message_post + space_memory
    const sp = await c.query(
      `SELECT id FROM spaces WHERE org_id = $1 AND is_archived = false
       ORDER BY created_at ASC LIMIT 1`,
      [ORG_ID]
    );
    if (sp.rows.length > 0) {
      TEST_SPACE_ID = sp.rows[0].id;
    } else {
      const r = await c.query(
        `INSERT INTO spaces (org_id, name, type, created_by)
         VALUES ($1, 'mcp-phase4-test-space', 'public', $2)
         RETURNING id`,
        [ORG_ID, TEST_USER_ID]
      );
      TEST_SPACE_ID = r.rows[0].id;
    }

    // Seed one wiki page owned by OTHER_EMP_ID so memory_update rejection
    // has a target to try to hit.
    const slug = `phase4-other-mem-${Date.now()}`;
    OTHER_EMP_WIKI_SLUG = slug;
    await c.query(
      `INSERT INTO wiki_pages
         (id, org_id, scope, agent_employee_id, type, title, slug, summary,
          content, confidence, version, is_deleted, created_at, updated_at)
       VALUES
         (gen_random_uuid()::text, $1, 'user', $2, 'fact', 'Other employee memory',
          $3, 'summary', 'body content', 0.8, 1, false, now(), now())`,
      [ORG_ID, OTHER_EMP_ID, slug]
    );
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    // Clean up agent_actions, messages, tasks, space_memory, wiki_pages
    // created during this test run.
    // Phase 7 — clear receipts first to satisfy FK constraints.
    await c.query(
      `DELETE FROM action_receipts
       WHERE action_id IN (SELECT id FROM agent_actions WHERE user_id = $1)
          OR employee_id = ANY($2::text[])`,
      [TEST_USER_ID, [EMP_CONSERVATIVE_ID, EMP_STANDARD_ID, EMP_AUTONOMOUS_ID, OTHER_EMP_ID]]
    );
    await c.query(
      `DELETE FROM agent_actions WHERE user_id = $1`,
      [TEST_USER_ID]
    );
    await c.query(
      `DELETE FROM space_memory WHERE updated_by_employee_id IN ($1,$2,$3,$4)`,
      [EMP_CONSERVATIVE_ID, EMP_STANDARD_ID, EMP_AUTONOMOUS_ID, OTHER_EMP_ID]
    );
    await c.query(
      `DELETE FROM messages WHERE user_id = $1`,
      [TEST_USER_ID]
    );
    if (TEST_PROJECT_ID) {
      await c.query(
        `DELETE FROM tasks WHERE project_id = $1 AND created_by = $2`,
        [TEST_PROJECT_ID, TEST_USER_ID]
      );
    }
    await c.query(
      `DELETE FROM wiki_pages WHERE agent_employee_id IN ($1,$2,$3,$4)`,
      [EMP_CONSERVATIVE_ID, EMP_STANDARD_ID, EMP_AUTONOMOUS_ID, OTHER_EMP_ID]
    );
    await c.query(
      `DELETE FROM agent_employees WHERE id = ANY($1::text[])`,
      [[EMP_CONSERVATIVE_ID, EMP_STANDARD_ID, EMP_AUTONOMOUS_ID, OTHER_EMP_ID]]
    );
    await c.query(`DELETE FROM users WHERE id = $1`, [TEST_USER_ID]);
  });
}

before(async () => {
  await seedFixtures();
  const tokenModule = await import('../src/lib/mcp-token.js');
  const routeModule = await import('../src/routes/mcp-server-v1.js');
  testApp = new Hono();
  testApp.route('/api/mcp/v1', routeModule.mcpServerV1Routes);
  // Issue one bearer per BYOA employee — Phase 9 routing is 1:1.
  for (const [id, slug] of [
    [EMP_CONSERVATIVE_ID, EMP_CONSERVATIVE_SLUG],
    [EMP_STANDARD_ID, EMP_STANDARD_SLUG],
    [EMP_AUTONOMOUS_ID, EMP_AUTONOMOUS_SLUG],
    [OTHER_EMP_ID, OTHER_EMP_SLUG],
  ]) {
    TOKENS_BY_SLUG.set(slug, await tokenModule.issueEmployeeToken(ORG_ID, id));
  }
});

after(async () => {
  await teardownFixtures();
});

function app() {
  if (!testApp) throw new Error('test app not initialized');
  return testApp;
}

async function mcpCall(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const slug = (args as any).caller_employee_slug as string | undefined;
  const token = slug ? TOKENS_BY_SLUG.get(slug) : undefined;
  if (!token) {
    throw new Error(`mcpCall: no bearer for caller_employee_slug=${slug}`);
  }
  const res = await app().request('/api/mcp/v1/tools/call', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
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

test('1. task_create with autonomous trust auto-executes', async () => {
  // NOTE: task_create is tier=quick. Standard trust auto-executes only 'auto'
  // tier actions, so we use the autonomous employee here to exercise the
  // happy-path auto-execute branch. (The queued-for-approval counterpart is
  // covered by test 2 with a conservative employee.)
  const title = `phase4 task auto ${Date.now()}`;
  const { status, body } = await mcpCall('task_create', {
    caller_employee_slug: EMP_AUTONOMOUS_SLUG,
    title,
    description: 'created by test',
    project_id: TEST_PROJECT_ID,
    priority: 'p2',
  });
  assert.equal(status, 200);
  assert.ok(!body.isError, `task_create should not error: ${JSON.stringify(body)}`);
  const parsed = parseContent(body);
  assert.ok(parsed && parsed.id, `task_create should return created task: ${JSON.stringify(parsed)}`);
  assert.notEqual(parsed.status, 'queued_for_approval', 'standard trust + quick tier should auto-execute');
  assert.equal(parsed.title, title);

  // Verify row exists
  await withClient(async (c) => {
    const r = await c.query(`SELECT title FROM tasks WHERE id = $1`, [parsed.id]);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].title, title);
  });
});

test('2. task_create with conservative trust queues for approval', async () => {
  const title = `phase4 task queued ${Date.now()}`;
  const { status, body } = await mcpCall('task_create', {
    caller_employee_slug: EMP_CONSERVATIVE_SLUG,
    title,
    project_id: TEST_PROJECT_ID,
  });
  assert.equal(status, 200);
  assert.ok(!body.isError, `task_create should not error: ${JSON.stringify(body)}`);
  const parsed = parseContent(body);
  assert.equal(parsed.status, 'queued_for_approval');
  assert.ok(parsed.approval_id, 'approval_id returned');

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT action, approval_status, approval_tier FROM agent_actions WHERE id = $1`,
      [parsed.approval_id]
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].action, 'task_create');
    assert.equal(r.rows[0].approval_status, 'pending');
    assert.equal(r.rows[0].approval_tier, 'quick');
    const t = await c.query(`SELECT id FROM tasks WHERE title = $1`, [title]);
    assert.equal(t.rows.length, 0, 'no task row should have been inserted');
  });
});

test('3. message_post with standard trust returns pseudo-result (full tier)', async () => {
  const { status, body } = await mcpCall('message_post', {
    caller_employee_slug: EMP_STANDARD_SLUG,
    space_id: TEST_SPACE_ID,
    content: 'phase4 message standard',
  });
  assert.equal(status, 200);
  assert.ok(!body.isError);
  const parsed = parseContent(body);
  assert.equal(parsed.status, 'queued_for_approval');
  assert.ok(parsed.approval_id);

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT approval_tier FROM agent_actions WHERE id = $1`,
      [parsed.approval_id]
    );
    assert.equal(r.rows[0].approval_tier, 'full');
  });
});

test('4. message_post with autonomous trust auto-executes (full-tier unlocked)', async () => {
  // Trust unlock (2026-04-18): Autonomous trust now auto-executes full-tier
  // actions. message_post is full-tier but NOT in the destructive guard set,
  // so it runs immediately instead of queuing.
  // Standard trust still queues full-tier — that is covered by test 3.
  const content = `phase4 message auto ${Date.now()}`;
  const { status, body } = await mcpCall('message_post', {
    caller_employee_slug: EMP_AUTONOMOUS_SLUG,
    space_id: TEST_SPACE_ID,
    content,
  });
  assert.equal(status, 200);
  assert.ok(!body.isError, `message_post should not error: ${JSON.stringify(body)}`);
  const parsed = parseContent(body);
  assert.notEqual(
    parsed.status,
    'queued_for_approval',
    'autonomous trust must not queue message_post — it should auto-execute',
  );
  // The result should be the posted message row (id + content present)
  assert.ok(parsed.id, `auto-executed message_post should return message id: ${JSON.stringify(parsed)}`);
  assert.equal(parsed.content, content, 'returned content should match posted content');

  // Verify the message row exists in the DB
  await withClient(async (c) => {
    const r = await c.query(
      `SELECT id, content FROM messages WHERE id = $1`,
      [parsed.id],
    );
    assert.equal(r.rows.length, 1, 'message row should have been inserted');
    assert.equal(r.rows[0].content, content);
  });
});

test('5. memory_update rejects cross-employee updates', async () => {
  const { status, body } = await mcpCall('memory_update', {
    caller_employee_slug: EMP_STANDARD_SLUG,
    slug: OTHER_EMP_WIKI_SLUG,
    patch: { title: 'hacked' },
  });
  assert.equal(status, 200);
  assert.ok(body.isError === true, `cross-employee update must set isError: ${JSON.stringify(body)}`);
  const txt = body.content?.[0]?.text ?? '';
  assert.match(txt, /another|not allowed|cannot|forbidden/i);
});

test('6. memory_update scope=org returns pseudo-result for conservative', async () => {
  // Seed an owned page first
  let ownedSlug = '';
  await withClient(async (c) => {
    ownedSlug = `phase4-cons-owned-${Date.now()}`;
    await c.query(
      `INSERT INTO wiki_pages
        (id, org_id, scope, agent_employee_id, type, title, slug, summary,
         content, confidence, version, is_deleted, created_at, updated_at)
       VALUES
        (gen_random_uuid()::text, $1, 'user', $2, 'fact', 'Phase4 owned', $3,
         'sum', 'content', 0.7, 1, false, now(), now())`,
      [ORG_ID, EMP_CONSERVATIVE_ID, ownedSlug]
    );
  });

  const { status, body } = await mcpCall('memory_update', {
    caller_employee_slug: EMP_CONSERVATIVE_SLUG,
    slug: ownedSlug,
    patch: { scope: 'org' },
  });
  assert.equal(status, 200);
  assert.ok(!body.isError, `memory_update should not error: ${JSON.stringify(body)}`);
  const parsed = parseContent(body);
  assert.equal(parsed.status, 'queued_for_approval', 'scope promotion must queue');
});

test('7. space_memory_set → space_memory_get round-trip', async () => {
  const key = `phase4-key-${Date.now()}`;
  const value = { note: 'hello', count: 3 };

  const setRes = await mcpCall('space_memory_set', {
    caller_employee_slug: EMP_STANDARD_SLUG,
    space_id: TEST_SPACE_ID,
    key,
    value,
  });
  assert.ok(!setRes.body.isError, `set error: ${JSON.stringify(setRes.body)}`);

  const getRes = await mcpCall('space_memory_get', {
    caller_employee_slug: EMP_STANDARD_SLUG,
    space_id: TEST_SPACE_ID,
    key,
  });
  assert.ok(!getRes.body.isError, `get error: ${JSON.stringify(getRes.body)}`);
  const parsed = parseContent(getRes.body);
  assert.deepEqual(parsed.value, value);
});

test('8. delegation_self_report writes to agent_actions as approved', async () => {
  const { status, body } = await mcpCall('delegation_self_report', {
    caller_employee_slug: EMP_STANDARD_SLUG,
    target_employee_slug: 'some-other-agent',
    reason: 'planning help',
    session_id: 'sess_123',
  });
  assert.equal(status, 200);
  assert.ok(!body.isError);
  const parsed = parseContent(body);
  assert.equal(parsed.logged, true);
  assert.ok(parsed.action_id);

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT action, approval_status, params FROM agent_actions WHERE id = $1`,
      [parsed.action_id]
    );
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].action, 'delegation_self_report');
    assert.equal(r.rows[0].approval_status, 'approved');
  });
});

test('9. cache invalidation: task_create auto-exec clears platform_context cache', async () => {
  // Use EXACT same args so the second call hits cache.
  const cacheArgs = {
    caller_employee_slug: EMP_AUTONOMOUS_SLUG,
    trigger: { kind: 'phase4-cache-invalidation' },
  };
  const c1 = await mcpCall('platform_context', cacheArgs);
  const c1Parsed = parseContent(c1.body);
  const c2 = await mcpCall('platform_context', cacheArgs);
  const c2Parsed = parseContent(c2.body);
  assert.equal(
    c2Parsed._cache_hit,
    true,
    'second call should hit cache before write'
  );

  // Now do a write that auto-executes (autonomous + quick tier)
  const wrote = await mcpCall('task_create', {
    caller_employee_slug: EMP_AUTONOMOUS_SLUG,
    title: `phase4 cache bust ${Date.now()}`,
    project_id: TEST_PROJECT_ID,
  });
  assert.ok(!wrote.body.isError);
  const wroteParsed = parseContent(wrote.body);
  assert.ok(wroteParsed.id, 'task auto-executed');

  // Third platform_context call should NOT be a cache hit
  const c3 = await mcpCall('platform_context', cacheArgs);
  const c3Parsed = parseContent(c3.body);
  assert.equal(
    c3Parsed._cache_hit,
    false,
    'cache should be invalidated after write'
  );
  assert.notEqual(c3Parsed.generated_at, c1Parsed.generated_at);
});
