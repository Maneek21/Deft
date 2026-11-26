/**
 * Documents in chat over HTTP (plan Task F13): posting a document into a
 * chat (POST /api/messages/:spaceId with `document_ids`), the document
 * cards a message shows (POST /api/documents/cards) and the chat's Docs tab
 * (GET /api/spaces/:id/documents).
 *
 * Rule C4 throughout: a document's title reaches only someone who can open
 * it. A posted message stores ids only (`metadata.documents = [{ id }]`), so
 * neither its answer, its live event (the same object) nor its notifications
 * carry a title; a card is null for a viewer who can't open the document, and
 * for an id that doesn't exist or belongs to another workspace, so the cards
 * can't be used to find out whether a document exists; a drive or folder
 * the viewer can't see is named null.
 *
 * The database client is wrapped, as in drives-read-snapshot-db.test.ts, to
 * record the options each transaction is opened with and each query started
 * on the pool itself: the Docs tab reads its authorization and each page of
 * its data in one read-only, repeatable-read transaction and nothing outside
 * it.
 *
 * `message:new` is observed on real Socket.io clients of the chat's members,
 * through the socket server (setupSocket) with a space-access check that
 * lets each member join the chat's room.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/chat-documents-http-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { after, before, mock, test } from 'node:test';
import { sql } from 'drizzle-orm';

const opened: Array<{ config: unknown; isolation: string | null }> = [];
const direct: string[] = [];
const actualDb = await import('../src/lib/db.js');
const realDb = actualDb.db;
const recordingDb = new Proxy(realDb, {
  get(target, prop) {
    if (prop === 'transaction') {
      return (run: (tx: any) => Promise<unknown>, config?: unknown) => target.transaction(async (tx: any) => {
        const result = await tx.execute(sql`SHOW transaction_isolation`);
        opened.push({ config: config ?? null, isolation: (result.rows[0] as { transaction_isolation?: string } | undefined)?.transaction_isolation ?? null });
        return run(tx);
      }, config as any);
    }
    if (prop === 'select' || prop === 'execute') direct.push(prop);
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
mock.module(new URL('../src/lib/db.ts', import.meta.url).href, { namedExports: { ...actualDb, db: recordingDb } });

const { documentRoutes } = await import('../src/routes/documents.js');
const { messageRoutes, storeLinkPreviews } = await import('../src/routes/messages.js');
const { spaceRoutes } = await import('../src/routes/spaces.js');
const { getIO, setupSocket } = await import('../src/socket.js');
const { io: connectSocket } = createRequire(new URL('../../web/package.json', import.meta.url))('socket.io-client');
const { setupDrivesFixture } = await import('./fixtures/drives-fixture.js');
const { safeTestDatabaseUrl } = await import('./fixtures/safe-test-database.js');

const url = safeTestDatabaseUrl();
const SKIP = 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
const SNAPSHOT = { isolationLevel: 'repeatable read', accessMode: 'read only' };
let fx: Awaited<ReturnType<typeof setupDrivesFixture>> | undefined;

before(async () => {
  if (!url) return;
  fx = await setupDrivesFixture('chat-documents-http', {
    routes: [
      { path: '/api/documents', app: documentRoutes },
      { path: '/api/messages', app: messageRoutes },
      { path: '/api/spaces', app: spaceRoutes },
    ],
  });
});

after(async () => {
  try {
    if (fx) {
      // Posting writes messages and their jobs, which the fixture doesn't know about.
      for (const org of [fx.orgId, fx.otherOrgId]) {
        await fx.client.query('DELETE FROM job_queue WHERE org_id = $1', [org]);
        await fx.client.query('DELETE FROM messages WHERE org_id = $1', [org]);
      }
    }
    await fx?.teardown();
  } finally {
    await actualDb.closeDb();
  }
});

async function json(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** `request` that asserts the status and returns the parsed body. */
async function call(userId: string, method: string, path: string, body: unknown, status: number): Promise<any> {
  const res = await fx!.request(userId, method, path, body);
  const parsed = await json(res);
  assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(parsed)}`);
  return parsed;
}

/** A private drive with `manager` at full, and a document in it called `title`. */
async function privateDocument(manager: string, title: string, driveName = `${title} drive`): Promise<{ drive: string; document: string }> {
  const drive = await fx!.insertDrive({ kind: 'private', name: driveName });
  await fx!.addDriveMember(drive, { user: manager }, 'full');
  return { drive, document: await fx!.insertDocument({ driveId: drive, title }) };
}

/** A document of the other workspace, inserted directly. */
async function foreignDocument(title: string): Promise<string> {
  const drive = randomUUID();
  const document = randomUUID();
  await fx!.client.query(`INSERT INTO drives (id, org_id, name, kind, default_role, created_by) VALUES ($1, $2, $3, 'open', 'edit', $4)`,
    [drive, fx!.otherOrgId, `Foreign ${title}`, fx!.people.outsider]);
  await fx!.client.query(`INSERT INTO documents (id, org_id, drive_id, title, content_json, content_text, size_bytes, created_by)
    VALUES ($1, $2, $3, $4, '{"type":"doc","content":[]}'::jsonb, '', 0, $5)`, [document, fx!.otherOrgId, drive, title, fx!.people.outsider]);
  return document;
}

/** A new private chat of the workspace with `members`, removed with the fixture. */
async function newChat(members: string[], name = 'chat'): Promise<string> {
  const id = randomUUID();
  await fx!.client.query('INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, $4, $5)',
    [id, fx!.orgId, `${name}-${id.slice(0, 8)}`, 'private', fx!.people.owner]);
  for (const user of members) await fx!.client.query('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), id, user]);
  return id;
}

/** Links `spaceId` to `driveId` at `role`, as POST /api/drives/:id/link-space writes it. */
async function linkChat(driveId: string, spaceId: string, role = 'edit') {
  await fx!.client.query(`INSERT INTO drive_members (id, org_id, drive_id, principal_type, principal_id, role, is_link, added_by)
    VALUES ($1, $2, $3, 'space', $4, $5, true, $6)`, [randomUUID(), fx!.orgId, driveId, spaceId, role, fx!.people.owner]);
}

/**
 * Socket.io clients for `people`, each joined to the room of `spaceId`,
 * recording every `message:new` they receive.
 */
async function chatSockets(spaceId: string, people: string[]) {
  const server = createServer();
  const principals = new Map(people.map((id) => [`token-${id}`, {
    id, email: `${id}@drives.test`, org_id: fx!.orgId, sid: `sid-${id}`, exp: Math.floor(Date.now() / 1000) + 600,
  }]));
  const sockets = setupSocket(server, {
    verifyAccess: async (token: string) => {
      const principal = principals.get(token);
      if (!principal) throw new Error('unknown token');
      return principal as any;
    },
    // The chat's members may join its room; nobody joins any other.
    getSpaceAccess: (async (id: string, user: { id: string }) => (id === spaceId && people.includes(user.id) ? { user_name: user.id } : undefined)) as any,
    recordLastSeen: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const clients: any[] = [];
  const received = new Map<string, any[]>();
  for (const id of people) {
    const client = connectSocket(`http://127.0.0.1:${port}`, { auth: { token: `token-${id}` }, transports: ['websocket'], reconnection: false });
    clients.push(client);
    const events: any[] = [];
    received.set(id, events);
    client.on('message:new', (data: unknown) => events.push(data));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`presence:init timed out for ${id}`)), 5_000);
      client.once('presence:init', () => { clearTimeout(timer); resolve(); });
    });
    client.emit('space:join', spaceId);
  }
  const deadline = Date.now() + 5_000;
  while ((await getIO()!.in(`space:${spaceId}`).fetchSockets()).length < people.length) {
    assert.ok(Date.now() < deadline, 'every member joined the chat’s room');
    await new Promise((r) => setTimeout(r, 10));
  }
  return {
    received: (id: string) => received.get(id)!,
    close: async () => {
      for (const client of clients) client.close();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    },
  };
}

