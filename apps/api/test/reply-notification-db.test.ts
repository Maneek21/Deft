/**
 * Text that outlives its message, part two.
 *
 *   - "X replied to your message": the notification's body is the reply's
 *     text, but its link opens the parent. It now names the reply, so
 *     deleting the reply removes the text from the notification list, the
 *     inbox, the outside-agent inbox tool and the needs-you list. A row
 *     written before that names no reply and returns no reply text at all.
 *   - Link previews are fetched after the response: a message deleted in the
 *     meantime gets no preview and the space is told nothing.
 *   - The newer mention check and the needs-you list agree with the space
 *     check on archived public spaces: readable by people in them only.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/reply-notification-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before, mock } from 'node:test';
import { createServer } from 'node:http';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import pg from 'pg';
import { closeDb, db } from '../src/lib/db.js';
import { syncNotificationToAttention, upsertAttentionItem, filterVisibleAttentionItems } from '../src/lib/attention.js';
import { setupSocket } from '../src/socket.js';
import { humanAttentionList, humanAttentionAcknowledge, humanAttentionSnooze, humanAttentionResolve, humanInboxList, humanInboxMarkRead, humanMessagePost, humanSendMessage, type HumanToolContext } from '../src/lib/mcp-tools/human.js';
import { handleBlockedAlert } from '../src/workers/handlers/blocked-alert.js';
import * as notificationDelivery from '../src/lib/notification-delivery.js';
const { emitVisibleNotification } = notificationDelivery;
import { nativeSourceAccessSql } from '../src/lib/native-mention-visibility.js';
import { withoutUnverifiableReplyText } from '../src/lib/reply-notification-text.js';
import { storeLinkPreviews } from '../src/routes/messages.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const orgId = randomUUID();
const ids = { alice: randomUUID(), bob: randomUUID(), carol: randomUUID() };
const S = { room: randomUUID(), pub: randomUUID() };
let client: pg.Client | undefined;
let unavailable = url ? '' : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
let seeded = false;
let app: Hono | undefined;

async function call(actor: string, method: string, path: string, body?: unknown) {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('user', { id: actor, org_id: orgId, email: `${actor}@example.test`, sid: `reply-${actor}`, role: 'member' } as any);
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

const ctx = (user: string): HumanToolContext => ({
  org_id: orgId, user_id: user, role: 'member', scopes: ['read:messages', 'write:messages', 'read:workspace', 'write:workspace', 'read:wiki'], principal_kind: 'human',
} as HumanToolContext);
const toolText = (result: { content: Array<{ text: string }> }) => result.content.map((part) => part.text).join('\n');

/** The four places a notification's text can be read from, as text. */
async function places(actor: string): Promise<Record<string, string>> {
  const web = async (path: string) => { const r = await call(actor, 'GET', path); return `${r.status} ${r.text}`; };
  return {
    notifications: await web('/api/notifications'),
    inbox: await web('/api/inbox?include_read=1'),
    inbox_tool: toolText(await humanInboxList({ unread_only: false }, ctx(actor)) as any),
    needs_you: await web('/api/attention'),
    needs_you_tool: toolText(await humanAttentionList({}, ctx(actor)) as any),
  };
}

async function post(actor: string, space: string, content: string, parentId?: string): Promise<string> {
  const response = await call(actor, 'POST', `/api/messages/${space}`, parentId ? { content, parent_id: parentId } : { content });
  assert.equal(response.status, 201, response.text);
  return response.json.id as string;
}

