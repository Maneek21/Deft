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
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { setupSocket } from '../src/socket.js';

const { io: connectSocket } = createRequire(new URL('../../web/package.json', import.meta.url))('socket.io-client');

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
const MESSAGE_A = `w1g-message-a-${stamp}`;
const SPACE_A_OTHER = `w1g-space-a-other-${stamp}`;
const SCHEDULED_B = `w1g-scheduled-b-${stamp}`;
const NOTE_B = `w1g-note-b-${stamp}`;
const FOLDER_B = `w1g-folder-b-${stamp}`;
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
    // Round 2 fixtures: an org-A message, an org-A space the caller is not in,
    // and org-B rows owned by the caller (scheduled message, note, folder).
    await c.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content, is_pinned, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'w1g org A message', false, false, NOW() - interval '1 hour', NOW())`,
      [MESSAGE_A, ORG_A, SPACE_A, USER_ID],
    );
    await c.query(
      `INSERT INTO spaces (id, org_id, name, type, is_default, is_archived, agent_enabled, created_by, created_at, updated_at)
       VALUES ($1, $2, 'w1g org A other', 'private', false, false, true, $3, NOW(), NOW())`,
      [SPACE_A_OTHER, ORG_A, USER_ID],
    );
    await c.query(
      `INSERT INTO scheduled_messages (id, org_id, user_id, space_id, content, scheduled_for, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + interval '1 day', 'pending', NOW(), NOW())`,
      [SCHEDULED_B, ORG_B, USER_ID, SPACE_B, `${SECRET} scheduled B`],
    );
    await c.query(
      `INSERT INTO note_folders (id, org_id, user_id, name, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [FOLDER_B, ORG_B, USER_ID, `${SECRET} folder B`],
    );
    await c.query(
      `INSERT INTO notes (id, org_id, user_id, title, folder_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
      [NOTE_B, ORG_B, USER_ID, `${SECRET} note B`, FOLDER_B],
    );
  });
});

after(async () => {
  await withClient(async (c) => {
    const spacesList = [SPACE_A, SPACE_B, SPACE_A_OTHER];
    await c.query(`DELETE FROM job_queue WHERE payload::text LIKE $1`, [`%w1g-%${stamp}%`]).catch(() => undefined);
    await c.query(`DELETE FROM scheduled_messages WHERE user_id = $1`, [USER_ID]);
    await c.query(`DELETE FROM note_versions WHERE note_id IN (SELECT id FROM notes WHERE user_id = $1)`, [USER_ID]).catch(() => undefined);
    await c.query(`DELETE FROM note_shares WHERE note_id IN (SELECT id FROM notes WHERE user_id = $1)`, [USER_ID]).catch(() => undefined);
    await c.query(`DELETE FROM notes WHERE user_id = $1`, [USER_ID]);
    await c.query(`DELETE FROM note_folders WHERE user_id = $1`, [USER_ID]);
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
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM scheduled_messages WHERE space_id = $1 AND id <> $2`, [SPACE_B, SCHEDULED_B]), 0);

  const ok = await call('scheduled', ORG_B, 'POST', '/api/scheduled-messages', { space_id: SPACE_B, content: 'w1g scheduled', scheduled_for: when });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM scheduled_messages WHERE space_id = $1 AND org_id = $2 AND id <> $3`, [SPACE_B, ORG_B, SCHEDULED_B]), 1);
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

// ── Round 2 ──────────────────────────────────────────────────────────────

test('W1g: pin, unpin and pin list are bound to the authorized space and active org', async () => {
  // Unpin through an org-A space URL with an org-B message id must not touch the B message.
  const unpin = await call('pins', ORG_A, 'DELETE', `/api/spaces/${SPACE_A}/pins/${MESSAGE_B}`);
  const unpinMissing = await call('pins', ORG_A, 'DELETE', `/api/spaces/${SPACE_A}/pins/w1g-missing-message-${stamp}`);
  assert.equal(unpin.status, unpinMissing.status, unpin.text);
  assert.deepEqual(unpin.json, unpinMissing.json);
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM messages WHERE id = $1 AND is_pinned = true`, [MESSAGE_B]), 1,
    'unpin via an org-A space cleared is_pinned on an org-B message');

  // Pinning a foreign message into an org-A space fails exactly like a missing message.
  const pin = await call('pins', ORG_A, 'POST', `/api/spaces/${SPACE_A}/pins`, { message_id: MESSAGE_B });
  const pinMissing = await call('pins', ORG_A, 'POST', `/api/spaces/${SPACE_A}/pins`, { message_id: `w1g-missing-message-${stamp}` });
  assert.equal(pinMissing.status, 404, pinMissing.text);
  assert.equal(pin.status, pinMissing.status, pin.text);
  assert.deepEqual(pin.json, pinMissing.json);
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM pinned_messages WHERE space_id = $1`, [SPACE_A]), 0);

  // A pin row in an org-A space that points at a message outside that space
  // (legacy / corrupt data) must not surface the foreign message's content.
  await withClient((c) => c.query(
    `INSERT INTO pinned_messages (id, message_id, space_id, pinned_by) VALUES (gen_random_uuid()::text, $1, $2, $3)`,
    [MESSAGE_B, SPACE_A, USER_ID],
  ));
  try {
    const list = await call('pins', ORG_A, 'GET', `/api/spaces/${SPACE_A}/pins`);
    assert.equal(list.status, 200, list.text);
    assert.ok(!list.text.includes(SECRET), `pin list leaked an org-B message: ${list.text}`);
  } finally {
    await withClient((c) => c.query(`DELETE FROM pinned_messages WHERE space_id = $1`, [SPACE_A]));
  }

  // Right org still works end to end.
  const okUnpin = await call('pins', ORG_B, 'DELETE', `/api/spaces/${SPACE_B}/pins/${MESSAGE_B}`);
  assert.equal(okUnpin.status, 200, okUnpin.text);
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM messages WHERE id = $1 AND is_pinned = false`, [MESSAGE_B]), 1);
  const okPin = await call('pins', ORG_B, 'POST', `/api/spaces/${SPACE_B}/pins`, { message_id: MESSAGE_B });
  assert.equal(okPin.status, 201, okPin.text);
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM messages WHERE id = $1 AND is_pinned = true`, [MESSAGE_B]), 1);
});

test('W1g: messages around= treats a foreign message id like a nonexistent one', async () => {
  const foreign = await call('messages', ORG_A, 'GET', `/api/messages/${SPACE_A}?around=${MESSAGE_B}`);
  const missing = await call('messages', ORG_A, 'GET', `/api/messages/${SPACE_A}?around=w1g-missing-message-${stamp}`);
  assert.equal(missing.status, 200, missing.text);
  assert.equal(foreign.status, missing.status, foreign.text);
  assert.deepEqual(foreign.json, missing.json);

  const own = await call('messages', ORG_A, 'GET', `/api/messages/${SPACE_A}?around=${MESSAGE_A}`);
  assert.equal(own.status, 200, own.text);
  assert.ok(own.text.includes(MESSAGE_A), own.text);
});

/** Org-B space, same-org non-member space and nonexistent space must all get one identical denial. */
async function assertIdenticalDenial(route: RouteName, method: string, path: (space: string) => string, body?: (space: string) => unknown) {
  const crossOrg = await call(route, ORG_A, method, path(SPACE_B), body?.(SPACE_B));
  const nonMember = await call(route, ORG_A, method, path(SPACE_A_OTHER), body?.(SPACE_A_OTHER));
  const missing = await call(route, ORG_A, method, path(MISSING_SPACE), body?.(MISSING_SPACE));
  assert.equal(nonMember.status, 403, `${route} ${method} same-org non-member: ${nonMember.text}`);
  assert.equal(crossOrg.status, nonMember.status, `${route} ${method} cross-org vs non-member (body: ${crossOrg.text})`);
  assert.deepEqual(crossOrg.json, nonMember.json, `${route} ${method} cross-org body`);
  assert.equal(missing.status, nonMember.status, `${route} ${method} missing vs non-member (body: ${missing.text})`);
  assert.deepEqual(missing.json, nonMember.json, `${route} ${method} missing body`);
  assert.ok(!crossOrg.text.includes(SECRET), `${route} leaked org B data`);
}

test('W1g: spaces detail/members and wiki create deny cross-org, non-member and missing spaces identically', async () => {
  await assertIdenticalDenial('spaces', 'GET', (s) => `/api/spaces/${s}`);
  await assertIdenticalDenial('spaces', 'GET', (s) => `/api/spaces/${s}/members`);
  await assertIdenticalDenial('spaces', 'POST', (s) => `/api/spaces/${s}/members`, () => ({ user_id: USER_ID }));
  await assertIdenticalDenial('wiki', 'POST', () => '/api/wiki', (s) => ({ title: `w1g wiki ${stamp}`, content: 'x', type: 'fact', scope: 'space', space_id: s }));
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM space_members WHERE space_id = $1 AND user_id = $2`, [SPACE_A_OTHER, USER_ID]), 0);
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM wiki_pages WHERE space_id = ANY($1)`, [[SPACE_B, SPACE_A_OTHER]]), 0);

  const detail = await call('spaces', ORG_B, 'GET', `/api/spaces/${SPACE_B}`);
  assert.equal(detail.status, 200, detail.text);
  const members = await call('spaces', ORG_B, 'GET', `/api/spaces/${SPACE_B}/members`);
  assert.equal(members.status, 200, members.text);
});

test('W1g: mute refuses a space outside the caller\'s active org', async () => {
  await assertLooksLikeNonMember('spaces', 'PATCH', (s) => `/api/spaces/${s}/mute`, () => ({ muted: true }));
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM space_members WHERE space_id = $1 AND user_id = $2 AND is_muted = true`, [SPACE_B, USER_ID]), 0);

  const ok = await call('spaces', ORG_B, 'PATCH', `/api/spaces/${SPACE_B}/mute`, { muted: false });
  assert.equal(ok.status, 200, ok.text);
});

