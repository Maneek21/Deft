/**
 * A deleted message says nothing to anyone.
 *
 * Deleting a message only marks its row; the text, metadata and attachment
 * links stay in the database. No reader may get them back: not a member of
 * the space, not a member reading a public space before joining, not the
 * author. The chat list and threads keep a placeholder row (id, author, time,
 * the deleted flag); every other surface leaves the message out.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/deleted-message-content-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { Hono } from 'hono';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { withoutDeletedContent } from '../src/lib/deleted-message.js';
import {
  humanFetch, humanMessagesRecent, humanMessagesSearch, humanSearch, humanThreadFetch, type HumanToolContext,
} from '../src/lib/mcp-tools/human.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID();
const TOKEN = `delmsg${Date.now()}z`;
const ids = { author: randomUUID(), peer: randomUUID(), reader: randomUUID(), bot: randomUUID() };
const viewers: Array<[string, string]> = [['the author', ids.author], ['a member of the space', ids.peer], ['a member who has not joined', ids.reader]];
const S = { pub: randomUUID(), conversation: randomUUID() };
const M = { top: randomUUID(), parent: randomUUID(), reply: randomUUID(), pinned: randomUUID(), live: randomUUID(), trace: randomUUID() };
const fileId = randomUUID();
let client: pg.Client | undefined;
let unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let seeded = false;
let app: Hono | undefined;

async function call(actor: string, method: string, path: string) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('user', { id: actor, org_id: orgId, email: `${actor}@example.test`, sid: `del-${actor}`, role: 'member' } as any);
    await next();
  });
  hono.route('/', app!);
  const response = await hono.request(path, { method });
  const text = await response.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: response.status, json, text };
}

const ctx = (user: string): HumanToolContext => ({
  org_id: orgId, user_id: user, role: 'member', scopes: ['read:messages', 'read:workspace', 'read:wiki'], principal_kind: 'human',
} as HumanToolContext);
const toolText = (result: { content: Array<{ text: string }> }) => result.content.map((part) => part.text).join('\n');
const canaries = (value: string) => [...new Set(value.match(/CANARY-[A-Z-]+/g) ?? [])].sort();

/** Every read surface for one viewer, as text. */
async function readAll(actor: string): Promise<Record<string, string>> {
  const c = ctx(actor);
  const web = async (path: string) => { const r = await call(actor, 'GET', path); return `${r.status} ${r.text}`; };
  return {
    list: await web(`/api/messages/${S.pub}`),
    list_around: await web(`/api/messages/${S.pub}?around=${M.live}`),
    thread: await web(`/api/messages/${M.parent}/thread`),
    thread_of_deleted: await web(`/api/messages/${M.top}/thread`),
    history: await web(`/api/messages/${M.top}/history`),
    pins: await web(`/api/spaces/${S.pub}/pins`),
    search: await web(`/api/search?q=${TOKEN}`),
    tool_messages_recent: toolText(await humanMessagesRecent({ space_id: S.pub, since: '2020-01-01T00:00:00.000Z' }, c) as any),
    tool_messages_search: toolText(await humanMessagesSearch({ query: TOKEN }, c) as any),
    tool_search: toolText(await humanSearch({ query: TOKEN }, c) as any),
    tool_thread_fetch: toolText(await humanThreadFetch({ parent_message_id: M.parent }, c) as any),
    tool_thread_fetch_deleted: toolText(await humanThreadFetch({ parent_message_id: M.top }, c) as any),
    tool_fetch: toolText(await humanFetch({ id: `message:${M.top}` }, c) as any),
  };
}

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  const q = (text: string, values: unknown[]) => client!.query(text, values);
  await q('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Deleted messages', `deleted-messages-${orgId}`]);
  for (const [name, id] of Object.entries(ids)) {
    const agent = name === 'bot';
    await q('INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,$4,$5)', [id, `${id}@example.test`, name, agent ? 'agent' : 'human', agent]);
    await q(`INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'member')`, [randomUUID(), orgId, id]);
  }
  await q(`INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,'public',$4)`, [S.pub, orgId, `public ${S.pub}`, ids.author]);
  await q(`INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,'agent_conversation',$4)`, [S.conversation, orgId, `conversation ${S.conversation}`, ids.author]);
  for (const [space, user] of [[S.pub, ids.author], [S.pub, ids.peer], [S.conversation, ids.author], [S.conversation, ids.bot]] as const) {
    await q('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), space, user]);
  }
  const message = (id: string, space: string, tag: string, parent: string | null = null, metadata: unknown = null, minutesAgo = 10) => q(
    `INSERT INTO messages(id,org_id,space_id,user_id,content,parent_id,metadata,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb, now() - ($8::text || ' minutes')::interval)`,
    [id, orgId, space, ids.author, `${TOKEN} CANARY-${tag}`, parent, metadata === null ? null : JSON.stringify(metadata), String(minutesAgo)]);
  await message(M.top, S.pub, 'TOP', null, { link_preview: { title: 'CANARY-META' }, kind: 'note' }, 9);
  await message(M.parent, S.pub, 'KEPT-PARENT', null, null, 8);
  await message(M.reply, S.pub, 'REPLY', M.parent, null, 7);
  await message(M.pinned, S.pub, 'PIN', null, null, 6);
  await message(M.live, S.pub, 'KEPT-LIVE', null, null, 5);
  await message(M.trace, S.conversation, 'TRACE', null, null, 4);
  await q('UPDATE messages SET is_pinned=true WHERE id=$1', [M.pinned]);
  await q('INSERT INTO pinned_messages(id,message_id,space_id,pinned_by) VALUES($1,$2,$3,$4)', [randomUUID(), M.pinned, S.pub, ids.author]);
  await q('INSERT INTO message_versions(id,message_id,content) VALUES($1,$2,$3)', [randomUUID(), M.top, `${TOKEN} CANARY-VERSION`]);
  await q(`INSERT INTO reactions(id,message_id,user_id,emoji) VALUES($1,$2,$3,'CANARY-REACTION')`, [randomUUID(), M.top, ids.peer]);
  await q(`INSERT INTO files(id,org_id,uploaded_by,filename,mime_type,size_bytes,storage_key,message_id)
    VALUES($1,$2,$3,'CANARY-FILE.txt','text/plain',4,$4,$5)`, [fileId, orgId, ids.author, `deleted-message-${fileId}`, M.top]);
  await q('INSERT INTO message_attachments(org_id,message_id,file_id,position) VALUES($1,$2,$3,0)', [orgId, M.top, fileId]);

  app = new Hono()
    .route('/api/messages', (await import('../src/routes/messages.js')).messageRoutes)
    .route('/api/spaces', (await import('../src/routes/pins.js')).pinRoutes)
    .route('/api/search', (await import('../src/routes/search.js')).searchRoutes)
    .route('/api/agent', (await import('../src/routes/agent.js')).agentRoutes);
  seeded = true;
});

