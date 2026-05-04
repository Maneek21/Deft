/**
 * Phase 6 — events_query MCP tool tests.
 *
 * Run: pnpm --filter @deft/api test -- mcp-events
 *
 * Covers:
 *   1. events_query returns rows scoped to the caller's org
 *   2. events_query filters by event_type (type param)
 *   3. events_query filters by since/until time range
 *   4. events_query with invalid caller_employee_slug returns 403
 *
 * Uses the same pattern as mcp-server.test.ts: seed a throwaway BYOA
 * employee + issue a bearer token + call via the real HTTP router.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6'; // Maneek seed org
const TEST_EMPLOYEE_ID = 'test-mcp-phase6-events-employee';
const TEST_EMPLOYEE_SLUG = 'mcp-phase6-events-test';
const TEST_USER_ID = 'test-mcp-phase6-events-user';

// Seeded events we insert in before() and delete in after(). We use a
// synthetic org id for the "other org" row to prove scoping.
const OTHER_ORG_ID = 'phase6-events-other-org';
const OTHER_EVENT_ID = 'test-mcp-phase6-other-event';
const PR_EVENT_ID = 'test-mcp-phase6-pr-event';
const CAL_EVENT_ID = 'test-mcp-phase6-cal-event';
const OLD_EVENT_ID = 'test-mcp-phase6-old-event';

let RAW_TOKEN: string | null = null;
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
    // Shadow user for the test employee
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, 'mcp-phase6-events@test.local', 'MCP Phase 6 Events User'],
    );

    // Test employee
    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, 'project_manager', 'test', 'standard',
         true, true, $3)
       ON CONFLICT (id) DO UPDATE SET
         is_active = true`,
      [
        TEST_EMPLOYEE_ID,
        ORG_ID,
        TEST_USER_ID,
        'MCP Phase 6 Events Test Employee',
        TEST_EMPLOYEE_SLUG,
      ],
    );

    // Make sure the "other org" row exists (FK on events.org_id references orgs)
    await c.query(
      `INSERT INTO orgs (id, name, slug, timezone)
       VALUES ($1, 'Phase6 Other Org', 'phase6-other-org', 'UTC')
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_ORG_ID],
    );

    // Clean any stale events from prior runs (by id OR external_id)
    await c.query(
      `DELETE FROM events WHERE id = ANY($1::text[])
         OR external_id = ANY($2::text[])`,
      [
        [PR_EVENT_ID, CAL_EVENT_ID, OLD_EVENT_ID, OTHER_EVENT_ID],
        [
          'phase6-pr-merged-external',
          'phase6-cal-external-v1',
          'phase6-pr-opened-old',
          'phase6-other-org-external',
        ],
      ],
    );

    // Seed events. NOTE: the events.timestamp column is `timestamp without
    // time zone`, so we bind JS Date values directly — the pg driver converts
    // them to a naive wall-clock value in UTC, which matches how drizzle
    // reads them back. Using `now()` in SQL would store in the DB session
    // timezone (Asia/Calcutta on our dev box) and then get misread as UTC.
    // Build UTC wall-clock strings (naive — no trailing Z) so the pg driver
    // stores exactly the UTC wall-clock into a `timestamp without time zone`
    // column, which is then read back by drizzle as a JS Date treated as
    // UTC. Without this, `now()` in SQL runs in the DB session timezone
    // (Asia/Calcutta on our dev box) and the roundtrip is off by the offset.
    const now = new Date();
    const toNaiveUtc = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '');
    const recentPrTs = toNaiveUtc(new Date(now.getTime() - 60 * 60 * 1000));
    const upcomingCalTs = toNaiveUtc(new Date(now.getTime() + 15 * 60 * 1000));
    const oldEventTs = toNaiveUtc(new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000));
    const otherOrgTs = toNaiveUtc(new Date(now.getTime() - 30 * 60 * 1000));

    await c.query(
      `INSERT INTO events
         (id, org_id, source, event_type, external_id, title, body, url,
          actor, timestamp, metadata)
       VALUES ($1, $2, 'github', 'pr_merged', 'phase6-pr-merged-external',
         'Phase6 PR merged', 'body', 'https://example.com/pr/1',
         'tester', $3, '{}'::jsonb)`,
      [PR_EVENT_ID, ORG_ID, recentPrTs],
    );

    await c.query(
      `INSERT INTO events
         (id, org_id, source, event_type, external_id, title, body, url,
          actor, timestamp, metadata)
       VALUES ($1, $2, 'google_calendar', 'calendar_event',
         'phase6-cal-external-v1',
         'Phase6 upcoming meeting', 'body', 'https://example.com/cal/1',
         'tester', $3, '{}'::jsonb)`,
      [CAL_EVENT_ID, ORG_ID, upcomingCalTs],
    );

    await c.query(
      `INSERT INTO events
         (id, org_id, source, event_type, external_id, title, body, url,
          actor, timestamp, metadata)
       VALUES ($1, $2, 'github', 'pr_opened', 'phase6-pr-opened-old',
         'Phase6 old pr', 'body', 'https://example.com/pr/0',
         'tester', $3, '{}'::jsonb)`,
      [OLD_EVENT_ID, ORG_ID, oldEventTs],
    );

    await c.query(
      `INSERT INTO events
         (id, org_id, source, event_type, external_id, title, body, url,
          actor, timestamp, metadata)
       VALUES ($1, $2, 'github', 'pr_merged', 'phase6-other-org-external',
         'Phase6 other org PR', 'body', 'https://example.com/pr/x',
         'tester', $3, '{}'::jsonb)`,
      [OTHER_EVENT_ID, OTHER_ORG_ID, otherOrgTs],
    );
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    await c.query(
      `DELETE FROM events WHERE id = ANY($1::text[])`,
      [[PR_EVENT_ID, CAL_EVENT_ID, OLD_EVENT_ID, OTHER_EVENT_ID]],
    );
    await c.query(`DELETE FROM agent_employees WHERE id = $1`, [TEST_EMPLOYEE_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [TEST_USER_ID]);
    await c.query(`DELETE FROM orgs WHERE id = $1`, [OTHER_ORG_ID]);
  });
}

before(async () => {
  await seedFixtures();
  const tokenModule = await import('../src/lib/mcp-token.js');
  const routeModule = await import('../src/routes/mcp-server-v1.js');
  testApp = new Hono();
  testApp.route('/api/mcp/v1', routeModule.mcpServerV1Routes);
  RAW_TOKEN = await tokenModule.issueEmployeeToken(ORG_ID, TEST_EMPLOYEE_ID);
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
  bearer?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
  const res = await app().request('/api/mcp/v1/tools/call', {
    method: 'POST',
    headers,
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

test('1. events_query returns rows scoped to the caller org (no cross-org leak)', async () => {
  const { status, body } = await mcpCall(
    'events_query',
    { caller_employee_slug: TEST_EMPLOYEE_SLUG, limit: 50 },
    RAW_TOKEN!,
  );
  assert.equal(status, 200);
  assert.ok(!body.isError, `events_query should not error: ${JSON.stringify(body)}`);
  const rows = parseContent(body);
  assert.ok(Array.isArray(rows), 'result is array');
  // Must contain our seeded test-org events
  const ids = new Set(rows.map((r: any) => r.id));
  assert.ok(ids.has(PR_EVENT_ID), 'PR event in results');
  assert.ok(ids.has(CAL_EVENT_ID), 'Calendar event in results');
  // Must NOT contain the other-org event
  assert.ok(!ids.has(OTHER_EVENT_ID), 'Other org event must not leak in');
});

test('2. events_query filters by type (event_type)', async () => {
  const { status, body } = await mcpCall(
    'events_query',
    {
      caller_employee_slug: TEST_EMPLOYEE_SLUG,
      type: 'pr_merged',
      limit: 50,
    },
    RAW_TOKEN!,
  );
  assert.equal(status, 200);
  assert.ok(!body.isError);
  const rows = parseContent(body);
  assert.ok(Array.isArray(rows));
  // Every row must be pr_merged
  for (const r of rows) {
    assert.equal(r.event_type, 'pr_merged', 'all rows match the type filter');
  }
  const ids = new Set(rows.map((r: any) => r.id));
  assert.ok(ids.has(PR_EVENT_ID), 'PR merged event found');
  assert.ok(!ids.has(CAL_EVENT_ID), 'Calendar event filtered out');
});

test('3. events_query filters by since/until time range', async () => {
  // Scope by source=github so we only match the 2 github events we seeded
  // (recent PR merged + 5-day-old PR opened). The seed org may contain
  // unrelated events from other test fixtures, so narrowing keeps the
  // assertions deterministic.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const { status, body } = await mcpCall(
    'events_query',
    {
      caller_employee_slug: TEST_EMPLOYEE_SLUG,
      source: 'github',
      since,
      until,
      limit: 200,
    },
    RAW_TOKEN!,
  );
  assert.equal(status, 200);
  assert.ok(!body.isError);
  const rows = parseContent(body);
  assert.ok(Array.isArray(rows));
  const ids = new Set(rows.map((r: any) => r.id));
  assert.ok(ids.has(PR_EVENT_ID), 'Recent PR event present');
  assert.ok(!ids.has(OLD_EVENT_ID), '5-day-old event filtered out by since');
});

test('4. events_query with unknown caller_employee_slug returns 403', async () => {
  const { status } = await mcpCall(
    'events_query',
    { caller_employee_slug: 'nobody-on-this-phase6-gateway' },
    RAW_TOKEN!,
  );
  assert.equal(status, 403);
});
