/**
 * The live-editing server (plan Task F7): /collab over real sockets, against
 * the test database. Who may connect and how (read-write, read-only,
 * refused), stores, the limits (documents, connections, size, frames,
 * awareness), access changes closing open connections (the fence, rule C3),
 * session expiry and revocation, the emergency switch and a paused install,
 * the upgrade routing next to Socket.io, the single writer (rule C2) and
 * shutdown. Limits are lowered per test with setCollabLimitsForTest; the
 * whole file runs with unloadAfterMs 200 so documents leave between tests.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/collab-server-http-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test, { after, before } from 'node:test';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as Y from 'yjs';
import { ensureBlockIds, jsonToText, jsonToYDoc } from '@deft/doc-schema';
import { setCollabLimitsForTest } from '../src/collab/limits.js';
import { onDocumentStored, type DocumentStoredEvent } from '../src/collab/persistence.js';
import { collabStateForTest, collabTestSeams, getCollabServer } from '../src/collab/server.js';
import { closeDb, db } from '../src/lib/db.js';
import { applyAccessLossInTx, finishAccessLoss } from '../src/lib/document-access-change.js';
import { DocumentWriteRefused, writeDocument } from '../src/lib/document-writer.js';
import { _setPausedStartForTest } from '../src/lib/paused-start.js';
import { revokeMemberWebSessions } from '../src/lib/web-sessions.js';
import { documentRoutes } from '../src/routes/documents.js';
import { driveRoutes } from '../src/routes/drives.js';
import { spaceRoutes } from '../src/routes/spaces.js';
import { bumpRealtimeAccessGeneration, getIO } from '../src/socket.js';
import {
  collabFrames, connectCollab, connectOutcome, pollUntil, rawCollab, reissueToken, startCollabTestServer, tokenExpiry, tokenFor, ydocText,
  type CollabTestClient, type CollabTestServer,
} from './fixtures/collab-client.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const { io: connectSocketIo } = createRequire(new URL('../../web/package.json', import.meta.url))('socket.io-client');

const url = safeTestDatabaseUrl();
const SKIP = 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
const ROUTES = [
  { path: '/api/drives', app: driveRoutes },
  { path: '/api/documents', app: documentRoutes },
  { path: '/api/spaces', app: spaceRoutes },
];

let fx: DrivesFixture | undefined;
let srv: CollabTestServer | undefined;
let restoreFileLimits: (() => void) | undefined;

before(async () => {
  if (!url) return;
  fx = await setupDrivesFixture('collab', { routes: ROUTES });
  restoreFileLimits = setCollabLimitsForTest({ unloadAfterMs: 200 });
  srv = await startCollabTestServer(fx);
});

after(async () => {
  restoreFileLimits?.();
  collabTestSeams.afterAuthenticate = null;
  await srv?.close();
  await fx?.teardown();
  await closeDb();
});

type JSONContent = Parameters<typeof jsonToText>[0];

const paragraphs = (...texts: string[]): JSONContent => ({
  type: 'doc', content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

/** `n` characters of text that doesn't repeat in short runs. */
function bigText(n: number): string {
  let s = '';
  for (let i = 0; s.length < n; i += 1) s += `${i.toString(36)} `;
  return s.slice(0, n);
}

type StoredRow = {
  content_json: JSONContent; content_text: string; size_bytes: number; state_bytes: number | null; ydoc_state: Buffer | null;
  last_edited_by: string | null; revision: string;
};

async function stored(documentId: string): Promise<StoredRow> {
  const { rows: [row] } = await fx!.client.query(`SELECT content_json, content_text, size_bytes, octet_length(ydoc_state) AS state_bytes,
    ydoc_state, last_edited_by, revision FROM documents WHERE id = $1`, [documentId]);
  return row as StoredRow;
}

/** The text of the stored live state (ydoc_state), or '' when there is none yet. */
function storedStateText(row: StoredRow): string {
  if (!row.ydoc_state) return '';
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(row.ydoc_state));
  const text = ydocText(doc);
  doc.destroy();
  return text;
}

/** Connects, tracked for cleanup, and waits until synced. */
async function open(t: { after(fn: () => void): void }, documentId: string, userId: string, orgId = fx!.orgId): Promise<CollabTestClient> {
  const client = connectCollab({ url: srv!.url, documentId, token: await tokenFor(userId, orgId) });
  t.after(() => client.destroy());
  await client.waitSynced();
  return client;
}

/** Connects and waits for the close (the refusal). */
async function refusedCode(t: { after(fn: () => void): void }, documentId: string, userId: string, orgId = fx!.orgId): Promise<number> {
  const { client, outcome } = await connectOutcome({ url: srv!.url, documentId, token: await tokenFor(userId, orgId) });
  t.after(() => client.destroy());
  assert.notEqual(outcome, 'ok', 'the connection was refused');
  return outcome as number;
}

/**
 * Leaves the server with nothing loaded or reserved, so capacity tests start
 * empty, whatever the runner's speed: once no connection or write holds a
 * document, every idle one is stored and unloaded through the test seam,
 * without waiting for its unload timer. A document that won't go fails with
 * how each held document stands.
 */
async function allUnloaded(): Promise<void> {
  await pollUntil(() => collabStateForTest().heldDocuments === 0, 'no connection or write holds a document', 10_000);
  await collabStateForTest().unloadIdle();
  const state = collabStateForTest();
  assert.equal(state.reservedDocuments, 0, `documents still held: ${state.describe()}`);
}

/**
 * Has `writer` type `text` (an edit attempt), then waits until `observer`
 * sees a later awareness probe from it. The server handles a socket's frames
 * in order and sends document updates no later than awareness, so by then
 * the attempt, had it been applied, would have reached `observer`.
 */
async function attemptReached(writer: CollabTestClient, observer: CollabTestClient, text: string): Promise<boolean> {
  writer.typeText(text);
  writer.provider.setAwarenessField('probe', text);
  await pollUntil(() => (observer.provider.awareness!.getStates().get(writer.ydoc.clientID) as { probe?: string } | undefined)?.probe === text,
    'the probe arrives');
  return observer.text().includes(text);
}

/** Holds the document row FOR UPDATE from another connection until `release`, and says when a waiter is blocked on it. */
async function holdRow(documentId: string) {
  const holder = new pg.Client({ connectionString: url! });
  await holder.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT id FROM documents WHERE id = $1 FOR UPDATE', [documentId]);
  const { rows: [{ pid }] } = await holder.query('SELECT pg_backend_pid() AS pid');
  return {
    waiterBlocked: async () => {
      const { rows: [row] } = await fx!.client.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid]);
      return (row as { n: number }).n > 0;
    },
    release: async () => {
      await holder.query('COMMIT').catch(() => undefined);
      await holder.end();
    },
  };
}

/** Adds a CHECK constraint that refuses every write of the document's row (a database failure), and the drop. */
async function failWrites(documentId: string) {
  const constraint = `f7_store_fault_${documentId.replaceAll('-', '').slice(0, 12)}`;
  await fx!.client.query(`ALTER TABLE documents ADD CONSTRAINT ${constraint} CHECK (id <> '${documentId}') NOT VALID`);
  let dropped = false;
  return async () => {
    if (dropped) return;
    dropped = true;
    await fx!.client.query(`ALTER TABLE documents DROP CONSTRAINT IF EXISTS ${constraint}`);
  };
}

