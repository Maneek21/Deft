/**
 * A pushed notification for a chat message shows who it is from and a short
 * plain-text preview, built at the moment of sending and only for a recipient
 * who may read that message then. Everything else keeps the generic body.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';
import webpush from 'web-push';
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
    for (const table of ['web_push_subscriptions', 'attention_deliveries', 'attention_events', 'attention_items', 'messages', 'spaces', 'org_members']) {
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

test('queued sends combine opt-in preview text with a checked and pinned push endpoint', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { sendAttentionDelivery } = await import('../src/lib/web-push.js');
  const { protectPushSubscription } = await import('../src/lib/push-subscription.js');
  const { publicFetchDeps } = await import('../src/lib/public-http-fetch.js');
  const originalHosted = process.env.DEFT_HOSTED;
  const originalSettings = {
    VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: env.VAPID_SUBJECT,
    PUSH_MESSAGE_PREVIEWS_ENABLED: env.PUSH_MESSAGE_PREVIEWS_ENABLED,
  };
  t.after(() => {
    Object.assign(env, originalSettings);
    if (originalHosted === undefined) delete process.env.DEFT_HOSTED;
    else process.env.DEFT_HOSTED = originalHosted;
  });
  process.env.DEFT_HOSTED = 'true';
  const keys = webpush.generateVAPIDKeys();
  Object.assign(env, { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:push-test@example.test' });
  await q('UPDATE users SET notification_preferences=$1 WHERE id=$2', [
    { push: { enabled: true, chat: true } }, ids.bob,
  ]);
  const endpoint = 'https://fcm.googleapis.com/fcm/send/combined-test';
  const protectedSubscription = protectPushSubscription({ endpoint, p256dh: keys.publicKey, auth: 'abcdefghijklmnop' });
  await q('INSERT INTO web_push_subscriptions(id,org_id,user_id,endpoint,endpoint_hash,p256dh,auth) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), orgId, ids.bob, protectedSubscription.endpoint, protectedSubscription.endpoint_hash, protectedSubscription.p256dh, protectedSubscription.auth]);
  let address = '142.250.1.1';
  t.mock.method(publicFetchDeps, 'lookup', async () => [{ address, family: 4 }]);
  const sends: Array<{ body: string; title: string; endpoint: string; agent: unknown }> = [];
  t.mock.method(webpush, 'sendNotification', async (subscription, payload, options) => {
    sends.push({ ...JSON.parse(String(payload)), endpoint: subscription.endpoint, agent: options?.agent });
    return { statusCode: 201, body: '', headers: {} };
  });
  let queuedMessageId = '';
  const queue = async () => {
    const messageId = await message(rooms.general, ids.alice, 'Review the launch plan');
    queuedMessageId = messageId;
    const attention = await item(ids.bob, { type: 'message', id: messageId });
    const deliveryId = randomUUID();
    await q("INSERT INTO attention_deliveries(id,org_id,attention_item_id,user_id,channel) VALUES($1,$2,$3,$4,'push')",
      [deliveryId, orgId, attention.id, ids.bob]);
    return deliveryId;
  };
  for (const enabled of [true, false]) {
    env.PUSH_MESSAGE_PREVIEWS_ENABLED = enabled;
    assert.deepEqual(await sendAttentionDelivery(await queue()), { sent: 1, failed: 0 });
    const sent = sends.at(-1)!;
    assert.equal(sent.body, enabled ? 'Review the launch plan' : GENERIC);
    assert.equal(sent.title, enabled ? 'Alice Example in #general' : 'Alice mentioned you');
    assert.equal(sent.endpoint, endpoint);
    const agent = sent.agent as { options: { lookup: (host: string, options: object, callback: (...args: unknown[]) => void) => void } };
    const pinned = await new Promise<unknown[]>(resolve => agent.options.lookup('fcm.googleapis.com', {}, (...args) => resolve(args)));
    assert.deepEqual(pinned, [null, '142.250.1.1', 4]);
  }
  const deletionDuringDns = t.mock.method(publicFetchDeps, 'lookup', async () => {
    await q('UPDATE messages SET is_deleted=true WHERE id=$1', [queuedMessageId]);
    return [{ address: '142.250.1.1', family: 4 }];
  });
  try {
    env.PUSH_MESSAGE_PREVIEWS_ENABLED = true;
    assert.deepEqual(await sendAttentionDelivery(await queue()), { skipped: true, reason: 'source_access_revoked' });
    assert.equal(sends.length, 2, 'a source deleted during DNS must not deliver its retained preview');
  } finally { deletionDuringDns.mock.restore(); }
  address = '10.0.0.5';
  await assert.rejects(sendAttentionDelivery(await queue()), /push endpoint/i);
  assert.equal(sends.length, 2, 'a stored endpoint resolving internally is never contacted');
});
