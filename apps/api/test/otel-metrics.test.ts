/**
 * Phase 10 — Prometheus text format helpers + metrics route.
 *
 * Covers:
 *   1. formatCounter emits a single Prometheus 0.0.4 counter line
 *   2. formatHistogram emits correct bucket + sum + count lines in order
 *   3. label values with special chars (", \n, \\) are escaped correctly
 *   4. collectMetrics includes all expected metric names when the DB has data
 *   5. metrics route returns 401 without a bearer
 *   6. metrics route returns 200 text/plain with a correct bearer
 *
 * Run: pnpm --filter @deft/api test -- otel-metrics
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const RUN_SUFFIX = `otel-${Date.now()}`;
const EMP_ID = `test-emp-${RUN_SUFFIX}`;
const EMP_SLUG = `test-emp-${RUN_SUFFIX}`;
const SHADOW_USER_ID = `test-shadow-${RUN_SUFFIX}`;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

before(async () => {
  // Force the metrics token so the auth test is deterministic.
  process.env.METRICS_SCRAPE_TOKEN = 'test-scrape-token-ok';

  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Otel Shadow', true)
       ON CONFLICT (id) DO NOTHING`,
      [SHADOW_USER_ID, `${SHADOW_USER_ID}@test.local`],
    );
    await c.query(
      `INSERT INTO agent_employees
         (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
          is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, 'Otel Emp', $4,
         'project_manager', 'test', 'standard',
         true, true, $3)
       ON CONFLICT (id) DO UPDATE SET is_active = true`,
      [EMP_ID, ORG_ID, SHADOW_USER_ID, EMP_SLUG],
    );
    // Seed 5 turns with varied latency + token counts for histogram + sum tests.
    for (let i = 0; i < 5; i++) {
      await c.query(
        `INSERT INTO agent_session_turns
           (id, org_id, employee_id, trigger_kind, input_messages_json,
            latency_ms, model_name, tokens_in, tokens_out, result)
         VALUES (gen_random_uuid()::text, $1, $2, 'chat_mention', '[]'::jsonb,
           $3, 'anthropic/claude-sonnet-4-6', $4, $5, 'success')`,
        [ORG_ID, EMP_ID, 500 + i * 700, 100 * (i + 1), 50 * (i + 1)],
      );
    }
  });
});

after(async () => {
  await withClient(async (c) => {
    await c.query(`DELETE FROM agent_session_turns WHERE employee_id = $1`, [EMP_ID]);
    await c.query(`DELETE FROM agent_actions WHERE agent_employee_id = $1`, [EMP_ID]);
    await c.query(`DELETE FROM agent_employees WHERE id = $1`, [EMP_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [SHADOW_USER_ID]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

test('1. formatCounter emits a Prometheus 0.0.4 counter line', async () => {
  const { formatCounter } = await import('../src/lib/otel-metrics.js');
  const text = formatCounter(
    'deft_test_total',
    'A test counter',
    { employee_slug: 'alex-pm', org_id: 'org-1' },
    42,
  );
  // Spec: HELP + TYPE + metric lines, each newline-terminated.
  assert.match(text, /^# HELP deft_test_total A test counter$/m);
  assert.match(text, /^# TYPE deft_test_total counter$/m);
  assert.match(
    text,
    /^deft_test_total\{employee_slug="alex-pm",org_id="org-1"\} 42$/m,
  );
});

test('2. formatHistogram emits bucket + sum + count lines in order', async () => {
  const { formatHistogram } = await import('../src/lib/otel-metrics.js');
  const text = formatHistogram(
    'deft_test_latency_ms',
    'Latency histogram',
    { employee_slug: 'alex-pm' },
    [
      { le: 500, count: 1 },
      { le: 1000, count: 3 },
      { le: 5000, count: 5 },
      { le: Infinity, count: 5 },
    ],
    15000,
    5,
  );
  const lines = text.trim().split('\n');
  const bucketLines = lines.filter((l) => l.includes('_bucket'));
  assert.equal(bucketLines.length, 4, 'expected 4 bucket lines');

  // Ordered by le ascending.
  assert.ok(
    bucketLines[0]!.includes('le="500"'),
    `first bucket should be le=500, got ${bucketLines[0]}`,
  );
  assert.ok(
    bucketLines[1]!.includes('le="1000"'),
    `second bucket should be le=1000, got ${bucketLines[1]}`,
  );
  // +Inf bucket uses the literal +Inf marker.
  assert.ok(
    bucketLines[3]!.includes('le="+Inf"'),
    `last bucket should be le="+Inf", got ${bucketLines[3]}`,
  );

  // Sum and count lines appear after all bucket lines.
  const sumIdx = lines.findIndex((l) => l.startsWith('deft_test_latency_ms_sum'));
  const countIdx = lines.findIndex((l) => l.startsWith('deft_test_latency_ms_count'));
  assert.ok(sumIdx >= 0 && countIdx >= 0, 'sum and count lines present');
  assert.ok(
    sumIdx > lines.findIndex((l) => l.includes('_bucket')),
    'sum must come after buckets',
  );
  assert.match(text, /deft_test_latency_ms_sum\{employee_slug="alex-pm"\} 15000/);
  assert.match(text, /deft_test_latency_ms_count\{employee_slug="alex-pm"\} 5/);
});

test('3. label values with special chars are escaped', async () => {
  const { formatCounter } = await import('../src/lib/otel-metrics.js');
  const text = formatCounter(
    'deft_escape_total',
    'escape test',
    { msg: 'hello "world"\nwith\\slash' },
    1,
  );
  // Per Prom 0.0.4: \\, \n, \" must be escaped inside label values.
  assert.match(
    text,
    /msg="hello \\"world\\"\\nwith\\\\slash"/,
    `escape mismatch: ${text}`,
  );
});

test('4. collectMetrics includes expected metric names with seeded data', async () => {
  const { collectMetrics } = await import('../src/lib/otel-metrics.js');
  const { db } = await import('../src/lib/db.js');
  const text = await collectMetrics(db as any);
  assert.match(text, /deft_employee_chat_turn_total/);
  assert.match(text, /deft_employee_chat_latency_ms_bucket/);
  assert.match(text, /deft_employee_tokens_in_total/);
  assert.match(text, /deft_employee_tokens_out_total/);
  assert.match(text, /deft_approval_queue_size/);
  // mcp tool calls is a stub counter (Phase 10 follow-up) but the HELP must still be present.
  assert.match(text, /deft_mcp_tool_calls_total/);
});

test('5. GET /api/metrics returns 401 without bearer', async () => {
  const { metricsRoutes } = await import('../src/routes/metrics.js');
  const app = new Hono();
  app.route('/api/metrics', metricsRoutes);
  const res = await app.request('/api/metrics');
  assert.equal(res.status, 401);
});

test('6. GET /api/metrics returns 200 text/plain with a valid bearer', async () => {
  const { metricsRoutes } = await import('../src/routes/metrics.js');
  const app = new Hono();
  app.route('/api/metrics', metricsRoutes);
  const res = await app.request('/api/metrics', {
    headers: { Authorization: 'Bearer test-scrape-token-ok' },
  });
  assert.equal(res.status, 200);
  const ct = res.headers.get('content-type') ?? '';
  assert.ok(
    ct.startsWith('text/plain'),
    `content-type should be text/plain, got ${ct}`,
  );
  const body = await res.text();
  assert.match(body, /deft_employee_chat_turn_total/);
});