/** Records what reaches the console while it runs, without printing it. */
function captureConsole(t: { after(fn: () => void): void }): string[] {
  const lines: string[] = [];
  const original = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  for (const method of ['error', 'warn', 'log', 'info'] as const) {
    console[method] = (...args: unknown[]) => { lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg))).join(' ')); };
  }
  t.after(() => Object.assign(console, original));
  return lines;
}

async function driveMemberId(driveId: string, userId: string): Promise<string> {
  const { rows: [row] } = await fx!.client.query('SELECT id FROM drive_members WHERE drive_id = $1 AND principal_id = $2', [driveId, userId]);
  return (row as { id: string }).id;
}

function appendParagraph(doc: Y.Doc, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment('default').push([paragraph]);
}

// ---------------------------------------------------------------------------
// Connecting

test('an editor connects read-write, a viewer read-only, and an outsider and an ungranted guest are refused with 4403', { skip: !url && SKIP }, async (t) => {
  const { people } = fx!;
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Connect' });
  await fx!.share(doc, { user: people.guest }, 'view');
  const ungrantedGuest = await fx!.addPerson({ role: 'guest' });

  const editor = await open(t, doc, people.member);
  assert.equal(editor.readOnly, false);
  const viewer = await open(t, doc, people.guest);
  assert.equal(viewer.readOnly, true);
  assert.deepEqual(getCollabServer().connectedUserIds(doc).sort(), [people.member, people.guest].sort());
  // The viewer's actual write attempt is never applied.
  assert.equal(await attemptReached(viewer, editor, 'A viewer tried to write'), false);
  assert.ok(!(await stored(doc)).content_text.includes('A viewer tried to write'));

  assert.equal(await refusedCode(t, doc, people.outsider, fx!.otherOrgId), 4403);
  assert.equal(await refusedCode(t, doc, ungrantedGuest), 4403);
});

test('edits are stored within 10 s with content_json, content_text, size_bytes and last_edited_by', { skip: !url && SKIP }, async (t) => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Stored' });
  const editor = await open(t, doc, fx!.people.member);
  const started = Date.now();
  editor.typeText('Stored by the live server');
  await pollUntil(async () => (await stored(doc)).content_text.includes('Stored by the live server'), 'the edit is stored', 10_000);
  assert.ok(Date.now() - started < 10_000);
  const row = await stored(doc);
  assert.ok(JSON.stringify(row.content_json).includes('Stored by the live server'));
  assert.equal(row.size_bytes, row.state_bytes, 'size_bytes is the stored live state');
  assert.ok(storedStateText(row).includes('Stored by the live server'));
  assert.equal(row.last_edited_by, fx!.people.member);
  assert.ok(Number(row.revision) >= 1, 'each store bumps the revision');
});

// ---------------------------------------------------------------------------
// Limits

test('loading a third document with maxLoadedDocuments 2 is refused with 4429', { skip: !url && SKIP }, async (t) => {
  await allUnloaded();
  t.after(setCollabLimitsForTest({ maxLoadedDocuments: 2 }));
  const docs: string[] = [];
  for (const n of [1, 2, 3]) docs.push(await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: `Load ${n}` }));
  await open(t, docs[0]!, fx!.people.member);
  await open(t, docs[1]!, fx!.people.member);
  assert.equal(await refusedCode(t, docs[2]!, fx!.people.member), 4429);
  // A document already loaded still takes connections.
  await open(t, docs[0]!, fx!.people.member2);
});

test('a third connection with maxConnectionsPerDocument 2 is refused with 4430', { skip: !url && SKIP }, async (t) => {
  t.after(setCollabLimitsForTest({ maxConnectionsPerDocument: 2 }));
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Crowded' });
  const first = await open(t, doc, fx!.people.member);
  await open(t, doc, fx!.people.member2);
  assert.equal(await refusedCode(t, doc, fx!.people.owner), 4430);
  // A place frees when someone leaves.
  first.destroy();
  await pollUntil(() => getCollabServer().connectedUserIds(doc).length === 1, 'the first connection left');
  await open(t, doc, fx!.people.owner);
});

test('concurrent loads never exceed maxLoadedDocuments', { skip: !url && SKIP }, async (t) => {
  await allUnloaded();
  t.after(setCollabLimitsForTest({ maxLoadedDocuments: 2 }));
  collabStateForTest().resetPeak();
  const docs: string[] = [];
  const tokens: string[] = [];
  for (const n of [1, 2, 3, 4, 5]) {
    docs.push(await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: `Burst ${n}` }));
    tokens.push(await tokenFor(fx!.people.member, fx!.orgId));
  }
  const results = await Promise.all(docs.map((documentId, i) => connectOutcome({ url: srv!.url, documentId, token: tokens[i]! })));
  for (const { client } of results) t.after(() => client.destroy());
  const outcomes = results.map((r) => r.outcome);
  assert.equal(outcomes.filter((o) => o === 'ok').length, 2, 'two documents load');
  assert.equal(outcomes.filter((o) => o === 4429).length, 3, 'the other three are refused as busy');
  assert.ok(collabStateForTest().peakDocuments <= 2, 'never more than two documents loaded or reserved');
});

test('an update crossing 2 MB is refused and the stored state is unchanged', { skip: !url && SKIP }, async (t) => {
  t.after(setCollabLimitsForTest({ docMaxBytes: 65_536 }));
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Paste' });
  const editor = await open(t, doc, fx!.people.member);
  editor.typeText('Before the paste');
  await pollUntil(async () => (await stored(doc)).content_text.includes('Before the paste'), 'the first edit is stored', 10_000);
  const before = await stored(doc);

  editor.typeText(bigText(100_000));
  const closed = await editor.waitClosed();
  assert.equal(closed.code, 4413);

  // The live document never took it, the process keeps serving, and nothing new was stored.
  const other = await open(t, doc, fx!.people.member2);
  assert.ok(other.text().includes('Before the paste'));
  assert.ok(other.text().length < 1_000, 'the paste was never applied');
  const otherDoc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Still served' });
  await open(t, otherDoc, fx!.people.member2);
  const after = await stored(doc);
  assert.equal(after.revision, before.revision);
  assert.ok(Buffer.from(after.ydoc_state!).equals(Buffer.from(before.ydoc_state!)));
});

test('a SyncStep2 carrying 3 MB is refused', { skip: !url && SKIP }, async (t) => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Step two' });
  const raw = rawCollab(srv!.url);
  t.after(() => raw.ws.terminate());
  await raw.authenticate(`doc:${doc}`, await tokenFor(fx!.people.member, fx!.orgId));
  const offline = new Y.Doc();
  appendParagraph(offline, 'x'.repeat(3_000_000));
  raw.send(collabFrames.syncStep2(`doc:${doc}`, Y.encodeStateAsUpdate(offline)));
  assert.equal((await raw.closed()).code, 4413);
  const reader = await open(t, doc, fx!.people.member2);
  assert.ok(reader.text().length < 1_000, 'the 3 MB was never applied');
});