async function waitUntil(cond: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), `timed out: ${label}`);
}

async function messagesWith(content: string): Promise<number> {
  const { rows: [row] } = await fx!.client.query('SELECT count(*)::int AS n FROM messages WHERE org_id = $1 AND content = $2', [fx!.orgId, content]);
  return row.n;
}

test('posting a document the poster can’t open is refused with 400 DOCUMENT_NOT_VISIBLE', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const hidden = await privateDocument(member2, 'Hidden plan F13-CANARY-HIDDEN');
  const open = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Open plan' });

  // A document the poster can't open, alone or beside one they can.
  for (const ids of [[hidden.document], [open, hidden.document]]) {
    const refused = await call(member, 'POST', `/api/messages/${fx.spaces.team}`, { content: 'Look at this', document_ids: ids }, 400);
    assert.equal(refused.code, 'DOCUMENT_NOT_VISIBLE');
    assert.doesNotMatch(JSON.stringify(refused), /F13-CANARY-HIDDEN/);
  }
  // An id that doesn't exist, or belongs to another workspace, answers the same.
  const foreign = await foreignDocument('Foreign plan');
  for (const ids of [[randomUUID()], [foreign]]) {
    const refused = await call(member, 'POST', `/api/messages/${fx.spaces.team}`, { content: 'Look at this', document_ids: ids }, 400);
    assert.equal(refused.code, 'DOCUMENT_NOT_VISIBLE');
  }
  // A deleted document too, even for someone who could open it before.
  const deleted = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Gone', deleted: true });
  assert.equal((await call(member, 'POST', `/api/messages/${fx.spaces.team}`, { content: 'Look at this', document_ids: [deleted] }, 400)).code,
    'DOCUMENT_NOT_VISIBLE');
  assert.equal(await messagesWith('Look at this'), 0, 'nothing was posted');

  // At most five documents.
  const six = await Promise.all(Array.from({ length: 6 }, (_, at) => fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: `Six ${at}` })));
  assert.equal((await call(member, 'POST', `/api/messages/${fx.spaces.team}`, { content: 'Six', document_ids: six }, 400)).code, 'VALIDATION_ERROR');
  assert.equal(await messagesWith('Six'), 0);
});

