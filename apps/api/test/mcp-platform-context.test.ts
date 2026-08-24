/**
 * Task 1.5 — platform_context delegates wiki retrieval to retrieveContext gateway.
 *
 * Run: pnpm --filter @deft/api test -- mcp-platform-context
 *
 * Covers:
 *   1. With a triggering message, wiki snippets are returned for the matched query
 *   2. Without a triggering message (empty query), fallback returns top-confidence pages
 *   3. Response shape has required fields: slug, title, summary, type, confidence
 *   4. Employee-tagged pages are returned for the correct employee (tier-bias)
 *   5. Second call within 60s returns a cache hit (_cache_hit: true)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { platformContext, _clearPlatformContextCache } from '../src/lib/mcp-tools/context.js';
import type { ToolContext } from '../src/lib/mcp-tools/types.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const TEST_USER_ID = `mcp-ctx-test-user-${Date.now()}`;
const AGENT_EMPLOYEE_ID = `mcp-ctx-test-emp-${Date.now()}`;

// Unique query term so only our seeded pages match.
const QUERY_TERM = `xmcpctx${Date.now()}`;

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

function makeCtx(): ToolContext {
  return {
    org_id: ORG_ID,
    employee_id: AGENT_EMPLOYEE_ID,
    employee_slug: 'mcp-ctx-test',
    trust_level: 'standard',
  };
}

let triggeringMessageId: string;
let triggeringSpaceId: string;

before(async () => {
  await withClient(async (c) => {
    // Keep the fixture self-contained on a freshly pushed schema. Many legacy
    // tests share this org id, so do not remove it in after().
    await c.query(
      `INSERT INTO orgs (id, name, slug, timezone)
       VALUES ($1, 'MCP Context Test Org', 'mcp-context-test-org', 'UTC')
       ON CONFLICT (id) DO NOTHING`,
      [ORG_ID],
    );

    // Ensure test user exists.
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'MCP Context Test User', false)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, `mcp-ctx-test-${Date.now()}@test.local`],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, TEST_USER_ID],
    );

    // Create a throwaway agent_employees row so FK on wiki_pages is satisfied.
    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, 'MCP Context Test Emp', $4, 'custom', 'test', 'standard',
         true, true, $3)
       ON CONFLICT (id) DO NOTHING`,
      [AGENT_EMPLOYEE_ID, ORG_ID, TEST_USER_ID, `mcp-ctx-slug-${Date.now()}`],
    );
    seededIds.push({ table: 'agent_employees', id: AGENT_EMPLOYEE_ID });

    // Seed a space for the message.
    const spaceId = `mcp-ctx-space-${Date.now()}`;
    triggeringSpaceId = spaceId;
    await c.query(
      `INSERT INTO spaces (id, org_id, name, created_by)
       VALUES ($1, $2, 'MCP Ctx Test Space', $3)
       ON CONFLICT (id) DO NOTHING`,
      [spaceId, ORG_ID, TEST_USER_ID],
    );
    seededIds.push({ table: 'spaces', id: spaceId });

    // Seed a message whose content IS the query term — this becomes the
    // triggering_message_id that the platform_context handler will fetch to
    // derive the wiki query text.  The content must match the wiki page
    // search_vector exactly (plainto_tsquery requires ALL tokens to match),
    // so we use just the unique term, not a sentence.
    const msgId = `mcp-ctx-msg-${Date.now()}`;
    await c.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [msgId, ORG_ID, spaceId, TEST_USER_ID, QUERY_TERM],
    );
    seededIds.push({ table: 'messages', id: msgId });
    triggeringMessageId = msgId;

    // Employee-tagged wiki page matching the query term.
    const empPageId = `mcp-ctx-emp-page-${Date.now()}`;
    await c.query(
      `INSERT INTO wiki_pages
         (id, org_id, type, scope, title, slug, summary, content, confidence,
          agent_employee_id, is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'fact', 'user', $3, $4, $5, $6, 0.9, $7, false, NOW(), NOW())`,
      [
        empPageId,
        ORG_ID,
        `Employee ${QUERY_TERM} Fact`,
        `mcp-ctx-emp-fact-${Date.now()}`,
        `Summary about ${QUERY_TERM} from employee memory.`,
        `The ${QUERY_TERM} fact is stored in employee scope.`,
        AGENT_EMPLOYEE_ID,
      ],
    );
    await c.query(
      `UPDATE wiki_pages SET search_vector =
         setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
         setweight(to_tsvector('english', COALESCE(summary, '')), 'B') ||
         setweight(to_tsvector('english', COALESCE(content, '')), 'C')
       WHERE id = $1`,
      [empPageId],
    );
    seededIds.push({ table: 'wiki_pages', id: empPageId });

    // Org-wide wiki page matching the query term.
    const orgPageId = `mcp-ctx-org-page-${Date.now()}`;
    await c.query(
      `INSERT INTO wiki_pages
         (id, org_id, type, scope, title, slug, summary, content, confidence,
          is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'concept', 'org', $3, $4, $5, $6, 0.8, false, NOW(), NOW())`,
      [
        orgPageId,
        ORG_ID,
        `Org ${QUERY_TERM} Concept`,
        `mcp-ctx-org-concept-${Date.now()}`,
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

    // Org-visible memory that originated from the trigger channel. The
    // context packet layer should route this to channel memory while the
    // flat legacy snippet list remains backward-compatible.
    const channelPageId = `mcp-ctx-channel-page-${Date.now()}`;
    await c.query(
      `INSERT INTO wiki_pages
         (id, org_id, type, scope, title, slug, summary, content, confidence,
          origin_space_id, created_via, is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'procedure', 'org', $3, $4, $5, $6, 0.95, $7,
          'test_channel_origin', false, NOW(), NOW())`,
      [
        channelPageId,
        ORG_ID,
        `Channel ${QUERY_TERM} Procedure`,
        `mcp-ctx-channel-procedure-${Date.now()}`,
        `Summary about ${QUERY_TERM} from the trigger channel.`,
        `The ${QUERY_TERM} procedure was captured from the trigger channel.`,
        spaceId,
      ],
    );
    await c.query(
      `UPDATE wiki_pages SET search_vector =
         setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
         setweight(to_tsvector('english', COALESCE(summary, '')), 'B') ||
         setweight(to_tsvector('english', COALESCE(content, '')), 'C')
       WHERE id = $1`,
      [channelPageId],
    );
    seededIds.push({ table: 'wiki_pages', id: channelPageId });

    const citedPageId = `mcp-ctx-cited-page-${Date.now()}`;
    await c.query(
      `INSERT INTO wiki_pages
         (id, org_id, type, scope, title, slug, summary, content, confidence,
          is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'fact', 'org', $3, $4, $5, $6, 0.92, false, NOW(), NOW())`,
      [
        citedPageId,
        ORG_ID,
        `Cited ${QUERY_TERM} Context`,
        `mcp-ctx-cited-context-${Date.now()}`,
        `Summary about ${QUERY_TERM} from a message citation.`,
        `The ${QUERY_TERM} cited page is linked to the trigger channel only through citation provenance.`,
      ],
    );
    await c.query(
      `UPDATE wiki_pages SET search_vector =
         setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
         setweight(to_tsvector('english', COALESCE(summary, '')), 'B') ||
         setweight(to_tsvector('english', COALESCE(content, '')), 'C')
       WHERE id = $1`,
      [citedPageId],
    );
    await c.query(
      `INSERT INTO wiki_citations
         (id, org_id, page_id, source_type, source_id, source_space_id, source_user_id, excerpt)
       VALUES (gen_random_uuid()::text, $1, $2, 'message', $3, $4, $5, $6)`,
      [ORG_ID, citedPageId, msgId, spaceId, TEST_USER_ID, `Citation excerpt for ${QUERY_TERM}`],
    );
    seededIds.push({ table: 'wiki_pages', id: citedPageId });
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
  _clearPlatformContextCache();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('platformContext', () => {
  test('1. wiki snippets returned when trigger has a matching message', async () => {
    _clearPlatformContextCache();
    const result = await platformContext(
      {
        caller_employee_slug: 'mcp-ctx-test',
        trigger: { kind: 'message', triggering_message_id: triggeringMessageId },
      },
      makeCtx(),
    );

    assert.ok(!result.isError, `Unexpected error: ${result.content[0]?.text}`);

    const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
    const snippets = parsed.relevant_wiki_snippets as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(snippets), 'relevant_wiki_snippets is an array');
    assert.ok(snippets.length >= 1, `Expected at least 1 wiki snippet, got ${snippets.length}`);

    // At least one snippet must match the seeded query term.
    const matchingTitles = snippets.filter((s) =>
      String(s.title).toLowerCase().includes(QUERY_TERM.toLowerCase()),
    );
    assert.ok(
      matchingTitles.length >= 1,
      `Expected at least one snippet with QUERY_TERM in title, got titles: ${snippets.map((s) => s.title).join(', ')}`,
    );
  });

  test('2. response shape has required fields: slug, title, summary, type, confidence', async () => {
    _clearPlatformContextCache();
    const result = await platformContext(
      {
        caller_employee_slug: 'mcp-ctx-test',
        trigger: { kind: 'message', triggering_message_id: triggeringMessageId },
      },
      makeCtx(),
    );

    assert.ok(!result.isError, `Unexpected error: ${result.content[0]?.text}`);

    const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
    const snippets = parsed.relevant_wiki_snippets as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(snippets), 'relevant_wiki_snippets is an array');

    for (const snippet of snippets) {
      assert.ok('slug' in snippet, 'Missing field: slug');
      assert.ok('title' in snippet, 'Missing field: title');
      assert.ok('summary' in snippet, 'Missing field: summary');
      assert.ok('type' in snippet, 'Missing field: type');
      assert.ok('confidence' in snippet, 'Missing field: confidence');
    }
  });

  test('3. employee-tagged pages appear when employee_id matches', async () => {
    _clearPlatformContextCache();
    const result = await platformContext(
      {
        caller_employee_slug: 'mcp-ctx-test',
        trigger: { kind: 'message', triggering_message_id: triggeringMessageId },
      },
      makeCtx(),
    );

    assert.ok(!result.isError, `Unexpected error: ${result.content[0]?.text}`);

    const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
    const snippets = parsed.relevant_wiki_snippets as Array<Record<string, unknown>>;
    const employeePage = snippets.find((s) => String(s.title).includes('Employee'));
    assert.ok(employeePage !== undefined, 'Employee-tagged wiki page should appear in snippets');
  });

  test('3b. context_packets separate company, channel, and employee memory', async () => {
    _clearPlatformContextCache();
    const result = await platformContext(
      {
        caller_employee_slug: 'mcp-ctx-test',
        trigger: {
          kind: 'message',
          triggering_message_id: triggeringMessageId,
          space_id: triggeringSpaceId,
        },
      },
      makeCtx(),
    );

    assert.ok(!result.isError, `Unexpected error: ${result.content[0]?.text}`);

    const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
    const packets = parsed.context_packets as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(packets), 'context_packets is an array');

    const company = packets.find((packet) => packet.id === 'company_memory');
    const channel = packets.find((packet) => packet.id === `space:${triggeringSpaceId}:memory`);
    const employee = packets.find((packet) => packet.id === 'employee_memory');
    assert.ok(company, 'company memory packet exists');
    assert.ok(channel, 'channel memory packet exists');
    assert.ok(employee, 'employee memory packet exists');
    assert.equal(
      packets[0]?.id,
      `space:${triggeringSpaceId}:memory`,
      'the current channel must be the first automatic evidence packet',
    );
    assert.equal(
      packets.at(-1)?.id,
      'company_memory',
      'broad company memory must follow local and employee-scoped evidence',
    );

    const companyItems = company.items as Array<Record<string, unknown>>;
    const channelItems = channel.items as Array<Record<string, unknown>>;
    const employeeItems = employee.items as Array<Record<string, unknown>>;

    assert.ok(
      companyItems.some((item) => String(item.title).includes('Org')),
      'company packet should contain org-wide memory',
    );
    assert.ok(
      channelItems.some((item) => String(item.title).includes('Channel')),
      'channel packet should contain channel-origin memory',
    );
    assert.ok(
      channelItems.some((item) => String(item.title).includes('Cited')),
      'channel packet should contain citation-linked memory',
    );
    assert.ok(
      employeeItems.some((item) => String(item.title).includes('Employee')),
      'employee packet should contain employee memory',
    );
    assert.ok(
      channel.retrieval_hint,
      'channel packet should include a retrieval hint for follow-up recall',
    );
  });

  test('4. without trigger message, fallback returns top-confidence snippets', async () => {
    _clearPlatformContextCache();
    const result = await platformContext(
      { caller_employee_slug: 'mcp-ctx-test' },
      makeCtx(),
    );

    assert.ok(!result.isError, `Unexpected error: ${result.content[0]?.text}`);

    const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
    // Should have the expected top-level payload structure.
    assert.ok(parsed.date, 'date field present');
    assert.ok(parsed.org, 'org field present');
    assert.ok(parsed.employee, 'employee field present');
    assert.ok(Array.isArray(parsed.relevant_wiki_snippets), 'relevant_wiki_snippets is array');
  });

  test('4b. channel trigger without message still routes source-linked memory into channel packet', async () => {
    _clearPlatformContextCache();
    const result = await platformContext(
      {
        caller_employee_slug: 'mcp-ctx-test',
        trigger: { kind: 'channel_wake', space_id: triggeringSpaceId },
      },
      makeCtx(),
    );

    assert.ok(!result.isError, `Unexpected error: ${result.content[0]?.text}`);

    const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
    const packets = parsed.context_packets as Array<Record<string, unknown>>;
    const channel = packets.find((packet) => packet.id === `space:${triggeringSpaceId}:memory`);
    assert.ok(channel, 'channel memory packet exists');

    const channelItems = channel.items as Array<Record<string, unknown>>;
    assert.ok(
      channelItems.some((item) => String(item.title).includes('Channel')),
      'channel packet should contain origin-space memory in no-query fallback',
    );
    assert.ok(
      channelItems.some((item) => String(item.title).includes('Cited')),
      'channel packet should contain citation-linked memory in no-query fallback',
    );
  });

  test('5. second call within 60s returns _cache_hit: true', async () => {
    _clearPlatformContextCache();
    const trigger = { kind: 'message', triggering_message_id: triggeringMessageId };

    // First call — seeds the cache.
    const first = await platformContext(
      { caller_employee_slug: 'mcp-ctx-test', trigger },
      makeCtx(),
    );
    assert.ok(!first.isError, `First call should not error: ${first.content[0]?.text}`);
    const firstParsed = JSON.parse(first.content[0].text) as Record<string, unknown>;
    assert.strictEqual(firstParsed._cache_hit, false, 'First call must not be a cache hit');

    // Second call — should hit the LRU cache.
    const second = await platformContext(
      { caller_employee_slug: 'mcp-ctx-test', trigger },
      makeCtx(),
    );
    assert.ok(!second.isError, `Second call should not error: ${second.content[0]?.text}`);
    const secondParsed = JSON.parse(second.content[0].text) as Record<string, unknown>;
    assert.strictEqual(secondParsed._cache_hit, true, 'Second call must be a cache hit');
  });
});