test('a document over the cap still accepts deletions', { skip: !url && SKIP }, async (t) => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Over the cap', json: paragraphs(bigText(100_000)) });
  t.after(setCollabLimitsForTest({ docMaxBytes: 65_536 }));
  const editor = await open(t, doc, fx!.people.member);
  const text = editor.ydoc.getXmlFragment('default').get(0) as Y.XmlElement;
  editor.ydoc.transact(() => (text.get(0) as Y.XmlText).delete(0, 60_000));
  await pollUntil(async () => {
    const row = await stored(doc);
    return row.state_bytes !== null && row.state_bytes < 65_536 && row.content_text.length <= 40_000;
  }, 'the deletion is stored', 10_000);
  assert.equal(editor.closes.length, 0, 'the deletion was accepted');
  // Growing past the cap again is refused.
  editor.typeText(bigText(40_000));
  assert.equal((await editor.waitClosed()).code, 4413);
});

test('a frame over 4 MiB is refused', { skip: !url && SKIP }, async (t) => {
  const raw = rawCollab(srv!.url);
  t.after(() => raw.ws.terminate());
  assert.ok(await raw.opened());
  raw.send(Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.equal((await raw.closed()).code, 1009);
});

test('an awareness update over 16 KB is dropped', { skip: !url && SKIP }, async (t) => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Awareness' });
  const a = await open(t, doc, fx!.people.member);
  const b = await open(t, doc, fx!.people.member2);
  const seen: string[] = [];
  b.provider.awareness!.on('change', () => {
    const state = b.provider.awareness!.getStates().get(a.ydoc.clientID) as { user?: { name?: string; pad?: string } } | undefined;
    if (state?.user?.name) seen.push(state.user.pad ? `${state.user.name}+pad` : state.user.name);
  });
  a.provider.setAwarenessField('user', { name: 'big', pad: 'x'.repeat(20_000) });
  // The server handles frames in order and broadcasts awareness with document
  // updates, so once B has the marker it has whatever the big state became.
  a.typeText('Marker after the big state');
  await pollUntil(() => b.text().includes('Marker after the big state'), 'the marker arrives');
  assert.ok(!seen.some((s) => s.startsWith('big')), 'the large state was never re-broadcast');
  a.provider.setAwarenessField('user', { name: 'small' });
  await pollUntil(() => seen.includes('small'), 'the small state arrives');
  assert.ok(!seen.some((s) => s.startsWith('big')));
  assert.equal(a.closes.length, 0, 'dropping it does not close the connection');
});

// ---------------------------------------------------------------------------
// Access changes

test('a role downgrade from edit to view turns open connections read-only within 5 s', { skip: !url && SKIP }, async (t) => {
  const { people } = fx!;
  const drive = await fx!.insertDrive({ kind: 'private', name: 'Downgrade' });
  await fx!.addDriveMember(drive, { user: people.owner }, 'full');
  await fx!.addDriveMember(drive, { user: people.member }, 'edit');
  const doc = await fx!.insertDocument({ driveId: drive, title: 'Downgrade' });
  const tab1 = await open(t, doc, people.member);
  const tab2 = await open(t, doc, people.member);
  assert.equal(tab1.readOnly, false);

  const started = Date.now();
  const res = await fx!.request(people.owner, 'PATCH', `/api/drives/${drive}/members/${await driveMemberId(drive, people.member)}`, { role: 'view' });
  assert.equal(res.status, 200);
  assert.equal((await tab1.waitClosed(5_000)).code, 4409);
  assert.equal((await tab2.waitClosed(5_000)).code, 4409);
  assert.ok(Date.now() - started < 5_000);
  const again = await open(t, doc, people.member);
  assert.equal(again.readOnly, true, 'the reconnect is read-only');
  // And its actual write attempt is never applied.
  const owner = await open(t, doc, people.owner);
  assert.equal(await attemptReached(again, owner, 'Written after the downgrade'), false);
  assert.ok(!(await stored(doc)).content_text.includes('Written after the downgrade'));
});

test('refuses a reconnect after the space share is removed and drops the queued update', { skip: !url && SKIP }, async (t) => {
  const { people, spaces } = fx!;
  const drive = await fx!.insertDrive({ kind: 'private', name: 'Chat share' });
  await fx!.addDriveMember(drive, { user: people.owner }, 'full');
  const doc = await fx!.insertDocument({ driveId: drive, title: 'Shared with the chat' });
  await fx!.share(doc, { space: spaces.team }, 'edit');
  const token = await tokenFor(people.member2, fx!.orgId);
  const laptop = connectCollab({ url: srv!.url, documentId: doc, token });
  t.after(() => laptop.destroy());
  await laptop.waitSynced();

  laptop.offline();
  await laptop.waitClosed();
  await pollUntil(() => !getCollabServer().connectedUserIds(doc).includes(people.member2), 'the laptop is offline');
  laptop.typeText('Written offline');
  const offlineUpdate = Y.encodeStateAsUpdate(laptop.ydoc);

  const res = await fx!.request(people.owner, 'DELETE', `/api/spaces/${spaces.team}/members/${people.member2}`);
  assert.equal(res.status, 200);

  laptop.online();
  assert.equal((await laptop.waitClosed()).code, 4403, 'the reconnect is refused');
  // Even sent straight after the auth frame, the queued update is dropped.
  const raw = rawCollab(srv!.url);
  t.after(() => raw.ws.terminate());
  assert.ok(await raw.opened());
  raw.send(collabFrames.auth(`doc:${doc}`, token));
  raw.send(collabFrames.update(`doc:${doc}`, offlineUpdate));
  assert.equal((await raw.closed()).code, 4403);

  const owner = await open(t, doc, people.owner);
  assert.ok(!owner.text().includes('Written offline'));
  assert.ok(!storedStateText(await stored(doc)).includes('Written offline'));
});

test('moving a document into a private drive closes a non-member\'s open connection', { skip: !url && SKIP }, async (t) => {
  const { people } = fx!;
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Moving' });
  const privateDrive = await fx!.insertDrive({ kind: 'private', name: 'Private target' });
  await fx!.addDriveMember(privateDrive, { user: people.owner }, 'full');
  const member = await open(t, doc, people.member);
  const res = await fx!.request(people.owner, 'POST', `/api/documents/${doc}/move`, { drive_id: privateDrive });
  assert.equal(res.status, 200);
  assert.equal((await member.waitClosed(5_000)).code, 4403);
});

test('an access change between auth and registration closes the connection', { skip: !url && SKIP }, async (t) => {
  const { people } = fx!;
  t.after(() => { collabTestSeams.afterAuthenticate = null; });
  const drive = await fx!.insertDrive({ kind: 'private', name: 'Between' });
  await fx!.addDriveMember(drive, { user: people.member }, 'edit');
  const doc = await fx!.insertDocument({ driveId: drive, title: 'Between auth and registration' });

  // A document access loss commits after the role was read: its event finds
  // no registered connection, so the generation check catches it.
  collabTestSeams.afterAuthenticate = async (documentId) => {
    if (documentId !== doc) return;
    collabTestSeams.afterAuthenticate = null;
    await fx!.client.query('DELETE FROM drive_members WHERE drive_id = $1 AND principal_id = $2', [drive, people.member]);
    await finishAccessLoss({ orgId: fx!.orgId, driveId: drive, userIds: [people.member] }, { cancelledActionIds: [] });
  };
  assert.equal(await refusedCode(t, doc, people.member), 4403);

  // A workspace access change (the realtime generation) in the same gap: 4401.
  const open2 = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Between, workspace' });
  collabTestSeams.afterAuthenticate = async (documentId) => {
    if (documentId !== open2) return;
    collabTestSeams.afterAuthenticate = null;
    bumpRealtimeAccessGeneration({ orgId: fx!.orgId, userId: people.member2, reason: 'org_role_changed' });
  };
  assert.equal(await refusedCode(t, open2, people.member2), 4401);
});

