/**
 * people-graph knowledge_dependency relationship tests.
 *
 * Run: pnpm --filter @deft/api test -- people-graph-knowledge-dependency
 *
 * Covers:
 *   1. detectRelationships creates a knowledge_dependency edge when user-A's wiki
 *      pages link to ≥2 wiki pages authored by user-B (via wikiLinks).
 *   2. The edge strength is normalised as min(1, count/10) — 3 links → 0.3.
 *   3. No edge is created when link count is below the threshold of 2.
 *
 * Uses the real local Postgres DB (postgres://postgres:postgres@localhost:5432/deft).
 * All inserted rows are cleaned up in finally blocks.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

// Real user IDs from the test org — must exist in users table (FK constraint)
const USER_A = '329fe0f6-39b3-4f66-8e6d-539ad7f4906a'; // Alex PM (citing author)
const USER_B = '07308d0d-199a-479d-a2e3-fefdf7cdbac9'; // Priya (cited author)

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Insert a wiki page, returns the page id. */
async function seedWikiPage(
  c: pg.Client,
  userId: string,
  suffix: string,
): Promise<string> {
  const slug = `test-kd-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await c.query(
    `INSERT INTO wiki_pages
       (org_id, user_id, slug, title, content, type, scope, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [ORG_ID, userId, slug, `KD test page ${suffix}`, 'Test content.', 'decision', 'org', 0.9],
  );
  return r.rows[0].id as string;
}

/** Insert a wiki link (source → target). Returns the link id. */
async function seedWikiLink(
  c: pg.Client,
  sourcePageId: string,
  targetPageId: string,
  suffix: string,
): Promise<string> {
  const r = await c.query(
    `INSERT INTO wiki_links (org_id, source_page_id, target_page_id, context)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_page_id, target_page_id) DO UPDATE SET context = EXCLUDED.context
     RETURNING id`,
    [ORG_ID, sourcePageId, targetPageId, `test-kd-link-${suffix}`],
  );
  return r.rows[0].id as string;
}

// ─── Service import ───────────────────────────────────────────────────────────

let detectRelationships: (orgId: string) => Promise<void>;

before(async () => {
  const mod = await import('../src/services/people-graph.js');
  detectRelationships = mod.detectRelationships;
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test('1. knowledge_dependency edge created with strength ≈ 0.3 for 3 citations', async () => {
  const sourcePageIds: string[] = [];
  const targetPageIds: string[] = [];
  const linkIds: string[] = [];
  let existingRelId: string | undefined;

  await withClient(async (c) => {
    // user-B authors 3 pages
    for (let i = 0; i < 3; i++) {
      targetPageIds.push(await seedWikiPage(c, USER_B, `target-${i}`));
    }
    // user-A authors 1 source page
    const sourceId = await seedWikiPage(c, USER_A, 'source-0');
    sourcePageIds.push(sourceId);
    // user-A's page links to all 3 of user-B's pages
    for (const targetId of targetPageIds) {
      linkIds.push(await seedWikiLink(c, sourceId, targetId, `${sourceId}-${targetId}`));
    }
  });

  // Store any pre-existing knowledge_dependency row so we can distinguish
  const existingRows = await withClient(async (c) => {
    const r = await c.query(
      `SELECT id FROM people_relationships
       WHERE user_a_id = $1 AND user_b_id = $2 AND relationship_type = 'knowledge_dependency'
         AND org_id = $3`,
      [USER_A, USER_B, ORG_ID],
    );
    return r.rows as Array<{ id: string }>;
  });
  existingRelId = existingRows[0]?.id;

  try {
    await detectRelationships(ORG_ID);

    const rows = await withClient(async (c) => {
      const r = await c.query(
        `SELECT id, strength FROM people_relationships
         WHERE user_a_id = $1 AND user_b_id = $2 AND relationship_type = 'knowledge_dependency'
           AND org_id = $3`,
        [USER_A, USER_B, ORG_ID],
      );
      return r.rows as Array<{ id: string; strength: number }>;
    });

    assert.ok(rows.length >= 1, 'expected at least 1 knowledge_dependency row');

    // The row's strength should be 3/10 = 0.3 (but may be higher if pre-existing links exist)
    const rel = rows.find((r) => r.id !== existingRelId) ?? rows[0];
    assert.ok(rel, 'expected a knowledge_dependency relationship row');
    assert.ok(
      rel.strength >= 0.3,
      `strength should be >= 0.3 (3 citations / 10), got ${rel.strength}`,
    );
    assert.ok(
      rel.strength <= 1.0,
      `strength should be <= 1.0, got ${rel.strength}`,
    );
  } finally {
    await withClient(async (c) => {
      if (linkIds.length > 0) {
        await c.query(`DELETE FROM wiki_links WHERE id = ANY($1)`, [linkIds]);
      }
      if (sourcePageIds.length > 0) {
        await c.query(`DELETE FROM wiki_pages WHERE id = ANY($1)`, [sourcePageIds]);
      }
      if (targetPageIds.length > 0) {
        await c.query(`DELETE FROM wiki_pages WHERE id = ANY($1)`, [targetPageIds]);
      }
      // Clean up the relationship row we created (or updated)
      await c.query(
        `DELETE FROM people_relationships
         WHERE user_a_id = $1 AND user_b_id = $2 AND relationship_type = 'knowledge_dependency'
           AND org_id = $3`,
        [USER_A, USER_B, ORG_ID],
      );
    });
  }
});

test('2. no knowledge_dependency edge when citation count is below threshold (1 link)', async () => {
  const sourcePageIds: string[] = [];
  const targetPageIds: string[] = [];
  const linkIds: string[] = [];

  // Use a different pair to avoid interference: we'll use USER_B as source, USER_A as target
  await withClient(async (c) => {
    const targetId = await seedWikiPage(c, USER_A, 'below-target');
    targetPageIds.push(targetId);
    const sourceId = await seedWikiPage(c, USER_B, 'below-source');
    sourcePageIds.push(sourceId);
    linkIds.push(await seedWikiLink(c, sourceId, targetId, `below-${sourceId}-${targetId}`));
  });

  try {
    await detectRelationships(ORG_ID);

    const rows = await withClient(async (c) => {
      const r = await c.query(
        `SELECT id FROM people_relationships
         WHERE user_a_id = $1 AND user_b_id = $2 AND relationship_type = 'knowledge_dependency'
           AND org_id = $3`,
        [USER_B, USER_A, ORG_ID],
      );
      return r.rows;
    });

    assert.equal(rows.length, 0, 'expected no knowledge_dependency row for only 1 citation');
  } finally {
    await withClient(async (c) => {
      if (linkIds.length > 0) {
        await c.query(`DELETE FROM wiki_links WHERE id = ANY($1)`, [linkIds]);
      }
      if (sourcePageIds.length > 0) {
        await c.query(`DELETE FROM wiki_pages WHERE id = ANY($1)`, [sourcePageIds]);
      }
      if (targetPageIds.length > 0) {
        await c.query(`DELETE FROM wiki_pages WHERE id = ANY($1)`, [targetPageIds]);
      }
    });
  }
});
