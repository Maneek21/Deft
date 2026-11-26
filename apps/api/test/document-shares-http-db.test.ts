/**
 * Sharing a document with people and chats over HTTP (routes/documents.ts,
 * lib/document-shares.ts; plan Task F9): the share routes, the
 * `document_shared` notification and its Inbox and attention copies, the
 * `document:shared` socket event, the audience count for the posting prompt,
 * and the access-loss path (consult rule C3) for lowered and removed shares.
 *
 * As in drives-http-db.test.ts, an `onAccessLossInTx` hook registered once
 * for the file records each access loss with the id of the transaction it
 * ran in (`txid_current_if_assigned()`, set only inside a transaction that
 * has already written), so a recorded id shows the hook ran inside the
 * change's own transaction.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/document-shares-http-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import test, { after, before } from 'node:test';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { closeDb } from '../src/lib/db.js';
import { documentRoleFor } from '../src/lib/document-access.js';
import { onDocumentAccessChanged, type DocumentAccessChange } from '../src/lib/document-access-events.js';
import { currentAccessGeneration, onAccessLossInTx } from '../src/lib/document-access-change.js';
import { attentionRoutes } from '../src/routes/attention.js';
import { dashboardRoutes } from '../src/routes/dashboard.js';
import { documentRoutes } from '../src/routes/documents.js';
import { inboxRoutes } from '../src/routes/inbox.js';
import { notificationRoutes } from '../src/routes/notifications.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { socketHarness, waitFor } from './fixtures/drives-socket.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const SKIP = 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
const ROUTES = [
  { path: '/api/documents', app: documentRoutes },
  { path: '/api/notifications', app: notificationRoutes },
  { path: '/api/inbox', app: inboxRoutes },
  { path: '/api/dashboard', app: dashboardRoutes },
  { path: '/api/attention', app: attentionRoutes },
];
let fx: DrivesFixture | undefined;

const lossesInTx: Array<{ change: DocumentAccessChange; txid: string | null }> = [];
const accessChanges: DocumentAccessChange[] = [];
const unsubscribe: Array<() => void> = [];

before(async () => {
  if (!url) return;
  fx = await setupDrivesFixture('document-shares-http', { routes: ROUTES });
  onAccessLossInTx(async (tx, change) => {
    const result = await tx.execute(sql`SELECT txid_current_if_assigned()::text AS txid`);
    lossesInTx.push({ change, txid: (result.rows[0] as { txid: string | null }).txid });
    return [];
  });
  unsubscribe.push(onDocumentAccessChanged((change) => { accessChanges.push(change); }));
});

after(async () => {
  for (const stop of unsubscribe) stop();
  try {
    await fx?.teardown();
  } finally {
    await closeDb();
  }
});

function resetEvents() {
  lossesInTx.length = 0;
  accessChanges.length = 0;
}

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

/** A private drive with `manager` holding full access, and a document in it. */
async function documentOf(manager: string, title = 'Shared document'): Promise<{ drive: string; document: string }> {
  const drive = await fx!.insertDrive({ kind: 'private', name: `${title} drive` });
  await fx!.addDriveMember(drive, { user: manager }, 'full');
  return { drive, document: await fx!.insertDocument({ driveId: drive, title }) };
}

const share = (actor: string, document: string, principal: { user?: string; space?: string }, role: string, status = 201, extra: Record<string, unknown> = {}) =>
  call(actor, 'POST', `/api/documents/${document}/shares`, {
    principal_type: principal.user ? 'user' : 'space', principal_id: principal.user ?? principal.space, role, ...extra,
  }, status);

async function shareRows(document: string): Promise<Array<[string, string, string]>> {
  const { rows } = await fx!.client.query('SELECT principal_type, principal_id, role FROM document_shares WHERE document_id = $1 ORDER BY principal_id',
    [document]);
  return rows.map((row) => [row.principal_type, row.principal_id, row.role]);
}

async function shareIdOf(document: string, principalId: string): Promise<string> {
  const { rows: [row] } = await fx!.client.query('SELECT id FROM document_shares WHERE document_id = $1 AND principal_id = $2', [document, principalId]);
  assert.ok(row, `a share of ${document} to ${principalId}`);
  return row.id;
}

const roleOf = (userId: string, document: string) => documentRoleFor(userId, fx!.orgId, document);

/** The one hook call and emitted change a single access loss should produce. */
function assertOneLoss(expected: DocumentAccessChange, generationBefore: number) {
  assert.equal(lossesInTx.length, 1, `one applyAccessLossInTx call: ${JSON.stringify(lossesInTx)}`);
  assert.deepEqual(lossesInTx[0]!.change, expected);
  assert.ok(lossesInTx[0]!.txid, 'the hook ran inside the transaction that made the change');
  assert.ok(accessChanges.some((change) => isDeepStrictEqual(change, expected)), 'finishAccessLoss emitted the change');
  assert.ok(currentAccessGeneration() > generationBefore, 'the access generation moved');
}

async function lockHolder(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url!, connectionTimeoutMillis: 3000 });
  await client.connect();
  return client;
}