test('an update arriving after access loss commits is never applied', { skip: !url && SKIP }, async (t) => {
  const { people } = fx!;
  const drive = await fx!.insertDrive({ kind: 'private', name: 'Fence' });
  await fx!.addDriveMember(drive, { user: people.owner }, 'full');
  await fx!.addDriveMember(drive, { user: people.member }, 'edit');
  const doc = await fx!.insertDocument({ driveId: drive, title: 'Fenced' });
  const unrelated = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Unrelated' });
  const member = await open(t, doc, people.member);

  // The loss commits; its event names another document, so only the fence
  // (the moved access generation) stands between the next update and the document.
  await fx!.client.query('DELETE FROM drive_members WHERE drive_id = $1 AND principal_id = $2', [drive, people.member]);
  await finishAccessLoss({ orgId: fx!.orgId, documentIds: [unrelated] }, { cancelledActionIds: [] });
  member.typeText('After the loss');
  assert.equal((await member.waitClosed()).code, 4403);
  const owner = await open(t, doc, people.owner);
  assert.ok(!owner.text().includes('After the loss'));
});

// ---------------------------------------------------------------------------
// Sessions

test('a revoked web session closes its connections', { skip: !url && SKIP }, async (t) => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Revoked' });
  const client = await open(t, doc, fx!.people.member2);
  await revokeMemberWebSessions(fx!.orgId, fx!.people.member2);
  assert.equal((await client.waitClosed()).code, 4401);
});

test('token sync keeps a connection open past 15 minutes without reconnecting', { skip: !url && SKIP }, async (t) => {
  // Scaled down: the first token lives 5 s instead of 15 minutes, and the
  // client sends a fresh one before then, as it does every 10 minutes.
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Token sync' });
  const first = await tokenFor(fx!.people.member, fx!.orgId, { expiresInSeconds: 5 });
  let current = first;
  const client = connectCollab({ url: srv!.url, documentId: doc, token: () => current });
  t.after(() => client.destroy());
  await client.waitSynced();
  current = reissueToken(first, 120);
  await client.provider.sendToken();
  await pollUntil(() => Date.now() > tokenExpiry(first) + 300, 'the first token has expired', 8_000);
  client.typeText('After the first token expired');
  await pollUntil(async () => (await stored(doc)).content_text.includes('After the first token expired'), 'the edit is stored', 10_000);
  assert.equal(client.closes.length, 0, 'never closed');
  assert.equal(client.opens, 1, 'never reconnected');
});

test('a frame after token expiry closes with 4401', { skip: !url && SKIP }, async (t) => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Expired' });
  const token = await tokenFor(fx!.people.member, fx!.orgId, { expiresInSeconds: 3 });
  const client = connectCollab({ url: srv!.url, documentId: doc, token });
  t.after(() => client.destroy());
  await client.waitSynced();
  await pollUntil(() => Date.now() > tokenExpiry(token) + 200, 'the token has expired', 6_000);
  client.typeText('After expiry');
  assert.equal((await client.waitClosed()).code, 4401);
  const reader = await open(t, doc, fx!.people.member2);
  assert.ok(!reader.text().includes('After expiry'));
});

// ---------------------------------------------------------------------------
// The switch, a paused install, upgrades

test('DEFT_DOCUMENTS_LIVE=off refuses /collab with 4503 and GET /api/documents/:id says live: false', { skip: !url && SKIP }, async (t) => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Live off', json: paragraphs('Read through REST') });
  process.env.DEFT_DOCUMENTS_LIVE = 'off';
  t.after(() => { delete process.env.DEFT_DOCUMENTS_LIVE; });
  const raw = rawCollab(srv!.url);
  t.after(() => raw.ws.terminate());
  assert.ok(await raw.opened());
  assert.deepEqual(await raw.closed(), { code: 4503, reason: 'live_off' });
  const res = await fx!.request(fx!.people.member, 'GET', `/api/documents/${doc}`);
  assert.equal(res.status, 200);
  const body = await res.json() as { document: { live: boolean; content_json?: JSONContent } };
  assert.equal(body.document.live, false);
  assert.ok(JSON.stringify(body.document.content_json).includes('Read through REST'));
});

test('/collab is refused while paused', { skip: !url && SKIP }, async (t) => {
  _setPausedStartForTest(true);
  t.after(() => _setPausedStartForTest(false));
  const raw = rawCollab(srv!.url);
  t.after(() => raw.ws.terminate());
  assert.ok(await raw.opened());
  assert.deepEqual(await raw.closed(), { code: 4503, reason: 'paused' });
});

test('a /collab upgrade from another origin is refused', { skip: !url && SKIP }, async (t) => {
  const saved = { hosted: process.env.DEFT_HOSTED, app: process.env.NEXT_PUBLIC_APP_URL };
  process.env.DEFT_HOSTED = 'true';
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.collab.test';
  t.after(() => {
    if (saved.hosted === undefined) delete process.env.DEFT_HOSTED; else process.env.DEFT_HOSTED = saved.hosted;
    if (saved.app === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = saved.app;
  });
  const foreign = rawCollab(srv!.url, { origin: 'https://elsewhere.test' });
  t.after(() => foreign.ws.terminate());
  assert.equal(await foreign.opened(), false, 'the upgrade is ended');
  const own = rawCollab(srv!.url, { origin: 'https://app.collab.test' });
  t.after(() => own.ws.terminate());
  assert.equal(await own.opened(), true, 'the web app\'s own origin upgrades');
});

test('an upgrade on an unknown path is ended, and Socket.io still connects', { skip: !url && SKIP }, async (t) => {
  const started = Date.now();
  const raw = rawCollab(`ws://127.0.0.1:${srv!.port}/elsewhere`);
  t.after(() => raw.ws.terminate());
  assert.equal(await raw.opened(), false);
  assert.ok(Date.now() - started < 900, 'ended at once, not after engine.io\'s one-second timeout');
  assert.equal((getIO() as unknown as { engine: { opts: { destroyUpgrade: boolean } } }).engine.opts.destroyUpgrade, false,
    'engine.io leaves other paths alone');

  const socket = connectSocketIo(`http://127.0.0.1:${srv!.port}`, {
    auth: { token: await tokenFor(fx!.people.member, fx!.orgId) }, transports: ['websocket'], reconnection: false,
  });
  t.after(() => socket.close());
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('presence:init timed out')), 5_000);
    socket.once('presence:init', () => { clearTimeout(timer); resolve(); });
  });
  // And /collab works on the same server.
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Beside Socket.io' });
  await open(t, doc, fx!.people.member);
});

