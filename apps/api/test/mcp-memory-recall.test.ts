/**
 * Task 1.4 — memory_recall delegates to retrieveContext gateway.
 *
 * Run: pnpm --filter @deft/api test -- mcp-memory-recall
 *
 * Covers:
 *   1. scope: 'own'  → only employee-tagged pages returned
 *   2. scope: 'org'  → only org-wide pages (agent_employee_id IS NULL) returned
 *   3. scope: 'all'  → both tiers returned (default behaviour)
 *   4. empty query   → error result
 *   5. response shape preserves: slug, title, summary, type, confidence
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { memoryRecall } from '../src/lib/mcp-tools/memory.js';
import type { ToolContext } from '../src/lib/mcp-tools/types.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const TEST_USER_ID = 'mcp-recall-test-user';
const AGENT_EMPLOYEE_ID = `mcp-recall-test-emp-${Date.now()}`;

// Unique query term so only our seeded pages match — avoids interference with
// other wiki_pages rows in the dev database.
const QUERY_TERM = `xmcprecall${Date.now()}`;

// IDs of rows inserted during setup — cleaned up in after().
const seededIds: { table: string; id: string }[] = [];

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Build a minimal ToolContext for the test employee. */
function makeCtx(): ToolContext {
  return {
    org_id: ORG_ID,
    employee_id: AGENT_EMPLOYEE_ID,
    employee_slug: 'mcp-recall-test',
    trust_level: 'standard',
  };
}

