/**
 * Task 1.4 — memory_recall delegates to retrieveContext gateway.
 *
 * Run: pnpm --filter @deft/api test -- mcp-memory-recall
 *
 * Covers:
 *   1. scope: 'own'  → only employee-tagged pages returned
 *   2. scope: 'org'  → only org-scoped pages returned, including audit-attributed pages
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
const OTHER_AGENT_EMPLOYEE_ID = `mcp-recall-other-emp-${Date.now()}`;
const SPACE_ID = `mcp-recall-space-${Date.now()}`;
const PRIVATE_SPACE_ID = `mcp-recall-private-space-${Date.now()}`;

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

    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, 'MCP Recall Other Emp', $4, 'custom', 'test', 'standard',
         true, true, $3)
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_AGENT_EMPLOYEE_ID, ORG_ID, TEST_USER_ID, `mcp-recall-other-${Date.now()}`],
    );
    seededIds.push({ table: 'agent_employees', id: OTHER_AGENT_EMPLOYEE_ID });

    await c.query(
      `INSERT INTO spaces (id, org_id, name, type, is_archived)
       VALUES ($1, $2, 'MCP Recall Public Space', 'public', false)`,
      [SPACE_ID, ORG_ID],
    );
    seededIds.push({ table: 'spaces', id: SPACE_ID });

    await c.query(
      `INSERT INTO spaces (id, org_id, name, type, is_archived)
       VALUES ($1, $2, 'MCP Recall Private Space', 'private', false)`,
      [PRIVATE_SPACE_ID, ORG_ID],
    );
    seededIds.push({ table: 'spaces', id: PRIVATE_SPACE_ID });

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

    // Org-wide wiki page (tier 2 — "org", legacy/no employee attribution).
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

    // Org-wide wiki page with employee attribution, matching Defty-approved
    // knowledge captures. This must be visible as org knowledge to other
    // employees even though agent_employee_id is not null.
    const attributedOrgPageId = `mcp-recall-attributed-org-page-${Date.now()}`;
    await c.query(
      `INSERT INTO wiki_pages
         (id, org_id, type, scope, title, slug, summary, content, confidence,
          agent_employee_id, is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'fact', 'org', $3, $4, $5, $6, 0.85, $7, false, NOW(), NOW())`,
      [
        attributedOrgPageId,
        ORG_ID,
        `Defty Org ${QUERY_TERM} Fact`,
        `defty-org-fact-${Date.now()}`,
        `Summary about ${QUERY_TERM} from Defty org knowledge.`,
        `The ${QUERY_TERM} fact was saved by Defty as org knowledge with audit attribution.`,
        OTHER_AGENT_EMPLOYEE_ID,
      ],
    );
    await c.query(
      `UPDATE wiki_pages SET search_vector =
         setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
         setweight(to_tsvector('english', COALESCE(summary, '')), 'B') ||
         setweight(to_tsvector('english', COALESCE(content, '')), 'C')
       WHERE id = $1`,
      [attributedOrgPageId],
    );
    seededIds.push({ table: 'wiki_pages', id: attributedOrgPageId });

    // Org-wide page that originated in one specific channel. Channel-only
    // recall should include this page while excluding unrelated org memory.
    const channelOriginPageId = `mcp-recall-channel-origin-page-${Date.now()}`;
    await c.query(
      `INSERT INTO wiki_pages
         (id, org_id, type, scope, title, slug, summary, content, confidence,
          origin_space_id, created_via, is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'procedure', 'org', $3, $4, $5, $6, 0.95, $7, 'test_channel_origin',
          false, NOW(), NOW())`,
      [
        channelOriginPageId,
        ORG_ID,
        `Channel ${QUERY_TERM} Procedure`,
        `channel-procedure-${Date.now()}`,
        `Summary about ${QUERY_TERM} from a specific channel.`,
        `The ${QUERY_TERM} channel procedure belongs to the public test channel.`,
        SPACE_ID,
      ],
    );
    await c.query(
      `UPDATE wiki_pages SET search_vector =
         setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
         setweight(to_tsvector('english', COALESCE(summary, '')), 'B') ||
         setweight(to_tsvector('english', COALESCE(content, '')), 'C')
       WHERE id = $1`,
      [channelOriginPageId],
    );
    seededIds.push({ table: 'wiki_pages', id: channelOriginPageId });
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

    // Org scope returns company memory, including pages that originated from a
    // channel but were promoted to org-level knowledge.
    for (const row of rows) {
      assert.ok(
        !String(row.title).includes('Employee'),
        `Expected no employee-private page in org scope, got title: ${row.title}`,
      );
    }
    // Employee-tagged page must not appear.
    const empPage = rows.find((r) => String(r.title).includes('Employee'));
    assert.strictEqual(empPage, undefined, 'Employee-tagged page must not appear in org scope');

    assert.ok(
      rows.some((r) => String(r.title).includes('Defty Org')),
      'Org scope should include org pages that retain agent_employee_id for audit attribution',
    );
    assert.ok(
      rows.some((r) => String(r.title).includes('Channel')),
      'Org scope should include promoted channel-origin company memory',
    );
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
      assert.ok('origin_space_id' in row, 'Missing field: origin_space_id');
      assert.ok('created_via' in row, 'Missing field: created_via');
      assert.ok('matched_space_id' in row, 'Missing field: matched_space_id');
    }
  });

  test('6. space_id with include_org=false returns channel-origin memory but excludes unrelated org memory', async () => {
    const result = await memoryRecall(
      {
        caller_employee_slug: 'mcp-recall-test',
        query: QUERY_TERM,
        scope: 'all',
        space_id: SPACE_ID,
        include_org: false,
        limit: 10,
      },
      makeCtx(),
    );

    assert.ok(!result.isError, `Unexpected error: ${result.content[0]?.text}`);

    const rows = JSON.parse(result.content[0].text) as Array<Record<string, unknown>>;
    assert.ok(rows.length >= 1, 'Expected channel-origin result');
    assert.ok(
      rows.some((row) => String(row.title).includes('Channel')),
      `Expected channel-origin page in results, got ${rows.map((row) => row.title).join(', ')}`,
    );
    assert.ok(
      rows.some((row) => row.matched_space_id === SPACE_ID),
      `Expected at least one row to carry matched_space_id ${SPACE_ID}`,
    );
    assert.ok(
      rows.every((row) => !String(row.title).startsWith('Org ')),
      `Channel-only recall should exclude unrelated org pages, got ${rows.map((row) => row.title).join(', ')}`,
    );
  });

  test('7. private space_id is rejected when employee shadow user is not a member', async () => {
    const result = await memoryRecall(
      {
        caller_employee_slug: 'mcp-recall-test',
        query: QUERY_TERM,
        space_id: PRIVATE_SPACE_ID,
        include_org: false,
        limit: 10,
      },
      makeCtx(),
    );

    assert.strictEqual(result.isError, true, 'Private inaccessible space should produce an error result');
    assert.match(result.content[0]?.text ?? '', /cannot access space/);
  });
});
