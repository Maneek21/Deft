/**
 * Document versions (plan Task F8): automatic versions from the stored
 * listener (at most one per 10 minutes, measured from the last automatic
 * one), named versions, viewing and restoring through the one writer (rule
 * C2), who may see history (can edit; 404 before 403), the size cap on a
 * restore, and `document_attachments.in_current` kept by the stored listener.
 * The version clock is driven with setVersionClockForTest; nothing sleeps.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/document-versions-http-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import * as Y from 'yjs';
import { ensureBlockIds, jsonToText, jsonToYDoc, yDocToJson } from '@deft/doc-schema';
import { setCollabLimitsForTest } from '../src/collab/limits.js';
import { onDocumentStored, type DocumentStoredEvent } from '../src/collab/persistence.js';
import { collabTestSeams } from '../src/collab/server.js';
import { closeDb } from '../src/lib/db.js';
import { writeDocument } from '../src/lib/document-writer.js';
import { createVersion, setVersionClockForTest, startDocumentVersioning } from '../src/lib/document-versions.js';
import { documentRoutes } from '../src/routes/documents.js';
import { _getAgentJobHandlerForTest } from '../src/workers/index.js';
import { connectCollab, pollUntil, startCollabTestServer, tokenFor, type CollabTestClient, type CollabTestServer } from './fixtures/collab-client.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const SKIP = 'Set DEFT_TEST_DATABASE_URL to a disposable test database';

type JSONContent = Parameters<typeof jsonToText>[0];

let fx: DrivesFixture | undefined;
let srv: CollabTestServer | undefined;
let stopVersioning: (() => void) | undefined;
let restoreClock: (() => void) | undefined;
let restoreLimits: (() => void) | undefined;
const fileIds: string[] = [];

/** The version clock's time; tests move it with `at`. */
let now = new Date('2026-11-26T08:00:00.000Z');
const at = (iso: string) => { now = new Date(iso); };

before(async () => {
  if (!url) return;
  fx = await setupDrivesFixture('versions', { routes: [{ path: '/api/documents', app: documentRoutes }] });
  restoreLimits = setCollabLimitsForTest({ unloadAfterMs: 200 });
  srv = await startCollabTestServer(fx);
  stopVersioning = startDocumentVersioning();
  restoreClock = setVersionClockForTest(() => now);
});

after(async () => {
  restoreClock?.();
  stopVersioning?.();
  restoreLimits?.();
  await srv?.close();
  if (fx) {
    await fx.client.query('DELETE FROM job_queue WHERE org_id = $1', [fx.orgId]);
    await fx.client.query('DELETE FROM document_attachments WHERE org_id = $1', [fx.orgId]);
    await fx.client.query('DELETE FROM files WHERE id = ANY($1::text[])', [fileIds]);
    await fx.teardown();
  }
  await closeDb();
});

