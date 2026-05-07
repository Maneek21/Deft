/**
 * MCP fetch_unread tool — covers unread filter + pending_actions inclusion.
 * Phase 3 of agent-chat unification (Task P3-6).
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/mcp-fetch-unread.test.ts
 *
 * Covers:
 *   1. fetch_unread returns messages from human in spaces the caller is a member of
 *   2. fetch_unread excludes the caller's own posts
 *   3. fetch_unread returns pending_actions for the caller
 *   4. fetch_unread limit caps the unread_messages array
 *   5. fetch_unread space_id filter restricts to that space
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { fetchUnread } from '../src/lib/mcp-tools/messages.js';
import type { ToolContext } from '../src/lib/mcp-tools/types.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';

// Use the fixed seed org — same as every other MCP test.
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

// Deterministic IDs so cleanup is idempotent across runs.
// NOTE: all id columns are `text PRIMARY KEY NOT NULL` with NO db default —
// Drizzle's $defaultFn() only fires through the ORM. Raw SQL must supply them.
const TEST_USER_ID = 'test-mcp-fetch-unread-human';
const AGENT_USER_ID = 'test-mcp-fetch-unread-agent';
const AGENT_EMPLOYEE_ID = 'test-mcp-fetch-unread-employee';
const AGENT_EMPLOYEE_SLUG = 'mcp-fetch-unread-test';
const SPACE_ID = 'test-mcp-fetch-unread-space';
const OTHER_SPACE_ID = 'test-mcp-fetch-unread-other-space';

// We track all inserted row IDs so the after() hook can clean them up.
const insertedMessages: string[] = [];
const insertedActions: string[] = [];

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Build a minimal ToolContext for the test agent employee. */
function makeCtx(): ToolContext {
  return {
    org_id: ORG_ID,
    employee_id: AGENT_EMPLOYEE_ID,
    employee_slug: AGENT_EMPLOYEE_SLUG,
    trust_level: 'autonomous',
  };
}

/**
 * Parse the MCP ToolResult into { unread_messages, pending_actions }.
 * textResult() always wraps as content[0].text JSON.
 */
function parseResult(r: any): { unread_messages: any[]; pending_actions: any[] } {
  const text = r?.content?.[0]?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      // fall through to raw shape
    }
  }
  return r;
}

before(async () => {
  await withClient(async (c) => {
    // Human shadow user
    await c.query(
      `INSERT INTO users (id, email, name, is_agent, email_verified)
       VALUES ($1, $2, 'FU Human', false, true)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, 'mcp-fetch-unread-human@test.local'],
    );

    // Agent shadow user (no email — agents may not have one)
    await c.query(
      `INSERT INTO users (id, name, is_agent, email_verified)
       VALUES ($1, 'FU Agent', true, true)
       ON CONFLICT (id) DO NOTHING`,
      [AGENT_USER_ID],
    );

    // Agent employee pointing at the shadow user
    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt,
         trust_level, is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, 'FU Agent', $4, 'engineering_lead', 'test',
         'autonomous', true, true, $3)
       ON CONFLICT (id) DO UPDATE SET
         user_id = $3,
         is_active = true`,
      [AGENT_EMPLOYEE_ID, ORG_ID, AGENT_USER_ID, AGENT_EMPLOYEE_SLUG],
    );

    // Org membership for both users.
    // gen_random_uuid() is used because id has no DB-level default.
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role)
       VALUES (gen_random_uuid(), $1, $2, 'owner'),
              (gen_random_uuid(), $1, $3, 'member')
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, TEST_USER_ID, AGENT_USER_ID],
    );

    // Primary test space
    await c.query(
      `INSERT INTO spaces (id, org_id, name, type, created_by)
       VALUES ($1, $2, 'fu-test-space', 'public', $3)
       ON CONFLICT (id) DO NOTHING`,
      [SPACE_ID, ORG_ID, TEST_USER_ID],
    );

    // Other (filter-target) space
    await c.query(
      `INSERT INTO spaces (id, org_id, name, type, created_by)
       VALUES ($1, $2, 'fu-other-space', 'public', $3)
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_SPACE_ID, ORG_ID, TEST_USER_ID],
    );

    // Space memberships — both users in both spaces, last_read_at = NULL so
    // all messages appear as "unread".
    await c.query(
      `INSERT INTO space_members (id, space_id, user_id)
       VALUES (gen_random_uuid(), $1, $2),
              (gen_random_uuid(), $1, $3),
              (gen_random_uuid(), $4, $2),
              (gen_random_uuid(), $4, $3)
       ON CONFLICT (space_id, user_id) DO UPDATE SET last_read_at = NULL`,
      [SPACE_ID, TEST_USER_ID, AGENT_USER_ID, OTHER_SPACE_ID],
    );
  });
});

after(async () => {
  await withClient(async (c) => {
    // Delete inserted messages
    if (insertedMessages.length > 0) {
      await c.query(`DELETE FROM messages WHERE id = ANY($1::text[])`, [insertedMessages]);
    }
    // Delete inserted actions
    if (insertedActions.length > 0) {
      await c.query(`DELETE FROM agent_actions WHERE id = ANY($1::text[])`, [insertedActions]);
    }
    // Remove space memberships
    await c.query(
      `DELETE FROM space_members WHERE space_id = ANY($1::text[])`,
      [[SPACE_ID, OTHER_SPACE_ID]],
    );
    // Remove spaces
    await c.query(`DELETE FROM spaces WHERE id = ANY($1::text[])`, [[SPACE_ID, OTHER_SPACE_ID]]);
    // Remove org memberships
    await c.query(
      `DELETE FROM org_members WHERE org_id = $1 AND user_id = ANY($2::text[])`,
      [ORG_ID, [TEST_USER_ID, AGENT_USER_ID]],
    );
    // Remove employee
    await c.query(`DELETE FROM agent_employees WHERE id = $1`, [AGENT_EMPLOYEE_ID]);
    // Remove users
    await c.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [
      [TEST_USER_ID, AGENT_USER_ID],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Test 1 — human message visible to caller
// ---------------------------------------------------------------------------
test('fetch_unread returns messages from human in spaces the caller is a member of', async () => {
  const msgId = await withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)
       RETURNING id`,
      [ORG_ID, SPACE_ID, TEST_USER_ID, 'hello agent from human'],
    );
    return r.rows[0].id as string;
  });
  insertedMessages.push(msgId);

  const r = parseResult(await fetchUnread({ caller_employee_slug: AGENT_EMPLOYEE_SLUG }, makeCtx()));
  assert.ok(
    r.unread_messages.some((m) => m.content === 'hello agent from human'),
    'should see the human message in unread_messages',
  );
});

