/**
 * Task 1.1 — retrieveContext gateway integration tests.
 *
 * Run: pnpm --filter @deft/api test -- retrieve-context
 *
 * Covers:
 *   1. Query matching all 4 types returns at least 2 results
 *   2. types: ['wiki'] only returns source_type === 'wiki_page'
 *   3. Short/empty query returns []
 *   4. Org isolation — results only contain rows from the correct org
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { retrieveContext } from '../src/lib/retrieve-context.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';

// Use the existing dev org / user so FK constraints are satisfied.
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const USER_ID = 'retrieve-ctx-test-user';
const USER_EMAIL = 'retrieve-ctx-test@test.local';

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
});