const paragraphs = (...texts: string[]): JSONContent => ({
  type: 'doc', content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

/** `json` in canonical form with block ids, as a stored document holds it, so a live load has nothing to derive. */
function canonical(json: JSONContent): JSONContent {
  const doc = jsonToYDoc(json);
  try {
    return ensureBlockIds(yDocToJson(doc));
  } finally {
    doc.destroy();
  }
}

/** `n` characters of text that doesn't repeat in short runs. */
function bigText(n: number): string {
  let s = '';
  for (let i = 0; s.length < n; i += 1) s += `${i.toString(36)} `;
  return s.slice(0, n);
}

function appendParagraph(doc: Y.Doc, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment('default').push([paragraph]);
}

/** An edit through the one writer, as `userId`; the stored listeners have run when it returns. */
async function edit(documentId: string, text: string, userId = fx!.people.member): Promise<void> {
  await writeDocument({ orgId: fx!.orgId, documentId, actor: { kind: 'user', userId }, reason: 'import', mutate: (d) => appendParagraph(d, text) });
}

type VersionRow = {
  id: string; kind: string; name: string | null; title: string | null; created_by: string | null; agent_user_id: string | null;
  at: string; size_bytes: number; content_json: JSONContent; edit_details: unknown;
};

/** The document's versions straight from the table, newest first (times as UTC ISO text). */
async function versionRows(documentId: string): Promise<VersionRow[]> {
  const { rows } = await fx!.client.query(`SELECT id, kind, name, title, created_by, agent_user_id, size_bytes, content_json, edit_details,
      to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
    FROM document_versions WHERE document_id = $1 ORDER BY created_at DESC, id DESC`, [documentId]);
  return rows as VersionRow[];
}

async function stored(documentId: string) {
  const { rows: [row] } = await fx!.client.query('SELECT content_text, revision, ydoc_state FROM documents WHERE id = $1', [documentId]);
  return row as { content_text: string; revision: string; ydoc_state: Buffer | null };
}

function stateText(state: Buffer | null): string {
  if (!state) return '';
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(state));
  try {
    return jsonToText(yDocToJson(doc));
  } finally {
    doc.destroy();
  }
}

/** Connects, tracked for cleanup, and waits until synced. */
async function open(t: { after(fn: () => void): void }, documentId: string, userId: string): Promise<CollabTestClient> {
  const client = connectCollab({ url: srv!.url, documentId, token: await tokenFor(userId, fx!.orgId) });
  t.after(() => client.destroy());
  await client.waitSynced();
  return client;
}

/** Records the document's stored events. Registered after the versioning listeners, so an event here has been through them. */
function storedEvents(t: { after(fn: () => void): void }, documentId: string): DocumentStoredEvent[] {
  const events: DocumentStoredEvent[] = [];
  t.after(onDocumentStored(async (e) => { if (e.documentId === documentId) events.push(e); }));
  return events;
}

/** A version row written straight into the table (setup that doesn't depend on the code under test). */
async function insertVersion(documentId: string, json: JSONContent, name: string, createdAt = '2026-11-26T07:00:00.000Z'): Promise<string> {
  const id = randomUUID();
  const text = JSON.stringify(json);
  const result = await fx!.client.query(`INSERT INTO document_versions (id, org_id, document_id, kind, name, title, content_json, size_bytes, created_by, created_at)
    SELECT $1, org_id, id, 'named', $3, title, $4::jsonb, $5::int, $6, $7::timestamp FROM documents WHERE id = $2`,
  [id, documentId, name, text, Buffer.byteLength(text), fx!.people.member, createdAt]);
  if (result.rowCount !== 1) throw new Error('no document');
  return id;
}

async function call(userId: string, method: string, path: string, body?: unknown) {
  const res = await fx!.request(userId, method, path, body);
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

const listPath = (documentId: string) => `/api/documents/${documentId}/versions`;

// ---------------------------------------------------------------------------
// The brief's five tests

test('an automatic version is saved after editing, at most one per 10 minutes', { skip: !url && SKIP }, async (t) => {
  const { people } = fx!;
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Auto', json: canonical(paragraphs('Start')) });

  at('2026-11-26T09:00:00.000Z');
  await edit(doc, 'First edit');
  let rows = await versionRows(doc);
  assert.equal(rows.length, 1, 'the first edit saves an automatic version');
  assert.equal(rows[0]!.kind, 'auto');
  assert.equal(rows[0]!.name, null);
  assert.equal(rows[0]!.title, 'Auto', 'the version records the title');
  assert.equal(rows[0]!.created_by, people.member, 'credited to the editor');
  assert.equal(rows[0]!.at, '2026-11-26T09:00:00.000Z', 'stamped with the version clock');
  assert.ok(jsonToText(rows[0]!.content_json).includes('First edit'));
  assert.ok(rows[0]!.size_bytes > 0);

  at('2026-11-26T09:09:59.999Z');
  await edit(doc, 'Second edit');
  rows = await versionRows(doc);
  assert.equal(rows.length, 1, 'no second automatic version inside 10 minutes');

  at('2026-11-26T09:10:00.000Z');
  await edit(doc, 'Third edit', people.member2);
  rows = await versionRows(doc);
  assert.equal(rows.length, 2, '10 minutes after the last automatic version, the next one is saved');
  assert.equal(rows[0]!.kind, 'auto');
  assert.equal(rows[0]!.created_by, people.member2);
  assert.ok(jsonToText(rows[0]!.content_json).includes('Second edit') && jsonToText(rows[0]!.content_json).includes('Third edit'));

  // A live edit reaches the listener through the live server's derived store.
  collabTestSeams.derivedEveryMs = 300;
  t.after(() => { collabTestSeams.derivedEveryMs = 60_000; });
  const events = storedEvents(t, doc);
  at('2026-11-26T09:15:00.000Z');
  const editor = await open(t, doc, people.member);
  editor.typeText('Typed live too early');
  await pollUntil(() => events.some((e) => jsonToText(e.json).includes('Typed live too early')), 'the live edit is derived and its listeners ran', 10_000);
  assert.equal((await versionRows(doc)).length, 2, 'measured from the last automatic version (09:10), not from the last edit');

  at('2026-11-26T09:20:00.000Z');
  editor.typeText('Typed live later');
  await pollUntil(async () => (await versionRows(doc)).length === 3, 'a live edit after the window saves a version', 10_000);
  const live = (await versionRows(doc))[0]!;
  assert.equal(live.kind, 'auto');
  assert.equal(live.created_by, people.member);
  assert.ok(jsonToText(live.content_json).includes('Typed live later'));
});

test('naming a version creates a named version', { skip: !url && SKIP }, async (t) => {
  const { people } = fx!;
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Proposal', json: canonical(paragraphs('Draft')) });
  const events = storedEvents(t, doc);
  at('2026-11-26T09:55:00.000Z');
  // An edit the server has accepted, named before the store debounce (2 s) has stored it anywhere.
  const editor = await open(t, doc, people.member);
  editor.typeText('Typed just now');
  await pollUntil(() => !editor.provider.hasUnsyncedChanges, 'the server accepted the edit');
  const unstored = await stored(doc);
  assert.ok(!stateText(unstored.ydoc_state).includes('Typed just now') && !unstored.content_text.includes('Typed just now'),
    'neither stored copy holds the edit yet');

  at('2026-11-26T10:00:00.000Z');
  const created = await call(people.member2, 'POST', listPath(doc), { name: '  Sent to client, v2  ' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.version.kind, 'named');
  assert.equal(created.body.version.name, 'Sent to client, v2');
  assert.equal(created.body.version.created_by, people.member2);
  assert.equal(created.body.version.title, 'Proposal');
  assert.equal(created.body.version.created_at, '2026-11-26T10:00:00.000Z');

  const shown = await call(people.member2, 'GET', `${listPath(doc)}/${created.body.version.id}`);
  assert.equal(shown.status, 200, JSON.stringify(shown.body));
  assert.equal(shown.body.version.id, created.body.version.id);
  assert.equal(shown.body.version.name, 'Sent to client, v2');
  const text = jsonToText(shown.body.version.content_json);
  assert.equal(text, 'Draft\n\nTyped just now', 'the version holds every edit the server accepted, stored or not');

  // The edit's own store comes later, and saves an automatic version then.
  at('2026-11-26T10:01:00.000Z');
  await pollUntil(() => events.some((e) => jsonToText(e.json).includes('Typed just now')), 'the edit is stored and derived', 10_000);
  const listed = await call(people.member, 'GET', listPath(doc));
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.versions.map((v: { kind: string; name: string | null }) => [v.kind, v.name]),
    [['auto', null], ['named', 'Sent to client, v2']], 'the automatic version from the store, then the named one');

  for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(201) }, { name: 7 }]) {
    const refused = await call(people.member, 'POST', listPath(doc), body);
    assert.equal(refused.status, 400, `refused: ${JSON.stringify(body)}`);
    assert.equal(refused.body.code, 'VALIDATION_ERROR');
  }
  assert.equal((await versionRows(doc)).length, 2, 'nothing else was saved');
});