after(async () => {
  if (seeded && client) {
    await client.query('DELETE FROM message_attachments WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM files WHERE org_id=$1', [orgId]);
    for (const table of ['reactions', 'message_versions', 'pinned_messages']) {
      await client.query(`DELETE FROM ${table} WHERE message_id IN (SELECT id FROM messages WHERE org_id=$1)`, [orgId]);
    }
    await client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [orgId]);
    await client.query('UPDATE messages SET parent_id=NULL WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM messages WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM spaces WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM org_members WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM orgs WHERE id=$1', [orgId]);
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [Object.values(ids)]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

const DELETED = ['CANARY-FILE', 'CANARY-META', 'CANARY-PIN', 'CANARY-REACTION', 'CANARY-REPLY', 'CANARY-TOP', 'CANARY-VERSION'];

test('before deletion every reader gets the text on every surface', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const [who, actor] of viewers) {
    const seen = await readAll(actor);
    assert.deepEqual(canaries(seen.list), ['CANARY-FILE', 'CANARY-KEPT-LIVE', 'CANARY-KEPT-PARENT', 'CANARY-META', 'CANARY-PIN', 'CANARY-REACTION', 'CANARY-TOP'], `${who}: list`);
    assert.ok(seen.list_around.includes('CANARY-TOP') && seen.list_around.includes('CANARY-FILE'), `${who}: list around`);
    assert.deepEqual(canaries(seen.thread), ['CANARY-KEPT-PARENT', 'CANARY-REPLY'], `${who}: thread`);
    assert.ok(seen.thread_of_deleted.startsWith('200 ') && seen.thread_of_deleted.includes('CANARY-TOP'), `${who}: thread of the top message`);
    assert.deepEqual(canaries(seen.history), ['CANARY-VERSION'], `${who}: history`);
    assert.deepEqual(canaries(seen.pins), ['CANARY-PIN'], `${who}: pins`);
    for (const surface of ['search', 'tool_messages_recent', 'tool_messages_search', 'tool_search']) {
      for (const expected of ['CANARY-TOP', 'CANARY-PIN', 'CANARY-REPLY']) {
        assert.ok(seen[surface]!.includes(expected), `${who}: ${surface} is missing ${expected}: ${seen[surface]}`);
      }
    }
    assert.ok(seen.tool_thread_fetch.includes('CANARY-REPLY'), `${who}: tool thread fetch`);
    assert.ok(seen.tool_thread_fetch_deleted.includes('CANARY-TOP'), `${who}: tool thread fetch of the top message`);
    assert.ok(seen.tool_fetch.includes('CANARY-TOP'), `${who}: tool fetch`);
  }
  const trace = await call(ids.author, 'GET', `/api/agent/conversations/${S.conversation}/trace.json`);
  assert.equal(trace.status, 200, trace.text);
  assert.deepEqual(canaries(trace.text), ['CANARY-TRACE']);
});