// ---------------------------------------------------------------------------
// Stores and the single writer

test('writeDocument edits a document nobody has open and runs the stored listeners; no unchecked writer is reachable', { skip: !url && SKIP }, async (t) => {
  // The brief's "withDocument edits a document nobody has open" (C2: writeDocument is the only way in).
  const server = getCollabServer() as unknown as Record<string, unknown>;
  assert.equal('withDocument' in server, false, 'withDocument is not callable');
  assert.equal('write' in server, false, 'the write machinery is not callable');
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Nobody here', json: paragraphs('Already here') });
  const events: DocumentStoredEvent[] = [];
  t.after(onDocumentStored(async (e) => { if (e.documentId === doc) events.push(e); }));
  await writeDocument({
    orgId: fx!.orgId, documentId: doc, actor: { kind: 'system', userId: 'system' }, requiredRole: null, reason: 'import',
    mutate: (ydoc) => appendParagraph(ydoc, 'Written while nobody had it open'),
  });
  assert.ok(!collabStateForTest().loadedDocumentIds.includes(doc), 'written from the row, not loaded');
  const row = await stored(doc);
  assert.ok(row.content_text.includes('Written while nobody had it open'));
  assert.ok(storedStateText(row).includes('Written while nobody had it open'));
  assert.equal(Number(row.revision), 1);
  assert.equal(row.last_edited_by, null, 'a system write names no editor');
  assert.equal(events.length, 1, 'the listeners ran before it returned');
  assert.deepEqual([events[0]!.editorIds, events[0]!.agentUserIds, events[0]!.actionIds], [[], [], []]);
  assert.ok(jsonToText(events[0]!.previousJson).includes('Already here'));
  assert.ok(!jsonToText(events[0]!.previousJson).includes('Written while'));
  assert.ok(jsonToText(events[0]!.json).includes('Written while nobody had it open'));
  // The next live load starts from what was written.
  const reader = await open(t, doc, fx!.people.member2);
  assert.ok(reader.text().includes('Written while nobody had it open'));
});

test('writeDocument refuses a stale expectedRevision and an over-cap result', { skip: !url && SKIP }, async (t) => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Writer' });
  const actor = { kind: 'user' as const, userId: fx!.people.member };
  const first = await writeDocument({ orgId: fx!.orgId, documentId: doc, actor, reason: 'import', mutate: (d) => appendParagraph(d, 'One') });
  assert.equal(first.revision, 1);
  await assert.rejects(
    writeDocument({ orgId: fx!.orgId, documentId: doc, actor, reason: 'import', expectedRevision: 0, mutate: (d) => appendParagraph(d, 'Stale') }),
    (e: unknown) => e instanceof DocumentWriteRefused && e.code === 'REVISION_CHANGED',
  );
  const second = await writeDocument({ orgId: fx!.orgId, documentId: doc, actor, reason: 'import', expectedRevision: 1, mutate: (d) => appendParagraph(d, 'Two') });
  assert.equal(second.revision, 2);

  // Live: pending live changes are stored first, so a revision read before them is stale.
  const editor = await open(t, doc, fx!.people.member2);
  editor.typeText('Typed live');
  await pollUntil(() => !editor.provider.hasUnsyncedChanges, 'the live edit reached the server');
  await assert.rejects(
    writeDocument({ orgId: fx!.orgId, documentId: doc, actor, reason: 'import', expectedRevision: 2, mutate: (d) => appendParagraph(d, 'Late') }),
    (e: unknown) => e instanceof DocumentWriteRefused && e.code === 'REVISION_CHANGED',
  );
  const live = await writeDocument({ orgId: fx!.orgId, documentId: doc, actor, reason: 'import', mutate: (d) => appendParagraph(d, 'Through the live copy') });
  await pollUntil(() => editor.text().includes('Through the live copy'), 'the connected editor sees the write');
  assert.equal(Number((await stored(doc)).revision), live.revision);

  // Over the cap: refused, and nothing changes, live or from the row.
  t.after(setCollabLimitsForTest({ docMaxBytes: 65_536 }));
  const before = await stored(doc);
  await assert.rejects(
    writeDocument({ orgId: fx!.orgId, documentId: doc, actor, reason: 'import', mutate: (d) => appendParagraph(d, bigText(100_000)) }),
    (e: unknown) => e instanceof DocumentWriteRefused && e.code === 'TOO_LARGE',
  );
  assert.equal((await stored(doc)).revision, before.revision);
  assert.ok(editor.text().length < 1_000, 'the live copy never took it');
  editor.destroy();
  await allUnloaded();
  await assert.rejects(
    writeDocument({ orgId: fx!.orgId, documentId: doc, actor, reason: 'import', mutate: (d) => appendParagraph(d, bigText(100_000)) }),
    (e: unknown) => e instanceof DocumentWriteRefused && e.code === 'TOO_LARGE',
  );
  assert.equal((await stored(doc)).revision, before.revision, 'refused from the row as well');
});

test('writeDocument checks Defty as the asker and an agent as itself, lets a system actor through, and refuses agent edits on a suggest-only drive', { skip: !url && SKIP }, async () => {
  const { people } = fx!;
  const drive = await fx!.insertDrive({ kind: 'private', name: 'Actors' });
  await fx!.addDriveMember(drive, { user: people.member }, 'edit');
  await fx!.addDriveMember(drive, { user: people.agentUser }, 'edit');
  const doc = await fx!.insertDocument({ driveId: drive, title: 'Actors' });
  const defty = await fx!.addPerson({ kind: 'agent' });
  const write = (actor: Parameters<typeof writeDocument>[0]['actor'], extra: Partial<Parameters<typeof writeDocument>[0]> = {}) =>
    writeDocument({ orgId: fx!.orgId, documentId: doc, actor, reason: 'agent_edit', mutate: (d) => appendParagraph(d, 'edit'), ...extra });
  const forbidden = (e: unknown) => e instanceof DocumentWriteRefused && e.code === 'FORBIDDEN';

  await write({ kind: 'agent', userId: defty, askerId: people.member });
  await assert.rejects(write({ kind: 'agent', userId: defty, askerId: people.member2 }), forbidden);
  await assert.rejects(write({ kind: 'agent', userId: defty }), forbidden, 'Defty\'s own user holds nothing');
  await write({ kind: 'agent', userId: people.agentUser });
  await write({ kind: 'system', userId: 'system' }, { requiredRole: null, reason: 'move_fix' });
  await assert.rejects(write({ kind: 'user', userId: people.member }, { requiredRole: null, reason: 'move_fix' }), forbidden);

  await fx!.client.query('UPDATE drives SET agent_suggest_only = true WHERE id = $1', [drive]);
  await assert.rejects(write({ kind: 'agent', userId: people.agentUser }), forbidden);
  await assert.rejects(write({ kind: 'agent', userId: defty, askerId: people.member }), forbidden);
  await write({ kind: 'user', userId: people.member });
  await write({ kind: 'agent', userId: people.agentUser }, { reason: 'suggestion' });
});

