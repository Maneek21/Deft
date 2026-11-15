/**
 * Before-strangers fix 4: reading a public space before joining it (rule N6).
 *
 * A member of the workspace who is not a guest may READ a public space they
 * have not joined, on the web routes for space details, messages, threads and
 * search. A guest never can. Every WRITE still needs the caller to have
 * joined. Private, archived and other-workspace spaces are unchanged.
 *
 * The table below is the contract: one row per web surface, with the answer
 * for a member who has not joined and for a guest who has not joined.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/public-space-read-before-join-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID();
const otherOrgId = randomUUID();
const stamp = Date.now();
const TOKEN = `pubread${stamp}z`;
const ids = {
  creator: randomUUID(), member: randomUUID(), guest: randomUUID(), joinedGuest: randomUUID(),
  inactive: randomUUID(), stranger: randomUUID(),
};
const roles: Record<string, 'member' | 'guest'> = {
  [ids.creator]: 'member', [ids.member]: 'member', [ids.guest]: 'guest', [ids.joinedGuest]: 'guest',
  [ids.inactive]: 'member', [ids.stranger]: 'member',
};
const S = { pub: randomUUID(), priv: randomUUID(), archived: randomUUID(), foreign: randomUUID(), own: randomUUID() };
const M = { pub: randomUUID(), pubReply: randomUUID(), priv: randomUUID(), archived: randomUUID(), foreign: randomUUID() };
const names: Record<string, string> = Object.fromEntries(Object.entries(S).map(([key, id]) => [id, `${TOKEN} ${key} space`]));
let client: pg.Client | undefined;
let unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let seeded = false;
let app: Hono | undefined;

async function call(actor: string, method: string, path: string, body?: unknown, org = orgId) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    // The session role is 'member' for everyone: who is a guest must come from the database.
    c.set('user', { id: actor, org_id: org, email: `${actor}@example.test`, sid: `pubread-${actor}`, role: 'member' } as any);
    await next();
  });
  hono.route('/', app!);
  const response = await hono.request(path, body === undefined
    ? { method }
    : { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const text = await response.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: response.status, json, text };
}

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  const q = (text: string, values: unknown[]) => client!.query(text, values);
  await q('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Public read', `public-read-${orgId}`]);
  await q('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [otherOrgId, 'Public read other', `public-read-${otherOrgId}`]);
  for (const [name, id] of Object.entries(ids)) {
    await q(`INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,'human',false)`, [id, `${id}@example.test`, name]);
    await q('INSERT INTO org_members(id,org_id,user_id,role,is_active) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), name === 'stranger' ? otherOrgId : orgId, id, roles[id], name !== 'inactive']);
  }
  const spaces: Array<[string, string, 'public' | 'private', boolean, string, string[]]> = [
    [S.pub, orgId, 'public', false, ids.creator, [ids.creator, ids.joinedGuest]],
    [S.priv, orgId, 'private', false, ids.creator, [ids.creator]],
    [S.archived, orgId, 'public', true, ids.creator, [ids.creator]],
    [S.foreign, otherOrgId, 'public', false, ids.stranger, [ids.stranger]],
    // A space the member and the guest are in, used as a place they may forward to.
    [S.own, orgId, 'private', false, ids.creator, [ids.creator, ids.member, ids.guest]],
  ];
  for (const [id, org, type, archived, creator, members] of spaces) {
    await q('INSERT INTO spaces(id,org_id,name,type,is_archived,created_by) VALUES($1,$2,$3,$4,$5,$6)', [id, org, names[id], type, archived, creator]);
    for (const member of members) await q('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), id, member]);
  }
  const message = (id: string, org: string, space: string, author: string, parent: string | null) => q(
    'INSERT INTO messages(id,org_id,space_id,user_id,content,parent_id) VALUES($1,$2,$3,$4,$5,$6)',
    [id, org, space, author, `${TOKEN} message ${id}`, parent]);
  await message(M.pub, orgId, S.pub, ids.creator, null);
  await message(M.pubReply, orgId, S.pub, ids.creator, M.pub);
  await message(M.priv, orgId, S.priv, ids.creator, null);
  await message(M.archived, orgId, S.archived, ids.creator, null);
  await message(M.foreign, otherOrgId, S.foreign, ids.stranger, null);

  app = new Hono()
    .route('/api/spaces', (await import('../src/routes/spaces.js')).spaceRoutes)
    .route('/api/messages', (await import('../src/routes/messages.js')).messageRoutes)
    .route('/api/search', (await import('../src/routes/search.js')).searchRoutes)
    .route('/api/scheduled-messages', (await import('../src/routes/scheduled.js')).scheduledRoutes);
  seeded = true;
});

after(async () => {
  if (seeded && client) {
    const orgs = [orgId, otherOrgId];
    for (const table of ['scheduled_messages', 'notifications', 'attention_events', 'attention_items']) {
      await client.query(`DELETE FROM ${table} WHERE org_id=ANY($1::text[])`, [orgs]);
    }
    await client.query('DELETE FROM job_queue WHERE org_id=ANY($1::text[])', [orgs]).catch(() => undefined);
    await client.query('DELETE FROM thread_reads WHERE user_id=ANY($1::text[])', [Object.values(ids)]);
    await client.query('DELETE FROM reactions WHERE user_id=ANY($1::text[])', [Object.values(ids)]);
    await client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=ANY($1::text[]))', [orgs]);
    await client.query('UPDATE messages SET parent_id=NULL WHERE org_id=ANY($1::text[])', [orgs]);
    await client.query('DELETE FROM messages WHERE org_id=ANY($1::text[])', [orgs]);
    await client.query('DELETE FROM spaces WHERE org_id=ANY($1::text[])', [orgs]);
    await client.query('DELETE FROM org_members WHERE org_id=ANY($1::text[])', [orgs]);
    await client.query('DELETE FROM orgs WHERE id=ANY($1::text[])', [orgs]);
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [Object.values(ids)]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

type Row = {
  surface: string;
  method: string;
  path: string;
  body?: unknown;
  /** Status for a member who has not joined, and for a guest who has not joined. */
  member: number;
  guest: number;
};