test('restore creates a restore version and the live document shows the restored content', { skip: !url && SKIP }, async (t) => {
  const { people } = fx!;
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Restore me', json: canonical(paragraphs('Original text')) });
  // An automatic version at 14:00, so every live store until 14:10 is inside its window.
  at('2026-11-26T14:00:00.000Z');
  await edit(doc, 'Second paragraph');
  at('2026-11-26T14:05:00.000Z');
  const named = await call(people.member, 'POST', listPath(doc), { name: 'Before the rewrite' });
  assert.equal(named.status, 201, JSON.stringify(named.body));
  const original = (await versionRows(doc))[0]!;
  const restoredText = 'Original text\n\nSecond paragraph';
  assert.equal(jsonToText(original.content_json), restoredText);

  const editor = await open(t, doc, people.member);
  editor.typeText('Typed after the version');
  await pollUntil(() => !editor.provider.hasUnsyncedChanges, 'the live edit reached the server');

  at('2026-11-26T14:09:00.000Z');
  const restored = await call(people.member2, 'POST', `${listPath(doc)}/${named.body.version.id}/restore`);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));

  // Everyone connected sees the restored content, and so does the stored copy.
  await pollUntil(() => editor.text() === restoredText, `the live document shows the restored content (${editor.text()})`);
  assert.equal((await stored(doc)).content_text, restoredText);

  const rows = await versionRows(doc);
  assert.deepEqual(rows.map((r) => [r.kind, r.name]), [
    ['restore', 'Restored from 26 Nov 2026, 14:05 UTC'],
    ['restore', 'Before restore from 26 Nov 2026, 14:05 UTC'],
    ['named', 'Before the rewrite'],
    ['auto', null],
  ], 'the restore, the state before it, and the history kept; no automatic version inside the window');
  const [restore, before, kept, automatic] = rows;
  assert.equal(restore!.id, restored.body.version_id);
  assert.equal(restore!.created_by, people.member2);
  assert.equal(restore!.at, '2026-11-26T14:09:00.000Z');
  assert.equal(jsonToText(restore!.content_json), restoredText);
  assert.deepEqual(restore!.edit_details, { restored_version_id: named.body.version.id });
  // Nothing is lost: what was there just before the restore is a version of its own, just before the restore one.
  assert.equal(jsonToText(before!.content_json), `${restoredText}\n\nTyped after the version`, 'the state before the restore is kept');
  assert.equal(before!.at, '2026-11-26T14:08:59.999Z');
  assert.equal(before!.created_by, null);
  assert.deepEqual(before!.edit_details, { before_restore_of: named.body.version.id });
  // History is never rewritten.
  assert.equal(kept!.id, original.id);
  assert.deepEqual(kept!.content_json, original.content_json);
  assert.equal(automatic!.at, '2026-11-26T14:00:00.000Z');

  // The live document keeps working after the restore.
  editor.typeText('Typed after the restore');
  await pollUntil(() => !editor.provider.hasUnsyncedChanges, 'the next edit is accepted');
  assert.ok(editor.text().startsWith(restoredText));

  // The restore didn't move the automatic deadline: 10 minutes after 14:00, the next edit saves one.
  at('2026-11-26T14:10:00.000Z');
  await edit(doc, 'Edited at 14:10');
  const autos = (await versionRows(doc)).filter((r) => r.kind === 'auto').map((r) => r.at);
  assert.deepEqual(autos, ['2026-11-26T14:10:00.000Z', '2026-11-26T14:00:00.000Z']);
});