before(async () => {
  await withClient(async (c) => {
    // Ensure test user exists.
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'MCP Recall Test User', false)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, 'mcp-recall-test@test.local'],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, TEST_USER_ID],
    );

    // Create throwaway agent_employees row so FK on wiki_pages is satisfied.
    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, 'MCP Recall Test Emp', $4, 'custom', 'test', 'standard',
         true, true, $3)
       ON CONFLICT (id) DO NOTHING`,
      [AGENT_EMPLOYEE_ID, ORG_ID, TEST_USER_ID, `mcp-recall-slug-${Date.now()}`],
    );
    seededIds.push({ table: 'agent_employees', id: AGENT_EMPLOYEE_ID });

    // Employee-tagged wiki page (tier 1 — "own").
    const empPageId = `mcp-recall-emp-page-${Date.now()}`;
    await c.query(
      `INSERT INTO wiki_pages
         (id, org_id, type, scope, title, slug, summary, content, confidence,
          agent_employee_id, is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'fact', 'user', $3, $4, $5, $6, 0.9, $7, false, NOW(), NOW())`,
      [
        empPageId,
        ORG_ID,
        `Employee ${QUERY_TERM} Fact`,
        `emp-fact-${Date.now()}`,
        `Summary about ${QUERY_TERM} from employee memory.`,
        `The ${QUERY_TERM} fact is stored in employee scope.`,
        AGENT_EMPLOYEE_ID,
      ],
    );
    // Immediately update search_vector so FTS works.
    await c.query(
      `UPDATE wiki_pages SET search_vector =
         setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
         setweight(to_tsvector('english', COALESCE(summary, '')), 'B') ||
         setweight(to_tsvector('english', COALESCE(content, '')), 'C')
       WHERE id = $1`,
      [empPageId],
    );
    seededIds.push({ table: 'wiki_pages', id: empPageId });

    // Org-wide wiki page (tier 2 — "org", agent_employee_id IS NULL).
    const orgPageId = `mcp-recall-org-page-${Date.now()}`;
    await c.query(
      `INSERT INTO wiki_pages
         (id, org_id, type, scope, title, slug, summary, content, confidence,
          is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'concept', 'org', $3, $4, $5, $6, 0.8, false, NOW(), NOW())`,
      [
        orgPageId,
        ORG_ID,
        `Org ${QUERY_TERM} Concept`,
        `org-concept-${Date.now()}`,
        `Summary about ${QUERY_TERM} from org knowledge.`,
        `The ${QUERY_TERM} concept governs the organisation.`,
      ],
    );
    await c.query(
      `UPDATE wiki_pages SET search_vector =
         setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
         setweight(to_tsvector('english', COALESCE(summary, '')), 'B') ||
         setweight(to_tsvector('english', COALESCE(content, '')), 'C')
       WHERE id = $1`,
      [orgPageId],
    );
    seededIds.push({ table: 'wiki_pages', id: orgPageId });
  });
});

after(async () => {
  await withClient(async (c) => {
    for (const { table, id } of [...seededIds].reverse()) {
      await c.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    }
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [TEST_USER_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [TEST_USER_ID]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('memoryRecall', () => {
  test('1. scope: own returns only employee-tagged pages', async () => {
    const result = await memoryRecall(
      { caller_employee_slug: 'mcp-recall-test', query: QUERY_TERM, scope: 'own', limit: 10 },
      makeCtx(),
    );

    assert.ok(!result.isError, `Unexpected error: ${result.content[0]?.text}`);

    const rows = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>;
    assert.ok(rows.length >= 1, `Expected at least 1 own-scope result, got ${rows.length}`);

    // All returned pages should be the employee-tagged one (title includes 'Employee').
    for (const row of rows) {
      assert.ok(
        String(row.title).includes('Employee'),
        `Expected only employee-tagged page in own scope, got title: ${row.title}`,
      );
    }
    // Org-wide page must not appear.
    const orgPage = rows.find((r) => String(r.title).includes('Org'));
    assert.strictEqual(orgPage, undefined, 'Org-wide page must not appear in own scope');
  });

  test('2. scope: org returns only org-wide pages', async () => {
    const result = await memoryRecall(
      { caller_employee_slug: 'mcp-recall-test', query: QUERY_TERM, scope: 'org', limit: 10 },
      makeCtx(),
    );

    assert.ok(!result.isError, `Unexpected error: ${result.content[0]?.text}`);

    const rows = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>;
    assert.ok(rows.length >= 1, `Expected at least 1 org-scope result, got ${rows.length}`);

    // All returned pages should be the org-wide one (title includes 'Org').
    for (const row of rows) {
      assert.ok(
        String(row.title).includes('Org'),
        `Expected only org-wide page in org scope, got title: ${row.title}`,
      );
    }
    // Employee-tagged page must not appear.
    const empPage = rows.find((r) => String(r.title).includes('Employee'));
    assert.strictEqual(empPage, undefined, 'Employee-tagged page must not appear in org scope');
  });

  test('3. scope: all (default) returns both tiers', async () => {
    const result = await memoryRecall(
      { caller_employee_slug: 'mcp-recall-test', query: QUERY_TERM, scope: 'all', limit: 10 },
      makeCtx(),
    );

    assert.ok(!result.isError, `Unexpected error: ${result.content[0]?.text}`);

    const rows = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>;
    assert.ok(rows.length >= 2, `Expected at least 2 results (both tiers), got ${rows.length}`);

    const titles = rows.map((r) => String(r.title));
    assert.ok(titles.some((t) => t.includes('Employee')), 'Employee-tagged page should appear in all scope');
    assert.ok(titles.some((t) => t.includes('Org')), 'Org-wide page should appear in all scope');
  });

  test('4. empty query returns error result', async () => {
    const result = await memoryRecall(
      { caller_employee_slug: 'mcp-recall-test', query: '' },
      makeCtx(),
    );

    assert.strictEqual(result.isError, true, 'Empty query should produce an error result');
  });

  test('5. response shape has required fields: slug, title, summary, type, confidence', async () => {
    const result = await memoryRecall(
      { caller_employee_slug: 'mcp-recall-test', query: QUERY_TERM, scope: 'all', limit: 5 },
      makeCtx(),
    );

    assert.ok(!result.isError, `Unexpected error: ${result.content[0]?.text}`);

    const rows = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>;
    assert.ok(rows.length >= 1, 'Expected at least 1 result for shape check');

    for (const row of rows) {
      assert.ok('slug' in row, 'Missing field: slug');
      assert.ok('title' in row, 'Missing field: title');
      assert.ok('summary' in row, 'Missing field: summary');
      assert.ok('type' in row, 'Missing field: type');
      assert.ok('confidence' in row, 'Missing field: confidence');
    }
  });
});
