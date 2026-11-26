/**
 * Before-strangers fix 4: reading a public space before joining it (rule N6).
 *
 * A member of the workspace who is not a guest may READ a public space they
 * have not joined, on every web surface: space details, member list,
 * messages, threads, edit history, read receipts, pinned messages, clips,
 * attachments, the canvas, the space's knowledge and wiki graph, and search.
 * The live socket room stays for people in the space (see
 * public-spaces-browse-join-db.test.ts). A guest never can. Every WRITE
 * still needs the caller to have
 * joined. Private spaces, DMs, group DMs, agent conversations, archived and
 * other-workspace spaces are unchanged.
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
import {
  AttachmentDownloadAuthorityError, authorizeAttachmentDownload, canAccessAttachmentMessage, getVisibleAttachment,
} from '../src/lib/attachment-access.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';
import { humanFetch, humanThreadFetch, humanMessagesSearch, humanSearch, type HumanToolContext } from '../src/lib/mcp-tools/human.js';
import { resolveNativeMessageDisplay } from '../src/lib/native-content-projections.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID();
const otherOrgId = randomUUID();
const stamp = Date.now();
const TOKEN = `pubread${stamp}z`;
const ids = {
  creator: randomUUID(), member: randomUUID(), guest: randomUUID(), joinedGuest: randomUUID(),
  inactive: randomUUID(), stranger: randomUUID(), agentViewer: randomUUID(), systemViewer: randomUUID(),
};
const roles: Record<string, 'member' | 'guest' | 'admin'> = {
  [ids.creator]: 'member', [ids.member]: 'member', [ids.guest]: 'guest', [ids.joinedGuest]: 'guest',
  [ids.inactive]: 'member', [ids.stranger]: 'member', [ids.agentViewer]: 'member', [ids.systemViewer]: 'member',
};
const S = {
  pub: randomUUID(), priv: randomUUID(), archived: randomUUID(), foreign: randomUUID(), own: randomUUID(),
  dm: randomUUID(), groupDm: randomUUID(), agentConversation: randomUUID(),
};
const M = {
  pub: randomUUID(), pubReply: randomUUID(), priv: randomUUID(), archived: randomUUID(), foreign: randomUUID(),
  dm: randomUUID(), groupDm: randomUUID(), agentConversation: randomUUID(),
};
/** One clip and one attached file in the public space and in the private one. */
const CLIP = { pub: randomUUID(), priv: randomUUID() };
const FILE = { pub: randomUUID(), priv: randomUUID() };
const SESSION = { member: randomUUID(), guest: randomUUID() };
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
    const kind = name === 'agentViewer' ? 'agent' : name === 'systemViewer' ? 'system' : 'human';
    await q('INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,$4,$5)', [id, `${id}@example.test`, name, kind, kind === 'agent']);
    await q('INSERT INTO org_members(id,org_id,user_id,role,is_active) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(), name === 'stranger' ? otherOrgId : orgId, id, roles[id], name !== 'inactive']);
  }
  const spaces: Array<[string, string, 'public' | 'private' | 'dm' | 'group_dm' | 'agent_conversation', boolean, string, string[]]> = [
    [S.pub, orgId, 'public', false, ids.creator, [ids.creator, ids.joinedGuest]],
    [S.priv, orgId, 'private', false, ids.creator, [ids.creator]],
    [S.archived, orgId, 'public', true, ids.creator, [ids.creator]],
    [S.foreign, otherOrgId, 'public', false, ids.stranger, [ids.stranger]],
    // A space the member and the guest are in, used as a place they may forward to.
    [S.own, orgId, 'private', false, ids.creator, [ids.creator, ids.member, ids.guest]],
    // Space types that are never public.
    [S.dm, orgId, 'dm', false, ids.creator, [ids.creator, ids.inactive]],
    [S.groupDm, orgId, 'group_dm', false, ids.creator, [ids.creator, ids.inactive, ids.stranger]],
    [S.agentConversation, orgId, 'agent_conversation', false, ids.creator, [ids.creator, ids.agentViewer]],
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
  await message(M.dm, orgId, S.dm, ids.creator, null);
  await message(M.groupDm, orgId, S.groupDm, ids.creator, null);
  await message(M.agentConversation, orgId, S.agentConversation, ids.creator, null);

  // What else there is to read in a space: a pin, an edit, a clip and an attachment.
  for (const [space, messageId, clip, file] of [[S.pub, M.pub, CLIP.pub, FILE.pub], [S.priv, M.priv, CLIP.priv, FILE.priv]] as const) {
    await q('UPDATE messages SET is_pinned=true WHERE id=$1', [messageId]);
    await q('INSERT INTO pinned_messages(id,message_id,space_id,pinned_by) VALUES($1,$2,$3,$4)', [randomUUID(), messageId, space, ids.creator]);
    await q('INSERT INTO message_versions(id,message_id,content) VALUES($1,$2,$3)', [randomUUID(), messageId, `${TOKEN} earlier version`]);
    await q(`INSERT INTO clips(id,org_id,space_id,message_id,context_type,context_id,created_by,file_key,status,transcript)
      VALUES($1,$2,$3,$4,'space',$3,$5,$6,'ready',$7)`, [clip, orgId, space, messageId, ids.creator, `${clip}.webm`, `${TOKEN} clip transcript`]);
    await q(`INSERT INTO files(id,org_id,uploaded_by,filename,mime_type,size_bytes,storage_key,message_id)
      VALUES($1,$2,$3,$4,'text/plain',4,$5,$6)`, [file, orgId, ids.creator, `${TOKEN}.txt`, `public-read-${file}`, messageId]);
    await q('INSERT INTO message_attachments(org_id,message_id,file_id,position) VALUES($1,$2,$3,0)', [orgId, messageId, file]);
  }
  for (const space of [S.pub, S.priv]) {
    await q(`INSERT INTO canvases(id,org_id,space_id,title,content) VALUES($1,$2,$3,$4,'{}'::jsonb)`, [randomUUID(), orgId, space, `${TOKEN} canvas`]);
  }
  for (const [sid, user] of [[SESSION.member, ids.member], [SESSION.guest, ids.guest]] as const) {
    await q(`INSERT INTO web_sessions(id,user_id,org_id,refresh_token_hash,expires_at) VALUES($1,$2,$3,'test', now() + interval '1 hour')`, [sid, user, orgId]);
  }

  app = new Hono()
    .route('/api/spaces', (await import('../src/routes/spaces.js')).spaceRoutes)
    .route('/api/messages', (await import('../src/routes/messages.js')).messageRoutes)
    .route('/api/search', (await import('../src/routes/search.js')).searchRoutes)
    .route('/api/scheduled-messages', (await import('../src/routes/scheduled.js')).scheduledRoutes)
    .route('/api/spaces', (await import('../src/routes/pins.js')).pinRoutes)
    .route('/api/clips', (await import('../src/routes/clips.js')).clipRoutes)
    .route('/api/spaces', (await import('../src/routes/canvas.js')).canvasRoutes)
    .route('/api/spaces', (await import('../src/routes/knowledge.js')).knowledgeRoutes)
    .route('/api/wiki', (await import('../src/routes/wiki.js')).wikiRoutes);
  seeded = true;
});