test('a posted document is stored as an id only: no title in the answer, the live event or the notifications', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const posted = await privateDocument(member2, 'Roadmap F13-CANARY-TITLE');
  const open = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Open F13-CANARY-OPEN' });

  const content = `Spec is ready ${randomUUID()}`;
  // member can't open the posted document; guest can open neither.
  const sockets = await chatSockets(fx.spaces.team, [member, member2, fx.people.guest]);
  let message: any;
  try {
    // The same id twice is posted once.
    message = await call(member2, 'POST', `/api/messages/${fx.spaces.team}`, { content, document_ids: [posted.document, open, posted.document] }, 201);
    assert.deepEqual(message.metadata, { documents: [{ id: posted.document }, { id: open }] });
    assert.doesNotMatch(JSON.stringify(message), /F13-CANARY/);
    // The live event each member received carries the ids and no title.
    for (const who of [member, member2, fx.people.guest]) {
      await waitUntil(() => sockets.received(who).some((event) => event?.id === message.id), `message:new for ${who}`);
      const event = sockets.received(who).find((item) => item?.id === message.id);
      assert.deepEqual(event.metadata, { documents: [{ id: posted.document }, { id: open }] });
      assert.doesNotMatch(JSON.stringify(event), /F13-CANARY/);
    }
  } finally {
    await sockets.close();
  }
  const { rows: [stored] } = await fx.client.query('SELECT metadata FROM messages WHERE id = $1', [message.id]);
  assert.deepEqual(stored.metadata, { documents: [{ id: posted.document }, { id: open }] });
  const { rows: notifications } = await fx.client.query(`SELECT title, body, metadata FROM notifications
    WHERE org_id = $1 AND metadata->>'message_id' = $2`, [fx.orgId, message.id]);
  assert.ok(notifications.length > 0, 'the chat’s members were notified');
  assert.doesNotMatch(JSON.stringify(notifications), /F13-CANARY/);
  // The member who can't open the posted document reads the message with its id, and gets a null card.
  const history = await call(member, 'GET', `/api/messages/${fx.spaces.team}`, undefined, 200);
  const listed = (history.messages ?? history).find((row: any) => row.id === message.id);
  assert.deepEqual(listed.metadata, { documents: [{ id: posted.document }, { id: open }] });
  const cards = await call(member, 'POST', '/api/documents/cards', { ids: [posted.document] }, 200);
  assert.deepEqual(cards.cards, { [posted.document]: null });
});

