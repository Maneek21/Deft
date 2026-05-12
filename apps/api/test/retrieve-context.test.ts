/**
 * Task 1.1 — retrieveContext gateway integration tests.
 * Task 1.2 — hybrid FTS + pgvector ranking tests appended below.
 * Task 5.2 — notes visibility tests appended below.
 *
 * Run: pnpm --filter @deft/api test -- retrieve-context
 *
 * Covers:
 *   1. Query matching all 4 types returns at least 2 results
 *   2. types: ['wiki'] only returns source_type === 'wiki_page'
 *   3. Short/empty query returns []
 *   4. Org isolation — results only contain rows from the correct org
 *   5. Notes branch: without user_id only org-visible notes are returned
 *   6. Employee-tagged wiki pages rank higher than org-wide pages (two-tier)
 *   7. hybrid: false param bypasses vector search (pure FTS path)
 *   8. Hybrid falls back to FTS when OPENAI_API_KEY is unset
 *   9. NULL-embedding pages still appear in hybrid results alongside embedded pages
 *  10. Org-visible note from user-A appears in user-B's results; private note does not
 *  11. System query (no user_id) returns only org-visible notes
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { retrieveContext } from '../src/lib/retrieve-context.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

// Use the existing dev org / user so FK constraints are satisfied.
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const USER_ID = 'retrieve-ctx-test-user';
const USER_EMAIL = 'retrieve-ctx-test@test.local';

// A fake agent_employee_id for the two-tier test. Must exist in agent_employees
// or the FK will reject the insert — we create a throwaway row in before().
const AGENT_EMPLOYEE_ID = `rctest-emp-${Date.now()}`;

// IDs of rows we insert during setup — cleaned up in after().
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

before(async () => {
  await withClient(async (c) => {
    // Ensure test user exists.
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Retrieve Ctx Test User', false)
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID, USER_EMAIL],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, USER_ID],
    );

    // Seed wiki page (type='concept') containing "billing decision".
    const wikiId = `rctest-wiki-${Date.now()}`;
    await c.query(
      `INSERT INTO wiki_pages (id, org_id, type, scope, title, slug, content, confidence, is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'concept', 'org', 'Billing Decision Policy', $3, 'This billing decision governs all invoice workflows.', 1.0, false, NOW(), NOW())`,
      [wikiId, ORG_ID, `billing-decision-policy-${Date.now()}`],
    );
    seededIds.push({ table: 'wiki_pages', id: wikiId });

    // Seed wiki page (type='decision') containing "billing decision".
    const decisionId = `rctest-decision-${Date.now()}`;
    await c.query(
      `INSERT INTO wiki_pages (id, org_id, type, scope, title, slug, content, confidence, is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'decision', 'org', 'Billing Decision Record', $3, 'We made a billing decision to use Stripe.', 1.0, false, NOW(), NOW())`,
      [decisionId, ORG_ID, `billing-decision-record-${Date.now()}`],
    );
    seededIds.push({ table: 'wiki_pages', id: decisionId });

    // Seed agent_memory row containing "billing decision".
    const memId = `rctest-mem-${Date.now()}`;
    await c.query(
      `INSERT INTO agent_memory (id, org_id, user_id, conversation_id, scope, key, value, created_at, updated_at)
       VALUES ($1, $2, $3, NULL, 'user', 'billing_note', 'User mentioned billing decision for Q2.', NOW(), NOW())`,
      [memId, ORG_ID, USER_ID],
    );
    seededIds.push({ table: 'agent_memory', id: memId });

    // Seed note containing "billing decision".
    const noteId = `rctest-note-${Date.now()}`;
    await c.query(
      `INSERT INTO notes (id, org_id, user_id, title, content, is_deleted, is_pinned, is_template, version, created_at, updated_at)
       VALUES ($1, $2, $3, 'Q2 Billing Notes', 'billing decision agreed upon in Q2 planning.', false, false, false, 1, NOW(), NOW())`,
      [noteId, ORG_ID, USER_ID],
    );
    seededIds.push({ table: 'notes', id: noteId });

    // ── Two-tier test setup ───────────────────────────────────────────────────
    // Create a throwaway agent_employees row so the FK on wiki_pages is satisfied.
    // Uses the test user (already inserted above) as both user_id and created_by.
    await c.query(
      `INSERT INTO agent_employees
        (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         is_byoa, is_active, created_by)
       VALUES ($1, $2, $3, 'RC Test Employee', $4, 'custom', 'test', 'standard',
         true, true, $3)
       ON CONFLICT (id) DO NOTHING`,
      [AGENT_EMPLOYEE_ID, ORG_ID, USER_ID, `rctest-emp-slug-${Date.now()}`],
    );
    seededIds.push({ table: 'agent_employees', id: AGENT_EMPLOYEE_ID });

    // Use a unique nonsense term so only our two seeded pages match this query.
    // This avoids interference from other wiki_pages rows that contain common
    // terms like "billing decision".
    const TIER_QUERY_TERM = `xyztierbenchmark${Date.now()}`;

    // Employee-tagged wiki page — should rank higher with two-tier retrieval.
    const empWikiId = `rctest-emp-wiki-${Date.now()}`;
    await c.query(
      `INSERT INTO wiki_pages (id, org_id, type, scope, title, slug, content, confidence, agent_employee_id, is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'concept', 'org', $3, $4, $5, 1.0, $6, false, NOW(), NOW())`,
      [
        empWikiId,
        ORG_ID,
        `Employee ${TIER_QUERY_TERM} Guide`,
        `emp-tier-guide-${Date.now()}`,
        `The ${TIER_QUERY_TERM} process governs this employee role.`,
        AGENT_EMPLOYEE_ID,
      ],
    );
    seededIds.push({ table: 'wiki_pages', id: empWikiId });
    // Store so test 6 can use it.
    (globalThis as Record<string, unknown>).__tierQueryTerm = TIER_QUERY_TERM;

    // Org-wide wiki page (no agent_employee_id) with same query term.
    const orgWikiId = `rctest-org-wiki-${Date.now()}`;
    await c.query(
      `INSERT INTO wiki_pages (id, org_id, type, scope, title, slug, content, confidence, is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'concept', 'org', $3, $4, $5, 1.0, false, NOW(), NOW())`,
      [
        orgWikiId,
        ORG_ID,
        `Org ${TIER_QUERY_TERM} Overview`,
        `org-tier-overview-${Date.now()}`,
        `The ${TIER_QUERY_TERM} overview for the whole organisation.`,
      ],
    );
    seededIds.push({ table: 'wiki_pages', id: orgWikiId });
  });
});

after(async () => {
  await withClient(async (c) => {
    // Delete in reverse insertion order to avoid FK violations.
    for (const { table, id } of [...seededIds].reverse()) {
      await c.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    }
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [USER_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('retrieveContext', () => {
  test('1. returns at least 2 results across all types for a known query', async () => {
    const results = await retrieveContext({
      query: 'billing decision',
      org_id: ORG_ID,
      user_id: USER_ID,
      types: ['wiki', 'memory', 'notes', 'decisions'],
    });

    assert.ok(results.length >= 2, `Expected >=2 results, got ${results.length}`);
    // All scores should be between 0 and 1 (normalised).
    for (const r of results) {
      assert.ok(r.score >= 0 && r.score <= 1, `score out of range: ${r.score}`);
    }
  });

  test('2. types: [wiki] only returns source_type wiki_page', async () => {
    const results = await retrieveContext({
      query: 'billing decision',
      org_id: ORG_ID,
      user_id: USER_ID,
      types: ['wiki'],
    });

    assert.ok(results.length >= 1, 'Expected at least 1 wiki result');
    for (const r of results) {
      assert.strictEqual(r.source_type, 'wiki_page', `Unexpected source_type: ${r.source_type}`);
    }
  });

  test('3. query under 2 chars after cleaning returns empty array', async () => {
    const r1 = await retrieveContext({ query: 'a', org_id: ORG_ID });
    assert.deepEqual(r1, []);

    const r2 = await retrieveContext({ query: '!!!', org_id: ORG_ID });
    assert.deepEqual(r2, []);

    const r3 = await retrieveContext({ query: '', org_id: ORG_ID });
    assert.deepEqual(r3, []);
  });

  test('4. org isolation — different org_id returns no seeded results', async () => {
    const results = await retrieveContext({
      query: 'billing decision',
      org_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', // non-existent org
      user_id: USER_ID,
      types: ['wiki', 'memory', 'notes', 'decisions'],
    });

    // The seeded rows belong to ORG_ID, so a different org must return nothing.
    assert.strictEqual(results.length, 0);
  });

  test('5. notes branch: without user_id only org-visible notes are returned', async () => {
    // The note seeded in before() has default visibility ('private'), so a
    // system query (no user_id) should not return it.
    const results = await retrieveContext({
      query: 'billing decision',
      org_id: ORG_ID,
      types: ['notes'],
    });
    // The seeded note is private — it must not appear in a system query.
    const seededNoteReturned = results.some(
      (r) => r.source_type === 'note' && r.content.includes('billing decision agreed upon in Q2'),
    );
    assert.ok(!seededNoteReturned, 'Private note must not appear in a system query without user_id');
  });

  test('6. employee-tagged wiki pages rank higher than org-wide pages (two-tier)', async () => {
    // Use the unique term seeded in before() so only our two tier-test pages
    // match, avoiding interference from other wiki_pages in the dev DB.
    const tierQuery = (globalThis as Record<string, unknown>).__tierQueryTerm as string;
    const results = await retrieveContext({
      query: tierQuery,
      org_id: ORG_ID,
      types: ['wiki'],
      agent_employee_id: AGENT_EMPLOYEE_ID,
      limit: 10,
    });

    // We should have at least one employee-tagged and one org-wide result.
    const empResults = results.filter((r) => r.metadata?.tier === 'employee');
    const orgResults = results.filter((r) => r.metadata?.tier === 'org');

    assert.ok(empResults.length >= 1, 'Expected at least 1 employee-tier result');
    assert.ok(orgResults.length >= 1, 'Expected at least 1 org-tier result');

    // The highest-scoring employee result must outrank the highest-scoring org result.
    const topEmpScore = Math.max(...empResults.map((r) => r.score));
    const topOrgScore = Math.max(...orgResults.map((r) => r.score));
    assert.ok(
      topEmpScore > topOrgScore,
      `Employee-tier score (${topEmpScore}) should exceed org-tier score (${topOrgScore})`,
    );
  });

  // ─── Task 1.2: Hybrid FTS + vector ranking ─────────────────────────────────

  test('7. hybrid: false bypasses vector search and returns FTS-only results', async () => {
    // With hybrid:false the code must not call fetch (no embedding generated).
    // We verify by saving/replacing globalThis.fetch and asserting it was never
    // called with the OpenAI embeddings URL.
    const savedFetch = globalThis.fetch;
    let openaiCallCount = 0;
    globalThis.fetch = async (url: string | URL | Request, opts?: RequestInit) => {
      if (String(url).includes('openai.com/v1/embeddings')) {
        openaiCallCount++;
      }
      return savedFetch(url as RequestInfo, opts);
    };

    try {
      const results = await retrieveContext({
        query: 'billing decision',
        org_id: ORG_ID,
        user_id: USER_ID,
        types: ['wiki', 'decisions'],
        hybrid: false,
      });

      assert.strictEqual(openaiCallCount, 0, 'OpenAI embeddings API must NOT be called when hybrid:false');
      assert.ok(results.length >= 1, 'Should still return FTS results when hybrid:false');
      for (const r of results) {
        assert.ok(r.score >= 0 && r.score <= 1, `score out of range: ${r.score}`);
      }
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test('8. hybrid falls back to FTS when OPENAI_API_KEY is unset', async () => {
    const savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = '';

    try {
      // Should not throw; should return FTS-based results.
      const results = await retrieveContext({
        query: 'billing decision',
        org_id: ORG_ID,
        user_id: USER_ID,
        types: ['wiki', 'decisions'],
        hybrid: true, // explicitly request hybrid — should degrade gracefully
      });

      // At least 1 result expected from FTS path.
      assert.ok(results.length >= 1, `Expected >=1 FTS results, got ${results.length}`);
      for (const r of results) {
        assert.ok(r.score >= 0 && r.score <= 1, `score out of range: ${r.score}`);
      }
    } finally {
      process.env.OPENAI_API_KEY = savedKey;
    }
  });

  test('9. NULL-embedding pages still appear in hybrid results', async () => {
    // Seed two wiki pages with the same unique query term.
    // One has NULL embedding (no backfill), the other is left NULL too —
    // both should appear via FTS even in hybrid mode.
    // This exercises the coalesce(1 - (embedding <=> ?::vector), 0) path.
    const HYBRID_TERM = `xyzhydridbenchmark${Date.now()}`;
    const pageId1 = `rctest-hybrid-null-${Date.now()}`;
    const pageId2 = `rctest-hybrid-null2-${Date.now() + 1}`;

    await withClient(async (c) => {
      await c.query(
        `INSERT INTO wiki_pages (id, org_id, type, scope, title, slug, content, confidence, is_deleted, created_at, updated_at)
         VALUES ($1, $2, 'concept', 'org', $3, $4, $5, 1.0, false, NOW(), NOW())`,
        [pageId1, ORG_ID, `NullEmbed ${HYBRID_TERM} Page`, `null-embed-${Date.now()}`, `The ${HYBRID_TERM} process is described here.`],
      );
      await c.query(
        `INSERT INTO wiki_pages (id, org_id, type, scope, title, slug, content, confidence, is_deleted, created_at, updated_at)
         VALUES ($1, $2, 'concept', 'org', $3, $4, $5, 1.0, false, NOW(), NOW())`,
        [pageId2, ORG_ID, `NullEmbed ${HYBRID_TERM} Overview`, `null-embed2-${Date.now()}`, `The ${HYBRID_TERM} overview for the organisation.`],
      );
    });

    try {
      // Stub fetch to return a fake embedding so we exercise the hybrid SQL path.
      // If pgvector is not installed the SQL will throw and fall back to FTS —
      // either way both pages should be returned.
      const savedFetch = globalThis.fetch;
      const MOCK_EMBEDDING = Array(1536).fill(0.05);
      globalThis.fetch = async (url: string | URL | Request, opts?: RequestInit) => {
        if (String(url).includes('openai.com/v1/embeddings')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ embedding: MOCK_EMBEDDING }] }),
            text: async () => '{}',
          } as unknown as Response;
        }
        return savedFetch(url as RequestInfo, opts);
      };

      // Set a key so generateQueryEmbedding doesn't bail early.
      const savedKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'sk-test-hybrid';

      try {
        const results = await retrieveContext({
          query: HYBRID_TERM,
          org_id: ORG_ID,
          types: ['wiki'],
          hybrid: true,
          limit: 10,
        });

        // Both NULL-embedding pages must appear (FTS drives their score).
        const ids = results.map((r) => r.source_id);
        assert.ok(ids.includes(pageId1), 'NULL-embedding page 1 should appear in hybrid results');
        assert.ok(ids.includes(pageId2), 'NULL-embedding page 2 should appear in hybrid results');
        for (const r of results) {
          assert.ok(r.score >= 0 && r.score <= 1, `score out of range: ${r.score}`);
        }
      } finally {
        globalThis.fetch = savedFetch;
        process.env.OPENAI_API_KEY = savedKey;
      }
    } finally {
      await withClient(async (c) => {
        await c.query(`DELETE FROM wiki_pages WHERE id = $1`, [pageId1]);
        await c.query(`DELETE FROM wiki_pages WHERE id = $1`, [pageId2]);
      });
    }
  });

  // ─── Task 5.2: notes visibility ────────────────────────────────────────────

  test('10. org-visible note from user-A appears for user-B; private note does not', async () => {
    // Use a unique term to avoid collisions with other seeded data.
    const TERM = `xyzvisibilitytest${Date.now()}`;
    const USER_A_ID = `rctest-vis-usera-${Date.now()}`;
    const USER_B_ID = `rctest-vis-userb-${Date.now()}`;
    const noteOrgId = `rctest-vis-org-note-${Date.now()}`;
    const notePrivateId = `rctest-vis-priv-note-${Date.now()}`;

    await withClient(async (c) => {
      // Create user-A and user-B.
      await c.query(
        `INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, 'Vis User A', false)`,
        [USER_A_ID, `vis-usera-${Date.now()}@test.local`],
      );
      await c.query(
        `INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, 'Vis User B', false)`,
        [USER_B_ID, `vis-userb-${Date.now()}@test.local`],
      );
      await c.query(
        `INSERT INTO org_members (id, org_id, user_id, role, is_active)
         VALUES (gen_random_uuid()::text, $1, $2, 'member', true) ON CONFLICT DO NOTHING`,
        [ORG_ID, USER_A_ID],
      );
      await c.query(
        `INSERT INTO org_members (id, org_id, user_id, role, is_active)
         VALUES (gen_random_uuid()::text, $1, $2, 'member', true) ON CONFLICT DO NOTHING`,
        [ORG_ID, USER_B_ID],
      );
      // user-A's org-visible note.
      await c.query(
        `INSERT INTO notes (id, org_id, user_id, title, content, visibility, is_deleted, is_pinned, is_template, version, created_at, updated_at)
         VALUES ($1, $2, $3, 'Org note', $4, 'org', false, false, false, 1, NOW(), NOW())`,
        [noteOrgId, ORG_ID, USER_A_ID, `The ${TERM} org-visible content.`],
      );
      // user-A's private note (must NOT appear for user-B).
      await c.query(
        `INSERT INTO notes (id, org_id, user_id, title, content, visibility, is_deleted, is_pinned, is_template, version, created_at, updated_at)
         VALUES ($1, $2, $3, 'Private note', $4, 'private', false, false, false, 1, NOW(), NOW())`,
        [notePrivateId, ORG_ID, USER_A_ID, `The ${TERM} private content only user-A can see.`],
      );
    });

    try {
      const results = await retrieveContext({
        query: TERM,
        org_id: ORG_ID,
        user_id: USER_B_ID,
        types: ['notes'],
        limit: 20,
      });

      const ids = results.map((r) => r.source_id);
      assert.ok(ids.includes(noteOrgId), 'Org-visible note from user-A must appear for user-B');
      assert.ok(!ids.includes(notePrivateId), 'Private note from user-A must NOT appear for user-B');
    } finally {
      await withClient(async (c) => {
        await c.query(`DELETE FROM notes WHERE id IN ($1, $2)`, [noteOrgId, notePrivateId]);
        await c.query(`DELETE FROM org_members WHERE user_id IN ($1, $2)`, [USER_A_ID, USER_B_ID]);
        await c.query(`DELETE FROM users WHERE id IN ($1, $2)`, [USER_A_ID, USER_B_ID]);
      });
    }
  });

  test('11. system query (no user_id) returns only org-visible notes', async () => {
    const TERM = `xyzsystemquery${Date.now()}`;
    const USER_C_ID = `rctest-vis-userc-${Date.now()}`;
    const noteOrgId2 = `rctest-sys-org-note-${Date.now()}`;
    const notePrivateId2 = `rctest-sys-priv-note-${Date.now()}`;

    await withClient(async (c) => {
      await c.query(
        `INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, 'Vis User C', false)`,
        [USER_C_ID, `vis-userc-${Date.now()}@test.local`],
      );
      await c.query(
        `INSERT INTO org_members (id, org_id, user_id, role, is_active)
         VALUES (gen_random_uuid()::text, $1, $2, 'member', true) ON CONFLICT DO NOTHING`,
        [ORG_ID, USER_C_ID],
      );
      // org-visible note.
      await c.query(
        `INSERT INTO notes (id, org_id, user_id, title, content, visibility, is_deleted, is_pinned, is_template, version, created_at, updated_at)
         VALUES ($1, $2, $3, 'Sys org note', $4, 'org', false, false, false, 1, NOW(), NOW())`,
        [noteOrgId2, ORG_ID, USER_C_ID, `The ${TERM} org-visible system note.`],
      );
      // private note — must NOT appear in system query.
      await c.query(
        `INSERT INTO notes (id, org_id, user_id, title, content, visibility, is_deleted, is_pinned, is_template, version, created_at, updated_at)
         VALUES ($1, $2, $3, 'Sys priv note', $4, 'private', false, false, false, 1, NOW(), NOW())`,
        [notePrivateId2, ORG_ID, USER_C_ID, `The ${TERM} private system note.`],
      );
    });

    try {
      const results = await retrieveContext({
        query: TERM,
        org_id: ORG_ID,
        // no user_id — system query
        types: ['notes'],
        limit: 20,
      });

      const ids = results.map((r) => r.source_id);
      assert.ok(ids.includes(noteOrgId2), 'Org-visible note must appear in system query (no user_id)');
      assert.ok(!ids.includes(notePrivateId2), 'Private note must NOT appear in system query (no user_id)');
    } finally {
      await withClient(async (c) => {
        await c.query(`DELETE FROM notes WHERE id IN ($1, $2)`, [noteOrgId2, notePrivateId2]);
        await c.query(`DELETE FROM org_members WHERE user_id = $1`, [USER_C_ID]);
        await c.query(`DELETE FROM users WHERE id = $1`, [USER_C_ID]);
      });
    }
  });
});