after(async () => {
  if (seeded && client) {
    const orgs = [orgId, otherOrgId];
    await client.query('DELETE FROM project_spaces WHERE project_id IN (SELECT id FROM projects WHERE org_id=ANY($1::text[]))', [orgs]);
    for (const table of ['message_bookmarks', 'cross_references', 'audit_log', 'wiki_citations', 'wiki_pages', 'tasks', 'projects']) {
      await client.query(`DELETE FROM ${table} WHERE org_id=ANY($1::text[])`, [orgs]);
    }
    for (const table of ['scheduled_messages', 'notifications', 'attention_events', 'attention_items']) {
      await client.query(`DELETE FROM ${table} WHERE org_id=ANY($1::text[])`, [orgs]);
    }
    await client.query('DELETE FROM job_queue WHERE org_id=ANY($1::text[])', [orgs]).catch(() => undefined);
    await client.query('DELETE FROM web_sessions WHERE org_id=ANY($1::text[])', [orgs]);
    await client.query('DELETE FROM message_attachments WHERE org_id=ANY($1::text[])', [orgs]);
    await client.query('DELETE FROM files WHERE org_id=ANY($1::text[])', [orgs]);
    await client.query('DELETE FROM clips WHERE org_id=ANY($1::text[])', [orgs]);
    await client.query('DELETE FROM canvases WHERE org_id=ANY($1::text[])', [orgs]);
    for (const table of ['pinned_messages', 'message_versions']) {
      await client.query(`DELETE FROM ${table} WHERE message_id IN (SELECT id FROM messages WHERE org_id=ANY($1::text[]))`, [orgs]);
    }
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
  { surface: 'member list', method: 'GET', path: `/api/spaces/${S.pub}/members`, member: 200, guest: 403 },
  { surface: 'edit history', method: 'GET', path: `/api/messages/${M.pub}/history`, member: 200, guest: 404 },
  { surface: 'pinned messages', method: 'GET', path: `/api/spaces/${S.pub}/pins`, member: 200, guest: 403 },
  { surface: 'clips in the space', method: 'GET', path: `/api/clips/space/${S.pub}`, member: 200, guest: 403 },
  { surface: 'one clip', method: 'GET', path: `/api/clips/${CLIP.pub}`, member: 200, guest: 404 },
  { surface: 'read receipts', method: 'GET', path: `/api/messages/${S.pub}/read-receipts`, member: 200, guest: 403 },
  // A canvas is its document since the notes move (F15), shared with the chat's members: not reached before joining.
  { surface: 'canvas', method: 'GET', path: `/api/spaces/${S.pub}/canvas`, member: 404, guest: 403 },
  { surface: 'knowledge of the space', method: 'GET', path: `/api/spaces/${S.pub}/knowledge`, member: 200, guest: 403 },
  { surface: 'wiki graph of the space', method: 'GET', path: `/api/wiki/graph?mode=space&space_id=${S.pub}`, member: 200, guest: 403 },
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
  { surface: 'pin a message', method: 'POST', path: `/api/spaces/${S.pub}/pins`, body: { message_id: M.pubReply }, member: 403, guest: 403 },
  { surface: 'unpin a message', method: 'DELETE', path: `/api/spaces/${S.pub}/pins/${M.pub}`, member: 403, guest: 403 },
  { surface: 'delete a clip', method: 'DELETE', path: `/api/clips/${CLIP.pub}`, member: 404, guest: 404 },
  { surface: 'edit the canvas', method: 'PATCH', path: `/api/spaces/${S.pub}/canvas`, body: { title: 'changed' }, member: 403, guest: 403 },
  { surface: 'add knowledge', method: 'POST', path: `/api/spaces/${S.pub}/knowledge`, body: { type: 'decision', title: 'added' }, member: 403, guest: 403 },
  { surface: 'capture a discussion', method: 'POST', path: `/api/spaces/${S.pub}/knowledge/capture-discussion`, body: {}, member: 403, guest: 403 },
];

const snapshot = async () => {
  const one = async (text: string) => Number((await client!.query(text, [S.pub])).rows[0].n);
  return {
    members: await one('SELECT count(*)::int AS n FROM space_members WHERE space_id=$1'),
    messages: await one('SELECT count(*)::int AS n FROM messages WHERE space_id=$1 AND is_deleted=false'),
    reactions: await one('SELECT count(*)::int AS n FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE space_id=$1)'),
    scheduled: await one('SELECT count(*)::int AS n FROM scheduled_messages WHERE space_id=$1'),
    pins: await one('SELECT count(*)::int AS n FROM pinned_messages WHERE space_id=$1'),
    clips: await one('SELECT count(*)::int AS n FROM clips WHERE space_id=$1 AND is_deleted=false'),
    canvas: (await client!.query('SELECT title FROM canvases WHERE space_id=$1', [S.pub])).rows[0],
    knowledge: await one('SELECT count(*)::int AS n FROM wiki_pages WHERE space_id=$1'),
    name: (await client!.query('SELECT name, is_archived FROM spaces WHERE id=$1', [S.pub])).rows[0],
    content: (await client!.query('SELECT content FROM messages WHERE id=$1', [M.pub])).rows[0].content,
  };
};

for (const [label, rows] of [['read', READS], ['write', WRITES]] as const) {
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

test('the extra read surfaces return the space\'s content to a member who has not joined', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const members = await call(ids.member, 'GET', `/api/spaces/${S.pub}/members`);
  assert.deepEqual(members.json.map((row: any) => row.id).sort(), [ids.creator, ids.joinedGuest].sort());
  const history = await call(ids.member, 'GET', `/api/messages/${M.pub}/history`);
  assert.deepEqual(history.json.versions.map((version: any) => version.content), [`${TOKEN} earlier version`]);
  const pins = await call(ids.member, 'GET', `/api/spaces/${S.pub}/pins`);
  assert.deepEqual(pins.json.map((pin: any) => pin.message_id), [M.pub]);
  const clips = await call(ids.member, 'GET', `/api/clips/space/${S.pub}`);
  assert.deepEqual(clips.json.map((clip: any) => clip.id), [CLIP.pub]);
  assert.equal((await call(ids.member, 'GET', `/api/clips/${CLIP.pub}`)).json.transcript, `${TOKEN} clip transcript`);
});

test('attachments: a member who has not joined may download what they can read; a guest may not; attaching is still for members', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const signal = new AbortController().signal;
  const stored = (await getVisibleAttachment(FILE.pub, orgId, ids.creator))!;
  assert.equal(stored.id, FILE.pub);
  // Finding the file.
  assert.equal((await getVisibleAttachment(FILE.pub, orgId, ids.member))?.id, FILE.pub);
  assert.equal(await getVisibleAttachment(FILE.pub, orgId, ids.guest), null);
  assert.equal((await getVisibleAttachment(FILE.pub, orgId, ids.joinedGuest))?.id, FILE.pub);
  for (const actor of [ids.member, ids.guest, ids.inactive, ids.stranger]) {
    assert.equal(await getVisibleAttachment(FILE.priv, orgId, actor), null, 'a private space\'s file stays hidden');
  }
  assert.equal(await getVisibleAttachment(FILE.pub, orgId, ids.inactive), null);
  assert.equal(await getVisibleAttachment(FILE.pub, orgId, ids.stranger), null);
  // The final check made just before the bytes are handed over.
  const download = (user: string, sid: string) => authorizeAttachmentDownload({
    org_id: orgId, user_id: user, sid, jwt_expires_at: Date.now() + 60_000, file: stored, signal,
  });
  assert.equal((await download(ids.member, SESSION.member)).file.id, FILE.pub);
  await assert.rejects(download(ids.guest, SESSION.guest), (error) => error instanceof AttachmentDownloadAuthorityError && error.code === 'NOT_FOUND');
  // Attaching a file to a message is a write: the default check still needs membership.
  assert.equal(await canAccessAttachmentMessage(M.pub, orgId, ids.member), false);
  assert.equal(await canAccessAttachmentMessage(M.pub, orgId, ids.member, 'read'), true);
  assert.equal(await canAccessAttachmentMessage(M.pub, orgId, ids.guest, 'read'), false);
  assert.equal(await canAccessAttachmentMessage(M.pub, orgId, ids.creator), true);
});

test('private spaces, DMs, group DMs and agent conversations stay closed to anyone who is not in them', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const closed: Array<[string, string]> = [[S.priv, M.priv], [S.dm, M.dm], [S.groupDm, M.groupDm], [S.agentConversation, M.agentConversation]];
  for (const actor of [ids.member, ids.guest, ids.systemViewer]) {
    for (const [space, message] of closed) {
      const refused: Array<[string, number]> = [
        [`/api/spaces/${space}`, 403], [`/api/spaces/${space}/members`, 403], [`/api/messages/${space}`, 403],
        [`/api/spaces/${space}/pins`, 403], [`/api/clips/space/${space}`, 403],
        [`/api/messages/${space}/read-receipts`, 403], [`/api/spaces/${space}/canvas`, 403],
        [`/api/spaces/${space}/knowledge`, 403], [`/api/wiki/graph?mode=space&space_id=${space}`, 403],
        [`/api/messages/${message}/thread`, 404], [`/api/messages/${message}/history`, 404],
      ];
      for (const [path, status] of refused) {
        const response = await call(actor, 'GET', path);
        assert.equal(response.status, status, `${names[space]} ${path}: ${response.status} ${response.text}`);
        assert.ok(!response.text.includes(TOKEN), `${path} leaked content: ${response.text}`);
      }
    }
    assert.equal((await call(actor, 'GET', `/api/clips/${CLIP.priv}`)).status, 404);
    const found = await call(actor, 'GET', `/api/search?q=${TOKEN}`);
    for (const [space, message] of closed) assert.ok(!found.text.includes(space) && !found.text.includes(message), `${names[space]} in search`);
  }
  // Someone who is in them reads them as before.
  for (const [space, message] of closed) {
    assert.equal((await call(ids.creator, 'GET', `/api/messages/${space}`)).status, 200);
    assert.equal((await call(ids.creator, 'GET', `/api/messages/${message}/thread`)).status, 200);
  }
});