test('cards are null for a viewer who can’t open the document', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2, guest, outsider } = fx.people;
  const secret = await privateDocument(member2, 'Card F13-CANARY-CARD', 'Card drive F13-CANARY-DRIVE');
  const sharedToMember = await privateDocument(member2, 'Shared to member', 'Hidden home F13-CANARY-HOME');
  await fx.share(sharedToMember.document, { user: member }, 'comment');
  const open = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Open card' });
  const deleted = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Deleted card', deleted: true });
  const foreign = await foreignDocument('Foreign card');
  const unknown = randomUUID();
  const ids = [secret.document, sharedToMember.document, open, deleted, foreign, unknown];

  const forMember = await call(member, 'POST', '/api/documents/cards', { ids }, 200);
  assert.deepEqual(forMember.cards, {
    [secret.document]: null,
    // Shared with them, but its drive is hidden: no drive name.
    [sharedToMember.document]: { id: sharedToMember.document, title: 'Shared to member', icon: null, drive_name: null, role: 'comment' },
    [open]: { id: open, title: 'Open card', icon: null, drive_name: 'Workspace', role: 'edit' },
    [deleted]: null,
    [foreign]: null,
    [unknown]: null,
  });
  assert.doesNotMatch(JSON.stringify(forMember), /F13-CANARY/);

  const forOwner = await call(member2, 'POST', '/api/documents/cards', { ids: [secret.document] }, 200);
  assert.deepEqual(forOwner.cards, {
    [secret.document]: { id: secret.document, title: 'Card F13-CANARY-CARD', icon: null, drive_name: 'Card drive F13-CANARY-DRIVE', role: 'full' },
  });

  // A guest gets nothing from the open Workspace drive.
  const forGuest = await call(guest, 'POST', '/api/documents/cards', { ids: [open] }, 200);
  assert.deepEqual(forGuest.cards, { [open]: null });
  // Someone in the other workspace gets nothing of this one; the document of their own workspace's open drive is theirs.
  const forOutsider = await call(outsider, 'POST', '/api/documents/cards', { ids: [open, secret.document, foreign] }, 200);
  assert.deepEqual(forOutsider.cards, {
    [open]: null,
    [secret.document]: null,
    [foreign]: { id: foreign, title: 'Foreign card', icon: null, drive_name: 'Foreign Foreign card', role: 'edit' },
  });

  // At most 50 ids; a body that isn't a list of ids is 400.
  const fiftyOne = Array.from({ length: 51 }, () => randomUUID());
  assert.equal((await call(member, 'POST', '/api/documents/cards', { ids: fiftyOne }, 400)).code, 'VALIDATION_ERROR');
  assert.equal((await call(member, 'POST', '/api/documents/cards', { ids: fiftyOne.slice(0, 50) }, 200)).cards[fiftyOne[0]!], null);
  assert.equal((await call(member, 'POST', '/api/documents/cards', { ids: 'nope' }, 400)).code, 'VALIDATION_ERROR');
  const malformed = await fx.requestRaw(member, 'POST', '/api/documents/cards', '{"ids": [');
  assert.equal(malformed.status, 400);
});