// READ: allowed for a member who has not joined, refused for a guest.
const READS: Row[] = [
  { surface: 'space details', method: 'GET', path: `/api/spaces/${S.pub}`, member: 200, guest: 403 },
  { surface: 'messages', method: 'GET', path: `/api/messages/${S.pub}`, member: 200, guest: 403 },
  { surface: 'messages around one message', method: 'GET', path: `/api/messages/${S.pub}?around=${M.pub}`, member: 200, guest: 403 },
  { surface: 'thread', method: 'GET', path: `/api/messages/${M.pub}/thread`, member: 200, guest: 404 },
];

// WRITE: refused for both until they join.
const WRITES: Row[] = [
  { surface: 'post a message', method: 'POST', path: `/api/messages/${S.pub}`, body: { content: 'hello' }, member: 403, guest: 403 },
  { surface: 'reply in a thread', method: 'POST', path: `/api/messages/${S.pub}`, body: { content: 'hello', parent_id: M.pub }, member: 403, guest: 403 },
  { surface: 'edit a message', method: 'PATCH', path: `/api/messages/${M.pub}`, body: { content: 'edited' }, member: 404, guest: 404 },
  { surface: 'delete a message', method: 'DELETE', path: `/api/messages/${M.pub}`, member: 404, guest: 404 },
  { surface: 'react', method: 'POST', path: `/api/messages/${M.pub}/reactions`, body: { emoji: 'thumbsup' }, member: 404, guest: 404 },
  { surface: 'remove a reaction', method: 'DELETE', path: `/api/messages/${M.pub}/reactions/thumbsup`, member: 404, guest: 404 },
  { surface: 'mark a thread read', method: 'POST', path: `/api/messages/${M.pub}/thread-read`, member: 404, guest: 404 },
  { surface: 'forward a message out', method: 'POST', path: '/api/messages/forward', body: { message_id: M.pub, target_space_id: S.own }, member: 404, guest: 404 },
  { surface: 'schedule a message', method: 'POST', path: '/api/scheduled-messages', body: { space_id: S.pub, content: 'later', scheduled_for: '2999-01-01T00:00:00.000Z' }, member: 403, guest: 403 },
  { surface: 'rename the space', method: 'PATCH', path: `/api/spaces/${S.pub}`, body: { name: 'renamed' }, member: 403, guest: 403 },
  { surface: 'add a member', method: 'POST', path: `/api/spaces/${S.pub}/members`, body: { user_id: ids.inactive }, member: 403, guest: 403 },
  { surface: 'remove a member', method: 'DELETE', path: `/api/spaces/${S.pub}/members/${ids.creator}`, member: 403, guest: 403 },
  { surface: 'leave', method: 'DELETE', path: `/api/spaces/${S.pub}/members/me`, member: 403, guest: 403 },
  { surface: 'mute', method: 'PATCH', path: `/api/spaces/${S.pub}/mute`, body: { muted: true }, member: 403, guest: 403 },
  { surface: 'mark the space read', method: 'POST', path: `/api/spaces/${S.pub}/read`, member: 403, guest: 403 },
  { surface: 'mark a message unread', method: 'POST', path: `/api/spaces/${S.pub}/mark-unread`, body: { message_id: M.pub }, member: 403, guest: 403 },
  { surface: 'notification level', method: 'PATCH', path: `/api/spaces/${S.pub}/notification-level`, body: { level: 'all' }, member: 403, guest: 403 },
  { surface: 'archive the space', method: 'DELETE', path: `/api/spaces/${S.pub}`, member: 403, guest: 403 },
];