test('history needs can edit: a commenter and a guest get 403', { skip: !url && SKIP }, async () => {
  const { people } = fx!;
  const drive = await fx!.insertDrive({ kind: 'private', name: 'History' });
  await fx!.addDriveMember(drive, { user: people.member }, 'edit');
  const doc = await fx!.insertDocument({ driveId: drive, title: 'Client brief', json: canonical(paragraphs('Current')) });
  await fx!.share(doc, { user: people.member2 }, 'comment');
  await fx!.share(doc, { user: people.guest }, 'comment');
  const version = { id: await insertVersion(doc, canonical(paragraphs('Earlier')), 'v1') };
  const viewer = await fx!.addPerson({ role: 'member' });
  await fx!.share(doc, { user: viewer }, 'view');

  for (const userId of [people.member2, people.guest, viewer]) {
    for (const [method, path] of [
      ['GET', listPath(doc)],
      ['GET', `${listPath(doc)}/${version.id}`],
      ['POST', listPath(doc)],
      ['POST', `${listPath(doc)}/${version.id}/restore`],
    ] as const) {
      const res = await call(userId, method, path, method === 'POST' && !path.endsWith('/restore') ? { name: 'Mine' } : undefined);
      assert.equal(res.status, 403, `${method} ${path.replace(doc, ':id')} as ${userId === people.guest ? 'the guest' : 'a commenter or viewer'}`);
      assert.equal(res.body.code, 'FORBIDDEN_ROLE');
    }
  }
  assert.deepEqual((await versionRows(doc)).map((r) => r.id), [version.id], 'nothing was saved or restored');

  // It is the role that counts: a guest who can edit sees history.
  await fx!.share(doc, { user: people.guest }, 'edit');
  const listed = await call(people.guest, 'GET', listPath(doc));
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.versions.map((v: { id: string }) => v.id), [version.id]);
});

test('versions list newest first with kind, name and author', { skip: !url && SKIP }, async () => {
  const { people } = fx!;
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Listed', json: canonical(paragraphs('One')) });
  at('2026-11-26T11:00:00.000Z');
  await edit(doc, 'Two', people.member);
  at('2026-11-26T11:05:00.000Z');
  const named = await call(people.member2, 'POST', listPath(doc), { name: 'Checkpoint' });
  assert.equal(named.status, 201);
  const auto = (await versionRows(doc)).find((r) => r.kind === 'auto')!;
  at('2026-11-26T11:10:00.000Z');
  const restored = await call(people.member, 'POST', `${listPath(doc)}/${auto.id}/restore`);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));

  const listed = await call(people.member2, 'GET', listPath(doc));
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const versions = listed.body.versions as Array<Record<string, unknown>>;
  assert.deepEqual(versions.map((v) => [v.kind, v.name, v.created_by, v.created_at]), [
    ['restore', 'Restored from 26 Nov 2026, 11:00 UTC', people.member, '2026-11-26T11:10:00.000Z'],
    ['named', 'Checkpoint', people.member2, '2026-11-26T11:05:00.000Z'],
    ['auto', null, people.member, '2026-11-26T11:00:00.000Z'],
  ], 'newest first; the state before the restore was already the named version, so nothing extra was saved');
  for (const v of versions) {
    assert.deepEqual(Object.keys(v).sort(), ['agent_user_id', 'created_at', 'created_by', 'id', 'kind', 'name', 'size_bytes', 'title']);
    assert.equal(v.agent_user_id, null);
    assert.equal(v.title, 'Listed');
    assert.ok(typeof v.size_bytes === 'number' && v.size_bytes > 0);
    assert.equal('content_json' in v, false, 'the list carries no content');
  }
  assert.equal(listed.body.next_before, null);

  // Pages, newest first.
  const first = await call(people.member2, 'GET', `${listPath(doc)}?limit=2`);
  assert.deepEqual(first.body.versions.map((v: { kind: string }) => v.kind), ['restore', 'named']);
  assert.equal(first.body.next_before, first.body.versions[1].id);
  const second = await call(people.member2, 'GET', `${listPath(doc)}?limit=2&before=${first.body.next_before}`);
  assert.deepEqual(second.body.versions.map((v: { kind: string }) => v.kind), ['auto']);
  assert.equal(second.body.next_before, null);
  for (const query of ['?limit=0', '?limit=201', '?limit=x']) {
    assert.equal((await call(people.member2, 'GET', `${listPath(doc)}${query}`)).status, 400, query);
  }
});

// ---------------------------------------------------------------------------
// Added: in_current, the size cap on a restore, 404 before 403

async function insertFile(): Promise<string> {
  const id = randomUUID();
  fileIds.push(id);
  await fx!.client.query(`INSERT INTO files (id, org_id, uploaded_by, filename, mime_type, size_bytes, storage_key)
    VALUES ($1, $2, $3, 'image.png', 'image/png', 10, $4)`, [id, fx!.orgId, fx!.people.member, `test/${id}`]);
  return id;
}

async function attach(documentId: string, fileId: string): Promise<void> {
  await fx!.client.query(`INSERT INTO document_attachments (id, org_id, document_id, file_id, in_current, added_by)
    VALUES ($1, $2, $3, $4, true, $5)`, [randomUUID(), fx!.orgId, documentId, fileId, fx!.people.member]);
}