test('the Docs tab lists the linked drive and the documents shared into the chat, with each viewer’s role', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2, guest, owner, outsider } = fx.people;
  const team = fx.spaces.team;

  // The team chat's linked drive, at edit.
  const linked = await fx.insertDrive({ kind: 'private', name: 'Design' });
  await fx.client.query(`INSERT INTO drive_members (id, org_id, drive_id, principal_type, principal_id, role, is_link, added_by)
    VALUES ($1, $2, $3, 'space', $4, 'edit', true, $5)`, [randomUUID(), fx.orgId, linked, team, owner]);

  // Shared into the chat: one from member2's private drive, in a folder (comment), one from the Workspace drive (view).
  const home = await fx.insertDrive({ kind: 'private', name: 'Engineering F13-CANARY-ENG' });
  await fx.addDriveMember(home, { user: member2 }, 'full');
  const folder = await fx.insertFolder({ driveId: home });
  const checkout = await fx.insertDocument({ driveId: home, folderId: folder, title: 'Checkout redesign' });
  await fx.share(checkout, { space: team }, 'comment');
  const planning = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Q1 planning' });
  await fx.share(planning, { space: team }, 'view');
  // Not listed: shared with another chat, or deleted.
  const elsewhere = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Elsewhere' });
  await fx.share(elsewhere, { space: fx.spaces.other }, 'view');
  const gone = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Gone' });
  await fx.share(gone, { space: team }, 'view');
  await fx.client.query('UPDATE documents SET is_deleted = true, deleted_at = now() WHERE id = $1', [gone]);

  const byId = (body: any) => Object.fromEntries(body.shared.map((row: any) => [row.id, row]));

  direct.length = 0;
  opened.length = 0;
  const forMember = await call(member, 'GET', `/api/spaces/${team}/documents`, undefined, 200);
  assert.equal(opened.length, 1, 'one transaction');
  assert.deepEqual(opened[0]!.config, SNAPSHOT, 'read only, repeatable read');
  assert.equal(opened[0]!.isolation, 'repeatable read');
  assert.deepEqual(direct, [], 'nothing is read outside the snapshot');
  assert.deepEqual(forMember.linked_drive, { id: linked, name: 'Design', role: 'edit' });
  assert.deepEqual(Object.keys(byId(forMember)).sort(), [checkout, planning].sort());
  // The member can't see Engineering: its drive and folder stay unnamed.
  assert.deepEqual(byId(forMember)[checkout], { id: checkout, title: 'Checkout redesign', home: { drive_name: null, folder_name: null }, role: 'comment' });
  // On the Workspace drive the member's own edit beats the chat's view.
  assert.deepEqual(byId(forMember)[planning], { id: planning, title: 'Q1 planning', home: { drive_name: 'Workspace', folder_name: null }, role: 'edit' });
  assert.doesNotMatch(JSON.stringify(forMember), /F13-CANARY/);

  const forMember2 = await call(member2, 'GET', `/api/spaces/${team}/documents`, undefined, 200);
  assert.deepEqual(byId(forMember2)[checkout], {
    id: checkout, title: 'Checkout redesign', home: { drive_name: 'Engineering F13-CANARY-ENG', folder_name: 'Folder' }, role: 'full',
  });

  // A guest gets only what the chat was given.
  const forGuest = await call(guest, 'GET', `/api/spaces/${team}/documents`, undefined, 200);
  assert.deepEqual(forGuest.linked_drive, { id: linked, name: 'Design', role: 'edit' });
  assert.deepEqual(byId(forGuest)[planning], { id: planning, title: 'Q1 planning', home: { drive_name: null, folder_name: null }, role: 'view' });
  assert.equal(byId(forGuest)[checkout].role, 'comment');

  // Another chat lists only what it was given, and has no linked drive.
  const other = await call(member2, 'GET', `/api/spaces/${fx.spaces.other}/documents`, undefined, 200);
  assert.equal(other.linked_drive, null);
  assert.deepEqual(other.shared.map((row: any) => row.id), [elsewhere]);

  // Membership of the chat is required: the owner isn't in it, the outsider is in another workspace.
  for (const who of [owner, outsider]) {
    opened.length = 0;
    const refused = await call(who, 'GET', `/api/spaces/${team}/documents`, undefined, 403);
    assert.equal(refused.code, 'FORBIDDEN');
    assert.doesNotMatch(JSON.stringify(refused), /Design|Checkout/);
  }
  assert.equal((await call(member, 'GET', `/api/spaces/${randomUUID()}/documents`, undefined, 403)).code, 'FORBIDDEN');

  // A linked drive the viewer can't open (frozen) isn't named.
  await fx.client.query('UPDATE drives SET frozen_at = now() WHERE id = $1', [linked]);
  assert.equal((await call(member, 'GET', `/api/spaces/${team}/documents`, undefined, 200)).linked_drive, null);
});