before(async () => {
  if (unavailable) return;
  client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); } catch (error) { unavailable = String(error); return; }
  const q = (text: string, values: unknown[]) => client!.query(text, values);
  await q('INSERT INTO orgs(id,name,slug) VALUES($1,$2,$3)', [orgId, 'Reply notifications', `reply-notifications-${orgId}`]);
  for (const [name, id] of Object.entries(ids)) {
    await q(`INSERT INTO users(id,email,name,kind,is_agent) VALUES($1,$2,$3,'human',false)`, [id, `${id}@example.test`, name]);
    await q(`INSERT INTO org_members(id,org_id,user_id,role) VALUES($1,$2,$3,'member')`, [randomUUID(), orgId, id]);
  }
  // `room` is private (Alice and Bob); `pub` is public (Bob only: Carol and Alice have not joined).
  for (const [id, type, members] of [[S.room, 'private', [ids.alice, ids.bob]], [S.pub, 'public', [ids.bob]]] as const) {
    await q('INSERT INTO spaces(id,org_id,name,type,created_by) VALUES($1,$2,$3,$4,$5)', [id, orgId, `${type}-${id}`, type, ids.bob]);
    for (const member of members) await q('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), id, member]);
  }
  app = new Hono()
    .route('/api/messages', (await import('../src/routes/messages.js')).messageRoutes)
    .route('/api/notifications', (await import('../src/routes/notifications.js')).notificationRoutes)
    .route('/api/inbox', (await import('../src/routes/inbox.js')).inboxRoutes)
    .route('/api/attention', (await import('../src/routes/attention.js')).attentionRoutes);
  seeded = true;
});

after(async () => {
  if (seeded && client) {
    await client.query('DELETE FROM job_queue WHERE org_id=$1', [orgId]).catch(() => undefined);
    for (const table of ['oauth_audit_events', 'attention_events', 'attention_items', 'notifications', 'agent_actions', 'agent_nudges', 'tasks', 'projects']) {
      await client.query(`DELETE FROM ${table} WHERE org_id=$1`, [orgId]).catch(() => undefined);
    }
    await client.query('DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE org_id=$1)', [orgId]);
    await client.query('UPDATE messages SET parent_id=NULL WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM messages WHERE org_id=$1', [orgId]).catch(() => undefined);
    await client.query('DELETE FROM spaces WHERE org_id=$1', [orgId]).catch(() => undefined);
    await client.query('DELETE FROM org_members WHERE org_id=$1', [orgId]);
    await client.query('DELETE FROM orgs WHERE id=$1', [orgId]).catch(() => undefined);
    await client.query('DELETE FROM users WHERE id=ANY($1::text[])', [Object.values(ids)]).catch(() => undefined);
  }
  await client?.end().catch(() => undefined);
  await closeDb();
});

test('Alice posts, Bob replies "secret", Bob deletes the reply: the text is gone from all four places', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const parent = await post(ids.alice, S.room, 'Where shall we meet?');
  const reply = await post(ids.bob, S.room, 'CANARY-SECRET at the usual place', parent);

  // The notification names the reply, although its link opens the parent.
  const stored = await client!.query(`SELECT body, link, metadata FROM notifications WHERE org_id=$1 AND user_id=$2`, [orgId, ids.alice]);
  assert.equal(stored.rows.length, 1, JSON.stringify(stored.rows));
  assert.equal(stored.rows[0].metadata.message_id, reply);
  assert.equal(stored.rows[0].metadata.space_id, S.room);
  assert.ok(stored.rows[0].link.includes(`message=${parent}`));

  const before = await places(ids.alice);
  for (const [place, text] of Object.entries(before)) assert.ok(text.includes('CANARY-SECRET'), `${place} should show the reply while it exists: ${text}`);

  const deleted = await call(ids.bob, 'DELETE', `/api/messages/${reply}`);
  assert.equal(deleted.status, 200, deleted.text);

  const afterDelete = await places(ids.alice);
  for (const [place, text] of Object.entries(afterDelete)) assert.ok(!text.includes('CANARY-SECRET'), `${place} still returns the deleted reply's text: ${text}`);
  // Nothing was rewritten: the row still holds the text, it is simply not returned.
  const kept = await client!.query(`SELECT body FROM notifications WHERE org_id=$1 AND user_id=$2`, [orgId, ids.alice]);
  assert.ok(kept.rows[0].body.includes('CANARY-SECRET'));
  // A second reply to the same thread shows up again in one needs-you entry.
  await post(ids.bob, S.room, 'CANARY-SECOND thought', parent);
  const again = await places(ids.alice);
  assert.ok(again.needs_you.includes('CANARY-SECOND') && !again.needs_you.includes('CANARY-SECRET'), again.needs_you);
});

