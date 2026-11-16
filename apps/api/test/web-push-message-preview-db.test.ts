/**
 * A pushed notification for a chat message shows who it is from and a short
 * plain-text preview, built at the moment of sending and only for a recipient
 * who may read that message then. Everything else keeps the generic body.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID();
const ids = { alice: randomUUID(), bob: randomUUID(), outsider: randomUUID(), departed: randomUUID() };
const rooms = { general: randomUUID(), secret: randomUUID(), dm: randomUUID() };
let client: pg.Client | undefined;
let unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let seeded = false;
const originalPreviewsEnabled = env.PUSH_MESSAGE_PREVIEWS_ENABLED;

const q = (text: string, values: unknown[] = []) => client!.query(text, values);
const GENERIC = 'Open Deft to review.';

async function message(space: string, author: string, content: string, deleted = false) {
  const id = randomUUID();
  await q('INSERT INTO messages(id,org_id,space_id,user_id,content,is_deleted) VALUES($1,$2,$3,$4,$5,$6)',
    [id, orgId, space, author, content, deleted]);
  return id;
}

async function item(recipient: string, source: { type: string; id: string }, kind = 'mention', title = 'Alice mentioned you') {
  const id = randomUUID();
  await q(`INSERT INTO attention_items(id,org_id,user_id,kind,lane,dedupe_key,source_type,source_id,title,link)
    VALUES($1,$2,$3,$4,'needs_you',$5,$6,$7,$8,$9)`,
  [id, orgId, recipient, kind, `test:${id}`, source.type, source.id, title, `/chat?space=x&message=${source.id}`]);
  const { db } = await import('../src/lib/db.js');
  const { attentionItems } = await import('@deft/db/schema');
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select().from(attentionItems).where(eq(attentionItems.id, id));
  return row!;
}

async function payloadFor(recipient: string, source: { type: string; id: string }, kind?: string) {
  const { attentionPushPayload } = await import('../src/lib/web-push.js');
  return JSON.parse(await attentionPushPayload(await item(recipient, source, kind))) as {
    title: string; body: string; url: string; attention_id: string; tag: string;
  };
}

before(async () => {
  env.PUSH_MESSAGE_PREVIEWS_ENABLED = true;
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  await q('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Push preview', `push-preview-${orgId}`]);
  const names: Record<string, string> = { [ids.alice]: 'Alice Example', [ids.bob]: 'Bob', [ids.outsider]: 'Olive', [ids.departed]: 'Dee' };
  for (const id of Object.values(ids)) {
    await q("INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,'human',false)", [id, `${id}@example.test`, names[id]]);
    await q("INSERT INTO org_members(id,org_id,user_id,role,is_active) VALUES($1,$2,$3,'member',$4)", [randomUUID(), orgId, id, id !== ids.departed]);
  }
  const room = async (id: string, name: string, type: string, members: string[]) => {
    await q('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,$4,$5)', [id, orgId, name, type, ids.alice]);
    for (const user of members) await q('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), id, user]);
  };
  await room(rooms.general, 'general', 'private', [ids.alice, ids.bob, ids.departed]);
  await room(rooms.secret, 'secret', 'private', [ids.alice]);
  await room(rooms.dm, 'alice-bob', 'dm', [ids.alice, ids.bob]);
  seeded = true;
});

after(async () => {
  env.PUSH_MESSAGE_PREVIEWS_ENABLED = originalPreviewsEnabled;
  if (seeded && client) {
    await q('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [orgId]);
    for (const table of ['attention_deliveries', 'attention_events', 'attention_items', 'messages', 'spaces', 'org_members']) {
      await q(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]);
    }
    await q('DELETE FROM orgs WHERE id=$1', [orgId]);
    await q('DELETE FROM users WHERE id=ANY($1::text[])', [Object.values(ids)]);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

test('a mention shows the sender, the room and a preview of the message', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const id = await message(rooms.general, ids.alice, '<p>Can you review the <strong>launch</strong> plan?</p>');
  const payload = await payloadFor(ids.bob, { type: 'message', id });
  assert.equal(payload.title, 'Alice Example in #general');
  assert.equal(payload.body, 'Can you review the launch plan?');
  assert.deepEqual(Object.keys(payload).sort(), ['attention_id', 'body', 'tag', 'title', 'url']);
});

test('a direct message shows the sender only', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const id = await message(rooms.dm, ids.alice, 'Lunch at one?');
  const payload = await payloadFor(ids.bob, { type: 'message', id }, 'message');
  assert.equal(payload.title, 'Alice Example');
  assert.equal(payload.body, 'Lunch at one?');
});

test('existing subscribers keep generic text unless the operator opts in', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const id = await message(rooms.general, ids.alice, 'Only show this after opt-in');
  env.PUSH_MESSAGE_PREVIEWS_ENABLED = false;
  try {
    assert.equal((await payloadFor(ids.bob, { type: 'message', id })).body, GENERIC);
  } finally {
    env.PUSH_MESSAGE_PREVIEWS_ENABLED = true;
  }
});

test('a recipient who cannot read the message gets the generic text', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const id = await message(rooms.secret, ids.alice, 'Private numbers: 42');
  const payload = await payloadFor(ids.outsider, { type: 'message', id });
  assert.equal(payload.body, GENERIC);
  assert.equal(payload.title, 'Alice mentioned you');
  assert.equal(JSON.stringify(payload).includes('Private numbers'), false);

  const left = await message(rooms.general, ids.alice, 'Said after you left');
  await q('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [rooms.general, ids.bob]);
  try {
    assert.equal((await payloadFor(ids.bob, { type: 'message', id: left })).body, GENERIC, 'access is checked at sending time');
  } finally {
    await q('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), rooms.general, ids.bob]);
  }

  const departed = await message(rooms.general, ids.alice, 'For a departed member');
  assert.equal((await payloadFor(ids.departed, { type: 'message', id: departed })).body, GENERIC, 'an inactive member gets no preview');
});

test('a deleted message gets the generic text', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const id = await message(rooms.general, ids.alice, 'Oops, wrong room', true);
  const payload = await payloadFor(ids.bob, { type: 'message', id });
  assert.equal(payload.body, GENERIC);
  assert.equal(JSON.stringify(payload).includes('Oops'), false);
});

test('long text is cut to about 100 characters', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const id = await message(rooms.general, ids.alice, `<p>${'word '.repeat(80)}</p>`);
  const payload = await payloadFor(ids.bob, { type: 'message', id });
  assert.ok(Array.from(payload.body).length <= 100, payload.body);
  assert.ok(payload.body.endsWith('…'));
  assert.ok(payload.body.startsWith('word word'));
});

test('a thread reply whose source is the recipient\'s own message, and non-message kinds, stay generic', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const own = await message(rooms.general, ids.bob, 'My own question');
  assert.equal((await payloadFor(ids.bob, { type: 'message', id: own })).body, GENERIC);
  assert.equal((await payloadFor(ids.bob, { type: 'agent_action', id: randomUUID() }, 'approval')).body, GENERIC);
  assert.equal((await payloadFor(ids.bob, { type: 'task', id: randomUUID() }, 'task_assigned')).body, GENERIC);
});