test('link previews keep the documents a message carries', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const document = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Previewed' });
  const message = await call(member, 'POST', `/api/messages/${fx.spaces.team}`, { content: `See the spec ${randomUUID()}`, document_ids: [document] }, 201);
  const previews = [{ url: 'https://example.test/spec', title: 'Spec', description: null, image: null, favicon: null, siteName: null }];
  const sent: string[] = [];
  const io = { to: (room: string) => ({ emit: (event: string) => { sent.push(`${room} ${event}`); } }) };
  assert.equal(await storeLinkPreviews(io, fx.spaces.team, message.id, previews), true);
  assert.deepEqual(sent, [`space:${fx.spaces.team} message:link_previews`]);
  const history = await call(member, 'GET', `/api/messages/${fx.spaces.team}`, undefined, 200);
  const listed = (history.messages ?? history).find((row: any) => row.id === message.id);
  assert.deepEqual(listed.metadata, { documents: [{ id: document }], link_previews: previews });
  // A second preview run replaces the previews and still keeps the documents.
  assert.equal(await storeLinkPreviews(io, fx.spaces.team, message.id, []), true);
  const { rows: [stored] } = await fx.client.query('SELECT metadata FROM messages WHERE id = $1', [message.id]);
  assert.deepEqual(stored.metadata, { documents: [{ id: document }], link_previews: [] });
});

test('the Docs tab pages through every document shared into a chat, 50 at a time, each page in one snapshot', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const chat = await newChat([member, member2], 'paged');
  // 101 documents, shared in one statement so the shares carry one timestamp (the tie-break decides), plus a deleted one.
  const ids: string[] = [];
  for (let at = 0; at < 101; at += 1) ids.push(await fx.insertDocument({ driveId: fx.workspaceDriveId, title: `Paged ${at}` }));
  const deleted = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Paged deleted', deleted: true });
  await fx.client.query(`INSERT INTO document_shares (id, org_id, document_id, principal_type, principal_id, role, shared_by)
    SELECT gen_random_uuid()::text, $1, doc, 'space', $2, 'view', $3 FROM unnest($4::text[]) AS doc`,
  [fx.orgId, chat, fx.people.owner, [...ids, deleted]]);

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    opened.length = 0;
    direct.length = 0;
    const path: string = `/api/spaces/${chat}/documents${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page: any = await call(member, 'GET', path, undefined, 200);
    assert.equal(opened.length, 1, 'one transaction per page');
    assert.deepEqual(opened[0]!.config, SNAPSHOT);
    assert.deepEqual(direct, [], 'nothing is read outside the snapshot');
    assert.ok(page.shared.length <= 50, `at most 50 a page: ${page.shared.length}`);
    seen.push(...page.shared.map((row: any) => row.id));
    cursor = page.next_cursor;
    pages += 1;
    assert.ok(pages <= 4, 'the pages end');
  } while (cursor);
  assert.equal(pages, 3, '50, 50 and 1');
  assert.equal(new Set(seen).size, seen.length, 'no document is listed twice');
  assert.deepEqual([...seen].sort(), [...ids].sort(), 'every document the member can open is reachable, and only those');

  // A cursor that isn't one the server issued is refused.
  assert.equal((await call(member, 'GET', `/api/spaces/${chat}/documents?cursor=nonsense`, undefined, 400)).code, 'VALIDATION_ERROR');
});

test('"Link a drive" is offered only when the chat has no link at all and the viewer holds full on a drive', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, guest } = fx.people;
  const manager = await fx.addPerson();
  const managed = await fx.insertDrive({ kind: 'private', name: 'Managed' });
  await fx.addDriveMember(managed, { user: manager }, 'full');
  const chat = await newChat([manager, member, guest], 'linkable');

  // No link yet: the manager may link one; the member and the guest hold full on no drive.
  assert.equal((await call(manager, 'GET', `/api/spaces/${chat}/documents`, undefined, 200)).can_link, true);
  assert.equal((await call(member, 'GET', `/api/spaces/${chat}/documents`, undefined, 200)).can_link, false);
  assert.equal((await call(guest, 'GET', `/api/spaces/${chat}/documents`, undefined, 200)).can_link, false);

  // The chat is linked to a drive nobody in it can open (frozen): the link stays hidden, and no link is offered.
  const hidden = await fx.insertDrive({ kind: 'private', name: 'Hidden link F13-CANARY-LINK' });
  await linkChat(hidden, chat);
  await fx.client.query('UPDATE drives SET frozen_at = now() WHERE id = $1', [hidden]);
  const afterLink = await call(manager, 'GET', `/api/spaces/${chat}/documents`, undefined, 200);
  assert.equal(afterLink.linked_drive, null);
  assert.equal(afterLink.can_link, false, 'a hidden link is never offered, so it never answers ALREADY_LINKED');
  assert.doesNotMatch(JSON.stringify(afterLink), /F13-CANARY/);
});