test('W1g: scheduled list and cancel are bound to the active org', async () => {
  const list = await call('scheduled', ORG_A, 'GET', '/api/scheduled-messages');
  assert.equal(list.status, 200, list.text);
  assert.ok(!list.text.includes(SCHEDULED_B), `org-A list exposed an org-B scheduled message: ${list.text}`);
  assert.ok(!list.text.includes(SECRET));

  const cancel = await call('scheduled', ORG_A, 'DELETE', `/api/scheduled-messages/${SCHEDULED_B}`);
  const cancelMissing = await call('scheduled', ORG_A, 'DELETE', `/api/scheduled-messages/w1g-missing-scheduled-${stamp}`);
  assert.equal(cancel.status, cancelMissing.status, cancel.text);
  assert.deepEqual(cancel.json, cancelMissing.json);
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM scheduled_messages WHERE id = $1 AND status = 'pending'`, [SCHEDULED_B]), 1,
    'org-A session cancelled an org-B scheduled message');

  const okList = await call('scheduled', ORG_B, 'GET', '/api/scheduled-messages');
  assert.ok(okList.text.includes(SCHEDULED_B), okList.text);
});

test('W1g: daily-notes owner-only routes are bound to the active org', async () => {
  const folders = await call('daily-notes', ORG_A, 'GET', '/api/daily-notes/folders');
  assert.equal(folders.status, 200, folders.text);
  assert.ok(!folders.text.includes(SECRET), `org-A folder list exposed an org-B folder: ${folders.text}`);

  const attempts: Array<[string, string, unknown]> = [
    ['GET', `/api/daily-notes/${NOTE_B}/history`, undefined],
    ['GET', `/api/daily-notes/${NOTE_B}/shares`, undefined],
    ['POST', `/api/daily-notes/${NOTE_B}/shares`, { user_id: USER_ID }],
    ['DELETE', `/api/daily-notes/${NOTE_B}/shares/${USER_ID}`, undefined],
    ['DELETE', `/api/daily-notes/${NOTE_B}`, undefined],
    ['PATCH', `/api/daily-notes/folders/${FOLDER_B}`, { name: 'w1g renamed' }],
  ];
  for (const [method, path, body] of attempts) {
    const res = await call('daily-notes', ORG_A, method, path, body);
    assert.equal(res.status, 404, `${method} ${path} must treat an org-B note/folder as missing (body: ${res.text})`);
  }
  await call('daily-notes', ORG_A, 'DELETE', `/api/daily-notes/folders/${FOLDER_B}`);
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM notes WHERE id = $1 AND is_deleted = false AND folder_id = $2`, [NOTE_B, FOLDER_B]), 1,
    'org-A session deleted or detached an org-B note');
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM note_folders WHERE id = $1 AND is_deleted = false AND name = $2`, [FOLDER_B, `${SECRET} folder B`]), 1,
    'org-A session changed an org-B folder');
  assert.equal(await rowCount(`SELECT count(*)::int AS n FROM note_shares WHERE note_id = $1`, [NOTE_B]), 0);

  const okHistory = await call('daily-notes', ORG_B, 'GET', `/api/daily-notes/${NOTE_B}/history`);
  assert.equal(okHistory.status, 200, okHistory.text);
  const okFolders = await call('daily-notes', ORG_B, 'GET', '/api/daily-notes/folders');
  assert.ok(okFolders.text.includes(FOLDER_B), okFolders.text);
});

test('W1g: typing events require a checked space join and use the authenticated name', async () => {
  type Principal = { id: string; email: string; org_id: string; sid: string; exp: number };
  const exp = Math.floor(Date.now() / 1000) + 300;
  const principals: Record<string, Principal> = {
    attacker: { id: 'w1g-sock-user', email: 'w1g-sock@deft.invalid', org_id: 'w1g-sock-org-a', sid: 'w1g-sock-a', exp },
    victim: { id: 'w1g-sock-victim', email: 'w1g-victim@deft.invalid', org_id: 'w1g-sock-org-b', sid: 'w1g-sock-b', exp },
    peer: { id: 'w1g-sock-peer', email: 'w1g-peer@deft.invalid', org_id: 'w1g-sock-org-a', sid: 'w1g-sock-c', exp },
  };
  const allowedRoom: Record<string, string> = { attacker: 'w1g-room-a', victim: 'w1g-room-b', peer: 'w1g-room-a' };
  const realName: Record<string, string> = { attacker: 'Real Attacker Name', victim: 'Victim', peer: 'Peer' };
  const keyOf = (u: { id: string; org_id: string }) =>
    Object.keys(principals).find((k) => principals[k]!.id === u.id && principals[k]!.org_id === u.org_id)!;
  const server = createServer();
  const sockets = setupSocket(server, {
    verifyAccess: async (token: string) => principals[token] as any,
    requireMembership: async () => ({ role: 'member' }) as any,
    getSpaceAccess: async (spaceId, u) => {
      const key = keyOf(u);
      return allowedRoom[key] === spaceId ? { space_id: spaceId, space_name: 'room', user_name: realName[key]! } : undefined;
    },
    recordLastSeen: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const open = (token: string) => connectSocket(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'], reconnection: false });
  const attacker = open('attacker');
  const victim = open('victim');
  const peer = open('peer');
  const roomSize = (room: string) => sockets.sockets.adapter.rooms.get(room)?.size ?? 0;
  const waitFor = async (cond: () => boolean, label: string) => {
    const deadline = Date.now() + 5_000;
    while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.ok(cond(), `socket condition timed out: ${label}`);
  };
  const victimEvents: unknown[] = [];
  const peerEvents: unknown[] = [];
  victim.on('typing:start', (d: unknown) => victimEvents.push(d));
  victim.on('typing:stop', (d: unknown) => victimEvents.push(d));
  peer.on('typing:start', (d: unknown) => peerEvents.push(d));
  try {
    victim.emit('space:join', 'w1g-room-b');
    peer.emit('space:join', 'w1g-room-a');
    await waitFor(() => roomSize('space:w1g-room-b') === 1 && roomSize('space:w1g-room-a') === 1, 'victim+peer joined');

    // The attacker never passes the join check for the org-B room.
    attacker.emit('space:join', 'w1g-room-b');
    attacker.emit('typing:start', { space_id: 'w1g-room-b', user_name: 'Spoofed CEO' });
    attacker.emit('typing:stop', { space_id: 'w1g-room-b' });
    // A legitimate join + typing in its own room, as an ordering barrier.
    attacker.emit('space:join', 'w1g-room-a');
    await waitFor(() => roomSize('space:w1g-room-a') === 2, 'attacker joined own room');
    attacker.emit('typing:start', { space_id: 'w1g-room-a', user_name: 'Spoofed CEO' });
    await waitFor(() => peerEvents.length === 1, 'peer typing delivery');
    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(victimEvents, [], 'typing events reached an unjoined org-B space room');
    assert.deepEqual(peerEvents, [{ user_id: 'w1g-sock-user', user_name: 'Real Attacker Name', space_id: 'w1g-room-a' }]);
  } finally {
    attacker.close();
    victim.close();
    peer.close();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  }
});