// ---------------------------------------------------------------------------
// Test 2 — caller's own posts excluded
// ---------------------------------------------------------------------------
test("fetch_unread excludes the caller's own posts", async () => {
  const msgId = await withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)
       RETURNING id`,
      [ORG_ID, SPACE_ID, AGENT_USER_ID, 'self-post-should-not-appear'],
    );
    return r.rows[0].id as string;
  });
  insertedMessages.push(msgId);

  const r = parseResult(await fetchUnread({ caller_employee_slug: AGENT_EMPLOYEE_SLUG }, makeCtx()));
  assert.ok(
    !r.unread_messages.some((m) => m.content === 'self-post-should-not-appear'),
    'should NOT include messages posted by the agent shadow user',
  );
});

// ---------------------------------------------------------------------------
// Test 3 — pending_actions included for caller
// ---------------------------------------------------------------------------
test('fetch_unread returns pending_actions for the caller', async () => {
  const actionId = await withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO agent_actions
         (id, org_id, user_id, agent_employee_id, action, params,
          approval_tier, approval_status)
       VALUES (gen_random_uuid(), $1, $2, $3, 'create_task', $4::jsonb, 'quick', 'pending')
       RETURNING id`,
      [ORG_ID, TEST_USER_ID, AGENT_EMPLOYEE_ID, JSON.stringify({ title: 'pending task' })],
    );
    return r.rows[0].id as string;
  });
  insertedActions.push(actionId);

  const r = parseResult(await fetchUnread({ caller_employee_slug: AGENT_EMPLOYEE_SLUG }, makeCtx()));
  assert.ok(
    r.pending_actions.some((a) => a.id === actionId),
    'should include the pending agent_action in pending_actions',
  );
});

// ---------------------------------------------------------------------------
// Test 4 — limit caps unread_messages
// ---------------------------------------------------------------------------
test('fetch_unread limit caps the unread_messages array', async () => {
  const ids = await withClient(async (c) => {
    const inserted: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await c.query(
        `INSERT INTO messages (id, org_id, space_id, user_id, content)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)
         RETURNING id`,
        [ORG_ID, SPACE_ID, TEST_USER_ID, `bulk-limit-msg-${i}`],
      );
      inserted.push(r.rows[0].id as string);
    }
    return inserted;
  });
  insertedMessages.push(...ids);

  const r = parseResult(
    await fetchUnread({ caller_employee_slug: AGENT_EMPLOYEE_SLUG, limit: 3 }, makeCtx()),
  );
  assert.ok(
    r.unread_messages.length <= 3,
    `expected at most 3 messages, got ${r.unread_messages.length}`,
  );
});

// ---------------------------------------------------------------------------
// Test 5 — space_id filter restricts to that space
// ---------------------------------------------------------------------------
test('fetch_unread space_id filter restricts to that space', async () => {
  const msgId = await withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)
       RETURNING id`,
      [ORG_ID, OTHER_SPACE_ID, TEST_USER_ID, 'in-other-space-only'],
    );
    return r.rows[0].id as string;
  });
  insertedMessages.push(msgId);

  const r = parseResult(
    await fetchUnread(
      { caller_employee_slug: AGENT_EMPLOYEE_SLUG, space_id: SPACE_ID },
      makeCtx(),
    ),
  );
  assert.ok(
    !r.unread_messages.some((m) => m.content === 'in-other-space-only'),
    'space_id filter should exclude messages from other spaces',
  );
});