test('a reply notification written before the reply was named returns no reply text', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const parent = await post(ids.alice, S.room, 'An older question');
  const live = await post(ids.bob, S.room, 'A live mention target');
  const insert = async (title: string, body: string, messageId: string) => {
    const [row] = await db.execute(sql`
      INSERT INTO notifications(id, org_id, user_id, type, title, body, link)
      VALUES (${randomUUID()}, ${orgId}, ${ids.alice}, 'mention', ${title}, ${body}, ${`/chat?space=${S.room}&message=${messageId}`})
      RETURNING *`).then((result: any) => result.rows ?? result);
    await syncNotificationToAttention({ ...row, created_at: new Date(row.created_at), updated_at: new Date(row.updated_at) } as any, { deliver: false });
  };
  // Shape of the rows written before this change: reply text in the body, the parent in the link, no metadata.
  await insert('bob replied to your message', 'CANARY-LEGACY reply text', parent);
  // An ordinary mention names the message its text comes from, and is unaffected.
  await insert('bob mentioned you', 'CANARY-MENTION text', live);

  const seen = await places(ids.alice);
  for (const [place, text] of Object.entries(seen)) {
    assert.ok(!text.includes('CANARY-LEGACY'), `${place} returns reply text that cannot be tied to a reply: ${text}`);
    assert.ok(text.includes('CANARY-MENTION'), `${place} should still show an ordinary mention: ${text}`);
  }
  // The notice itself stays, with its title and link.
  assert.ok(seen.notifications.includes('bob replied to your message'));
  assert.ok(seen.needs_you.includes('bob replied to your message'));

  // The helper only touches reply notices that name no reply.
  const row = { title: 'bob replied to your message', body: 'text', metadata: { message_id: 'm1' } };
  assert.equal(withoutUnverifiableReplyText(row), row);
  assert.equal(withoutUnverifiableReplyText({ title: 'bob replied to your message', body: 'text', metadata: null }).body, null);
  assert.equal(withoutUnverifiableReplyText({ title: 'bob mentioned you', body: 'text', metadata: null }).body, 'text');
});

test('link previews are not stored or announced for a message deleted while they were fetched', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const sent: Array<[string, string]> = [];
  const io = { to: (room: string) => ({ emit: (event: string) => { sent.push([room, event]); return true; } }) };
  const previews = [{ url: 'https://example.test/a', title: 'CANARY-PREVIEW', description: null, image: null, favicon: null, siteName: null }];
  const live = await post(ids.bob, S.room, 'a message that stays');
  const gone = await post(ids.bob, S.room, 'a message that is deleted');
  assert.equal((await call(ids.bob, 'DELETE', `/api/messages/${gone}`)).status, 200);

  assert.equal(await storeLinkPreviews(io, S.room, live, previews), true);
  assert.equal(await storeLinkPreviews(io, S.room, gone, previews), false);
  assert.deepEqual(sent, [[`space:${S.room}`, 'message:link_previews']]);
  const rows = await client!.query('SELECT id, metadata FROM messages WHERE id=ANY($1::text[])', [[live, gone]]);
  const metadata = Object.fromEntries(rows.rows.map((row) => [row.id, row.metadata]));
  assert.equal(metadata[live].link_previews[0].title, 'CANARY-PREVIEW');
  assert.ok(!JSON.stringify(metadata[gone] ?? null).includes('CANARY-PREVIEW'));
});

