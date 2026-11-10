/**
 * W1-g: space membership must be bound to the caller's active org.
 *
 * One user is an active member of two orgs and a member of a private space in
 * org B. With a session for org A, every route guarded by
 * requireSpaceMembership must treat that org-B space exactly like a space the
 * caller is not a member of (same status and body), and must not read or write
 * anything for it. With a session for org B, the same user still succeeds.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/space-membership-active-org-db.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const ORG_A = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const stamp = Date.now();
const ORG_B = `w1g-org-b-${stamp}`;
const USER_ID = `w1g-user-${stamp}`;
const USER_EMAIL = `w1g-user-${stamp}@test.local`;
const SPACE_B = `w1g-space-b-${stamp}`;
const SPACE_A = `w1g-space-a-${stamp}`;
const MISSING_SPACE = `w1g-missing-space-${stamp}`;
const MESSAGE_B = `w1g-message-b-${stamp}`;
const SECRET = `w1gsecret${stamp}`;

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
    await c.query(`INSERT INTO orgs (id, name, slug) VALUES ($1, 'W1g Org B', $1)`, [ORG_B]);
    await c.query(`INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, 'W1g User', false)`, [USER_ID, USER_EMAIL]);
    for (const org of [ORG_A, ORG_B]) {
      await c.query(
        `INSERT INTO org_members (id, org_id, user_id, role, is_active)
         VALUES (gen_random_uuid()::text, $1, $2, 'member', true)`,
        [org, USER_ID],
      );
    }
    for (const [space, org] of [[SPACE_B, ORG_B], [SPACE_A, ORG_A]] as const) {
      await c.query(
        `INSERT INTO spaces (id, org_id, name, type, is_default, is_archived, agent_enabled, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, 'private', false, false, true, $4, NOW(), NOW())`,
        [space, org, `${SECRET} ${space}`, USER_ID],
      );
      await c.query(
        `INSERT INTO space_members (id, space_id, user_id, is_muted, notification_level, joined_at)
         VALUES (gen_random_uuid()::text, $1, $2, false, 'all', NOW())`,
        [space, USER_ID],
      );
    }
    await c.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content, is_pinned, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, true, false, NOW(), NOW())`,
      [MESSAGE_B, ORG_B, SPACE_B, USER_ID, `${SECRET} org B message`],
    );
    await c.query(
      `INSERT INTO pinned_messages (id, message_id, space_id, pinned_by) VALUES (gen_random_uuid()::text, $1, $2, $3)`,
      [MESSAGE_B, SPACE_B, USER_ID],
    );
  });
});

after(async () => {
  await withClient(async (c) => {
    const spacesList = [SPACE_A, SPACE_B];
    await c.query(`DELETE FROM job_queue WHERE payload::text LIKE $1`, [`%w1g-%${stamp}%`]).catch(() => undefined);
    await c.query(`DELETE FROM scheduled_messages WHERE user_id = $1`, [USER_ID]);
    await c.query(`DELETE FROM note_versions WHERE note_id IN (SELECT id FROM notes WHERE user_id = $1)`, [USER_ID]).catch(() => undefined);
    await c.query(`DELETE FROM notes WHERE user_id = $1`, [USER_ID]);
    await c.query(`DELETE FROM wiki_pages WHERE space_id = ANY($1) OR origin_space_id = ANY($1)`, [spacesList]);
    await c.query(`DELETE FROM canvases WHERE space_id = ANY($1)`, [spacesList]);
    await c.query(`DELETE FROM pinned_messages WHERE space_id = ANY($1)`, [spacesList]);
    await c.query(`DELETE FROM idempotency_keys WHERE user_id = $1`, [USER_ID]).catch(() => undefined);
    await c.query(`DELETE FROM messages WHERE space_id = ANY($1)`, [spacesList]);
    await c.query(`DELETE FROM space_members WHERE space_id = ANY($1)`, [spacesList]);
    await c.query(`DELETE FROM spaces WHERE id = ANY($1)`, [spacesList]);
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [USER_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
    await c.query(`DELETE FROM orgs WHERE id = $1`, [ORG_B]).catch(() => undefined);
  });
});

type RouteName = 'messages' | 'pins' | 'canvas' | 'wiki' | 'knowledge' | 'scheduled' | 'daily-notes' | 'spaces';

async function call(route: RouteName, orgId: string, method: string, path: string, body?: unknown) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: USER_ID, org_id: orgId, email: USER_EMAIL, sid: `w1g-sid-${stamp}` });
    await next();
  });
  if (route === 'messages') app.route('/api/messages', (await import('../src/routes/messages.js')).messageRoutes);
  if (route === 'pins') app.route('/api/spaces', (await import('../src/routes/pins.js')).pinRoutes);
  if (route === 'canvas') app.route('/api/spaces', (await import('../src/routes/canvas.js')).canvasRoutes);
  if (route === 'wiki') app.route('/api/wiki', (await import('../src/routes/wiki.js')).wikiRoutes);
  if (route === 'knowledge') app.route('/api/spaces', (await import('../src/routes/knowledge.js')).knowledgeRoutes);
  if (route === 'scheduled') app.route('/api/scheduled-messages', (await import('../src/routes/scheduled.js')).scheduledRoutes);
  if (route === 'daily-notes') app.route('/api/daily-notes', (await import('../src/routes/daily-notes.js')).dailyNoteRoutes);
  if (route === 'spaces') app.route('/api/spaces', (await import('../src/routes/spaces.js')).spaceRoutes);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await app.request(path, init);
  const text = await res.text();
  let json: unknown = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json, text };
}

/** Org-B space under an org-A session must look exactly like a space the caller is not in. */
async function assertLooksLikeNonMember(route: RouteName, method: string, path: (space: string) => string, body?: (space: string) => unknown) {
  const crossOrg = await call(route, ORG_A, method, path(SPACE_B), body?.(SPACE_B));
  const nonMember = await call(route, ORG_A, method, path(MISSING_SPACE), body?.(MISSING_SPACE));
  assert.equal(nonMember.status, 403, `${route} baseline non-member response: ${nonMember.text}`);
  assert.equal(crossOrg.status, nonMember.status, `${route} ${method} cross-org status (body: ${crossOrg.text})`);
  assert.deepEqual(crossOrg.json, nonMember.json);
  assert.ok(!crossOrg.text.includes(SECRET), `${route} leaked org B data`);
}

