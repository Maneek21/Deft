/**
 * Task 5.1 — notes visibility tests
 *
 * Run: pnpm --filter @deft/api test -- test/notes-visibility.test.ts
 *
 * Covers:
 *   1. user-B can see user-A's org-visible note in GET /api/daily-notes
 *   2. user-A's private note is NOT returned to user-B
 *   3. user-B attempting PATCH on user-A's note → 403
 *   4. user-A can PATCH their own note → 200
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const USER_A_ID = 'test-notes-vis-user-a';
const USER_A_EMAIL = 'notes-vis-user-a@test.local';
const USER_B_ID = 'test-notes-vis-user-b';
const USER_B_EMAIL = 'notes-vis-user-b@test.local';

let testApp: Hono | null = null;
let currentUserId = USER_A_ID;

// Track note IDs for cleanup
let orgNoteId: string;
let privateNoteId: string;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function seedFixtures() {
  await withClient(async (c) => {
    // Create user-A
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Notes Vis User A', false)
       ON CONFLICT (id) DO NOTHING`,
      [USER_A_ID, USER_A_EMAIL],
    );
    // Create user-B
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Notes Vis User B', false)
       ON CONFLICT (id) DO NOTHING`,
      [USER_B_ID, USER_B_EMAIL],
    );
    // Add both to org
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, USER_A_ID],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, USER_B_ID],
    );
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    await c.query(`DELETE FROM notes WHERE user_id IN ($1, $2)`, [USER_A_ID, USER_B_ID]);
    await c.query(`DELETE FROM org_members WHERE user_id IN ($1, $2)`, [USER_A_ID, USER_B_ID]);
    await c.query(`DELETE FROM users WHERE id IN ($1, $2)`, [USER_A_ID, USER_B_ID]);
  });
}

before(async () => {
  await seedFixtures();

  const { dailyNoteRoutes } = await import('../src/routes/daily-notes.js');
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    const uid = currentUserId;
    const email = uid === USER_A_ID ? USER_A_EMAIL : USER_B_EMAIL;
    c.set('user', {
      id: uid,
      email,
      org_id: ORG_ID,
    } as any);
    await next();
  });
  testApp.route('/api/daily-notes', dailyNoteRoutes);
});

after(async () => {
  await teardownFixtures();
});

function app(): Hono {
  if (!testApp) throw new Error('test app not initialized');
  return testApp;
}

// ─────────────────────────────────────────────────────────────────────────────

test('1. user-A creates an org-visible note — user-B can see it in GET list', async () => {
  // user-A creates an org-visible note
  currentUserId = USER_A_ID;
  const createRes = await app().request('/api/daily-notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Org note from A', visibility: 'org' }),
  });
  assert.equal(createRes.status, 201, 'POST should return 201');
  const created = (await createRes.json()) as any;
  orgNoteId = created.id;
  assert.ok(orgNoteId, 'should have an id');
  assert.equal(created.visibility, 'org', 'visibility should be org');

  // user-B lists notes — should see user-A's org-visible note
  currentUserId = USER_B_ID;
  const listRes = await app().request('/api/daily-notes', { method: 'GET' });
  assert.equal(listRes.status, 200);
  const notes = (await listRes.json()) as any[];
  const found = notes.find((n: any) => n.id === orgNoteId);
  assert.ok(found, 'user-B should see user-A\'s org-visible note');
});

test('2. user-A\'s private note is NOT visible to user-B', async () => {
  // user-A creates a private note (default)
  currentUserId = USER_A_ID;
  const createRes = await app().request('/api/daily-notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Private note from A' }),
  });
  assert.equal(createRes.status, 201);
  const created = (await createRes.json()) as any;
  privateNoteId = created.id;
  assert.equal(created.visibility, 'private', 'default visibility should be private');

  // user-B lists notes — should NOT see the private note
  currentUserId = USER_B_ID;
  const listRes = await app().request('/api/daily-notes', { method: 'GET' });
  assert.equal(listRes.status, 200);
  const notes = (await listRes.json()) as any[];
  const found = notes.find((n: any) => n.id === privateNoteId);
  assert.equal(found, undefined, 'user-B should NOT see user-A\'s private note');

  // The org-visible note should still appear
  const orgNote = notes.find((n: any) => n.id === orgNoteId);
  assert.ok(orgNote, 'user-B should still see user-A\'s org-visible note');
});

test('3. user-B attempting PATCH on user-A\'s org-visible note → 403', async () => {
  currentUserId = USER_B_ID;
  const res = await app().request(`/api/daily-notes/${orgNoteId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Hijacked title' }),
  });
  assert.equal(res.status, 403, 'user-B patching user-A\'s note should return 403');
  const body = (await res.json()) as any;
  assert.equal(body.code, 'FORBIDDEN');
});

test('4. user-A PATCHes their own org-visible note → 200', async () => {
  currentUserId = USER_A_ID;
  const res = await app().request(`/api/daily-notes/${orgNoteId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Updated by owner' }),
  });
  assert.equal(res.status, 200, 'owner patching own note should return 200');
  const body = (await res.json()) as any;
  assert.equal(body.title, 'Updated by owner');
});