test('an archived public space: the newer mention check and the needs-you list are for people in it only', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const message = await post(ids.bob, S.pub, 'CANARY-PUBLIC note');
  const mayRead = async (user: string) => {
    const result: any = await db.execute(sql`SELECT ${nativeSourceAccessSql(user, sql`'message'`, sql`${message}`, sql`${orgId}`)} AS ok`);
    return Boolean((result.rows ?? result)[0].ok);
  };
  for (const user of [ids.carol, ids.bob]) {
    await upsertAttentionItem({
      orgId, userId: user, kind: 'mention', lane: 'needs_you', priority: 'normal', dedupeKey: `archived-test:${user}`,
      sourceType: 'message', sourceId: message, sourceEventId: `archived-test:${user}`, title: 'A note for you', body: 'CANARY-PUBLIC note',
      link: `/chat?space=${S.pub}&message=${message}`,
    }, { deliver: false });
  }
  // Public and live: Carol has not joined, and may read it; Bob is in it.
  assert.deepEqual([await mayRead(ids.carol), await mayRead(ids.bob)], [true, true]);
  assert.ok((await places(ids.carol)).needs_you.includes('CANARY-PUBLIC'));

  await client!.query('UPDATE spaces SET is_archived=true WHERE id=$1', [S.pub]);
  assert.deepEqual([await mayRead(ids.carol), await mayRead(ids.bob)], [false, true]);
  const carol = await places(ids.carol);
  assert.ok(!carol.needs_you.includes('CANARY-PUBLIC') && !carol.needs_you_tool.includes('CANARY-PUBLIC'), carol.needs_you);
  assert.ok((await places(ids.bob)).needs_you.includes('CANARY-PUBLIC'));
});

test('blocked-alert attention copies lose their message excerpt after deletion or private-space exit', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const revoke of ['delete', 'leave']) {
    const message = await post(ids.bob, S.room, `CANARY-BLOCKED-${revoke.toUpperCase()}`);
    const result = await client!.query(`INSERT INTO notifications(id,org_id,user_id,type,title,body,link,metadata)
      VALUES($1,$2,$3,'agent_suggestion','Blocked Team Member',$4,$5,$6) RETURNING *`,
    [randomUUID(), orgId, ids.alice, `CANARY-BLOCKED-${revoke.toUpperCase()}`, `/chat?space=${S.room}&message=${message}`, JSON.stringify({ task_id: randomUUID(), nudge_type: 'blocked' })]);
    await syncNotificationToAttention(result.rows[0], { deliver: false });
    assert.ok((await places(ids.alice)).needs_you.includes(`CANARY-BLOCKED-${revoke.toUpperCase()}`));
    try {
      if (revoke === 'delete') await call(ids.bob, 'DELETE', `/api/messages/${message}`);
      else await client!.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [S.room, ids.alice]);
      for (const [place, text] of Object.entries(await places(ids.alice))) {
        assert.ok(!text.includes(`CANARY-BLOCKED-${revoke.toUpperCase()}`), `${place} leaks after ${revoke}: ${text}`);
      }
    } finally {
      if (revoke === 'leave') await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), S.room, ids.alice]);
    }
  }
});

test('inbox mark-read replays recheck the source after deletion and private-space exit', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const revoke of ['delete', 'leave']) {
    const parent = await post(ids.alice, S.room, 'Question for a retry');
    const reply = await post(ids.bob, S.room, 'CANARY-CACHED reply', parent);
    const { rows: [notice] } = await client!.query(`SELECT id FROM notifications WHERE org_id=$1 AND metadata->>'message_id'=$2`, [orgId, reply]);
    const args = { notification_id: notice.id, idempotency_key: randomUUID() };
    assert.ok(toolText(await humanInboxMarkRead(args, ctx(ids.alice)) as any).includes('CANARY-CACHED'));
    // A result cached by the old implementation has no target binding and contains the full body.
    await client!.query(`UPDATE oauth_audit_events SET metadata=(metadata - 'bind') || $3::jsonb
      WHERE org_id=$1 AND metadata->>'idempotency_key'=$2`, [orgId, args.idempotency_key,
      JSON.stringify({ result: { content: [{ type: 'text', text: 'CANARY-CACHED legacy result' }] } })]);
    try {
      if (revoke === 'delete') await call(ids.bob, 'DELETE', `/api/messages/${reply}`);
      else await client!.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2', [S.room, ids.alice]);
      const replay = await humanInboxMarkRead(args, ctx(ids.alice));
      assert.equal(replay.isError, true);
      assert.ok(!toolText(replay as any).includes('CANARY-CACHED'));
    } finally {
      if (revoke === 'leave') await client!.query('INSERT INTO space_members(id,space_id,user_id) VALUES($1,$2,$3)', [randomUUID(), S.room, ids.alice]);
    }
  }
});