async function inCurrent(documentId: string): Promise<Record<string, boolean>> {
  const { rows } = await fx!.client.query('SELECT file_id, in_current FROM document_attachments WHERE document_id = $1', [documentId]);
  return Object.fromEntries((rows as Array<{ file_id: string; in_current: boolean }>).map((r) => [r.file_id, r.in_current]));
}

const image = (fileId: string, alt: string): JSONContent => ({ type: 'image', attrs: { fileId, alt } });

test('in_current follows the current content: an image removed is false, restored is true, only for that document', { skip: !url && SKIP }, async () => {
  const { people } = fx!;
  const [kept, removed, stale] = [await insertFile(), await insertFile(), await insertFile()];
  const doc = await fx!.insertDocument({
    driveId: fx!.workspaceDriveId, title: 'Pictures',
    json: canonical({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Pictures' }] },
      image(kept, 'kept'),
      // The second image sits inside a table cell: file ids are found at any depth.
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [image(removed, 'removed')] }] }] },
    ] }),
  });
  for (const file of [kept, removed, stale]) await attach(doc, file);
  // Another document's row for the same file, which is not in that document's content.
  const other = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Elsewhere', json: canonical(paragraphs('No pictures')) });
  await attach(other, removed);

  at('2026-11-26T12:00:00.000Z');
  const named = await call(people.member, 'POST', listPath(doc), { name: 'With both pictures' });
  assert.equal(named.status, 201);

  at('2026-11-26T12:05:00.000Z');
  await writeDocument({
    orgId: fx!.orgId, documentId: doc, actor: { kind: 'user', userId: people.member }, reason: 'import',
    mutate: (d) => {
      const fragment = d.getXmlFragment('default');
      const index = fragment.toArray().findIndex((node) => node instanceof Y.XmlElement && node.nodeName === 'table');
      fragment.delete(index, 1);
    },
  });
  assert.deepEqual(await inCurrent(doc), { [kept]: true, [removed]: false, [stale]: false }, 'only files still in the content stay current');
  assert.deepEqual(await inCurrent(other), { [removed]: true }, 'another document’s rows are left alone');

  at('2026-11-26T12:10:00.000Z');
  const restored = await call(people.member, 'POST', `${listPath(doc)}/${named.body.version.id}/restore`);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.deepEqual(await inCurrent(doc), { [kept]: true, [removed]: true, [stale]: false }, 'a restore brings the image back into the current content');
});

test('a restore over the size cap is refused with 413 and changes nothing', { skip: !url && SKIP }, async (t) => {
  const { people } = fx!;
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Big history', json: canonical(paragraphs('Small now')) });
  at('2026-11-26T13:00:00.000Z');
  const big = { id: await insertVersion(doc, canonical(paragraphs(bigText(100_000))), 'Huge') };
  t.after(setCollabLimitsForTest({ docMaxBytes: 65_536 }));
  const before = await stored(doc);
  at('2026-11-26T13:05:00.000Z');
  const refused = await call(people.member, 'POST', `${listPath(doc)}/${big.id}/restore`);
  assert.equal(refused.status, 413, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'TOO_LARGE');
  const after = await stored(doc);
  assert.equal(after.revision, before.revision, 'the document is unchanged');
  assert.equal(after.content_text, 'Small now');
  assert.deepEqual((await versionRows(doc)).map((r) => r.id), [big.id], 'no restore version and no other version was saved');
});

/** Adds a CHECK constraint that refuses every new or changed `table` row of the document (an injected failure); returns the drop. */
async function failRowsOf(table: 'document_versions' | 'document_attachments', documentId: string) {
  const constraint = `f8_fault_${table}_${documentId.replaceAll('-', '').slice(0, 12)}`;
  await fx!.client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (document_id <> '${documentId}') NOT VALID`);
  let dropped = false;
  return async () => {
    if (dropped) return;
    dropped = true;
    await fx!.client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint}`);
  };
}

test('a restore whose history can’t be saved changes nothing: content, stored state and the live document stay, and no history row exists', { skip: !url && SKIP }, async (t) => {
  const { people } = fx!;
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'All or nothing', json: canonical(paragraphs('Kept as it is')) });
  const old = await insertVersion(doc, canonical(paragraphs('Old content')), 'Old');
  const events = storedEvents(t, doc);
  at('2026-11-26T16:00:00.000Z');
  const editor = await open(t, doc, people.member);
  editor.typeText('Typed and stored');
  await pollUntil(() => events.some((e) => jsonToText(e.json).includes('Typed and stored')), 'the live edit is stored and derived', 10_000);
  const before = await stored(doc);
  const historyBefore = (await versionRows(doc)).map((r) => r.id);

  const drop = await failRowsOf('document_versions', doc);
  t.after(drop);
  at('2026-11-26T16:05:00.000Z');
  const refused = await call(people.member2, 'POST', `${listPath(doc)}/${old}/restore`);
  await drop();
  assert.equal(refused.status, 500, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'INTERNAL_ERROR');

  const after = await stored(doc);
  assert.equal(after.revision, before.revision, 'the store rolled back with the history');
  assert.equal(after.content_text, before.content_text);
  assert.ok(after.ydoc_state!.equals(before.ydoc_state!), 'the stored state is unchanged');
  // A round trip: anything the server sent before acknowledging this probe has arrived.
  editor.typeText('Probe');
  await pollUntil(() => !editor.provider.hasUnsyncedChanges, 'the probe is accepted');
  assert.equal(editor.text(), 'Kept as it is\n\nTyped and stored\n\nProbe', 'the live document never took the restore');
  assert.deepEqual((await versionRows(doc)).map((r) => r.id), historyBefore, 'no history row exists');
});

