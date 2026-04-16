/**
 * Task 3.1 — In-chat knowledge panel integration tests.
 *
 * Run: pnpm --filter @deft/api test -- in-chat-knowledge-panel
 *
 * Covers:
 *   1. GET /api/spaces/:spaceId/knowledge returns wiki pages with matching space_id
 *   2. GET also returns pages with a wiki citation from a message in that space
 *   3. POST creates a wiki_pages row with scope='space', space_id set, embed-content enqueued
 *   4. PATCH updates the entry and re-enqueues embed-content when content changes
 *   5. DELETE soft-deletes the entry (is_deleted=true)
 *
 * Uses a real Postgres DB against the dev instance. Cleans up after itself.
 * Requires DATABASE_URL or defaults to postgres://postgres:postgres@localhost:5432/cairn.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';

// Use the existing dev org so FK constraints on org_id are satisfied.
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const USER_ID = 'ick-test-user-uuid';
const SPACE_ID = `ick-test-space-${Date.now()}`;
const ALT_SPACE_ID = `ick-test-alt-space-${Date.now()}`;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// Track rows created so we can clean up.
const createdPageIds: string[] = [];
const createdMessageIds: string[] = [];

before(async () => {
  await withClient(async (c) => {
    // Ensure test user exists (no FK on users.org_id).
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'ICK Test User', false)
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID, 'ick-test@test.local'],
    );

    // Create the test space — minimal columns only.
    // spaces table: id, org_id, name, type, is_archived
    await c.query(
      `INSERT INTO spaces (id, org_id, name, type, is_archived)
       VALUES ($1, $2, 'ICK Test Space', 'public', false)
       ON CONFLICT (id) DO NOTHING`,
      [SPACE_ID, ORG_ID],
    );
    await c.query(
      `INSERT INTO spaces (id, org_id, name, type, is_archived)
       VALUES ($1, $2, 'ICK Alt Space', 'public', false)
       ON CONFLICT (id) DO NOTHING`,
      [ALT_SPACE_ID, ORG_ID],
    );

    // Ensure org_member exists so the route auth middleware can find the user.
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, USER_ID],
    );
  });
});

after(async () => {
  await withClient(async (c) => {
    // Clean up wiki citations, links, ops log, and pages.
    if (createdPageIds.length > 0) {
      await c.query(`DELETE FROM wiki_citations WHERE page_id = ANY($1)`, [createdPageIds]);
      await c.query(`DELETE FROM wiki_links WHERE source_page_id = ANY($1) OR target_page_id = ANY($1)`, [createdPageIds]);
      await c.query(`DELETE FROM wiki_ops_log WHERE page_id = ANY($1)`, [createdPageIds]);
      await c.query(
        `DELETE FROM job_queue WHERE name = 'embed-content' AND data->>'source_type' = 'wiki_page' AND data->>'source_id' = ANY($1)`,
        [createdPageIds],
      );
      await c.query(`DELETE FROM wiki_pages WHERE id = ANY($1)`, [createdPageIds]);
    }

    // Clean up messages (need to delete citations referencing them first).
    if (createdMessageIds.length > 0) {
      await c.query(`DELETE FROM wiki_citations WHERE source_type = 'message' AND source_id = ANY($1)`, [createdMessageIds]);
      await c.query(`DELETE FROM messages WHERE id = ANY($1)`, [createdMessageIds]);
    }

    // Clean up spaces and space_members.
    await c.query(`DELETE FROM space_members WHERE space_id = ANY($1)`, [[SPACE_ID, ALT_SPACE_ID]]);
    await c.query(`DELETE FROM spaces WHERE id = ANY($1)`, [[SPACE_ID, ALT_SPACE_ID]]);
  });
});

// ─── Direct DB helpers ────────────────────────────────────────────────────────

async function insertWikiPage(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = `ick-page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO wiki_pages
         (id, org_id, scope, space_id, type, title, slug, content, confidence, is_deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)`,
      [
        id,
        overrides.org_id ?? ORG_ID,
        overrides.scope ?? 'org',
        overrides.space_id ?? null,
        overrides.type ?? 'fact',
        overrides.title ?? 'Test Page',
        overrides.slug ?? `test-page-${id}`,
        overrides.content ?? 'Test content.',
        overrides.confidence ?? 0.9,
      ],
    );
  });
  createdPageIds.push(id);
  return id;
}

async function insertMessage(spaceId: string): Promise<string> {
  const id = `ick-msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content, is_pinned, is_deleted)
       VALUES ($1, $2, $3, $4, 'test message', false, false)`,
      [id, ORG_ID, spaceId, USER_ID],
    );
  });
  createdMessageIds.push(id);
  return id;
}

async function insertCitation(pageId: string, messageId: string): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO wiki_citations (id, page_id, source_type, source_id)
       VALUES (gen_random_uuid()::text, $1, 'message', $2)
       ON CONFLICT DO NOTHING`,
      [pageId, messageId],
    );
  });
}

// ─── Route handler tests (direct import) ─────────────────────────────────────
//
// We invoke the Hono route handlers by importing the router and calling fetch
// with a mock Request. Hono supports this via app.fetch(request, env, ctx).

let knowledgeRoutes: any;

before(async () => {
  const mod = await import('../src/routes/knowledge.js');
  knowledgeRoutes = mod.knowledgeRoutes;
});

// Build a minimal authenticated Request for the route.
function makeReq(method: string, path: string, body?: unknown): Request {
  const url = `http://localhost${path}`;
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(url, init);
}

// Hono middleware sets 'user' in the context. We inject it via a test wrapper.
async function callRoute(method: string, path: string, body?: unknown): Promise<Response> {
  const { Hono } = await import('hono');
  const app = new Hono();

  // Inject mock auth middleware
  app.use('*', async (c, next) => {
    c.set('user', { id: USER_ID, org_id: ORG_ID, email: 'ick-test@test.local', name: 'ICK Test User' });
    await next();
  });

  // Mount our route handler (knowledgeRoutes handles /:spaceId/knowledge paths)
  app.route('/', knowledgeRoutes);

  const req = makeReq(method, path, body);
  return app.fetch(req);
}

// ─── Test 1: GET returns page with matching space_id ─────────────────────────

test('1. GET /spaces/:spaceId/knowledge returns wiki page with space_id=spaceId', async () => {
  const pageId = await insertWikiPage({ space_id: SPACE_ID, type: 'decision', title: 'Test Decision' });

  const res = await callRoute('GET', `/${SPACE_ID}/knowledge`);
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);

  const data = await res.json() as any;
  assert.ok(Array.isArray(data.entries), 'entries should be an array');

  const found = data.entries.find((e: any) => e.id === pageId);
  assert.ok(found, `Page ${pageId} should appear in the panel response`);
  assert.equal(found.type, 'decision');
  assert.equal(found.title, 'Test Decision');
});

// ─── Test 2: GET also returns page cited from a message in the space ─────────

test('2. GET returns org-scoped page that has a citation from a message in the space', async () => {
  // Insert an org-scoped page (no space_id) — simulates memory-extract before this fix
  const pageId = await insertWikiPage({ scope: 'org', space_id: null, type: 'fact', title: 'Cited Org Page' });

  // Insert a message in our space and a citation linking the page to it
  const messageId = await insertMessage(SPACE_ID);
  await insertCitation(pageId, messageId);

  const res = await callRoute('GET', `/${SPACE_ID}/knowledge`);
  assert.equal(res.status, 200);

  const data = await res.json() as any;
  const found = data.entries.find((e: any) => e.id === pageId);
  assert.ok(found, `Cited page ${pageId} should appear via citation join`);
});

// ─── Test 3: GET does NOT return page from a different space ─────────────────

test('3. GET does NOT return pages from a different space with no citation', async () => {
  const pageId = await insertWikiPage({ space_id: ALT_SPACE_ID, type: 'fact', title: 'Other Space Page' });

  const res = await callRoute('GET', `/${SPACE_ID}/knowledge`);
  assert.equal(res.status, 200);

  const data = await res.json() as any;
  const found = data.entries.find((e: any) => e.id === pageId);
  assert.ok(!found, `Page from ALT_SPACE_ID should NOT appear in SPACE_ID panel`);
});

// ─── Test 4: POST creates wiki_pages row + enqueues embed-content ─────────────

test('4. POST creates wiki_pages row with type=resource, scope=space, embed-content enqueued', async () => {
  const res = await callRoute('POST', `/${SPACE_ID}/knowledge`, {
    type: 'resource',
    title: 'ICK Test Resource',
    content: 'A useful resource for testing.',
  });
  assert.equal(res.status, 201, `Expected 201, got ${res.status}`);

  const entry = await res.json() as any;
  assert.ok(entry.id, 'Response should include id');
  assert.equal(entry.type, 'resource');
  assert.equal(entry.title, 'ICK Test Resource');
  assert.equal(entry.scope, 'space');
  assert.equal(entry.space_id, SPACE_ID);
  createdPageIds.push(entry.id);

  // Verify DB row
  const row = await withClient(async (c) => {
    const r = await c.query(
      `SELECT id, type, scope, space_id FROM wiki_pages WHERE id = $1`,
      [entry.id],
    );
    return r.rows[0] ?? null;
  });
  assert.ok(row, 'wiki_pages row should exist');
  assert.equal(row.type, 'resource');
  assert.equal(row.scope, 'space');
  assert.equal(row.space_id, SPACE_ID);

  // Verify embed-content job enqueued
  const job = await withClient(async (c) => {
    const r = await c.query(
      `SELECT id, name, data FROM job_queue
       WHERE name = 'embed-content'
         AND data->>'source_type' = 'wiki_page'
         AND data->>'source_id' = $1
       ORDER BY created_at DESC LIMIT 1`,
      [entry.id],
    );
    return r.rows[0] ?? null;
  });
  assert.ok(job, 'embed-content job should be in job_queue');
  assert.equal(job.data.source_type, 'wiki_page');
  assert.equal(job.data.source_id, entry.id);
});

// ─── Test 5: PATCH updates the entry ─────────────────────────────────────────

test('5. PATCH updates title and content, re-enqueues embed-content', async () => {
  const pageId = await insertWikiPage({ space_id: SPACE_ID, type: 'fact', title: 'Patch Target' });

  const res = await callRoute('PATCH', `/${SPACE_ID}/knowledge/${pageId}`, {
    title: 'Patch Target Updated',
    content: 'Updated content here.',
  });
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);

  const entry = await res.json() as any;
  assert.equal(entry.title, 'Patch Target Updated');

  // Verify DB row updated
  const row = await withClient(async (c) => {
    const r = await c.query(`SELECT title, content FROM wiki_pages WHERE id = $1`, [pageId]);
    return r.rows[0] ?? null;
  });
  assert.ok(row, 'wiki_pages row should exist');
  assert.equal(row.title, 'Patch Target Updated');
  assert.equal(row.content, 'Updated content here.');

  // Verify embed-content re-enqueued
  const job = await withClient(async (c) => {
    const r = await c.query(
      `SELECT id FROM job_queue
       WHERE name = 'embed-content'
         AND data->>'source_type' = 'wiki_page'
         AND data->>'source_id' = $1
       ORDER BY created_at DESC LIMIT 1`,
      [pageId],
    );
    return r.rows[0] ?? null;
  });
  assert.ok(job, 'embed-content job should be re-enqueued after PATCH with content change');
});

// ─── Test 6: DELETE soft-deletes the entry ────────────────────────────────────

test('6. DELETE soft-deletes entry (is_deleted=true)', async () => {
  const pageId = await insertWikiPage({ space_id: SPACE_ID, type: 'concept', title: 'Delete Me' });

  const res = await callRoute('DELETE', `/${SPACE_ID}/knowledge/${pageId}`);
  assert.equal(res.status, 200, `Expected 200, got ${res.status}`);

  const data = await res.json() as any;
  assert.equal(data.success, true);

  // Verify is_deleted=true in DB
  const row = await withClient(async (c) => {
    const r = await c.query(`SELECT is_deleted FROM wiki_pages WHERE id = $1`, [pageId]);
    return r.rows[0] ?? null;
  });
  assert.ok(row, 'wiki_pages row should still exist (soft delete)');
  assert.equal(row.is_deleted, true);
});

// ─── Test 7: GET ?type= filter works with wiki type names ─────────────────────

test('7. GET ?type=decision filter returns only decision-type pages', async () => {
  const decisionId = await insertWikiPage({ space_id: SPACE_ID, type: 'decision', title: 'Type Filter Decision' });
  const factId = await insertWikiPage({ space_id: SPACE_ID, type: 'fact', title: 'Type Filter Fact' });

  const res = await callRoute('GET', `/${SPACE_ID}/knowledge?type=decision`);
  assert.equal(res.status, 200);

  const data = await res.json() as any;
  const ids = data.entries.map((e: any) => e.id);
  assert.ok(ids.includes(decisionId), 'Should include the decision page');
  assert.ok(!ids.includes(factId), 'Should NOT include the fact page when filtering for decision');
});