test('delayed attention projection and revoked-source transitions emit no private or deleted body', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const server = createServer();
  const io = setupSocket(server);
  const emitted: Array<{ event: string; body: string }> = [];
  const stub = mock.method(io, 'to', () => ({ emit: (event: string, row: unknown) => { emitted.push({ event, body: JSON.stringify(row) }); } }) as any);
  try {
    const message = await post(ids.bob, S.room, 'A source that will disappear');
    const item = await upsertAttentionItem({ orgId, userId: ids.alice, kind: 'mention', lane: 'needs_you', priority: 'normal',
      dedupeKey: randomUUID(), sourceType: 'message', sourceId: message, sourceEventId: randomUUID(), title: 'Mention', body: 'CANARY-EMISSION',
    }, { deliver: false });
    assert.ok(emitted.some(row => row.body.includes('CANARY-EMISSION')));
    emitted.length = 0;
    await call(ids.bob, 'DELETE', `/api/messages/${message}`);
    await filterVisibleAttentionItems(ids.alice, [item!]);
    const { rows: [notice] } = await client!.query(`INSERT INTO notifications(id,org_id,user_id,type,title,body,link)
      VALUES($1,$2,$3,'mention','Delayed mention','CANARY-DELAYED',$4) RETURNING *`,
    [randomUUID(), orgId, ids.alice, `/chat?space=${S.room}&message=${message}`]);
    await syncNotificationToAttention(notice, { deliver: false });
    assert.ok(!emitted.some(row => row.body.includes('CANARY-EMISSION') || row.body.includes('CANARY-DELAYED')), JSON.stringify(emitted));
  } finally {
    stub.mock.restore();
    await new Promise<void>(resolve => io.close(() => resolve()));
  }
});

test('Attention retries reload the reused thread item instead of a deleted reply snapshot', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const transition of [humanAttentionAcknowledge, humanAttentionSnooze, humanAttentionResolve]) {
    const parent = await post(ids.alice, S.room, 'Attention retry parent');
    const reply = await post(ids.bob, S.room, 'CANARY-ATTENTION-DELETED', parent);
    const { rows: [item] } = await client!.query(`SELECT id FROM attention_items WHERE org_id=$1 AND metadata->>'message_id'=$2`, [orgId, reply]);
    const args = { attention_id: item.id, idempotency_key: randomUUID(), until: new Date(Date.now() + 86400000).toISOString() };
    const first = await transition(args, ctx(ids.alice));
    assert.ok(toolText(first as any).includes('CANARY-ATTENTION-DELETED'));
    // Keep compatibility with snapshots cached by the old implementation.
    await client!.query(`UPDATE oauth_audit_events SET metadata=jsonb_set(metadata,'{result}',$3::jsonb)
      WHERE org_id=$1 AND metadata->>'idempotency_key'=$2`, [orgId, args.idempotency_key, JSON.stringify(first)]);
    await call(ids.bob, 'DELETE', `/api/messages/${reply}`);
    await post(ids.bob, S.room, 'CANARY-ATTENTION-CURRENT', parent);
    const replay = await transition(args, ctx(ids.alice));
    assert.ok(!replay.isError, toolText(replay as any));
    assert.ok(!toolText(replay as any).includes('CANARY-ATTENTION-DELETED'));
    assert.ok(toolText(replay as any).includes('CANARY-ATTENTION-CURRENT'));
    assert.equal(JSON.parse(toolText(replay as any)).item.state, 'open_unseen', 'a retry must not reapply the old transition to the new reply');
  }
});