test('creating a document over docMaxBytes is refused with 413 TOO_LARGE', { skip: !url && SKIP }, async (t) => {
  t.after(setCollabLimitsForTest({ docMaxBytes: 65_536 }));
  const before = await fx!.client.query('SELECT count(*)::int AS n FROM documents WHERE org_id = $1', [fx!.orgId]);
  const res = await fx!.request(fx!.people.member, 'POST', '/api/documents', { drive_id: fx!.workspaceDriveId, json: paragraphs(bigText(100_000)) });
  assert.equal(res.status, 413);
  assert.equal((await res.json() as { code: string }).code, 'TOO_LARGE');
  const afterCount = await fx!.client.query('SELECT count(*)::int AS n FROM documents WHERE org_id = $1', [fx!.orgId]);
  assert.equal(afterCount.rows[0].n, before.rows[0].n);
  const small = await fx!.request(fx!.people.member, 'POST', '/api/documents', { drive_id: fx!.workspaceDriveId, json: paragraphs('Small') });
  assert.equal(small.status, 201);
});

test('a block stored without an id gets one written back into the live document, once', { skip: !url && SKIP }, async (t) => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Block ids' });
  const editor = await open(t, doc, fx!.people.member);
  editor.typeText('Needs an id');
  await pollUntil(async () => (await stored(doc)).content_text.includes('Needs an id'), 'stored', 10_000);
  const storedIds = ((await stored(doc)).content_json.content ?? []).map((block) => block.attrs?.id);
  assert.ok(storedIds.length >= 2 && storedIds.every((id) => typeof id === 'string' && id.length > 0), 'every stored block has an id');
  const liveIds = () => editor.ydoc.getXmlFragment('default').toArray().map((el) => (el as Y.XmlElement).getAttribute('id'));
  await pollUntil(() => JSON.stringify(liveIds()) === JSON.stringify(storedIds), 'the ids reached the live document');

  // A later derive finds nothing to write back: no update reaches the editor.
  let remoteUpdates = 0;
  editor.ydoc.on('update', (_update: Uint8Array, origin: unknown) => { if (origin === editor.provider) remoteUpdates += 1; });
  await writeDocument({ orgId: fx!.orgId, documentId: doc, actor: { kind: 'user', userId: fx!.people.member }, reason: 'import', mutate: () => {} });
  // A round trip on the same socket: anything sent before the acknowledgement has arrived.
  editor.typeText('Round trip');
  await pollUntil(() => !editor.provider.hasUnsyncedChanges, 'acknowledged');
  assert.equal(remoteUpdates, 0, 'no second write-back');
  assert.deepEqual(((await stored(doc)).content_json.content ?? []).map((block) => block.attrs?.id), storedIds);
});

test('a failed store retries and the document stays loaded', { skip: !url && SKIP }, async (t) => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Retry' });
  const editor = await open(t, doc, fx!.people.member);
  const drop = await failWrites(doc);
  t.after(drop);
  const failures = collabStateForTest().storeFailures;
  editor.typeText('Stored on retry');
  await pollUntil(() => !editor.provider.hasUnsyncedChanges, 'the edit reached the server');
  editor.destroy();
  await pollUntil(() => collabStateForTest().storeFailures > failures, 'a store failed', 10_000);
  // Empty for well over unloadAfterMs, yet kept: its edit isn't stored.
  const failedAt = Date.now();
  await pollUntil(() => Date.now() - failedAt > 1_000, 'a second passes', 2_000);
  assert.ok(collabStateForTest().loadedDocumentIds.includes(doc), 'stays loaded after the failure');
  assert.ok(!(await stored(doc)).content_text.includes('Stored on retry'));
  await drop();
  await pollUntil(async () => (await stored(doc)).content_text.includes('Stored on retry'), 'the retry stored it', 10_000);
  await pollUntil(() => !collabStateForTest().loadedDocumentIds.includes(doc), 'it unloads after the successful store', 5_000);
});

// ---------------------------------------------------------------------------
// Fix round 1

test('a socket edit arriving during a writer\'s transaction is measured with the write, so the merged result stays under the cap', { skip: !url && SKIP }, async (t) => {
  t.after(setCollabLimitsForTest({ docMaxBytes: 65_536 }));
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Writer and socket' });
  const editor = await open(t, doc, fx!.people.member);
  editor.typeText('Start');
  await pollUntil(async () => (await stored(doc)).content_text.includes('Start'), 'the first edit is stored', 10_000);
  // The writer waits inside its transaction on the row this holds.
  const row = await holdRow(doc);
  t.after(row.release);
  const writing = writeDocument({
    orgId: fx!.orgId, documentId: doc, actor: { kind: 'user', userId: fx!.people.member2 }, reason: 'import',
    mutate: (d) => appendParagraph(d, `Writer ${bigText(40_000)}`),
  });
  await pollUntil(row.waiterBlocked, 'the writer waits for the row');
  // Alone it would fit (40 KB < 64 KB); with the write in progress it would not.
  editor.typeText(`Socket ${bigText(40_000)}`);
  assert.equal((await editor.waitClosed()).code, 4413);
  await row.release();
  await writing;
  const after = await stored(doc);
  assert.ok(after.size_bytes <= 65_536, `the merged result stays under the cap (${after.size_bytes})`);
  assert.ok(after.content_text.includes('Writer '));
  assert.ok(!after.content_text.includes('Socket '));
  const reader = await open(t, doc, fx!.people.member2);
  assert.ok(reader.text().includes('Writer ') && !reader.text().includes('Socket '));
});

test('a cold write is refused BUSY while live editing\'s memory budget is spent', { skip: !url && SKIP }, async (t) => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Cold and busy' });
  t.after(setCollabLimitsForTest({ memoryBudgetBytes: 1_000 }));
  await assert.rejects(
    writeDocument({ orgId: fx!.orgId, documentId: doc, actor: { kind: 'user', userId: fx!.people.member }, reason: 'import', mutate: (d) => appendParagraph(d, 'x') }),
    (e: unknown) => e instanceof DocumentWriteRefused && e.code === 'BUSY',
  );
  assert.equal(Number((await stored(doc)).revision), 0);
});

test('a no-op resync doesn\'t lower the size estimate', { skip: !url && SKIP }, async (t) => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Resync', json: paragraphs(bigText(60_000)) });
  t.after(setCollabLimitsForTest({ docMaxBytes: 65_536 }));
  const editor = await open(t, doc, fx!.people.member);
  const observer = await open(t, doc, fx!.people.member2);
  // Everything the editor has, sent again: already applied, so Yjs emits nothing.
  editor.socket.send(collabFrames.update(`doc:${doc}`, Y.encodeStateAsUpdate(editor.ydoc)));
  editor.provider.setAwarenessField('probe', 'after the resync');
  await pollUntil(() => (observer.provider.awareness!.getStates().get(editor.ydoc.clientID) as { probe?: string } | undefined)?.probe === 'after the resync',
    'the resync was handled');
  const state = collabStateForTest();
  assert.ok(state.approxBytes(doc)! >= state.encodedBytes(doc)!, `estimate ${state.approxBytes(doc)} below the real ${state.encodedBytes(doc)}`);
  assert.equal(editor.closes.length, 0);
});