test('a failed in_current update queues a reconcile job, which puts the flags right with no further edits', { skip: !url && SKIP }, async (t) => {
  const { people } = fx!;
  const [kept, removed] = [await insertFile(), await insertFile()];
  const doc = await fx!.insertDocument({
    driveId: fx!.workspaceDriveId, title: 'Reconcile', json: canonical({ type: 'doc', content: [image(kept, 'kept'), image(removed, 'removed')] }),
  });
  for (const file of [kept, removed]) await attach(doc, file);

  // The listener's update fails after the content has committed.
  const drop = await failRowsOf('document_attachments', doc);
  t.after(drop);
  at('2026-11-26T16:30:00.000Z');
  await writeDocument({
    orgId: fx!.orgId, documentId: doc, actor: { kind: 'user', userId: people.member }, reason: 'import',
    mutate: (d) => {
      const fragment = d.getXmlFragment('default');
      const index = fragment.toArray().findIndex((node) => node instanceof Y.XmlElement && node.getAttribute('fileId') === removed);
      fragment.delete(index, 1);
    },
  });
  await drop();
  assert.deepEqual(await inCurrent(doc), { [kept]: true, [removed]: true }, 'the flags are wrong until the job runs');

  const { rows: jobs } = await fx!.client.query(`SELECT id, name, data, org_id, dedupe_key, status FROM job_queue
    WHERE org_id = $1 AND name = 'document-attachments-reconcile' AND data->>'document_id' = $2`, [fx!.orgId, doc]);
  assert.equal(jobs.length, 1, 'one durable job was queued');
  const job = jobs[0] as { id: string; name: string; data: Record<string, unknown>; org_id: string; dedupe_key: string; status: string };
  assert.equal(job.status, 'pending');
  assert.equal(job.dedupe_key, `document-attachments-reconcile:${doc}:${(await stored(doc)).revision}`, 'keyed by document and revision (rule C1)');

  const handler = await _getAgentJobHandlerForTest('document-attachments-reconcile');
  assert.ok(handler, 'the job has a handler');
  await handler({ id: job.id, name: job.name, data: job.data, attempts: 1, orgId: job.org_id });
  assert.deepEqual(await inCurrent(doc), { [kept]: true, [removed]: false }, 'recomputed from the stored content');
  await handler({ id: job.id, name: job.name, data: job.data, attempts: 2, orgId: job.org_id });
  assert.deepEqual(await inCurrent(doc), { [kept]: true, [removed]: false }, 'running it again changes nothing');
});

test('late attachment listeners can’t leave stale flags: stores A, B, C commit first, A fails, its job runs, B runs late, C fails', { skip: !url && SKIP }, async (t) => {
  const { people } = fx!;
  const [one, two, three] = [await insertFile(), await insertFile(), await insertFile()];
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Interleaved', json: canonical({ type: 'doc', content: [image(one, 'one')] }) });
  for (const file of [one, two, three]) await attach(doc, file);

  // A gate that runs first in every listener run for this document, so each run waits until the test lets it go.
  const arrivals: Array<() => void> = [];
  stopVersioning!();
  const gateOff = onDocumentStored(async (e) => {
    if (e.documentId !== doc) return;
    await new Promise<void>((resolve) => { arrivals.push(resolve); });
  });
  stopVersioning = startDocumentVersioning();
  t.after(gateOff);

  const revision = async () => Number((await stored(doc)).revision);
  const write = (mutate: (d: Y.Doc) => void) =>
    writeDocument({ orgId: fx!.orgId, documentId: doc, actor: { kind: 'user', userId: people.member }, reason: 'import', mutate });
  const addImage = (fileId: string) => (d: Y.Doc) => {
    const element = new Y.XmlElement('image');
    element.setAttribute('fileId', fileId);
    d.getXmlFragment('default').push([element]);
  };
  const removeImage = (fileId: string) => (d: Y.Doc) => {
    const fragment = d.getXmlFragment('default');
    fragment.delete(fragment.toArray().findIndex((node) => node instanceof Y.XmlElement && node.getAttribute('fileId') === fileId), 1);
  };
  const jobs = async () => (await fx!.client.query(`SELECT id, name, data, org_id, dedupe_key, status FROM job_queue
    WHERE org_id = $1 AND name = 'document-attachments-reconcile' AND data->>'document_id' = $2`, [fx!.orgId, doc]))
    .rows as Array<{ id: string; name: string; data: Record<string, unknown>; org_id: string; dedupe_key: string; status: string }>;
  const handler = (await _getAgentJobHandlerForTest('document-attachments-reconcile'))!;
  /** Runs every pending job for the document and marks it completed, as a worker would. */
  const runPendingJobs = async () => {
    for (const job of (await jobs()).filter((j) => j.status === 'pending')) {
      await handler({ id: job.id, name: job.name, data: job.data, attempts: 1, orgId: job.org_id });
      await fx!.client.query(`UPDATE job_queue SET status = 'completed', completed_at = now() WHERE id = $1`, [job.id]);
    }
  };

  // Stores A, B and C all commit before any of their listeners runs.
  at('2026-11-26T18:00:00.000Z');
  const start = await revision();
  const writes = [write(addImage(two))]; // A: one, two
  await pollUntil(async () => (await revision()) === start + 1 && arrivals.length === 1, 'store A committed, its run waits');
  writes.push(write(removeImage(one))); // B: two
  await pollUntil(async () => (await revision()) === start + 2, 'store B committed');
  writes.push(write(addImage(three))); // C: two, three
  await pollUntil(async () => (await revision()) === start + 3, 'store C committed');
  const [revA, revC] = [start + 1, start + 3];

  // A's listener fails; its job runs (from whatever is stored then) and finishes.
  let drop = await failRowsOf('document_attachments', doc);
  t.after(drop);
  arrivals[0]!();
  await pollUntil(() => arrivals.length === 2, 'A’s run is over and B’s waits');
  await drop();
  const firstJobKey = (await jobs())[0]?.dedupe_key ?? null;
  await runPendingJobs();
  // B's listener runs late, after C's store; then C's listener fails.
  arrivals[1]!();
  await pollUntil(() => arrivals.length === 3, 'B’s run is over and C’s waits');
  drop = await failRowsOf('document_attachments', doc);
  t.after(drop);
  arrivals[2]!();
  await Promise.all(writes);
  await drop();

  assert.deepEqual({ firstJobKey, flags: await inCurrent(doc) }, {
    firstJobKey: `document-attachments-reconcile:${doc}:${revA}`,
    flags: { [one]: false, [two]: true, [three]: true },
  }, `A’s job is keyed by A’s own store (not the latest, ${revC}), and the flags match the latest stored content`);
  await runPendingJobs();
  assert.deepEqual(await inCurrent(doc), { [one]: false, [two]: true, [three]: true }, 'any job still queued leaves them right');
});