test('an agent user and a system user follow the same shared rule: read a public space, write nowhere they are not in', async (t) => {
  if (unavailable) return t.skip(unavailable);
  // publicSpaceVisibleSql refuses only human guests, so these users read a public space like a member.
  for (const actor of [ids.agentViewer, ids.systemViewer]) {
    for (const row of READS) {
      const response = await call(actor, row.method, row.path, row.body);
      // The canvas is a document shared with the chat's members (F15): a reader of the public space, member or not, gets
      // the same answer as a member of the workspace who hasn't joined.
      assert.equal(response.status, row.surface === 'canvas' ? row.member : 200, `${row.surface}: ${response.status} ${response.text}`);
    }
    for (const row of WRITES) {
      const response = await call(actor, row.method, row.path, row.body);
      assert.equal(response.status, row.member, `${row.surface}: ${response.status} ${response.text}`);
    }
    assert.equal((await call(actor, 'GET', `/api/spaces/${S.priv}`)).status, 403);
    assert.equal((await call(actor, 'GET', `/api/messages/${S.archived}`)).status, 403);
  }
  // The agent is in its own conversation and reads it; the system user is not.
  assert.equal((await call(ids.agentViewer, 'GET', `/api/messages/${S.agentConversation}`)).status, 200);
  assert.equal((await call(ids.systemViewer, 'GET', `/api/messages/${S.agentConversation}`)).status, 403);
});