test('normalization growth is counted in the size cap', { skip: !url && SKIP }, async (t) => {
  t.after(setCollabLimitsForTest({ docMaxBytes: 65_536 }));
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Normalization' });
  const editor = await open(t, doc, fx!.people.member);
  // Paragraphs without block ids, up to just under the cap; the ids the
  // server writes back would carry them over it.
  const draft = new Y.Doc();
  Y.applyUpdate(draft, Y.encodeStateAsUpdate(editor.ydoc));
  let count = 0;
  while (draft.getXmlFragment('default').length < 2_000 && Y.encodeStateAsUpdate(draft).byteLength < 65_536 - 1_500) {
    appendParagraph(draft, `Paragraph ${count} ${bigText(120)}`);
    count += 1;
  }
  assert.ok(count > 100, 'enough blocks for their ids to matter');
  editor.socket.send(collabFrames.update(`doc:${doc}`, Y.encodeStateAsUpdate(draft, Y.encodeStateVector(editor.ydoc))));
  assert.equal((await editor.waitClosed()).code, 4413);
  const reader = await open(t, doc, fx!.people.member2);
  assert.ok(!reader.text().includes('Paragraph 0 '));
});

test('a deletion whose result stays above the cap is accepted', { skip: !url && SKIP }, async (t) => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Still over', json: paragraphs(bigText(100_000)) });
  t.after(setCollabLimitsForTest({ docMaxBytes: 65_536 }));
  const editor = await open(t, doc, fx!.people.member);
  const paragraph = editor.ydoc.getXmlFragment('default').get(0) as Y.XmlElement;
  editor.ydoc.transact(() => (paragraph.get(0) as Y.XmlText).delete(0, 10_000));
  await pollUntil(async () => (await stored(doc)).content_text.length <= 90_000, 'the deletion is stored', 10_000);
  const row = await stored(doc);
  assert.ok(row.state_bytes! > 65_536, 'still over the cap');
  assert.equal(editor.closes.length, 0, 'the deletion was accepted');
});

test('memory admission counts the projected total and never reserves past the budget', { skip: !url && SKIP }, async (t) => {
  await allUnloaded();
  const provisional = 65_536 * 13;
  const budget = Math.floor(provisional * 2.5);
  t.after(setCollabLimitsForTest({ docMaxBytes: 65_536, memoryBudgetBytes: budget }));
  t.after(() => { collabTestSeams.afterAuthenticate = null; });
  collabStateForTest().resetPeak();
  const docs: string[] = [];
  const tokens: string[] = [];
  for (const n of [1, 2, 3, 4]) {
    docs.push(await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: `Budget ${n}` }));
    tokens.push(await tokenFor(fx!.people.member, fx!.orgId));
  }
  // Admitted connections wait here, holding their provisional reservations.
  let entered = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  collabTestSeams.afterAuthenticate = async () => { entered += 1; await gate; };
  const clients = docs.map((documentId, i) => connectCollab({ url: srv!.url, documentId, token: tokens[i]! }));
  for (const client of clients) t.after(() => client.destroy());
  const refused = () => clients.filter((c) => c.closes.some((close) => close.code === 4429));
  // Nothing loads while the gate holds, so every reservation is still provisional.
  await pollUntil(() => refused().length === 2, 'two of the four are refused as busy');
  await pollUntil(() => entered === 2, 'the two admitted reach the gate');
  release();
  for (const client of clients.filter((c) => !refused().includes(c))) await client.waitSynced();
  collabTestSeams.afterAuthenticate = null;
  assert.equal(entered, 2, 'two reservations fit: 2 × provisional ≤ 2.5 × provisional < 3 ×');
  assert.ok(collabStateForTest().peakReservedBytes <= budget, `peak ${collabStateForTest().peakReservedBytes} within ${budget}`);
});

test('memory reservations are released after a failed authentication and after a failed load', { skip: !url && SKIP }, async (t) => {
  await allUnloaded();
  t.after(() => { collabTestSeams.afterAuthenticate = null; });
  assert.equal(collabStateForTest().reservedBytes, 0);
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Bad token' });
  const bad = await connectOutcome({ url: srv!.url, documentId: doc, token: 'not-a-token' });
  t.after(() => bad.client.destroy());
  assert.equal(bad.outcome, 4401);
  assert.equal(collabStateForTest().reservedBytes, 0, 'released after the failed authentication');
  assert.equal(collabStateForTest().reservedDocuments, 0);

  // The row disappears between authentication and the load, so the load fails.
  const gone = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Gone before load' });
  collabTestSeams.afterAuthenticate = async (documentId) => {
    if (documentId !== gone) return;
    collabTestSeams.afterAuthenticate = null;
    await fx!.client.query('DELETE FROM documents WHERE id = $1', [gone]);
  };
  // Authentication passes (the client hears so), then the load fails.
  const loading = connectCollab({ url: srv!.url, documentId: gone, token: await tokenFor(fx!.people.member, fx!.orgId) });
  t.after(() => loading.destroy());
  assert.equal((await loading.waitClosed()).code, 4429);
  await pollUntil(() => collabStateForTest().reservedDocuments === 0, 'the slot is freed');
  assert.equal(collabStateForTest().reservedBytes, 0, 'released after the failed load');
});

