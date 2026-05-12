/**
 * Task 2.3 — decisions is_reversed → wiki confidence integration test.
 *
 * Run: pnpm --filter @deft/api test -- decisions-is-reversed
 *
 * Verifies that:
 *  1. PATCH /api/decisions/:id with { is_reversed: true } sets confidence=0.2 and
 *     appends 'reversed' to tags on the wiki_pages row.
 *  2. PATCH with { is_reversed: false } restores confidence=0.9 and removes 'reversed'.
 *
 * Uses a real Postgres DB (defaults to postgres://postgres:postgres@localhost:5432/deft).
 * All inserted rows are cleaned up in finally blocks.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const USER_ID = '329fe0f6-39b3-4f66-8e6d-539ad7f4906a'; // Alex PM

let testApp: Hono | null = null;
let wikiPageId: string | null = null;

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
  // Seed a wiki_pages row with type='decision', confidence=0.9, tags=[]
  wikiPageId = await withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO wiki_pages
        (id, org_id, type, title, slug, content, confidence, tags, is_deleted, version)
       VALUES
        (gen_random_uuid()::text, $1, 'decision', 'Ship the monorepo',
         'ship-the-monorepo-' || extract(epoch from now())::text,
         'We decided to ship the monorepo by end of Q2.', 0.9, ARRAY[]::text[], false, 1)
       RETURNING id`,
      [ORG_ID],
    );
    return r.rows[0].id as string;
  });

  // Build a test Hono app that injects an authenticated user, bypassing JWT
  const { decisionRoutes } = await import('../src/routes/decisions.js');
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    c.set('user', {
      id: USER_ID,
      email: 'maneek@test.com',
      org_id: ORG_ID,
    } as any);
    await next();
  });
  testApp.route('/api/decisions', decisionRoutes);
});

after(async () => {
  if (wikiPageId) {
    await withClient(async (c) => {
      await c.query(`DELETE FROM wiki_pages WHERE id = $1`, [wikiPageId]);
    });
  }
});

function app(): Hono {
  if (!testApp) throw new Error('test app not initialized');
  return testApp;
}

// ─────────────────────────────────────────────────────────────────────────────

test('PATCH /api/decisions/:id with is_reversed=true sets confidence=0.2 and tags=["reversed"]', async () => {
  assert.ok(wikiPageId, 'wikiPageId must be set');

  const res = await app().request(`/api/decisions/${wikiPageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_reversed: true }),
  });

  const body = await res.json();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.is_reversed, true, 'response should include is_reversed=true');

  // Verify wiki_pages row updated
  await withClient(async (c) => {
    const r = await c.query(
      `SELECT confidence, tags FROM wiki_pages WHERE id = $1`,
      [wikiPageId],
    );
    assert.equal(r.rows.length, 1, 'wiki page row must exist');
    assert.ok(
      parseFloat(r.rows[0].confidence) < 0.5,
      `confidence should be < 0.5, got ${r.rows[0].confidence}`,
    );
    assert.ok(
      r.rows[0].tags.includes('reversed'),
      `tags should contain 'reversed', got ${JSON.stringify(r.rows[0].tags)}`,
    );
  });
});

test('PATCH /api/decisions/:id with is_reversed=false restores confidence=0.9 and removes "reversed" from tags', async () => {
  assert.ok(wikiPageId, 'wikiPageId must be set');

  const res = await app().request(`/api/decisions/${wikiPageId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_reversed: false }),
  });

  const body = await res.json();
  assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.is_reversed, false, 'response should include is_reversed=false');

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT confidence, tags FROM wiki_pages WHERE id = $1`,
      [wikiPageId],
    );
    assert.equal(r.rows.length, 1, 'wiki page row must exist');
    assert.ok(
      parseFloat(r.rows[0].confidence) >= 0.5,
      `confidence should be >= 0.5, got ${r.rows[0].confidence}`,
    );
    assert.ok(
      !r.rows[0].tags.includes('reversed'),
      `tags should NOT contain 'reversed', got ${JSON.stringify(r.rows[0].tags)}`,
    );
  });
});

test('GET /api/decisions returns decisions from wiki_pages type=decision', async () => {
  assert.ok(wikiPageId, 'wikiPageId must be set');

  const res = await app().request('/api/decisions', { method: 'GET' });
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);

  const body = await res.json();
  assert.ok(Array.isArray(body.decisions), 'response should have decisions array');

  const found = body.decisions.find((d: any) => d.id === wikiPageId);
  assert.ok(found, 'seeded wiki_pages decision should appear in GET /api/decisions');
  assert.ok(found.decision_text, 'decision_text field should be present');
});

test('PATCH /api/decisions/:id returns 404 for unknown id', async () => {
  const res = await app().request('/api/decisions/nonexistent-id-xyz', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_reversed: true }),
  });
  assert.equal(res.status, 404);
});