test('queued blocked alerts never deliver deleted text and quote the live source rather than the queue snapshot', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const project = randomUUID(), task = randomUUID();
  await client!.query(`INSERT INTO projects(id,org_id,name,prefix,lead_id) VALUES($1,$2,'Blocked alerts','BLA',$3)`, [project, orgId, ids.alice]);
  await client!.query(`INSERT INTO tasks(id,org_id,project_id,number,title,status,assignee_id,created_by) VALUES($1,$2,$3,1,'Blocked task','in_progress',$4,$5)`, [task, orgId, project, ids.bob, ids.alice]);
  const io = setupSocket(createServer());
  const emitted: string[] = [];
  const stub = mock.method(io, 'to', () => ({ emit: (_event: string, row: unknown) => { emitted.push(JSON.stringify(row)); } }) as any);
  try {
    for (const deleted of [true, false]) {
      await client!.query('DELETE FROM agent_nudges WHERE org_id=$1', [orgId]);
      const message = await post(ids.bob, S.room, 'CANARY-LIVE-BLOCKER');
      if (deleted) await call(ids.bob, 'DELETE', `/api/messages/${message}`);
      emitted.length = 0;
      await handleBlockedAlert({ id: randomUUID(), name: 'blocked-alert', attempts: 0,
        data: { orgId, userId: ids.bob, spaceId: S.room, messageId: message, content: 'CANARY-QUEUED-BLOCKER' } });
      assert.ok(!emitted.join('\n').includes('CANARY-QUEUED-BLOCKER'));
      assert.equal(emitted.some(text => text.includes('CANARY-LIVE-BLOCKER')), !deleted);
    }
  } finally {
    stub.mock.restore();
    await new Promise<void>(resolve => io.close(() => resolve()));
  }
});

test('MCP message-write retries cannot return cached deleted message text', async (t) => {
  if (unavailable) return t.skip(unavailable);
  for (const send of [humanMessagePost, humanSendMessage]) {
    const args = { space_id: S.room, content: 'CANARY-MCP-DELETED', idempotency_key: randomUUID() };
    const first = await send(args, ctx(ids.bob));
    assert.ok(!first.isError, toolText(first as any));
    const message = JSON.parse(toolText(first as any)).id;
    await client!.query(`UPDATE oauth_audit_events SET metadata=jsonb_set(metadata,'{result}',$3::jsonb)
      WHERE org_id=$1 AND metadata->>'idempotency_key'=$2`, [orgId, args.idempotency_key, JSON.stringify(first)]);
    assert.equal((await call(ids.bob, 'DELETE', `/api/messages/${message}`)).status, 200);
    const replay = await send(args, ctx(ids.bob));
    assert.ok(!toolText(replay as any).includes('CANARY-MCP-DELETED'));
    const count = await client!.query('SELECT count(*)::int AS n FROM messages WHERE id=$1', [message]);
    assert.equal(count.rows[0].n, 1, 'the retry did not create a replacement message');
  }
});

test('legacy socket delivery rechecks a notification source after it was created', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const message = await post(ids.bob, S.room, 'Socket source');
  const { rows: [notice] } = await client!.query(`INSERT INTO notifications(id,org_id,user_id,type,title,body,link)
    VALUES($1,$2,$3,'agent_suggestion','Blocked Team Member','CANARY-FINAL-SOCKET',$4) RETURNING *`,
  [randomUUID(), orgId, ids.alice, `/chat?space=${S.room}&message=${message}`]);
  const io = setupSocket(createServer());
  const emitted: string[] = [];
  const stub = mock.method(io, 'to', () => ({ emit: (_event: string, row: unknown) => { emitted.push(JSON.stringify(row)); } }) as any);
  try {
    assert.equal(await emitVisibleNotification(notice), true);
    assert.ok(emitted.join('\n').includes('CANARY-FINAL-SOCKET'));
    emitted.length = 0;
    await call(ids.bob, 'DELETE', `/api/messages/${message}`);
    assert.equal(await emitVisibleNotification(notice), false);
    assert.ok(!emitted.join('\n').includes('CANARY-FINAL-SOCKET'));
  } finally {
    stub.mock.restore();
    await new Promise<void>(resolve => io.close(() => resolve()));
  }
});