test('a frame between an access-loss commit and finishAccessLoss is refused', { skip: !url && SKIP }, async (t) => {
  const { people } = fx!;
  const drive = await fx!.insertDrive({ kind: 'private', name: 'Barrier' });
  await fx!.addDriveMember(drive, { user: people.owner }, 'full');
  await fx!.addDriveMember(drive, { user: people.member }, 'edit');
  const doc = await fx!.insertDocument({ driveId: drive, title: 'Barrier' });
  const member = await open(t, doc, people.member);
  const change = { orgId: fx!.orgId, driveId: drive, userIds: [people.member] };
  // Committed, with finishAccessLoss not yet run: the generation hasn't moved.
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM drive_members WHERE drive_id = ${drive} AND principal_id = ${people.member}`);
    return applyAccessLossInTx(tx, change);
  });
  t.after(() => finishAccessLoss(change, result));
  member.typeText('Between the commit and the finish');
  assert.equal((await member.waitClosed()).code, 4403);
  await finishAccessLoss(change, result);
  const owner = await open(t, doc, people.owner);
  assert.ok(!owner.text().includes('Between the commit and the finish'));
});

test('a change stored inside the derive window is derived when the window ends', { skip: !url && SKIP }, async (t) => {
  collabTestSeams.derivedEveryMs = 6_000;
  t.after(() => { collabTestSeams.derivedEveryMs = 60_000; });
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Window' });
  const editor = await open(t, doc, fx!.people.member);
  editor.typeText('First');
  await pollUntil(async () => (await stored(doc)).content_text.includes('First'), 'the first edit is derived', 10_000);
  editor.typeText('Second');
  await pollUntil(async () => storedStateText(await stored(doc)).includes('Second'), 'the second edit is stored', 10_000);
  assert.ok(!(await stored(doc)).content_text.includes('Second'), 'stored inside the window: state only');
  // Nobody edits again; the outstanding derivation still lands.
  await pollUntil(async () => (await stored(doc)).content_text.includes('Second'), 'derived when the window ends', 10_000);
  assert.equal(editor.closes.length, 0);
});

test('a reload with derived copies behind the live state derives them', { skip: !url && SKIP }, async (t) => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Behind', json: paragraphs('Stale text') });
  const ahead = jsonToYDoc(ensureBlockIds(paragraphs('Stale text', 'Only in the live state')));
  await fx!.client.query('UPDATE documents SET ydoc_state = $2 WHERE id = $1', [doc, Buffer.from(Y.encodeStateAsUpdate(ahead))]);
  ahead.destroy();
  await open(t, doc, fx!.people.member);
  await pollUntil(async () => (await stored(doc)).content_text.includes('Only in the live state'), 'derived after the reload', 10_000);
});

test('a document whose final derivation fails stays loaded', { skip: !url && SKIP }, async (t) => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Underivable' });
  const odd = new Y.Doc();
  appendParagraph(odd, 'Before the odd block');
  odd.getXmlFragment('default').push([new Y.XmlElement('notInTheSchema')]);
  await fx!.client.query('UPDATE documents SET ydoc_state = $2 WHERE id = $1', [doc, Buffer.from(Y.encodeStateAsUpdate(odd))]);
  odd.destroy();
  const lines = captureConsole(t);
  const editor = await open(t, doc, fx!.people.member);
  editor.typeText('After the odd block');
  await pollUntil(() => !editor.provider.hasUnsyncedChanges, 'the edit reached the server');
  const finals = collabStateForTest().underivedFinals;
  editor.destroy();
  await pollUntil(() => collabStateForTest().underivedFinals > finals, 'a final store could not derive', 10_000);
  assert.ok(collabStateForTest().loadedDocumentIds.includes(doc), 'kept loaded: its text could not be stored');
  const state = new Y.Doc();
  Y.applyUpdate(state, new Uint8Array((await stored(doc)).ydoc_state!));
  assert.ok(state.getXmlFragment('default').toString().includes('After the odd block'), 'its live state was stored');
  state.destroy();
  assert.ok(lines.every((line) => !line.includes('After the odd block')), 'nothing a person wrote is logged');
  // Removing the odd block lets it derive and unload.
  const fixer = await open(t, doc, fx!.people.member);
  const fragment = fixer.ydoc.getXmlFragment('default');
  const index = fragment.toArray().findIndex((node) => node instanceof Y.XmlElement && node.nodeName === 'notInTheSchema');
  fixer.ydoc.transact(() => fragment.delete(index, 1));
  await pollUntil(async () => (await stored(doc)).content_text.includes('After the odd block'), 'derived once the odd block is gone', 10_000);
  fixer.destroy();
  await allUnloaded();
});

test('an expired connection that sends nothing is closed at expiry', { skip: !url && SKIP }, async (t) => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Silent' });
  const token = await tokenFor(fx!.people.member, fx!.orgId, { expiresInSeconds: 3 });
  const client = connectCollab({ url: srv!.url, documentId: doc, token });
  t.after(() => client.destroy());
  await client.waitSynced();
  const expiry = tokenExpiry(token);
  const closed = await client.waitClosed(Math.max(0, expiry - Date.now()) + 2_000);
  assert.equal(closed.code, 4401);
  assert.ok(Date.now() >= expiry - 50, 'not before the expiry');
});

test('a frame for another or a malformed document address is refused before Hocuspocus and never logged', { skip: !url && SKIP }, async (t) => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'One address' });
  const marker = `LEAKMARKER${randomUUID().slice(0, 8)}`;
  const lines = captureConsole(t);
  const nothing = Y.encodeStateAsUpdate(new Y.Doc());
  const second = rawCollab(srv!.url);
  t.after(() => second.ws.terminate());
  assert.ok(await second.opened());
  second.send(collabFrames.update(`doc:${doc}`, nothing));
  second.send(collabFrames.update(`doc:${marker}`, nothing));
  assert.equal((await second.closed()).code, 4403, 'a second document on a socket is refused');
  const malformed = rawCollab(srv!.url);
  t.after(() => malformed.ws.terminate());
  assert.ok(await malformed.opened());
  malformed.send(collabFrames.update(`${marker} is not a document address`, nothing));
  assert.equal((await malformed.closed()).code, 4404, 'a malformed address is refused');
  assert.ok(lines.every((line) => !line.includes(marker)), `the refused address reached the logs: ${lines.filter((l) => l.includes(marker)).join(' | ')}`);
});

test('shutdown flushes pending stores', { skip: !url && SKIP }, async (t) => {
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Shutdown' });
  const editor = await open(t, doc, fx!.people.member);
  editor.typeText('Flushed at shutdown');
  await pollUntil(() => !editor.provider.hasUnsyncedChanges, 'the edit reached the server');
  assert.ok(!(await stored(doc)).content_text.includes('Flushed at shutdown'), 'not stored yet: the store waits 2 s');
  await srv!.collab.destroy();
  const row = await stored(doc);
  assert.ok(row.content_text.includes('Flushed at shutdown'), 'derived content written at shutdown');
  assert.ok(storedStateText(row).includes('Flushed at shutdown'));
  assert.ok((await editor.waitClosed()).code > 0, 'the connection was closed');
});

test('shutdown retries a store that fails during the drain until it lands', { skip: !url && SKIP }, async (t) => {
  srv!.renew();
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Shutdown retry' });
  const editor = await open(t, doc, fx!.people.member);
  editor.typeText('Kept through a failing store');
  await pollUntil(() => !editor.provider.hasUnsyncedChanges, 'the edit was acknowledged');
  const drop = await failWrites(doc);
  t.after(drop);
  const failures = collabStateForTest().storeFailures;
  const stopping = srv!.collab.destroy({ retryUntil: Date.now() + 8_000 });
  await pollUntil(() => collabStateForTest().storeFailures > failures, 'the store fails during the drain', 5_000);
  assert.equal(editor.closes.length, 0, 'connections stay open until everything is stored');
  await drop();
  await stopping;
  const row = await stored(doc);
  assert.ok(storedStateText(row).includes('Kept through a failing store'), 'stored by a retry');
  assert.ok(row.content_text.includes('Kept through a failing store'));
  assert.ok((await editor.waitClosed()).code > 0, 'then the connection closes');
});

test('shutdown that cannot store a document says which one and fails', { skip: !url && SKIP }, async (t) => {
  srv!.renew();
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Shutdown failure' });
  const editor = await open(t, doc, fx!.people.member);
  editor.typeText('Lost with the database down');
  await pollUntil(() => !editor.provider.hasUnsyncedChanges, 'the edit was acknowledged');
  const drop = await failWrites(doc);
  t.after(drop);
  const lines = captureConsole(t);
  await assert.rejects(srv!.collab.destroy({ retryUntil: Date.now() + 1_500 }), /could not store/);
  assert.ok(lines.some((line) => line.includes('[collab] shutdown could not store a document') && line.includes(doc)), lines.join(' | '));
  assert.ok(lines.every((line) => !line.includes('Lost with the database down')), 'nothing a person wrote is logged');
  assert.ok(!storedStateText(await stored(doc)).includes('Lost with the database down'));
});
