/**
 * Task 5.3 — command palette: wiki / notes / decisions groups in global search.
 *
 * Run: pnpm --filter @deft/api test -- search-route-knowledge-groups
 *
 * Covers:
 *   1. Response has `wiki`, `privateNotes`, `decisions` keys
 *   2. Wiki group contains the seeded wiki page matching "cloudflare"
 *   3. Decisions group contains the seeded decision page matching "cloudflare"
 *   4. PrivateNotes group contains the seeded note owned by the test user
 *   5. PrivateNotes group does NOT contain a note belonging to a different user
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

// Reuse the existing dev org so FK constraints are satisfied.
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const USER_ID = `srkg-test-user-${Date.now()}`;
const USER_EMAIL = `srkg-test-${Date.now()}@test.local`;
const OTHER_USER_ID = `srkg-other-user-${Date.now()}`;
const OTHER_USER_EMAIL = `srkg-other-${Date.now()}@test.local`;

// IDs created during setup — cleaned up in after().
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

// Unique term so only our seeded rows match — prevents interference from other data.
const SEARCH_TERM = `cloudflare${Date.now()}`;

let wikiPageId: string;
let hyphenatedWikiPageId: string;
let decisionPageId: string;
let noteId: string;
let otherUserNoteId: string;

before(async () => {
  await withClient(async (c) => {
    // Test user
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'SRKG Test User', false)
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID, USER_EMAIL],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, USER_ID],
    );

    // Other user (different owner — their notes must not appear)
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'SRKG Other User', false)
       ON CONFLICT (id) DO NOTHING`,
      [OTHER_USER_ID, OTHER_USER_EMAIL],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, OTHER_USER_ID],
    );

    // Seed wiki page (type='concept') containing SEARCH_TERM
    wikiPageId = `srkg-wiki-${Date.now()}`;
    await c.query(
      `INSERT INTO wiki_pages (id, org_id, type, scope, title, slug, content, confidence, is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'concept', 'org', $3, $4, $5, 1.0, false, NOW(), NOW())`,
      [
        wikiPageId,
        ORG_ID,
        `${SEARCH_TERM} CDN Configuration`,
        `${SEARCH_TERM}-cdn-config`,
        `We use ${SEARCH_TERM} for our CDN. Configuration docs are here.`,
      ],
    );
    seededIds.push({ table: 'wiki_pages', id: wikiPageId });

    // Body-only hyphenated marker: Knowledge and global search must agree when
    // users type the same phrase with spaces.
    hyphenatedWikiPageId = `srkg-hyphen-wiki-${Date.now()}`;
    await c.query(
      `INSERT INTO wiki_pages (id, org_id, type, scope, title, slug, content, confidence, is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'resource', 'org', 'Pilot proof page', 'pilot-proof-page', $3, 1.0, false, NOW(), NOW())`,
      [hyphenatedWikiPageId, ORG_ID, 'The durable proof marker is ruby-sunrise-2026.'],
    );
    seededIds.push({ table: 'wiki_pages', id: hyphenatedWikiPageId });

    // Seed decision page (type='decision') containing SEARCH_TERM
    decisionPageId = `srkg-decision-${Date.now()}`;
    await c.query(
      `INSERT INTO wiki_pages (id, org_id, type, scope, title, slug, content, confidence, is_deleted, created_at, updated_at)
       VALUES ($1, $2, 'decision', 'org', $3, $4, $5, 1.0, false, NOW(), NOW())`,
      [
        decisionPageId,
        ORG_ID,
        `Use ${SEARCH_TERM} for R2 storage`,
        `${SEARCH_TERM}-r2-decision`,
        `Decision: we chose ${SEARCH_TERM} R2 over S3 for cost reasons.`,
      ],
    );
    seededIds.push({ table: 'wiki_pages', id: decisionPageId });

    // Seed note for the test user containing SEARCH_TERM
    noteId = `srkg-note-${Date.now()}`;
    await c.query(
      `INSERT INTO notes (id, org_id, user_id, title, content, is_deleted, is_pinned, is_template, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, false, false, false, 1, NOW(), NOW())`,
      [
        noteId,
        ORG_ID,
        USER_ID,
        `${SEARCH_TERM} setup notes`,
        `Personal notes on ${SEARCH_TERM} setup and configuration steps.`,
      ],
    );
    seededIds.push({ table: 'notes', id: noteId });

    // Seed note for OTHER user — must NOT appear in our user's privateNotes
    otherUserNoteId = `srkg-other-note-${Date.now()}`;
    await c.query(
      `INSERT INTO notes (id, org_id, user_id, title, content, is_deleted, is_pinned, is_template, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, false, false, false, 1, NOW(), NOW())`,
      [
        otherUserNoteId,
        ORG_ID,
        OTHER_USER_ID,
        `Other ${SEARCH_TERM} notes`,
        `Other user secret notes about ${SEARCH_TERM}.`,
      ],
    );
    seededIds.push({ table: 'notes', id: otherUserNoteId });
  });
});

after(async () => {
  await withClient(async (c) => {
    for (const { table, id } of [...seededIds].reverse()) {
      await c.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    }
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [USER_ID]);
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [OTHER_USER_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [OTHER_USER_ID]);
  });
});

// ─── Route helper ─────────────────────────────────────────────────────────────

let searchRoutes: any;

before(async () => {
  const mod = await import('../src/routes/search.js');
  searchRoutes = mod.searchRoutes;
});

async function callSearch(query: string, userId = USER_ID): Promise<{ status: number; body: any }> {
  const { Hono } = await import('hono');
  const app = new Hono();

  app.use('*', async (c, next) => {
    c.set('user', { id: userId, org_id: ORG_ID, email: USER_EMAIL, name: 'SRKG Test User' });
    await next();
  });

  app.route('/', searchRoutes);

  const req = new Request(`http://localhost/?q=${encodeURIComponent(query)}`, {
    method: 'GET',
    headers: { 'content-type': 'application/json' },
  });

  const res = await app.fetch(req);
  const body = await res.json();
  return { status: res.status, body };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('1. response contains wiki, privateNotes, and decisions keys', async () => {
  const { status, body } = await callSearch(SEARCH_TERM);

  assert.equal(status, 200, `Expected 200, got ${status}`);
  assert.ok('wiki' in body, 'Response must have "wiki" key');
  assert.ok('privateNotes' in body, 'Response must have "privateNotes" key');
  assert.ok('decisions' in body, 'Response must have "decisions" key');
  // Existing groups must still be present
  assert.ok('spaces' in body, 'Response must still have "spaces" key');
  assert.ok('tasks' in body, 'Response must still have "tasks" key');
  assert.ok('tags' in body, 'Response must still have "tags" key');
  assert.ok('notes' in body, 'Response must still have legacy "notes" key');
});

test('2. wiki group contains the seeded wiki concept page', async () => {
  const { body } = await callSearch(SEARCH_TERM);

  assert.ok(Array.isArray(body.wiki), 'wiki should be an array');
  const found = body.wiki.find((w: any) => w.id === wikiPageId);
  assert.ok(found, `Wiki group should contain the seeded wiki page (${wikiPageId})`);
  assert.ok(found.title, 'Wiki result should have a title');
});

test('global search finds a body-only hyphenated wiki phrase from spaced words', async () => {
  const { status, body } = await callSearch('ruby sunrise');

  assert.equal(status, 200);
  assert.ok(
    body.wiki.some((page: any) => page.id === hyphenatedWikiPageId),
    'Global search should find ruby-sunrise-2026 when the user searches ruby sunrise',
  );
});

test('3. decisions group contains the seeded decision page', async () => {
  const { body } = await callSearch(SEARCH_TERM);

  assert.ok(Array.isArray(body.decisions), 'decisions should be an array');
  const found = body.decisions.find((d: any) => d.id === decisionPageId);
  assert.ok(found, `Decisions group should contain the seeded decision page (${decisionPageId})`);
  assert.ok(found.title, 'Decision result should have a title');
});

test('4. privateNotes group contains the seeded note owned by the test user', async () => {
  const { body } = await callSearch(SEARCH_TERM);

  assert.ok(Array.isArray(body.privateNotes), 'privateNotes should be an array');
  const found = body.privateNotes.find((n: any) => n.id === noteId);
  assert.ok(found, `PrivateNotes group should contain the seeded note (${noteId})`);
  assert.ok(found.title, 'Note result should have a title');
});

test('5. privateNotes group does NOT contain another user\'s note', async () => {
  const { body } = await callSearch(SEARCH_TERM);

  assert.ok(Array.isArray(body.privateNotes), 'privateNotes should be an array');
  const leaked = body.privateNotes.find((n: any) => n.id === otherUserNoteId);
  assert.ok(!leaked, `PrivateNotes must NOT contain other user's note (${otherUserNoteId}) — privacy violation`);
});
