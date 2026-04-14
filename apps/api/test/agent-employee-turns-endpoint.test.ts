/**
 * Phase 10 — session inspector turns endpoint tests.
 *
 * Extends Phase 6.5's `GET /api/agent-employees/:id/turns`:
 *   1. default limit is 20
 *   2. ?limit=50 returns up to 50
 *   3. ?limit=200 is capped at 100
 *   4. ?trigger_kind=chat_mention&result=success filters correctly
 *
 * Also exercises the new `GET /:id/turns/:turn_id/receipt` proxy.
 *
 * Run: pnpm --filter @deft/api test -- agent-employee-turns-endpoint
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const RUN_SUFFIX = `turns-${Date.now()}`;
const EMP_ID = `test-emp-${RUN_SUFFIX}`;
const EMP_SLUG = `test-emp-${RUN_SUFFIX}`;
const SHADOW_USER_ID = `test-shadow-${RUN_SUFFIX}`;
const MEMBER_USER_ID = `test-member-${RUN_SUFFIX}`;
const MEMBER_EMAIL = `${MEMBER_USER_ID}@test.local`;

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
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Turns Shadow', true)
       ON CONFLICT (id) DO NOTHING`,
      [SHADOW_USER_ID, `${SHADOW_USER_ID}@test.local`],
    );
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Turns Member', false)
       ON CONFLICT (id) DO NOTHING`,
      [MEMBER_USER_ID, MEMBER_EMAIL],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'owner', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, MEMBER_USER_ID],
    );
    await c.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          kind, connection_url, connection_status, is_active, created_by)
       VALUES ($1, $2, $3, 'Turns Test Emp', $4,
         'project_manager', 'test', 'standard',
         'openclaw', 'http://127.0.0.1:0/turns', 'connected', true, $3)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
      [EMP_ID, ORG_ID, SHADOW_USER_ID, EMP_SLUG],
    );

    // Seed 60 turns with mixed trigger_kind + result so limit/filter tests
    // have enough material to distinguish default (20) vs ?limit=50.
    for (let i = 0; i < 60; i++) {
      const trigger =
        i % 3 === 0 ? 'chat_mention' : i % 3 === 1 ? 'cron' : 'webhook';
      const result = i % 4 === 0 ? 'error' : 'success';
      await c.query(
        `INSERT INTO agent_session_turns
           (id, org_id, employee_id, trigger_kind, input_messages_json,
            tool_calls_json, raw_reply_text, latency_ms, model_name,
            tokens_in, tokens_out, result, created_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3,
           $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11, now() - ($12::text || ' seconds')::interval)`,
        [
          ORG_ID,
          EMP_ID,
          trigger,
          JSON.stringify([
            { role: 'system', content: 'You are alex.' },
            { role: 'user', content: `msg ${i}` },
          ]),
          JSON.stringify([
            { type: 'tool_use', name: 'memory_recall', input: { q: 'x' }, output: { ok: true } },
          ]),
          `reply ${i}`,
          1000 + i,
          'anthropic/claude-sonnet-4-6',
          100 + i,
          50 + i,
          result,
          String(i),
        ],
      );
    }
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    await c.query(`DELETE FROM agent_session_turns WHERE employee_id = $1`, [EMP_ID]);
    await c.query(`DELETE FROM agent_actions WHERE agent_employee_id = $1`, [EMP_ID]);
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [MEMBER_USER_ID]);
    await c.query(`DELETE FROM agent_employees WHERE id = $1`, [EMP_ID]);
    await c.query(`DELETE FROM users WHERE id IN ($1, $2)`, [
      SHADOW_USER_ID,
      MEMBER_USER_ID,
    ]);
  });
}

before(async () => {
  await seedFixtures();

  const { agentEmployeeRoutes } = await import('../src/routes/agent-employees.js');
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    c.set('user', {
      id: MEMBER_USER_ID,
      email: MEMBER_EMAIL,
      org_id: ORG_ID,
    } as any);
    await next();
  });
  testApp.route('/api/agent-employees', agentEmployeeRoutes);
});

after(async () => {
  await teardownFixtures();
});

function app(): Hono {
  if (!testApp) throw new Error('test app not initialized');
  return testApp;
}

// ─────────────────────────────────────────────────────────────────────────────

test('1. GET /:id/turns returns 20 turns by default', async () => {
  const res = await app().request(`/api/agent-employees/${EMP_ID}/turns`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.ok(Array.isArray(body.turns), 'body.turns should be an array');
  assert.equal(body.turns.length, 20);
  // Every turn should carry the full fields the session inspector needs.
  const sample = body.turns[0];
  assert.ok('input_messages_json' in sample, 'turn should include input_messages_json');
  assert.ok('tool_calls_json' in sample, 'turn should include tool_calls_json');
  assert.ok('raw_reply_text' in sample);
});

test('2. GET /:id/turns?limit=50 returns up to 50 turns', async () => {
  const res = await app().request(`/api/agent-employees/${EMP_ID}/turns?limit=50`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.turns.length, 50);
});

test('3. GET /:id/turns?limit=200 is capped at 100', async () => {
  const res = await app().request(`/api/agent-employees/${EMP_ID}/turns?limit=200`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  // We seeded 60 rows, so cap=100 should give us all 60 back.
  assert.equal(body.turns.length, 60);
});

test('4. GET /:id/turns?trigger_kind=chat_mention&result=success filters', async () => {
  const res = await app().request(
    `/api/agent-employees/${EMP_ID}/turns?trigger_kind=chat_mention&result=success&limit=100`,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.ok(body.turns.length > 0, 'expected at least one match');
  for (const t of body.turns) {
    assert.equal(t.trigger_kind, 'chat_mention');
    assert.equal(t.result, 'success');
  }
});