// Other read routes this fix does not open: they still need the caller to have joined.
const STILL_JOINED_ONLY: Row[] = [
  { surface: 'member list', method: 'GET', path: `/api/spaces/${S.pub}/members`, member: 403, guest: 403 },
  { surface: 'read receipts', method: 'GET', path: `/api/messages/${S.pub}/read-receipts`, member: 403, guest: 403 },
  { surface: 'edit history', method: 'GET', path: `/api/messages/${M.pub}/history`, member: 404, guest: 404 },
];

const snapshot = async () => {
  const one = async (text: string) => Number((await client!.query(text, [S.pub])).rows[0].n);
  return {
    members: await one('SELECT count(*)::int AS n FROM space_members WHERE space_id=$1'),
    messages: await one('SELECT count(*)::int AS n FROM messages WHERE space_id=$1 AND is_deleted=false'),
    reactions: await one('SELECT count(*)::int AS n FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE space_id=$1)'),
    scheduled: await one('SELECT count(*)::int AS n FROM scheduled_messages WHERE space_id=$1'),
    name: (await client!.query('SELECT name, is_archived FROM spaces WHERE id=$1', [S.pub])).rows[0],
    content: (await client!.query('SELECT content FROM messages WHERE id=$1', [M.pub])).rows[0].content,
  };
};

for (const [label, rows] of [['read', READS], ['write', WRITES], ['other read routes, unchanged', STILL_JOINED_ONLY]] as const) {
  test(`public space, not joined — ${label}: member and guest`, async (t) => {
    if (unavailable) return t.skip(unavailable);
    const before = await snapshot();
    for (const row of rows) {
      for (const [who, actor, expected] of [['member', ids.member, row.member], ['guest', ids.guest, row.guest]] as const) {
        const response = await call(actor, row.method, row.path, row.body);
        assert.equal(response.status, expected, `${row.surface} as ${who}: ${response.status} ${response.text}`);
        if (expected >= 400) assert.ok(!response.text.includes(TOKEN), `${row.surface} as ${who} leaked content: ${response.text}`);
      }
    }
    assert.deepEqual(await snapshot(), before, 'nothing in the space changed');
  });
}