test('after deletion no reader gets the text back, on any surface', async (t) => {
  if (unavailable) return t.skip(unavailable);
  // Someone else cannot delete it; the author can.
  assert.equal((await call(ids.peer, 'DELETE', `/api/messages/${M.top}`)).status, 403);
  for (const id of [M.top, M.reply, M.pinned, M.trace]) {
    const deleted = await call(ids.author, 'DELETE', `/api/messages/${id}`);
    assert.equal(deleted.status, 200, deleted.text);
  }
  // The rows, their text and their attachments are still stored.
  const stored = await client!.query('SELECT count(*)::int AS n FROM messages WHERE id=ANY($1::text[]) AND is_deleted AND content LIKE $2', [[M.top, M.reply, M.pinned, M.trace], '%CANARY-%']);
  assert.equal(stored.rows[0].n, 4);

  for (const [who, actor] of viewers) {
    const seen = await readAll(actor);
    for (const [surface, text] of Object.entries(seen)) {
      assert.deepEqual(canaries(text).filter((canary) => DELETED.includes(canary)), [], `${who}: ${surface} still returns deleted text: ${text}`);
    }
    // Live messages are untouched.
    assert.ok(seen.list.includes('CANARY-KEPT-LIVE') && seen.thread.includes('CANARY-KEPT-PARENT'), who);
    // A deleted message can no longer be opened by id.
    assert.ok(seen.thread_of_deleted.startsWith('404 '), `${who}: ${seen.thread_of_deleted}`);
    assert.ok(seen.history.startsWith('404 '), `${who}: ${seen.history}`);
    assert.equal(seen.pins.trim(), '200 []', who);

    // The list and the thread keep a placeholder, and only a placeholder.
    const list = await call(actor, 'GET', `/api/messages/${S.pub}`);
    const placeholder = list.json.messages.find((message: any) => message.id === M.top);
    assert.ok(placeholder, `${who}: the deleted message keeps its place in the list`);
    assert.deepEqual(
      { is_deleted: placeholder.is_deleted, content: placeholder.content, metadata: placeholder.metadata, reactions: placeholder.reactions, file_ids: placeholder.file_ids, files: placeholder.files, edited_at: placeholder.edited_at },
      { is_deleted: true, content: '', metadata: { kind: 'note' }, reactions: [], file_ids: [], files: [], edited_at: null },
    );
    assert.equal(placeholder.user_id, ids.author);
    assert.ok(placeholder.created_at);
    const thread = await call(actor, 'GET', `/api/messages/${M.parent}/thread`);
    const reply = thread.json.replies.find((message: any) => message.id === M.reply);
    assert.deepEqual({ is_deleted: reply.is_deleted, content: reply.content, metadata: reply.metadata }, { is_deleted: true, content: '', metadata: null });
  }

  // The conversation trace keeps the message's place, marked deleted, without its text.
  const trace = await call(ids.author, 'GET', `/api/agent/conversations/${S.conversation}/trace.json`);
  assert.equal(trace.status, 200, trace.text);
  assert.deepEqual(canaries(trace.text), []);
  const traced = trace.json.messages.find((message: any) => message.id === M.trace);
  assert.deepEqual({ deleted: traced.deleted, content: traced.content }, { deleted: true, content: '' });
});

test('withoutDeletedContent leaves live rows alone and blanks every content field of a deleted row', () => {
  const live = { id: 'm1', is_deleted: false, content: 'hello', metadata: { a: 1 }, files: [{ id: 'f' }] };
  assert.equal(withoutDeletedContent(live), live);
  const deleted = withoutDeletedContent({
    id: 'm2', user_id: 'u', created_at: 'now', is_deleted: true, is_pinned: true, reply_count: 2,
    content: 'secret', metadata: { kind: 'tool_result', agent_blocks: ['secret'] }, reactions: [{ emoji: 'x' }],
    file_ids: ['f'], files: [{ id: 'f' }], attachments: [{ id: 'f' }], link_preview: { title: 'secret' }, edited_at: 'then',
  });
  assert.deepEqual(deleted, {
    id: 'm2', user_id: 'u', created_at: 'now', is_deleted: true, is_pinned: true, reply_count: 2,
    content: '', metadata: { kind: 'tool_result' }, reactions: [], file_ids: [], files: [], attachments: [], link_preview: null, edited_at: null,
  });
  assert.deepEqual(withoutDeletedContent({ is_deleted: true, metadata: ['secret'] }).metadata, null);
});