async function rowCount(sql: string, params: unknown[]) {
  return withClient(async (c) => Number((await c.query(sql, params)).rows[0].n));
}

test('W1g: messages read + post refuses a space outside the caller\'s active org', async () => {
  await assertLooksLikeNonMember('messages', 'GET', (s) => `/api/messages/${s}`);
  await assertLooksLikeNonMember('messages', 'GET', (s) => `/api/messages/${s}/read-receipts`);
  await assertLooksLikeNonMember('messages', 'POST', (s) => `/api/messages/${s}`, () => ({ content: `${SECRET} cross-org post` }));
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM messages WHERE space_id = $1 AND org_id = $2`, [SPACE_B, ORG_A]), 0);

  // Forward: an org-B source message must not be copied into an org-A space.
  const forward = await call('messages', ORG_A, 'POST', '/api/messages/forward', { message_id: MESSAGE_B, target_space_id: SPACE_A });
  assert.equal(forward.status, 403, forward.text);
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM messages WHERE space_id = $1 AND content LIKE $2`, [SPACE_A, `%${SECRET}%`]), 0);

  const ok = await call('messages', ORG_B, 'GET', `/api/messages/${SPACE_B}`);
  assert.equal(ok.status, 200, ok.text);
  assert.ok(ok.text.includes(MESSAGE_B));
  const receipts = await call('messages', ORG_B, 'GET', `/api/messages/${SPACE_B}/read-receipts`);
  assert.equal(receipts.status, 200, receipts.text);
  const posted = await call('messages', ORG_B, 'POST', `/api/messages/${SPACE_B}`, { content: 'w1g right-org post' });
  assert.equal(posted.status, 201, posted.text);
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM messages WHERE space_id = $1 AND org_id = $2 AND content = 'w1g right-org post'`, [SPACE_B, ORG_B]), 1);
});

test('W1g: pins refuses a space outside the caller\'s active org', async () => {
  await assertLooksLikeNonMember('pins', 'GET', (s) => `/api/spaces/${s}/pins`);
  await assertLooksLikeNonMember('pins', 'POST', (s) => `/api/spaces/${s}/pins`, () => ({ message_id: MESSAGE_B }));
  await assertLooksLikeNonMember('pins', 'DELETE', (s) => `/api/spaces/${s}/pins/${MESSAGE_B}`);
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM pinned_messages WHERE space_id = $1`, [SPACE_B]), 1);

  const ok = await call('pins', ORG_B, 'GET', `/api/spaces/${SPACE_B}/pins`);
  assert.equal(ok.status, 200, ok.text);
  assert.ok(ok.text.includes(MESSAGE_B));
});