test('concurrent named versions of documents nobody has open all complete: the cold read uses the transaction’s connection', { skip: !url && SKIP }, async () => {
  const { people } = fx!;
  // More requests than the pool's 4 ordinary connections, each holding one in its transaction.
  const docs: string[] = [];
  for (let k = 0; k < 8; k += 1) docs.push(await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: `Cold ${k}`, json: canonical(paragraphs(`Cold text ${k}`)) }));
  at('2026-11-26T18:30:00.000Z');
  const startedAt = Date.now();
  const results = await Promise.all(docs.map((doc) => call(people.member, 'POST', listPath(doc), { name: 'Cold' })));
  const took = Date.now() - startedAt;
  assert.deepEqual(results.map((r) => r.status), docs.map(() => 201), JSON.stringify(results.map((r) => r.body)));
  assert.ok(took < 4_000, `they finished without waiting for a pool connection (${took} ms)`);
  for (const [k, doc] of docs.entries()) {
    const [version] = await versionRows(doc);
    assert.equal(jsonToText(version!.content_json), `Cold text ${k}`);
  }
});

test('restore brings back the version’s title: the document and the restore version carry it', { skip: !url && SKIP }, async (t) => {
  const { people } = fx!;
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Historical title', json: canonical(paragraphs('Historical text')) });
  // An automatic version at 16:58 keeps the live edit's store (if it lands first) inside the window.
  at('2026-11-26T16:58:00.000Z');
  await edit(doc, 'Second line');
  at('2026-11-26T17:00:00.000Z');
  const named = await call(people.member, 'POST', listPath(doc), { name: 'Historical' });
  assert.equal(named.status, 201);
  assert.equal(named.body.version.title, 'Historical title');
  const renamed = await call(people.member, 'PATCH', `/api/documents/${doc}`, { title: 'New title' });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  const editor = await open(t, doc, people.member);
  editor.typeText('Live edit');
  await pollUntil(() => !editor.provider.hasUnsyncedChanges, 'the live edit is accepted');

  at('2026-11-26T17:05:00.000Z');
  const restored = await call(people.member2, 'POST', `${listPath(doc)}/${named.body.version.id}/restore`);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  await pollUntil(() => editor.text() === 'Historical text\n\nSecond line', `the content came back (${editor.text()})`);
  const { rows: [row] } = await fx!.client.query('SELECT title FROM documents WHERE id = $1', [doc]);
  assert.equal((row as { title: string }).title, 'Historical title', 'the document has its old title back');
  const rows = await versionRows(doc);
  const restore = rows.find((r) => r.id === restored.body.version_id)!;
  assert.equal(restore.name, 'Restored from 26 Nov 2026, 17:00 UTC');
  assert.equal(restore.title, 'Historical title', 'the restore version records the restored title');
  const before = rows.find((r) => r.name === 'Before restore from 26 Nov 2026, 17:00 UTC');
  assert.ok(before, 'the state before the restore was kept');
  assert.equal(before.title, 'New title', 'and it keeps the title it had');
  assert.ok(jsonToText(before.content_json).includes('Live edit'));
});