test('the canvas: reading it never creates one, joined or not (F15)', async (t) => {
  if (unavailable) return t.skip(unavailable);
  // The canvas is its document since the notes move, shared with the chat's members: not reached before joining.
  assert.equal((await call(ids.member, 'GET', `/api/spaces/${S.pub}/canvas`)).status, 404);
  // A public space that has no canvas yet.
  const space = randomUUID();
  await client!.query(`INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,'public',$4)`, [space, orgId, `no canvas ${space}`, ids.creator]);
  await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), space, ids.creator]);
  const canvases = async () => Number((await client!.query('SELECT count(*)::int AS n FROM canvases WHERE space_id=$1', [space])).rows[0].n);
  const reader = await call(ids.member, 'GET', `/api/spaces/${space}/canvas`);
  assert.equal(reader.status, 404, reader.text);
  assert.equal(await canvases(), 0, 'reading created nothing');
  assert.equal((await call(ids.guest, 'GET', `/api/spaces/${space}/canvas`)).status, 403);
  const joined = await call(ids.creator, 'GET', `/api/spaces/${space}/canvas`);
  assert.equal(joined.status, 404, joined.text);
  assert.equal(await canvases(), 0, 'a member reading created nothing either');
});

test('saved messages, task sources/references, wiki citations and native displays use public read authority', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const project = randomUUID(), task = randomUUID(), page = randomUUID();
  await client!.query(`INSERT INTO projects(id,org_id,name,prefix) VALUES($1,$2,'Public references','PBR')`, [project, orgId]);
  await client!.query(`INSERT INTO tasks(id,org_id,project_id,number,title,created_by,source_message_id) VALUES($1,$2,$3,1,'Public source',$4,$5)`, [task, orgId, project, ids.creator, M.pub]);
  // The project belongs to a room the guest is in, so the guest reads the task
  // (a guest sees only the tasks of their projects, lib/task-visibility.ts).
  await client!.query('INSERT INTO project_spaces(id,project_id,space_id) VALUES($1,$2,$3)', [randomUUID(), project, S.own]);
  await client!.query(`INSERT INTO wiki_pages(id,org_id,title,slug,type,scope,user_id,content) VALUES($1,$2,'Public citations',$3,'decision','org',$4,'{}')`, [page, orgId, `pub-${page}`, ids.creator]);
  for (const message of [M.pub, M.priv]) {
    await client!.query(`INSERT INTO cross_references(id,org_id,source_type,source_id,target_type,target_id,created_by) VALUES($1,$2,'message',$3,'task',$4,$5)`, [randomUUID(), orgId, message, task, ids.creator]);
    await client!.query(`INSERT INTO wiki_citations(id,org_id,page_id,source_type,source_id,excerpt) VALUES($1,$2,$3,'message',$4,$5)`, [randomUUID(), orgId, page, message, `${TOKEN} cited ${message}`]);
    await client!.query(`INSERT INTO audit_log(id,org_id,actor_type,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,'user',$3,'message_post','message',$4,$5)`, [randomUUID(), orgId, ids.creator, message, JSON.stringify({ content: `${TOKEN} audit ${message}` })]);
    for (const actor of [ids.member, ids.guest]) {
      await client!.query(`INSERT INTO message_bookmarks(id,org_id,user_id,message_id,space_id) VALUES($1,$2,$3,$4,$5)`, [randomUUID(), orgId, actor, message, message === M.pub ? S.pub : S.priv]);
    }
  }
  app!.route('/api/bookmarks', (await import('../src/routes/bookmarks.js')).bookmarkRoutes)
    .route('/api/tasks', (await import('../src/routes/tasks.js')).taskRoutes)
    .route('/api/cross-references', (await import('../src/routes/cross-references.js')).crossReferenceRoutes)
    .route('/api/audit', (await import('../src/routes/audit.js')).auditRoutes);
  for (const actor of [ids.member, ids.guest]) {
    const allowed = actor === ids.member;
    const bookmarks = await call(actor, 'GET', '/api/bookmarks');
    assert.equal(bookmarks.status, 200, bookmarks.text);
    assert.deepEqual(bookmarks.json.map((row: any) => row.message_id), allowed ? [M.pub] : []);
    const details = await call(actor, 'GET', `/api/tasks/${task}`);
    assert.equal(details.status, 200, details.text);
    assert.equal(details.json.source_message?.id ?? null, allowed ? M.pub : null);
    const refs = await call(actor, 'GET', `/api/cross-references/tasks/${task}/references`);
    assert.equal(refs.status, 200, refs.text);
    assert.deepEqual(refs.json.references.map((row: any) => row.source_id), allowed ? [M.pub] : []);
    const fromMessage = await call(actor, 'GET', `/api/cross-references/messages/${M.pub}/references`);
    assert.equal(fromMessage.status, allowed ? 200 : 404, fromMessage.text);
    const citations = await call(actor, 'GET', `/api/wiki/pub-${page}`);
    assert.equal(citations.status, 200, citations.text);
    assert.deepEqual(citations.json.citations.map((row: any) => row.source_id), allowed ? [M.pub] : []);
    assert.equal(Boolean(await resolveNativeMessageDisplay({ user_id: actor, org_id: orgId, role: roles[actor] as any }, M.pub)), allowed);
  }
  roles[ids.member] = 'admin';
  await client!.query(`UPDATE org_members SET role='admin' WHERE org_id=$1 AND user_id=$2`, [orgId, ids.member]);
  try {
    const audit = await call(ids.member, 'GET', '/api/audit?entity_type=message');
    assert.equal(audit.status, 200, audit.text);
    assert.ok(audit.text.includes(`${TOKEN} audit ${M.pub}`), audit.text);
    assert.ok(!audit.text.includes(`${TOKEN} audit ${M.priv}`), audit.text);
  } finally {
    roles[ids.member] = 'member';
    await client!.query(`UPDATE org_members SET role='member' WHERE org_id=$1 AND user_id=$2`, [orgId, ids.member]);
  }
});

test('MCP public message reads require membership once the space is archived', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const context = (actor: string): HumanToolContext => ({ user_id: actor, org_id: orgId, role: roles[actor], scopes: ['read:messages', 'read:workspace'], principal_kind: 'human' } as HumanToolContext);
  const text = (result: any) => result.content.map((part: any) => part.text).join('\n');
  for (const actor of [ids.member, ids.creator]) {
    const ctx = context(actor);
    const allowed = actor === ids.creator;
    assert.equal(Boolean((await humanFetch({ id: `message:${M.archived}` }, ctx)).isError), !allowed);
    assert.equal(Boolean((await humanThreadFetch({ parent_message_id: M.archived }, ctx)).isError), !allowed);
    assert.equal(text(await humanMessagesSearch({ query: TOKEN, limit: 50 }, ctx)).includes(M.archived), allowed);
    assert.equal(text(await humanSearch({ query: TOKEN, limit: 50 }, ctx)).includes(M.archived), allowed);
  }
});
