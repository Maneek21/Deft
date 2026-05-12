/**
 * Fix verification — search_decisions + search_knowledge migrated to retrieveContext.
 *
 * Run: pnpm --filter @deft/api test -- agent-context-search-tools
 *
 * This test seeds a wiki_pages row of type='decision' and verifies that
 * executeToolCall('search_decisions') finds it via FTS tokenisation rather than
 * literal substring matching (the old ilike '%query%' path would miss a
 * natural-language question like "Where should we host our deployments?").
 *
 * Similarly it seeds a wiki_pages row of type='concept' and verifies that
 * executeToolCall('search_knowledge') finds it via FTS.
 *
 * Covers:
 *  1. search_decisions with natural-language query returns seeded decision
 *  2. search_decisions with empty query returns all org decisions (fallback path)
 *  3. search_knowledge with natural-language query returns seeded wiki page
 *  4. search_knowledge with type='decision' filter returns only decisions
 *  5. agent-context.ts no longer contains ilike substring pattern for search_decisions
 *  6. agent-context.ts no longer queries the deprecated spaceKnowledge table in search_knowledge
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import pg from 'pg';
import { executeToolCall } from '../src/lib/agent-context.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

// Use the shared dev org so FK constraints (org_id) are satisfied.
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const USER_ID = 'search-tools-test-user';
const USER_EMAIL = 'search-tools-test@test.local';

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

// Unique term suffix so our rows don't clash with existing data.
const SUFFIX = Date.now();
const DECISION_ID = `search-tools-decision-${SUFFIX}`;
const WIKI_ID = `search-tools-wiki-${SUFFIX}`;
// Unique search term that won't appear in other DB rows — prevents score competition.
const WIKI_UNIQUE_TERM = `xyzpipelineuniq${SUFFIX}`;

before(async () => {
  await withClient(async (c) => {
    // Ensure test user + org membership exist.
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Search Tools Test User', false)
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID, USER_EMAIL],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, USER_ID],
    );

    // Seed a decision wiki page about deployment hosting.
    // The content uses "deployment hosting migration" so FTS can tokenise it.
    await c.query(
      `INSERT INTO wiki_pages
         (id, org_id, type, scope, title, slug, content, confidence, is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'decision', 'org', $3, $4,
         'We decided to move our deployments to Cloudflare Workers for edge execution. Priya will draft the deployment hosting migration plan by Friday.',
         1.0, false, NOW(), NOW())`,
      [
        DECISION_ID,
        ORG_ID,
        `Cloudflare Workers deployment decision ${SUFFIX}`,
        `cloudflare-workers-decision-${SUFFIX}`,
      ],
    );
    seededIds.push({ table: 'wiki_pages', id: DECISION_ID });

    // Seed a concept wiki page with a unique term so only this row matches.
    // The unique term is included in both the content and the test query to
    // guarantee a FTS match without competing against other DB rows.
    await c.query(
      `INSERT INTO wiki_pages
         (id, org_id, type, scope, title, slug, content, confidence, is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'concept', 'org', $3, $4, $5,
         1.0, false, NOW(), NOW())`,
      [
        WIKI_ID,
        ORG_ID,
        `CI CD pipeline knowledge ${SUFFIX}`,
        `cicd-pipeline-knowledge-${SUFFIX}`,
        `Our automated deployment pipeline ${WIKI_UNIQUE_TERM} runs on GitHub Actions. Deployment setup requires configuring pipeline secrets.`,
      ],
    );
    seededIds.push({ table: 'wiki_pages', id: WIKI_ID });
  });
});

after(async () => {
  await withClient(async (c) => {
    for (const { table, id } of [...seededIds].reverse()) {
      await c.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    }
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [USER_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('search_decisions + search_knowledge migrate to retrieveContext', () => {
  test('1. search_decisions: natural-language query finds decision via FTS tokenisation', async () => {
    // This is the core regression test.
    // Old code: ilike '%Where should we host our deployments?%' → 0 results.
    // New code: FTS plainto_tsquery tokenises → matches "deployment" → finds the row.
    const { result, citations } = await executeToolCall(
      'search_decisions',
      { query: 'Where should we host our deployments?' },
      ORG_ID,
      USER_ID,
    );

    assert.ok(Array.isArray(result), 'result should be an array');
    const found = result.find((r: any) => r.id === DECISION_ID);
    assert.ok(
      found !== undefined,
      `Expected to find decision ${DECISION_ID} in results. Got: ${JSON.stringify(result.map((r: any) => r.id))}`,
    );

    // Verify response shape.
    assert.ok(typeof found.decision === 'string', 'item.decision should be a string');
    assert.ok(typeof found.context === 'string', 'item.context should be a string');
    assert.ok(typeof found.is_reversed === 'boolean', 'item.is_reversed should be a boolean');
    assert.ok('tags' in found, 'item should have a tags field');
    assert.ok('when' in found, 'item should have a when field');

    // Citation must be present.
    assert.ok(
      citations.some((c: any) => c.id === DECISION_ID && c.type === 'decision'),
      'Citation for the seeded decision must be present',
    );
  });

  test('2. search_decisions: empty query returns all decisions (listing fallback)', async () => {
    const { result } = await executeToolCall(
      'search_decisions',
      { query: '' },
      ORG_ID,
      USER_ID,
    );

    assert.ok(Array.isArray(result), 'result should be an array');
    // The seeded decision should appear in the all-decisions list.
    const found = result.find((r: any) => r.id === DECISION_ID);
    assert.ok(
      found !== undefined,
      `Seeded decision should appear in empty-query listing. Got: ${JSON.stringify(result.map((r: any) => r.id))}`,
    );
  });

  test('3. search_knowledge: natural-language query finds wiki page via FTS tokenisation', async () => {
    // Use the unique term so only our seeded row scores highly — no interference
    // from existing DB rows that may also contain "deployment" or "pipeline".
    const { result, citations } = await executeToolCall(
      'search_knowledge',
      { query: `deployment pipeline ${WIKI_UNIQUE_TERM}` },
      ORG_ID,
      USER_ID,
    );

    assert.ok(Array.isArray(result), 'result should be an array');
    const found = result.find((r: any) => r.id === WIKI_ID);
    assert.ok(
      found !== undefined,
      `Expected to find wiki page ${WIKI_ID} in results. Got: ${JSON.stringify(result.map((r: any) => r.id))}`,
    );

    // Verify response shape.
    assert.ok(typeof found.type === 'string', 'item.type should be a string');
    assert.ok(typeof found.title === 'string', 'item.title should be a string');
    assert.ok(typeof found.content === 'string', 'item.content should be a string');
    assert.ok('metadata' in found, 'item should have a metadata field');
    assert.ok('created_at' in found, 'item should have a created_at field');

    // Citation must be present.
    assert.ok(
      citations.some((c: any) => c.id === WIKI_ID && c.type === 'knowledge'),
      'Citation for the seeded wiki page must be present',
    );
  });

  test('4. search_knowledge: type=decision filter returns only decisions', async () => {
    const { result } = await executeToolCall(
      'search_knowledge',
      { query: 'deployment migration', type: 'decision' },
      ORG_ID,
      USER_ID,
    );

    assert.ok(Array.isArray(result), 'result should be an array');
    // All returned items must be decisions.
    for (const item of result as any[]) {
      assert.strictEqual(
        item.type,
        'decision',
        `All results should be type=decision, got: ${item.type}`,
      );
    }
  });

  test('5. agent-context.ts search_decisions no longer uses ilike substring pattern', () => {
    const __filename = fileURLToPath(import.meta.url);
    const contextPath = join(dirname(__filename), '../src/lib/agent-context.ts');
    const src = readFileSync(contextPath, 'utf8');

    // Find the search_decisions case block — it must NOT contain the old ilike pattern.
    const caseStart = src.indexOf("case 'search_decisions':");
    const caseEnd = src.indexOf("case 'get_user_activity':", caseStart);
    const caseBlock = src.slice(caseStart, caseEnd);

    assert.ok(
      !caseBlock.includes(`ilike(wikiPages.title`),
      'search_decisions must not use ilike on wikiPages.title (use retrieveContext instead)',
    );
    assert.ok(
      !caseBlock.includes(`ilike(wikiPages.content`),
      'search_decisions must not use ilike on wikiPages.content (use retrieveContext instead)',
    );
    assert.ok(
      caseBlock.includes('retrieveContext'),
      'search_decisions must call retrieveContext for query path',
    );
  });

  test('6. agent-context.ts search_knowledge no longer queries deprecated spaceKnowledge table', () => {
    const __filename = fileURLToPath(import.meta.url);
    const contextPath = join(dirname(__filename), '../src/lib/agent-context.ts');
    const src = readFileSync(contextPath, 'utf8');

    const caseStart = src.indexOf("case 'search_knowledge':");
    const caseEnd = src.indexOf("case 'add_knowledge':", caseStart);
    const caseBlock = src.slice(caseStart, caseEnd);

    assert.ok(
      !caseBlock.includes('spaceKnowledge'),
      'search_knowledge must not query the deprecated spaceKnowledge table (use retrieveContext instead)',
    );
    assert.ok(
      caseBlock.includes('retrieveContext'),
      'search_knowledge must call retrieveContext',
    );
  });
});