test('history answers 404 before 403: a document the caller can’t see is 404 on every route, whatever the version', { skip: !url && SKIP }, async () => {
  const { people } = fx!;
  const drive = await fx!.insertDrive({ kind: 'private', name: 'Hidden' });
  await fx!.addDriveMember(drive, { user: people.member }, 'edit');
  const doc = await fx!.insertDocument({ driveId: drive, title: 'Hidden', json: canonical(paragraphs('Secret')) });
  const version = { id: await insertVersion(doc, canonical(paragraphs('Secret, earlier')), 'v1') };
  const elsewhere = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Elsewhere', json: canonical(paragraphs('Open')) });
  const foreign = { id: await insertVersion(elsewhere, canonical(paragraphs('Open, earlier')), 'other') };
  const deleted = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Gone', deleted: true });

  const routes = (documentId: string, versionId: string) => [
    ['GET', listPath(documentId), undefined],
    ['GET', `${listPath(documentId)}/${versionId}`, undefined],
    ['POST', listPath(documentId), { name: 'Mine' }],
    ['POST', `${listPath(documentId)}/${versionId}/restore`, undefined],
  ] as const;

  // Someone in another workspace, and a member with no access: 404 for a real version and a made-up one alike.
  for (const userId of [people.outsider, people.member2]) {
    for (const versionId of [version.id, randomUUID()]) {
      for (const [method, path, body] of routes(doc, versionId)) {
        const res = await call(userId, method, path, body);
        assert.equal(res.status, 404, `${method} ${path} as ${userId === people.outsider ? 'an outsider' : 'a member without access'}`);
        assert.equal(res.body.code, 'NOT_FOUND');
      }
    }
  }
  // A deleted document is 404 to its editors too.
  for (const [method, path, body] of routes(deleted, randomUUID())) {
    assert.equal((await call(people.member, method, path, body)).status, 404, `${method} ${path} on a deleted document`);
  }
  // Once the caller can see the document, a role below edit is 403, before any version is looked up.
  await fx!.share(doc, { user: people.member2 }, 'comment');
  for (const [method, path, body] of routes(doc, randomUUID())) {
    const res = await call(people.member2, method, path, body);
    assert.equal(res.status, 403, `${method} ${path} as a commenter`);
  }
  // An editor asking for another document's version, or none, gets 404 VERSION_NOT_FOUND.
  for (const versionId of [foreign.id, randomUUID()]) {
    for (const [method, path] of [['GET', `${listPath(doc)}/${versionId}`], ['POST', `${listPath(doc)}/${versionId}/restore`]] as const) {
      const res = await call(people.member, method, path);
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.equal(res.body.code, 'VERSION_NOT_FOUND');
    }
  }
  assert.deepEqual((await versionRows(doc)).map((r) => r.id), [version.id], 'nothing was saved or restored');
});

test('createVersion records the title, takes the current content by default or a Y.Doc, and stores one agent version per action', { skip: !url && SKIP }, async () => {
  const { people } = fx!;
  const doc = await fx!.insertDocument({ driveId: fx!.workspaceDriveId, title: 'Library', json: canonical(paragraphs('From the row')) });
  at('2026-11-26T15:00:00.000Z');
  const fromRow = await createVersion({ orgId: fx!.orgId, documentId: doc, kind: 'named', name: 'Current', createdBy: people.member });
  const ydoc = jsonToYDoc(paragraphs('From a Y.Doc'));
  at('2026-11-26T15:01:00.000Z');
  const fromYDoc = await createVersion({ orgId: fx!.orgId, documentId: doc, kind: 'import', createdBy: people.member, ydoc });
  ydoc.destroy();
  const byId = new Map((await versionRows(doc)).map((r) => [r.id, r]));
  assert.equal(byId.get(fromRow.id)!.title, 'Library');
  assert.equal(jsonToText(byId.get(fromRow.id)!.content_json), 'From the row');
  assert.equal(byId.get(fromRow.id)!.at, '2026-11-26T15:00:00.000Z');
  const imported = byId.get(fromYDoc.id)!;
  assert.equal(imported.kind, 'import');
  assert.equal(jsonToText(imported.content_json), 'From a Y.Doc');
  assert.equal(typeof (imported.content_json.content?.[0]?.attrs as { id?: unknown } | undefined)?.id, 'string', 'blocks carry ids');

  const actionId = randomUUID();
  const agent = (text: string) => createVersion({
    orgId: fx!.orgId, documentId: doc, kind: 'agent', name: 'Agent, at member’s request: tidy', createdBy: people.member,
    agentUserId: people.agentUser, actionId, editDetails: { action_id: actionId }, json: canonical(paragraphs(text)),
  });
  const first = await agent('Agent edit');
  const again = await agent('Agent edit, retried');
  assert.equal(again.id, first.id, 'a retried agent edit stores no second version');
  const agentRows = (await versionRows(doc)).filter((r) => r.kind === 'agent');
  assert.equal(agentRows.length, 1);
  assert.equal(agentRows[0]!.agent_user_id, people.agentUser);
  assert.equal(jsonToText(agentRows[0]!.content_json), 'Agent edit');

  // The document must be in the workspace named.
  await assert.rejects(createVersion({ orgId: fx!.otherOrgId, documentId: doc, kind: 'named', name: 'Wrong workspace', createdBy: people.outsider }));
});