test('a member who has not joined reads the same content a member of the space reads', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const details = await call(ids.member, 'GET', `/api/spaces/${S.pub}`);
  assert.equal(details.json.id, S.pub);
  assert.equal(details.json.name, names[S.pub]);

  const list = await call(ids.member, 'GET', `/api/messages/${S.pub}`);
  assert.deepEqual(list.json.messages.map((message: any) => message.id), [M.pub]);
  assert.equal(list.json.messages[0].reply_count, 1);
  assert.deepEqual(list.json, (await call(ids.creator, 'GET', `/api/messages/${S.pub}`)).json);

  const thread = await call(ids.member, 'GET', `/api/messages/${M.pub}/thread`);
  assert.equal(thread.json.parent.id, M.pub);
  assert.deepEqual(thread.json.replies.map((reply: any) => reply.id), [M.pubReply]);

  // Reading does not join: the space is still absent from the member's own list.
  const mine = await call(ids.member, 'GET', '/api/spaces');
  assert.ok(!mine.json.some((space: any) => space.id === S.pub));
  const { rows } = await client!.query('SELECT 1 FROM space_members WHERE space_id=$1 AND user_id=$2', [S.pub, ids.member]);
  assert.equal(rows.length, 0);
});

test('search shows a public space and its messages to a member who has not joined, never to a guest', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const search = async (actor: string) => {
    const response = await call(actor, 'GET', `/api/search?q=${TOKEN}`);
    assert.equal(response.status, 200, response.text);
    return {
      spaces: response.json.spaces.map((space: any) => space.id).sort(),
      messages: response.json.messages.map((message: any) => message.id).sort(),
    };
  };
  // The member is in `own` (no messages there) and may read `pub`. Private, archived and other-workspace spaces stay out.
  assert.deepEqual(await search(ids.member), { spaces: [S.own, S.pub].sort(), messages: [M.pub, M.pubReply].sort() });
  // The guest is in `own` only.
  assert.deepEqual(await search(ids.guest), { spaces: [S.own], messages: [] });
  // A guest who was added to the public space reads it like any member of it.
  assert.deepEqual(await search(ids.joinedGuest), { spaces: [S.pub], messages: [M.pub, M.pubReply].sort() });
  // A member of the space keeps the archived space's messages they could already find.
  const creator = await search(ids.creator);
  assert.ok(creator.messages.includes(M.archived) && creator.messages.includes(M.priv));
});

test('private, archived and other-workspace spaces are unchanged, and so is anyone who is not an active member', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const NOT_A_MEMBER = { error: 'Not a member of this space', code: 'FORBIDDEN' };
  const missing = await call(ids.member, 'GET', `/api/spaces/${randomUUID()}`);
  assert.equal(missing.status, 403);
  for (const [space, message] of [[S.priv, M.priv], [S.archived, M.archived], [S.foreign, M.foreign]] as const) {
    const details = await call(ids.member, 'GET', `/api/spaces/${space}`);
    assert.equal(details.status, 403, `${names[space]}: ${details.text}`);
    assert.deepEqual(details.json, missing.json, 'a space that may not be read answers like a missing one');
    const list = await call(ids.member, 'GET', `/api/messages/${space}`);
    assert.equal(list.status, 403, list.text);
    assert.deepEqual(list.json, NOT_A_MEMBER);
    assert.equal((await call(ids.member, 'GET', `/api/messages/${message}/thread`)).status, 404);
  }
  // A deactivated member, and a member of another workspace whose session names this one, read nothing.
  for (const actor of [ids.inactive, ids.stranger]) {
    assert.equal((await call(actor, 'GET', `/api/spaces/${S.pub}`)).status, 403);
    assert.equal((await call(actor, 'GET', `/api/messages/${S.pub}`)).status, 403);
    assert.equal((await call(actor, 'GET', `/api/messages/${M.pub}/thread`)).status, 404);
    const found = await call(actor, 'GET', `/api/search?q=${TOKEN}`);
    assert.ok(!found.text.includes(S.pub) && !found.text.includes(M.pub), found.text);
  }
  // A guest who is in the public space reads it, as before.
  assert.equal((await call(ids.joinedGuest, 'GET', `/api/spaces/${S.pub}`)).status, 200);
  assert.equal((await call(ids.joinedGuest, 'GET', `/api/messages/${S.pub}`)).status, 200);
  assert.equal((await call(ids.joinedGuest, 'GET', `/api/messages/${M.pub}/thread`)).status, 200);
});