test('Attention delivery and filtering reject an older snapshot after its thread id is reused', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const oldSource = await post(ids.bob, S.room, 'CANARY-OLD-ATTENTION');
  const newSource = await post(ids.bob, S.room, 'Current Attention source');
  const effects: Array<() => Promise<void>> = [];
  const draft = { orgId, userId: ids.alice, kind: 'mention', lane: 'needs_you' as const, priority: 'normal' as const,
    dedupeKey: randomUUID(), sourceType: 'message', sourceId: oldSource, sourceEventId: randomUUID(),
    title: 'Reply', body: 'CANARY-OLD-ATTENTION' };
  const stale = await upsertAttentionItem(draft, { deliver: false, afterCommit: effect => effects.push(effect) });
  await call(ids.bob, 'DELETE', `/api/messages/${oldSource}`);
  const current = await upsertAttentionItem({ ...draft, sourceId: newSource, sourceEventId: randomUUID(), body: 'Current Attention body' }, { deliver: false });
  assert.equal(stale!.id, current!.id);
  const io = setupSocket(createServer());
  const emitted: string[] = [];
  const stub = mock.method(io, 'to', () => ({ emit: (_event: string, row: unknown) => { emitted.push(JSON.stringify(row)); } }) as any);
  try {
    for (const effect of effects) await effect();
    const filtered = await filterVisibleAttentionItems(ids.alice, [stale!]);
    assert.deepEqual({ leaked: emitted.some(text => text.includes('CANARY-OLD-ATTENTION')), staleRows: filtered.length },
      { leaked: false, staleRows: 0 });
    assert.equal((await filterVisibleAttentionItems(ids.alice, [current!])).length, 1, 'rejecting a stale snapshot must not resolve its replacement');
  } finally {
    stub.mock.restore();
    await new Promise<void>(resolve => io.close(() => resolve()));
  }
});

test('legacy notification fan-out uses one current-authority read for all recipients', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const source = await post(ids.bob, S.room, 'Fanout source');
  const notices = [];
  for (const recipient of [ids.alice, ids.carol]) {
    const { rows: [notice] } = await client!.query(`INSERT INTO notifications(id,org_id,user_id,type,title,body,metadata)
      VALUES($1,$2,$3,'message','Fanout','CANARY-FANOUT',$4) RETURNING *`,
    [randomUUID(), orgId, recipient, JSON.stringify({ message_id: source, space_id: S.room })]);
    notices.push(notice);
  }
  const io = setupSocket(createServer());
  const emitted: string[] = [];
  const stub = mock.method(io, 'to', () => ({ emit: (_event: string, row: unknown) => { emitted.push(JSON.stringify(row)); } }) as any);
  const select = db.select.bind(db);
  const reads = mock.method(db, 'select', select);
  try {
    const emitBatch = (notificationDelivery as any).emitVisibleNotifications;
    assert.equal(typeof emitBatch, 'function', 'fanout needs a shared batched visibility check');
    assert.equal(await emitBatch(notices), 1);
    assert.equal(reads.mock.callCount(), 1, 'authorization round trips must not grow with recipient count');
    assert.ok(emitted[0]?.includes(ids.alice));
    assert.ok(!emitted.join('\n').includes(ids.carol), 'a batch must authorize each recipient separately');
  } finally {
    reads.mock.restore(); stub.mock.restore();
    await new Promise<void>(resolve => io.close(() => resolve()));
  }
});