/** Waits until at least `n` backends of this database wait on a lock (a row, a transaction or an advisory lock). */
async function waitForLockWaiters(n: number, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows: [row] } = await fx!.client.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if (row.n >= n) return;
    assert.ok(Date.now() < deadline, `timed out waiting for ${n} lock waiter(s): ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function noticesFor(userId: string, document: string): Promise<Array<Record<string, any>>> {
  const { rows } = await fx!.client.query(`SELECT id, user_id, type, title, link, metadata FROM notifications
    WHERE org_id = $1 AND user_id = $2 AND metadata->>'document_id' = $3`, [fx!.orgId, userId, document]);
  return rows;
}

async function toldAbout(document: string): Promise<string[]> {
  const { rows } = await fx!.client.query(`SELECT user_id FROM notifications WHERE org_id = $1 AND metadata->>'document_id' = $2`,
    [fx!.orgId, document]);
  return rows.map((row) => row.user_id as string).sort();
}

// ── The brief's tests ───────────────────────────────────────────────────────

test('an editor shares with a person at up to can edit; full is refused with 400 ROLE_TOO_HIGH', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const { drive, document } = await documentOf(member, 'Editor shares');
  await fx.addDriveMember(drive, { user: member2 }, 'edit');
  const [toEdit, toComment, toView, toFull] = [await fx.addPerson(), await fx.addPerson(), await fx.addPerson(), await fx.addPerson()];
  const shared = (await share(member2, document, { user: toEdit }, 'edit')).share;
  assert.equal(shared.principal_type, 'user');
  assert.equal(shared.principal_id, toEdit);
  assert.equal(shared.role, 'edit');
  assert.equal(shared.document_id, document);
  assert.equal(shared.shared_by, member2);
  await share(member2, document, { user: toComment }, 'comment');
  await share(member2, document, { user: toView }, 'view');
  assert.equal(await roleOf(toEdit, document), 'edit');
  assert.equal(await roleOf(toComment, document), 'comment');
  assert.equal(await roleOf(toView, document), 'view');
  const refused = await share(member2, document, { user: toFull }, 'full', 400);
  assert.equal(refused.code, 'ROLE_TOO_HIGH');
  assert.equal(await roleOf(toFull, document), null);
  assert.equal((await share(member2, document, { user: toEdit }, 'view', 409)).code, 'ALREADY_SHARED', 'a second share to the same person');
  assert.equal((await share(member2, document, { user: toEdit }, 'owner', 400)).code, 'VALIDATION_ERROR');
  // PATCH refuses full too.
  const row = await shareIdOf(document, toView);
  assert.equal((await call(member2, 'PATCH', `/api/documents/${document}/shares/${row}`, { role: 'full' }, 400)).code, 'ROLE_TOO_HIGH');
});

test("a commenter can't share (403)", async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2, admin } = fx.people;
  const { drive, document } = await documentOf(member, 'Commenter');
  await fx.addDriveMember(drive, { user: member2 }, 'comment');
  const target = await fx.addPerson();
  assert.equal((await share(member2, document, { user: target }, 'view', 403)).code, 'FORBIDDEN_ROLE');
  await share(member, document, { user: target }, 'view');
  const row = await shareIdOf(document, target);
  assert.equal((await call(member2, 'PATCH', `/api/documents/${document}/shares/${row}`, { role: 'edit' }, 403)).code, 'FORBIDDEN_ROLE');
  assert.equal((await call(member2, 'DELETE', `/api/documents/${document}/shares/${row}`, undefined, 403)).code, 'FORBIDDEN_ROLE');
  // Someone who can't see the document at all gets 404, an admin of the workspace included (a private drive).
  assert.equal((await share(admin, document, { user: target }, 'view', 404)).code, 'NOT_FOUND');
  assert.equal((await call(admin, 'DELETE', `/api/documents/${document}/shares/${row}`, undefined, 404)).code, 'NOT_FOUND');
  assert.deepEqual(await shareRows(document), [['user', target, 'view']]);
});

test('sharing with a chat gives its members access, including a guest in that chat', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2, guest, agentUser, outsider, owner } = fx.people;
  const { document } = await documentOf(member, 'Chat share');
  for (const person of [member2, guest, agentUser]) assert.equal(await roleOf(person, document), null, 'nobody in the chat sees it yet');
  await share(member, document, { space: fx.spaces.team }, 'comment');
  for (const person of [member2, guest, agentUser]) assert.equal(await roleOf(person, document), 'comment', `${person} can comment`);
  assert.equal(await roleOf(owner, document), null, 'the workspace owner is not in the chat');
  assert.equal(await documentRoleFor(outsider, fx.otherOrgId, document), null);
});

test('the person shared with gets a document_shared notification, an attention item they can see, and a document:shared socket event', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2, guest } = fx.people;
  const { document } = await documentOf(member, 'Told about it');
  const sockets = await socketHarness(fx.orgId, [member, member2, guest]);
  try {
    await share(member, document, { user: member2 }, 'view');
    const [notice] = await noticesFor(member2, document);
    assert.ok(notice, 'a notification for the person shared with');
    assert.equal(notice.type, 'document_shared');
    assert.equal(notice.link, `/d/${document}`);
    assert.equal(notice.metadata.document_id, document);
    assert.equal(notice.metadata.subtype, 'document_share');
    assert.ok(String(notice.title).includes('Told about it'));
    assert.deepEqual(await noticesFor(member, document), [], 'never the sharer');
    // The notification list shows it.
    const listed = await call(member2, 'GET', '/api/notifications', undefined, 200);
    assert.ok((listed.notifications as any[]).some((row) => row.id === notice.id));
    // The Inbox lists it as a system item.
    const inbox = await call(member2, 'GET', '/api/inbox?kind=system', undefined, 200);
    assert.ok((inbox.items as any[]).some((item) => item.id === `notif:${notice.id}` && item.kind === 'system'));
    // Its attention item is a document item, deduped per document and person, and the person sees it.
    const { rows: [item] } = await fx.client.query(`SELECT id, source_type, source_id, dedupe_key FROM attention_items
      WHERE org_id = $1 AND user_id = $2 AND metadata->>'legacy_notification_id' = $3`, [fx.orgId, member2, notice.id]);
    assert.ok(item, 'an attention item');
    assert.equal(item.source_type, 'document');
    assert.equal(item.source_id, document);
    assert.equal(item.dedupe_key, `document_shared:${document}:${member2}`);
    const attention = await call(member2, 'GET', '/api/attention?lane=updates', undefined, 200);
    assert.ok((attention.items as any[]).some((row) => row.id === item.id), 'the attention item is shown');
    // The socket event goes to the person shared with only.
    await waitFor(() => sockets.received(member2, 'document:shared').length > 0, 'document:shared for member2');
    assert.deepEqual(sockets.received(member2, 'document:shared'), [{ document_id: document }]);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(sockets.received(member, 'document:shared'), [], 'not the sharer');
    assert.deepEqual(sockets.received(guest, 'document:shared'), [], 'not someone else');
    // The live notification and attention item pass their own visibility checks
    // (the recipient as a column of the statement: notification-delivery.ts).
    assert.ok(sockets.received(member2, 'notification:new').some((row) => row.id === notice.id), 'notification:new');
    assert.ok(sockets.received(member2, 'attention:new').some((row) => row.id === item.id), 'attention:new');
    assert.deepEqual(sockets.received(guest, 'notification:new').filter((row) => row.id === notice.id), []);
  } finally {
    await sockets.close();
  }
});

test('removing a share takes access away and emits an access change', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const { document } = await documentOf(member, 'Taken away');
  await share(member, document, { user: member2 }, 'edit');
  assert.equal(await roleOf(member2, document), 'edit');
  const row = await shareIdOf(document, member2);
  resetEvents();
  const generation = currentAccessGeneration();
  await call(member, 'DELETE', `/api/documents/${document}/shares/${row}`, undefined, 200);
  assert.equal(await roleOf(member2, document), null);
  assertOneLoss({ orgId: fx.orgId, documentIds: [document], userIds: [member2] }, generation);
  assert.deepEqual(await shareRows(document), []);
  assert.equal((await call(member, 'DELETE', `/api/documents/${document}/shares/${row}`, undefined, 404)).code, 'NOT_FOUND');
  // A chat share's removal names the chat.
  await share(member, document, { space: fx.spaces.team }, 'view');
  const chatRow = await shareIdOf(document, fx.spaces.team);
  resetEvents();
  const chatGeneration = currentAccessGeneration();
  await call(member, 'DELETE', `/api/documents/${document}/shares/${chatRow}`, undefined, 200);
  assertOneLoss({ orgId: fx.orgId, documentIds: [document], spaceId: fx.spaces.team }, chatGeneration);
  assert.equal(await roleOf(fx.people.guest, document), null);
});

test("GET audience counts chat members who can't open the document, and how many are guests", async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2, guest, owner } = fx.people;
  const { drive, document } = await documentOf(member, 'Posting prompt');
  const audience = (userId: string, status = 200, space = fx!.spaces.team) =>
    call(userId, 'GET', `/api/documents/${document}/audience?space_id=${space}`, undefined, status);
  // The team chat: member (can open), member2, guest and the agent (can't).
  assert.deepEqual(await audience(member), { cannot_open: 3, guests: 1, can_share: true });
  await share(member, document, { user: guest }, 'view');
  assert.deepEqual(await audience(member), { cannot_open: 2, guests: 0, can_share: true });
  // A viewer in the chat sees the counts but can't share.
  await fx.addDriveMember(drive, { user: member2 }, 'view');
  assert.deepEqual(await audience(member2), { cannot_open: 1, guests: 0, can_share: false });
  // Not in the chat: refused. Can't see the document: 404.
  assert.equal((await audience(member, 403, fx.spaces.other)).code, 'SPACE_MEMBERSHIP_REQUIRED');
  assert.equal((await audience(owner, 404)).code, 'NOT_FOUND');
  assert.equal((await call(member, 'GET', `/api/documents/${document}/audience`, undefined, 400)).code, 'VALIDATION_ERROR');
});

// ── The consult's added tests ───────────────────────────────────────────────

test('a document_shared notification leaves the list and the count once access is lost', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const { document } = await documentOf(member, 'Lost again');
  await share(member, document, { user: member2 }, 'view');
  const [notice] = await noticesFor(member2, document);
  assert.ok(notice);
  const state = async () => {
    const list = await call(member2, 'GET', '/api/notifications', undefined, 200);
    const inbox = await call(member2, 'GET', '/api/inbox?kind=system', undefined, 200);
    const inboxCount = await call(member2, 'GET', '/api/inbox?kind=system&count_only=1', undefined, 200);
    const dashboard = await call(member2, 'GET', '/api/dashboard', undefined, 200);
    const attention = await call(member2, 'GET', '/api/attention?lane=updates', undefined, 200);
    return {
      listed: (list.notifications as any[]).some((row) => row.id === notice.id),
      unread: list.unread_count as number,
      inInbox: (inbox.items as any[]).some((item) => item.id === `notif:${notice.id}`),
      inboxUnread: inboxCount.unread_count as number,
      dashboardUnread: dashboard.unread_notifications as number,
      attention: (attention.items as any[]).some((item) => item.source_type === 'document' && item.source_id === document),
    };
  };
  const shown = await state();
  assert.deepEqual([shown.listed, shown.inInbox, shown.attention], [true, true, true], 'shown while member2 can view it');
  await call(member, 'DELETE', `/api/documents/${document}/shares/${await shareIdOf(document, member2)}`, undefined, 200);
  const lost = await state();
  assert.deepEqual([lost.listed, lost.inInbox, lost.attention], [false, false, false], 'gone once access is lost');
  assert.equal(lost.unread, shown.unread - 1, 'the notification list count');
  assert.equal(lost.inboxUnread, shown.inboxUnread - 1, 'the Inbox count');
  assert.equal(lost.dashboardUnread, shown.dashboardUnread - 1, 'the dashboard count');
});

test("a viewer can't list shares", async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2, owner } = fx.people;
  const { drive, document } = await documentOf(member, 'Share list');
  await share(member, document, { user: member2 }, 'view');
  assert.equal(await roleOf(member2, document), 'view');
  assert.equal((await call(member2, 'GET', `/api/documents/${document}/shares`, undefined, 403)).code, 'FORBIDDEN_ROLE');
  assert.equal((await call(owner, 'GET', `/api/documents/${document}/shares`, undefined, 404)).code, 'NOT_FOUND');
  await fx.addDriveMember(drive, { user: member2 }, 'comment');
  assert.equal((await call(member2, 'GET', `/api/documents/${document}/shares`, undefined, 403)).code, 'FORBIDDEN_ROLE', 'a commenter neither');
  const listed = await call(member, 'GET', `/api/documents/${document}/shares`, undefined, 200);
  assert.deepEqual(listed.shares.map((row: any) => [row.principal_type, row.principal_id, row.role, row.name]), [['user', member2, 'view', 'member2']]);
});

test('a guest sharer sees only people they share a chat with', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2, guest } = fx.people;
  const { document } = await documentOf(member, 'Guest edits');
  const stranger = await fx.addPerson();
  await fx.client.query('UPDATE users SET name = $2 WHERE id = $1', [stranger, 'Stranger Name']);
  await share(member, document, { user: guest }, 'edit');
  await share(member, document, { user: member2 }, 'view');
  await share(member, document, { user: stranger }, 'view');
  await share(member, document, { space: fx.spaces.team }, 'view');
  // member2 shared it with their private chat (member isn't in it, so can't); the fixture records the owner as sharer.
  await fx.share(document, { space: fx.spaces.other }, 'view');
  const ids = {
    guest: await shareIdOf(document, guest), member2: await shareIdOf(document, member2), stranger: await shareIdOf(document, stranger),
    team: await shareIdOf(document, fx.spaces.team), other: await shareIdOf(document, fx.spaces.other),
  };
  /** The share list as `viewer` sees it, by share id: [principal_id, name, shared_by]. */
  const listAs = async (viewer: string) => new Map(((await call(viewer, 'GET', `/api/documents/${document}/shares`, undefined, 200)).shares as any[])
    .map((row) => [row.id, [row.principal_id, row.name, row.shared_by]]));
  const asGuest = await listAs(guest);
  assert.deepEqual(asGuest.get(ids.member2), [member2, 'member2', member], 'someone in a chat with the guest, shared by someone in one too');
  assert.deepEqual(asGuest.get(ids.guest), [guest, 'guest', member], 'themselves');
  // Minor 4 (fix round 1): someone hidden from the guest is hidden whole: no name, no id.
  assert.deepEqual(asGuest.get(ids.stranger), [null, null, member], 'nobody the guest shares a chat with');
  assert.equal(asGuest.get(ids.team)?.[0], fx.spaces.team);
  assert.ok(String(asGuest.get(ids.team)?.[1]).startsWith('team-'), 'a chat the guest is in');
  assert.deepEqual(asGuest.get(ids.other), [null, null, null], 'a private chat the guest is not in, shared by someone they can’t see');
  const asMember = await listAs(member);
  assert.deepEqual(asMember.get(ids.stranger), [stranger, 'Stranger Name', member], 'a member sees everyone');
  assert.deepEqual(asMember.get(ids.other), [null, null, fx.people.owner], 'the member is not in the other private chat either');
  // A guest can't share with someone they can't see: the same answer as someone who doesn't exist.
  assert.equal((await share(guest, document, { user: await fx.addPerson() }, 'view', 400)).code, 'PRINCIPAL_CANNOT_HOLD_ACCESS');
  assert.equal((await share(guest, document, { user: randomUUID() }, 'view', 400)).code, 'PRINCIPAL_CANNOT_HOLD_ACCESS');
});

test('include sub-pages shares the whole tree', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const { drive, document } = await documentOf(member, 'Tree root');
  const child = await fx.insertDocument({ driveId: drive, parentDocumentId: document, title: 'Child' });
  const grandchild = await fx.insertDocument({ driveId: drive, parentDocumentId: child, title: 'Grandchild' });
  const trashed = await fx.insertDocument({ driveId: drive, parentDocumentId: document, title: 'Trashed', deleted: true });
  const body = await share(member, document, { user: member2 }, 'comment');
  assert.equal(body.shared_subpages, 2);
  assert.equal(body.skipped_subpages, 0);
  for (const page of [document, child, grandchild]) assert.equal(await roleOf(member2, page), 'comment', `${page} is shared`);
  assert.deepEqual(await shareRows(trashed), [], 'a trashed sub-page is not shared');
  // A sub-page made later starts with its parent's shares (F5).
  const later = (await call(member, 'POST', '/api/documents', { parent_document_id: child, title: 'Later' }, 201)).document.id as string;
  assert.equal(await roleOf(member2, later), 'comment');
  // Only one notification, for the page shared.
  assert.equal((await toldAbout(document)).length, 1);
  assert.deepEqual(await toldAbout(child), []);
});

// ── Ruling 1: locks, eligibility, lowering, the access-loss path ───────────

test('a share to someone who can never hold access is refused with 400 PRINCIPAL_CANNOT_HOLD_ACCESS', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, outsider } = fx.people;
  const { document } = await documentOf(member, 'Cannot hold');
  const noEmployeeAgent = await fx.addPerson({ kind: 'agent' });
  const systemUser = await fx.addPerson({ kind: 'system' });
  const inactive = await fx.addPerson({ active: false });
  for (const [label, nobody] of [['an agent user with no employee (as Defty)', noEmployeeAgent], ['a system user', systemUser],
    ['an inactive member', inactive], ['a member of another workspace', outsider], ['nobody', randomUUID()]] as const) {
    assert.equal((await share(member, document, { user: nobody }, 'view', 400)).code, 'PRINCIPAL_CANNOT_HOLD_ACCESS', label);
  }
  // A chat of another workspace, and a chat that doesn't exist.
  const foreignChat = randomUUID();
  await fx.client.query(`INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, 'foreign', 'public', $3)`, [foreignChat, fx.otherOrgId, outsider]);
  assert.equal((await share(member, document, { space: foreignChat }, 'view', 400)).code, 'PRINCIPAL_CANNOT_HOLD_ACCESS');
  assert.equal((await share(member, document, { space: randomUUID() }, 'view', 400)).code, 'PRINCIPAL_CANNOT_HOLD_ACCESS');
  // A private chat the sharer can't read.
  assert.equal((await share(member, document, { space: fx.spaces.other }, 'view', 400)).code, 'PRINCIPAL_CANNOT_HOLD_ACCESS');
  assert.deepEqual(await shareRows(document), []);
});

test('lowering a share is allowed after its recipient lost eligibility; raising it is refused', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const { document } = await documentOf(member, 'Stale share');
  const person = await fx.addPerson();
  await share(member, document, { user: person }, 'comment');
  const row = await shareIdOf(document, person);
  await fx.client.query('UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2', [fx.orgId, person]);
  assert.equal((await call(member, 'PATCH', `/api/documents/${document}/shares/${row}`, { role: 'edit' }, 400)).code, 'PRINCIPAL_CANNOT_HOLD_ACCESS');
  assert.deepEqual(await shareRows(document), [['user', person, 'comment']]);
  resetEvents();
  const generation = currentAccessGeneration();
  assert.equal((await call(member, 'PATCH', `/api/documents/${document}/shares/${row}`, { role: 'view' }, 200)).share.role, 'view');
  assertOneLoss({ orgId: fx.orgId, documentIds: [document], userIds: [person] }, generation);
  await call(member, 'DELETE', `/api/documents/${document}/shares/${row}`, undefined, 200);
  assert.deepEqual(await shareRows(document), []);
});

test('raising a share emits an access change without the loss path; the same role changes nothing', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const { document } = await documentOf(member, 'Raised');
  const created = await share(member, document, { space: fx.spaces.team }, 'view');
  assert.ok(accessChanges.some((change) => isDeepStrictEqual(change, { orgId: fx!.orgId, documentIds: [document], spaceId: fx!.spaces.team })),
    'a new share emits the access change');
  const row = created.share.id as string;
  resetEvents();
  assert.equal((await call(member, 'PATCH', `/api/documents/${document}/shares/${row}`, { role: 'edit' }, 200)).share.role, 'edit');
  assert.deepEqual(lossesInTx, [], 'no access loss for a raise');
  assert.deepEqual(accessChanges, [{ orgId: fx.orgId, documentIds: [document], spaceId: fx.spaces.team }]);
  assert.equal(await roleOf(member2, document), 'edit');
  resetEvents();
  await call(member, 'PATCH', `/api/documents/${document}/shares/${row}`, { role: 'edit' }, 200);
  assert.deepEqual([lossesInTx, accessChanges], [[], []], 'nothing changed, nothing emitted');
  // A share of another document can't be reached through this one.
  const other = await documentOf(member, 'Other document');
  assert.equal((await call(member, 'PATCH', `/api/documents/${other.document}/shares/${row}`, { role: 'view' }, 404)).code, 'NOT_FOUND');
  assert.equal((await call(member, 'DELETE', `/api/documents/${other.document}/shares/${row}`, undefined, 404)).code, 'NOT_FOUND');
});

test('a recipient deactivated while a share waits on their rows is refused', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const { document } = await documentOf(member, 'Leaving recipient');
  const leaving = await fx.addPerson();
  const holder = await lockHolder();
  try {
    await holder.query('BEGIN');
    await holder.query('UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2', [fx.orgId, leaving]);
    let settled = false;
    const pending = fx.request(member, 'POST', `/api/documents/${document}/shares`, { principal_type: 'user', principal_id: leaving, role: 'view' })
      .finally(() => { settled = true; });
    await waitForLockWaiters(1, 'the share waits on the recipient’s membership row');
    assert.equal(settled, false);
    await holder.query('COMMIT');
    const res = await pending;
    const body = await json(res);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(body.code, 'PRINCIPAL_CANNOT_HOLD_ACCESS');
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    await holder.end();
  }
  assert.deepEqual(await shareRows(document), []);
});

test('a chat archived while a share to it waits refuses an unjoined reader; a member of the chat can still share it', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const reader = await fx.addPerson();
  const { document } = await documentOf(reader, 'Unjoined reader');
  const holder = await lockHolder();
  try {
    await holder.query('BEGIN');
    await holder.query('UPDATE spaces SET is_archived = true WHERE id = $1', [fx.spaces.team]);
    let settled = false;
    const pending = fx.request(reader, 'POST', `/api/documents/${document}/shares`, { principal_type: 'space', principal_id: fx.spaces.team, role: 'view' })
      .finally(() => { settled = true; });
    await waitForLockWaiters(1, 'the share waits on the chat row');
    assert.equal(settled, false);
    await holder.query('COMMIT');
    const res = await pending;
    const body = await json(res);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(body.code, 'PRINCIPAL_CANNOT_HOLD_ACCESS', 'an archived chat is unreadable to someone who never joined it');
    assert.deepEqual(await shareRows(document), []);
    // A member of the archived chat still shares with it (an archived chat keeps granting its members, rule C7).
    const memberDocument = (await documentOf(member, 'Member shares the archived chat')).document;
    await share(member, memberDocument, { space: fx.spaces.team }, 'view');
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    await holder.end();
    await fx.client.query('UPDATE spaces SET is_archived = false WHERE id = $1', [fx.spaces.team]);
  }
  // Unarchived, the unjoined reader of the public chat may share with it.
  await share(reader, document, { space: fx.spaces.team }, 'view');
});

test('a share waits for a move holding the document’s drive, then answers 409 CONFLICT', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const { drive, document } = await documentOf(member, 'Moving away');
  const target = await fx.insertDrive({ kind: 'private', name: 'Move target' });
  await fx.addDriveMember(target, { user: member }, 'full');
  const holder = await lockHolder();
  try {
    await holder.query('BEGIN');
    // As moveDocument does: both drives FOR UPDATE in id order, then the document.
    await holder.query('SELECT id FROM drives WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [[drive, target]]);
    await holder.query('UPDATE documents SET drive_id = $2 WHERE id = $1', [document, target]);
    let settled = false;
    const pending = fx.request(member, 'POST', `/api/documents/${document}/shares`, { principal_type: 'user', principal_id: member2, role: 'view' })
      .finally(() => { settled = true; });
    await waitForLockWaiters(1, 'the share waits on the drive row');
    assert.equal(settled, false);
    await holder.query('COMMIT');
    const res = await pending;
    const body = await json(res);
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(body.code, 'CONFLICT');
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    await holder.end();
  }
  assert.deepEqual(await shareRows(document), []);
  await share(member, document, { user: member2 }, 'view');
});

// ── Ruling 2: the notification branch ──────────────────────────────────────

test('a notification naming a document follows the document, whether or not it also names a drive; one naming only a drive keeps the drive check', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  // member2 can open `visible` (a share) but not its drive; can view `driveVisible` but not `hidden` in it.
  const { drive: hiddenDrive, document: visible } = await documentOf(member, 'Visible by share');
  await share(member, visible, { user: member2 }, 'view');
  const viewDrive = await fx.insertDrive({ kind: 'private', name: 'member2 views this drive' });
  await fx.addDriveMember(viewDrive, { user: member }, 'full');
  await fx.addDriveMember(viewDrive, { user: member2 }, 'view');
  const hidden = await fx.insertDocument({ driveId: hiddenDrive, title: 'Hidden' });
  const deleted = await fx.insertDocument({ driveId: viewDrive, title: 'Deleted', deleted: true });
  const ids = { docAndHiddenDrive: randomUUID(), hiddenDocAndDrive: randomUUID(), docOnly: randomUUID(), hiddenDocOnly: randomUUID(),
    driveOnly: randomUUID(), hiddenDriveOnly: randomUUID(), deletedDoc: randomUUID() };
  const insert = (id: string, metadata: Record<string, string>) => fx!.client.query(`INSERT INTO notifications (id, org_id, user_id, type, title, metadata)
    VALUES ($1, $2, $3, 'system', 'A notice', $4::jsonb)`, [id, fx!.orgId, member2, JSON.stringify(metadata)]);
  await insert(ids.docAndHiddenDrive, { document_id: visible, drive_id: hiddenDrive });
  await insert(ids.hiddenDocAndDrive, { document_id: hidden, drive_id: viewDrive });
  await insert(ids.docOnly, { document_id: visible });
  await insert(ids.hiddenDocOnly, { document_id: hidden });
  await insert(ids.driveOnly, { drive_id: viewDrive });
  await insert(ids.hiddenDriveOnly, { drive_id: hiddenDrive });
  await insert(ids.deletedDoc, { document_id: deleted, drive_id: viewDrive });
  const expected = new Map([
    [ids.docAndHiddenDrive, true], [ids.hiddenDocAndDrive, false], [ids.docOnly, true], [ids.hiddenDocOnly, false],
    [ids.driveOnly, true], [ids.hiddenDriveOnly, false], [ids.deletedDoc, false],
  ]);
  const listed = new Set(((await call(member2, 'GET', '/api/notifications', undefined, 200)).notifications as any[]).map((row) => row.id));
  for (const [id, shown] of expected) assert.equal(listed.has(id), shown, `${[...Object.entries(ids)].find(([, v]) => v === id)![0]}`);
  // The counts follow: list, Inbox and dashboard each count exactly the shown ones.
  const before = {
    list: (await call(member2, 'GET', '/api/notifications', undefined, 200)).unread_count as number,
    inbox: (await call(member2, 'GET', '/api/inbox?kind=system&count_only=1', undefined, 200)).unread_count as number,
    dashboard: (await call(member2, 'GET', '/api/dashboard', undefined, 200)).unread_notifications as number,
  };
  await fx.client.query('DELETE FROM notifications WHERE id = ANY($1::text[])', [[...expected.keys()]]);
  const after = {
    list: (await call(member2, 'GET', '/api/notifications', undefined, 200)).unread_count as number,
    inbox: (await call(member2, 'GET', '/api/inbox?kind=system&count_only=1', undefined, 200)).unread_count as number,
    dashboard: (await call(member2, 'GET', '/api/dashboard', undefined, 200)).unread_notifications as number,
  };
  const shownCount = [...expected.values()].filter(Boolean).length;
  assert.deepEqual(before, { list: after.list + shownCount, inbox: after.inbox + shownCount, dashboard: after.dashboard + shownCount });
});

// ── Ruling 3: sub-pages the actor can't edit ───────────────────────────────

test('include sub-pages skips the sub-pages the sharer can’t edit and counts them; off, only the page is shared', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const { drive, document } = await documentOf(member, 'Share-only editor');
  const editable = await fx.insertDocument({ driveId: drive, parentDocumentId: document, title: 'Editable child' });
  const readOnly = await fx.insertDocument({ driveId: drive, parentDocumentId: document, title: 'View-only child' });
  const unseen = await fx.insertDocument({ driveId: drive, parentDocumentId: editable, title: 'Unseen grandchild' });
  // member2's edit comes only from shares.
  await fx.share(document, { user: member2 }, 'edit');
  await fx.share(editable, { user: member2 }, 'edit');
  await fx.share(readOnly, { user: member2 }, 'view');
  const target = await fx.addPerson();
  const body = await share(member2, document, { user: target }, 'view');
  assert.equal(body.shared_subpages, 1);
  // Minor 1 (fix round 1): only the sub-page member2 can view is counted; the unseen one isn't revealed.
  assert.equal(body.skipped_subpages, 1);
  assert.equal(await roleOf(target, document), 'view');
  assert.equal(await roleOf(target, editable), 'view');
  assert.equal(await roleOf(target, readOnly), null, 'a sub-page the sharer can only view');
  assert.equal(await roleOf(target, unseen), null, 'a sub-page the sharer can’t see');
  // Off: only the page.
  const other = await fx.addPerson();
  const off = await share(member, document, { user: other }, 'comment', 201, { include_subpages: false });
  assert.deepEqual([off.shared_subpages, off.skipped_subpages], [0, 0]);
  assert.equal(await roleOf(other, document), 'comment');
  assert.equal(await roleOf(other, editable), null);
  // A sub-page that already gives at least the role keeps it; a lower one is raised.
  await fx.share(editable, { user: other }, 'edit');
  await fx.share(readOnly, { user: other }, 'view');
  await call(member, 'DELETE', `/api/documents/${document}/shares/${await shareIdOf(document, other)}`, { include_subpages: false }, 200);
  const again = await share(member, document, { user: other }, 'comment');
  assert.equal(again.shared_subpages, 2, 'the view share raised, and the unseen grandchild shared');
  assert.equal(again.skipped_subpages, 0);
  assert.deepEqual((await shareRows(editable)).filter(([, id]) => id === other), [['user', other, 'edit']], 'not lowered');
  assert.deepEqual((await shareRows(readOnly)).filter(([, id]) => id === other), [['user', other, 'comment']], 'raised');
});

// ── Ruling 5: who is told ───────────────────────────────────────────────────

test('a direct share tells the named person, an agent included; a chat share tells only its humans, never the sharer', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { agentUser, guest, member, member2 } = fx.people;
  const { document } = await documentOf(member, 'Told directly');
  await share(member, document, { user: agentUser }, 'view');
  assert.deepEqual(await toldAbout(document), [agentUser], 'an agent with an active employee, named directly');
  const chatDocument = (await documentOf(member2, 'Told by chat')).document;
  const sockets = await socketHarness(fx.orgId, [member, member2, guest, agentUser]);
  try {
    await share(member2, chatDocument, { space: fx.spaces.team }, 'view');
    assert.deepEqual(await toldAbout(chatDocument), [member, guest].sort(), 'the humans in the chat, apart from the sharer');
    await waitFor(() => sockets.received(guest, 'document:shared').length > 0 && sockets.received(member, 'document:shared').length > 0,
      'document:shared for the chat');
    assert.deepEqual(sockets.received(guest, 'document:shared'), [{ document_id: chatDocument }]);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(sockets.received(member2, 'document:shared'), [], 'not the sharer');
  } finally {
    await sockets.close();
  }
});

test('document:shared reaches only the new recipients, not the document’s other viewers', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2, guest } = fx.people;
  const { drive, document } = await documentOf(member, 'Other viewers');
  await fx.addDriveMember(drive, { user: member2 }, 'view');
  const sockets = await socketHarness(fx.orgId, [member, member2, guest]);
  try {
    await share(member, document, { user: guest }, 'view');
    await waitFor(() => sockets.received(guest, 'document:shared').length > 0, 'document:shared for the guest');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(sockets.received(member2, 'document:shared'), [], 'a drive viewer is not a new recipient');
  } finally {
    await sockets.close();
  }
});

// ── Requests ────────────────────────────────────────────────────────────────

test('malformed JSON is refused with 400 VALIDATION_ERROR before anything changes', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const { document } = await documentOf(member, 'Malformed');
  const raw = async (method: string, path: string, body: string) => {
    const res = await fx!.requestRaw(member, method, path, body);
    assert.equal(res.status, 400, `${method} ${path}`);
    assert.equal((await json(res)).code, 'VALIDATION_ERROR');
  };
  await raw('POST', `/api/documents/${document}/shares`, '{"principal_type":"user",');
  await share(member, document, { user: member2 }, 'comment');
  const row = await shareIdOf(document, member2);
  await raw('PATCH', `/api/documents/${document}/shares/${row}`, '{"role":');
  await raw('DELETE', `/api/documents/${document}/shares/${row}`, 'not json');
  assert.deepEqual(await shareRows(document), [['user', member2, 'comment']]);
});

test('the share routes answer a document of another workspace with 404', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, outsider } = fx.people;
  const { document } = await documentOf(member, 'Foreign reader');
  await share(member, document, { user: fx.people.member2 }, 'view');
  const row = await shareIdOf(document, fx.people.member2);
  assert.equal((await call(outsider, 'GET', `/api/documents/${document}/shares`, undefined, 404)).code, 'NOT_FOUND');
  assert.equal((await call(outsider, 'POST', `/api/documents/${document}/shares`, { principal_type: 'user', principal_id: outsider, role: 'view' }, 404)).code, 'NOT_FOUND');
  assert.equal((await call(outsider, 'PATCH', `/api/documents/${document}/shares/${row}`, { role: 'edit' }, 404)).code, 'NOT_FOUND');
  assert.equal((await call(outsider, 'DELETE', `/api/documents/${document}/shares/${row}`, undefined, 404)).code, 'NOT_FOUND');
  assert.equal((await call(outsider, 'GET', `/api/documents/${document}/audience?space_id=${fx.spaces.team}`, undefined, 404)).code, 'NOT_FOUND');
});

// ── Fix round 1 ─────────────────────────────────────────────────────────────

test('removing or lowering a page’s share does the same on the sub-pages the actor can edit, in one access loss; the rest are skipped and keep theirs', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const { drive, document } = await documentOf(member, 'Unshared tree');
  const child = await fx.insertDocument({ driveId: drive, parentDocumentId: document, title: 'Child' });
  const grandchild = await fx.insertDocument({ driveId: drive, parentDocumentId: child, title: 'Grandchild' });
  const guarded = await fx.insertDocument({ driveId: drive, parentDocumentId: document, title: 'View-only for member2' });
  const hidden = await fx.insertDocument({ driveId: drive, parentDocumentId: child, title: 'Hidden from member2' });
  // member2's edit comes only from shares: edit on the page, child and grandchild; view on `guarded`; nothing on `hidden`.
  for (const page of [document, child, grandchild]) await fx.share(page, { user: member2 }, 'edit');
  await fx.share(guarded, { user: member2 }, 'view');
  const person = await fx.addPerson();
  const shared = await share(member, document, { user: person }, 'edit');
  assert.equal(shared.shared_subpages, 4);
  const tree = [document, child, grandchild, guarded, hidden];
  const roles = () => Promise.all(tree.map((page) => roleOf(person, page)));
  assert.deepEqual(await roles(), ['edit', 'edit', 'edit', 'edit', 'edit']);
  const row = shared.share.id as string;
  const affected = [document, ...[child, grandchild].sort()];

  resetEvents();
  let generation = currentAccessGeneration();
  const lowered = await call(member2, 'PATCH', `/api/documents/${document}/shares/${row}`, { role: 'view' }, 200);
  assert.equal(lowered.share.role, 'view');
  assert.equal(lowered.lowered_subpages, 2);
  assert.equal(lowered.skipped_subpages, 1, 'the view-only sub-page; the hidden one is not counted');
  assert.deepEqual(await roles(), ['view', 'view', 'view', 'edit', 'edit'], 'lowered where member2 can edit, kept elsewhere');
  assertOneLoss({ orgId: fx.orgId, documentIds: affected, userIds: [person] }, generation);

  resetEvents();
  generation = currentAccessGeneration();
  const removed = await call(member2, 'DELETE', `/api/documents/${document}/shares/${row}`, undefined, 200);
  assert.equal(removed.removed_subpages, 2);
  assert.equal(removed.skipped_subpages, 1);
  assert.deepEqual(await roles(), [null, null, null, 'edit', 'edit'], 'removed where member2 can edit, kept elsewhere');
  assertOneLoss({ orgId: fx.orgId, documentIds: affected, userIds: [person] }, generation);
});

test('unsharing a page shared with its sub-pages takes every sub-page away; include_subpages false touches the page only; a raise touches the page only', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, guest } = fx.people;
  const { drive, document } = await documentOf(member, 'Chat tree');
  const child = await fx.insertDocument({ driveId: drive, parentDocumentId: document, title: 'Child' });
  const grandchild = await fx.insertDocument({ driveId: drive, parentDocumentId: child, title: 'Grandchild' });
  const pages = [document, child, grandchild];
  const roles = () => Promise.all(pages.map((page) => roleOf(guest, page)));
  const team = { space: fx.spaces.team };
  await share(member, document, team, 'comment');
  assert.deepEqual(await roles(), ['comment', 'comment', 'comment']);
  const removed = await call(member, 'DELETE', `/api/documents/${document}/shares/${await shareIdOf(document, fx.spaces.team)}`, undefined, 200);
  assert.deepEqual([removed.removed_subpages, removed.skipped_subpages], [2, 0]);
  assert.deepEqual(await roles(), [null, null, null], 'every sub-page is unshared too');
  for (const page of pages) assert.deepEqual(await shareRows(page), []);

  // Off: only the page.
  await share(member, document, team, 'edit');
  let row = await shareIdOf(document, fx.spaces.team);
  const lowered = await call(member, 'PATCH', `/api/documents/${document}/shares/${row}`, { role: 'view', include_subpages: false }, 200);
  assert.deepEqual([lowered.lowered_subpages, lowered.skipped_subpages], [0, 0]);
  assert.deepEqual(await roles(), ['view', 'edit', 'edit']);
  const kept = await call(member, 'DELETE', `/api/documents/${document}/shares/${row}`, { include_subpages: false }, 200);
  assert.deepEqual([kept.removed_subpages, kept.skipped_subpages], [0, 0]);
  assert.deepEqual(await roles(), [null, 'edit', 'edit']);

  // A raise changes the page only: raising across the tree is POST's job.
  await share(member, document, team, 'view', 201, { include_subpages: false });
  row = await shareIdOf(document, fx.spaces.team);
  await call(member, 'DELETE', `/api/documents/${child}/shares/${await shareIdOf(child, fx.spaces.team)}`, { include_subpages: false }, 200);
  await share(member, child, team, 'view', 201, { include_subpages: false });
  const raised = await call(member, 'PATCH', `/api/documents/${document}/shares/${row}`, { role: 'comment' }, 200);
  assert.deepEqual([raised.share.role, raised.lowered_subpages, raised.skipped_subpages], ['comment', 0, 0]);
  assert.deepEqual(await roles(), ['comment', 'view', 'edit']);
});

test('a refused share takes no locks first: a viewer gets 403 and a stranger 404 while the recipient and the pages are locked; the refusal order holds', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { admin, member, member2 } = fx.people;
  const { drive, document } = await documentOf(member, 'Refused early');
  const child = await fx.insertDocument({ driveId: drive, parentDocumentId: document, title: 'Child' });
  await fx.addDriveMember(drive, { user: member2 }, 'view');
  const person = await fx.addPerson();
  await fx.share(document, { user: person }, 'view');
  const row = await shareIdOf(document, person);
  const path = `/api/documents/${document}/shares`;
  const pending: Array<Promise<Response>> = [];
  /** The answer if it comes within 3 s; null when the request waited on a lock. */
  const prompt = (userId: string, method: string, at: string, body?: unknown) => {
    const request = fx!.request(userId, method, at, body);
    pending.push(request);
    return Promise.race([
      request.then(async (res) => ({ status: res.status, code: (await json(res.clone())).code })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
    ]);
  };
  const holder = await lockHolder();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2 FOR UPDATE', [fx.orgId, person]);
    await holder.query('SELECT 1 FROM documents WHERE id = ANY($1::text[]) FOR UPDATE', [[document, child]]);
    const body = { principal_type: 'user', principal_id: person, role: 'edit' };
    assert.deepEqual(await prompt(member2, 'POST', path, body), { status: 403, code: 'FORBIDDEN_ROLE' }, 'a viewer, at once');
    assert.deepEqual(await prompt(member2, 'PATCH', `${path}/${row}`, { role: 'edit' }), { status: 403, code: 'FORBIDDEN_ROLE' });
    assert.deepEqual(await prompt(member2, 'DELETE', `${path}/${row}`), { status: 403, code: 'FORBIDDEN_ROLE' });
    assert.deepEqual(await prompt(admin, 'POST', path, body), { status: 404, code: 'NOT_FOUND' }, 'someone who can’t see it, at once');
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    await holder.end();
    await Promise.allSettled(pending);
  }
  // 404, then 403, then 400 and 409.
  const cannotHold = await fx.addPerson({ kind: 'agent' });
  const to = (principal: string) => ({ principal_type: 'user', principal_id: principal, role: 'view' });
  assert.equal((await call(admin, 'POST', path, to(cannotHold), 404)).code, 'NOT_FOUND');
  assert.equal((await call(admin, 'POST', path, to(admin), 404)).code, 'NOT_FOUND', 'a self-share by someone who can’t see it');
  assert.equal((await call(member2, 'POST', path, to(cannotHold), 403)).code, 'FORBIDDEN_ROLE');
  assert.equal((await call(member2, 'POST', path, to(member2), 403)).code, 'FORBIDDEN_ROLE');
  assert.equal((await call(member, 'POST', path, to(cannotHold), 400)).code, 'PRINCIPAL_CANNOT_HOLD_ACCESS');
  assert.equal((await call(member, 'POST', path, to(person), 409)).code, 'ALREADY_SHARED');
  assert.equal((await call(admin, 'DELETE', `${path}/${row}`, undefined, 404)).code, 'NOT_FOUND');
});

test('a share tells, and sends document:shared to, only the people whose role on the page was below the share’s', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { agentUser, guest, member, member2 } = fx.people;
  // member2 can already edit `first` (a drive member): a comment share to the chat newly reaches the guest only.
  const first = await documentOf(member, 'Already editing');
  await fx.addDriveMember(first.drive, { user: member2 }, 'edit');
  const second = await documentOf(member, 'Only viewing');
  await fx.addDriveMember(second.drive, { user: member2 }, 'view');
  const sockets = await socketHarness(fx.orgId, [member, member2, guest, agentUser]);
  try {
    await share(member, first.document, { space: fx.spaces.team }, 'comment');
    assert.deepEqual(await toldAbout(first.document), [guest], 'member2 could already edit it');
    await waitFor(() => sockets.received(guest, 'document:shared').length > 0, 'document:shared for the guest');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(sockets.received(member2, 'document:shared'), [], 'nor is member2 sent the event');
    // member2 can only view `second`: an edit share to the chat raises them, so they are told.
    await share(member, second.document, { space: fx.spaces.team }, 'edit');
    assert.deepEqual(await toldAbout(second.document), [member2, guest].sort());
    await waitFor(() => sockets.received(member2, 'document:shared').some((event) => event.document_id === second.document),
      'document:shared for member2');
  } finally {
    await sockets.close();
  }
  // A person who could already open it at that role is not told.
  const third = await documentOf(member, 'Person already in');
  await fx.addDriveMember(third.drive, { user: member2 }, 'comment');
  await share(member, third.document, { user: member2 }, 'view');
  assert.deepEqual(await toldAbout(third.document), []);
});

test('a share naming the sharer is refused with 400 SELF_SHARE, and so is raising one; a chat the sharer is in is fine', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const { drive, document } = await documentOf(member, 'Self');
  assert.equal((await share(member, document, { user: member }, 'view', 400)).code, 'SELF_SHARE');
  assert.deepEqual(await shareRows(document), []);
  await share(member, document, { space: fx.spaces.team }, 'view');
  // A share to member2 that already exists: member2 (a drive editor) may lower or remove it, never raise it.
  await fx.addDriveMember(drive, { user: member2 }, 'edit');
  await fx.share(document, { user: member2 }, 'comment');
  const row = await shareIdOf(document, member2);
  assert.equal((await call(member2, 'PATCH', `/api/documents/${document}/shares/${row}`, { role: 'edit' }, 400)).code, 'SELF_SHARE');
  assert.equal((await call(member2, 'PATCH', `/api/documents/${document}/shares/${row}`, { role: 'view' }, 200)).share.role, 'view');
  await call(member2, 'DELETE', `/api/documents/${document}/shares/${row}`, undefined, 200);
  assert.deepEqual((await shareRows(document)).map(([type]) => type), ['space']);
});

// ── Consult fixes (F9 consult round 2) ─────────────────────────────────────

test('a full role is refused after the access check: a stranger gets 404, a viewer 403, an editor 400 ROLE_TOO_HIGH (S-F1)', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { admin, member, member2 } = fx.people;
  const { drive, document } = await documentOf(member, 'Full refused in order');
  await fx.addDriveMember(drive, { user: member2 }, 'view');
  const person = await fx.addPerson();
  await fx.share(document, { user: person }, 'view');
  const row = await shareIdOf(document, person);
  const asFull = { principal_type: 'user', principal_id: await fx.addPerson(), role: 'full' };
  const path = `/api/documents/${document}/shares`;
  assert.equal((await call(admin, 'POST', path, asFull, 404)).code, 'NOT_FOUND', 'a stranger, POST');
  assert.equal((await call(admin, 'POST', `/api/documents/${randomUUID()}/shares`, asFull, 404)).code, 'NOT_FOUND', 'no such document');
  assert.equal((await call(member2, 'POST', path, asFull, 403)).code, 'FORBIDDEN_ROLE', 'a viewer, POST');
  assert.equal((await call(member, 'POST', path, asFull, 400)).code, 'ROLE_TOO_HIGH', 'an editor, POST');
  assert.equal((await call(admin, 'PATCH', `${path}/${row}`, { role: 'full' }, 404)).code, 'NOT_FOUND', 'a stranger, PATCH');
  assert.equal((await call(member2, 'PATCH', `${path}/${row}`, { role: 'full' }, 403)).code, 'FORBIDDEN_ROLE', 'a viewer, PATCH');
  assert.equal((await call(member, 'PATCH', `${path}/${row}`, { role: 'full' }, 400)).code, 'ROLE_TOO_HIGH', 'an editor, PATCH');
  assert.deepEqual(await shareRows(document), [['user', person, 'view']]);
});

test('a document moved before its drive is locked is refused with 409 before its pages are locked; shares of one page run side by side (S-F2)', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const { drive, document } = await documentOf(member, 'Moved under a share');
  const child = await fx.insertDocument({ driveId: drive, parentDocumentId: document, title: 'Child' });
  const target = await fx.insertDrive({ kind: 'private', name: 'Moved to' });
  await fx.addDriveMember(target, { user: member }, 'full');
  const mover = await lockHolder();
  const childHolder = await lockHolder();
  let pending: Promise<Response> | null = null;
  try {
    // A move, as moveDocument makes it: both drives FOR UPDATE, then the page and its sub-page.
    await mover.query('BEGIN');
    await mover.query('SELECT id FROM drives WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [[drive, target]]);
    await mover.query('UPDATE documents SET drive_id = $2 WHERE id = ANY($1::text[])', [[document, child], target]);
    // A second writer queues for the sub-page (as a second move would) and holds it once the move commits.
    await childHolder.query('BEGIN');
    const childLocked = childHolder.query('SELECT id FROM documents WHERE id = $1 FOR UPDATE', [child]);
    pending = fx.request(member, 'POST', `/api/documents/${document}/shares`, { principal_type: 'user', principal_id: member2, role: 'view' });
    await waitForLockWaiters(2, 'the sub-page writer and the share both wait on the move');
    await mover.query('COMMIT');
    await childLocked;
    const answer = await Promise.race([
      pending.then(async (res) => ({ status: res.status, code: (await json(res.clone())).code })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
    ]);
    assert.deepEqual(answer, { status: 409, code: 'CONFLICT' }, 'refused at once, without waiting on the sub-page');
  } finally {
    await mover.query('ROLLBACK').catch(() => undefined);
    await childHolder.query('ROLLBACK').catch(() => undefined);
    await mover.end();
    await childHolder.end();
    if (pending) await pending.catch(() => undefined);
  }
  assert.deepEqual(await shareRows(document), []);
  // Two sharers share one page at once and both land: neither upgrades a lock the other shares. (Two
  // sharers: one person's shares queue on their own room-access lock.)
  await fx.addDriveMember(target, { user: member2 }, 'edit');
  const [first, second] = [await fx.addPerson(), await fx.addPerson()];
  const both = await Promise.all([[member, first], [member2, second]].map(([actor, person]) => fx!.request(actor!, 'POST',
    `/api/documents/${document}/shares`, { principal_type: 'user', principal_id: person, role: 'view' })));
  assert.deepEqual(both.map((res) => res.status), [201, 201]);
  assert.equal(await roleOf(first, child), 'view');
  assert.equal(await roleOf(second, child), 'view');
});

test('document:shared goes per page to the people newly reached on that page (S-F3)', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { agentUser, guest, member, member2 } = fx.people;
  const { drive, document } = await documentOf(member, 'Reached page by page');
  const child = await fx.insertDocument({ driveId: drive, parentDocumentId: document, title: 'Child' });
  // The share is `comment`. The guest can already edit the page but not the sub-page; member2 can already
  // edit the sub-page but not the page; the agent comments on both as a drive member.
  await fx.share(document, { user: guest }, 'edit');
  await fx.share(child, { user: member2 }, 'edit');
  await fx.addDriveMember(drive, { user: agentUser }, 'comment');
  const person = await fx.addPerson();
  await fx.share(child, { user: person }, 'edit');
  const sockets = await socketHarness(fx.orgId, [member, member2, guest, agentUser, person]);
  const shared = (userId: string) => sockets.received(userId, 'document:shared').map((event) => event.document_id).sort();
  try {
    await share(member, document, { space: fx.spaces.team }, 'comment');
    await waitFor(() => shared(guest).length > 0 && shared(member2).length > 0, 'document:shared for the chat');
    // A person newly reached on the page only.
    await share(member, document, { user: person }, 'comment');
    await waitFor(() => shared(person).length > 0, 'document:shared for the person');
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(shared(guest), [child], 'the guest newly reaches the sub-page only');
    assert.deepEqual(shared(member2), [document], 'member2 newly reaches the page only');
    assert.deepEqual(shared(agentUser), [], 'a drive member who could already comment gets none');
    assert.deepEqual(shared(person), [document], 'nor the person, on the sub-page they could already edit');
  } finally {
    await sockets.close();
  }
  // The notification is for the page shared, to the people newly reached on it.
  assert.deepEqual(await toldAbout(document), [member2, person].sort());
});