test('W1g: canvas refuses a space outside the caller\'s active org', async () => {
  await assertLooksLikeNonMember('canvas', 'GET', (s) => `/api/spaces/${s}/canvas`);
  await assertLooksLikeNonMember('canvas', 'PATCH', (s) => `/api/spaces/${s}/canvas`, () => ({ title: 'cross-org' }));
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM canvases WHERE space_id = $1`, [SPACE_B]), 0);

  const ok = await call('canvas', ORG_B, 'GET', `/api/spaces/${SPACE_B}/canvas`);
  assert.equal(ok.status, 201, ok.text);
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM canvases WHERE space_id = $1 AND org_id = $2`, [SPACE_B, ORG_B]), 1);
});

test('W1g: wiki refuses a space outside the caller\'s active org', async () => {
  await assertLooksLikeNonMember('wiki', 'GET', (s) => `/api/wiki/graph?mode=space&space_id=${s}`);
  const ok = await call('wiki', ORG_B, 'GET', `/api/wiki/graph?mode=space&space_id=${SPACE_B}`);
  assert.equal(ok.status, 200, ok.text);
});

test('W1g: knowledge refuses a space outside the caller\'s active org', async () => {
  await assertLooksLikeNonMember('knowledge', 'GET', (s) => `/api/spaces/${s}/knowledge`);
  await assertLooksLikeNonMember('knowledge', 'POST', (s) => `/api/spaces/${s}/knowledge`, () => ({ type: 'note', title: `${SECRET} cross-org`, content: 'x' }));
  await assertLooksLikeNonMember('knowledge', 'POST', (s) => `/api/spaces/${s}/knowledge/capture-discussion`, () => ({}));
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM wiki_pages WHERE space_id = $1 OR origin_space_id = $1`, [SPACE_B]), 0);

  const ok = await call('knowledge', ORG_B, 'GET', `/api/spaces/${SPACE_B}/knowledge`);
  assert.equal(ok.status, 200, ok.text);
});

test('W1g: scheduled messages refuses a space outside the caller\'s active org', async () => {
  const when = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await assertLooksLikeNonMember('scheduled', 'POST', () => '/api/scheduled-messages', (s) => ({ space_id: s, content: 'w1g scheduled', scheduled_for: when }));
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM scheduled_messages WHERE space_id = $1`, [SPACE_B]), 0);

  const ok = await call('scheduled', ORG_B, 'POST', '/api/scheduled-messages', { space_id: SPACE_B, content: 'w1g scheduled', scheduled_for: when });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM scheduled_messages WHERE space_id = $1 AND org_id = $2`, [SPACE_B, ORG_B]), 1);
});

test('W1g: daily-notes refuses a space outside the caller\'s active org', async () => {
  await assertLooksLikeNonMember('daily-notes', 'POST', () => '/api/daily-notes', (s) => ({ title: 'w1g note', visibility: 'space', visibility_space_id: s }));
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM notes WHERE visibility_space_id = $1`, [SPACE_B]), 0);

  // PATCH: an org-A note cannot be re-pointed at the org-B space.
  const own = await call('daily-notes', ORG_A, 'POST', '/api/daily-notes', { title: 'w1g org A note' });
  assert.equal(own.status, 201, own.text);
  const noteId = (own.json as { id: string }).id;
  await assertLooksLikeNonMember('daily-notes', 'PATCH', () => `/api/daily-notes/${noteId}`, (s) => ({ visibility: 'space', visibility_space_id: s }));
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM notes WHERE visibility_space_id = $1`, [SPACE_B]), 0);

  const ok = await call('daily-notes', ORG_B, 'POST', '/api/daily-notes', { title: 'w1g note', visibility: 'space', visibility_space_id: SPACE_B });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM notes WHERE visibility_space_id = $1 AND org_id = $2`, [SPACE_B, ORG_B]), 1);
});

test('W1g: spaces refuses a space outside the caller\'s active org', async () => {
  await assertLooksLikeNonMember('spaces', 'POST', (s) => `/api/spaces/${s}/read`);
  await assertLooksLikeNonMember('spaces', 'PATCH', (s) => `/api/spaces/${s}/notification-level`, () => ({ level: 'mentions' }));
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM space_members WHERE space_id = $1 AND user_id = $2 AND (notification_level <> 'all' OR last_read_at IS NOT NULL)`, [SPACE_B, USER_ID]), 0);

  const read = await call('spaces', ORG_B, 'POST', `/api/spaces/${SPACE_B}/read`);
  assert.equal(read.status, 200, read.text);
  const level = await call('spaces', ORG_B, 'PATCH', `/api/spaces/${SPACE_B}/notification-level`, { level: 'mentions' });
  assert.equal(level.status, 200, level.text);
  const detail = await call('spaces', ORG_B, 'GET', `/api/spaces/${SPACE_B}`);
  assert.equal(detail.status, 200, detail.text);
});
