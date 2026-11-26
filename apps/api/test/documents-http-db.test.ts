/**
 * Folders and documents over HTTP (routes/documents.ts, routes/doc-folders.ts,
 * the tree and trash routes of routes/drives.ts, lib/documents.ts): creating
 * them, sub-pages, the breadcrumb, moving, the trash, favourites and the
 * recent list. Moves and deletes run the access-loss path (consult rule C3)
 * and events follow rule C4: `document:updated` carries ids only and reaches
 * each viewer.
 *
 * As in drives-http-db.test.ts, an `onAccessLossInTx` hook registered once
 * for the file records each access loss with the id of the transaction it
 * ran in (`txid_current_if_assigned()`, set only inside a transaction that
 * has already written), so a recorded id shows the hook ran inside the
 * change's own transaction.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/documents-http-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import test, { after, before, mock } from 'node:test';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { closeDb, db } from '../src/lib/db.js';
import { documentRoleFor } from '../src/lib/document-access.js';
import { onDocumentAccessChanged, type DocumentAccessChange } from '../src/lib/document-access-events.js';
import { currentAccessGeneration, onAccessLossInTx } from '../src/lib/document-access-change.js';
import { onDocumentEvent, type DocumentLifecycleEvent } from '../src/lib/document-events.js';
import * as documentsLib from '../src/lib/documents.js';
import { docFolderRoutes } from '../src/routes/doc-folders.js';
import { documentRoutes } from '../src/routes/documents.js';
import { driveRoutes } from '../src/routes/drives.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { socketHarness, waitFor } from './fixtures/drives-socket.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const SKIP = 'Set DEFT_TEST_DATABASE_URL to a disposable test database';
const ROUTES = [
  { path: '/api/drives', app: driveRoutes },
  { path: '/api/documents', app: documentRoutes },
  { path: '/api/doc-folders', app: docFolderRoutes },
];
let fx: DrivesFixture | undefined;

const lossesInTx: Array<{ change: DocumentAccessChange; txid: string | null }> = [];
const accessChanges: DocumentAccessChange[] = [];
const lifecycle: DocumentLifecycleEvent[] = [];
const unsubscribe: Array<() => void> = [];

before(async () => {
  if (!url) return;
  fx = await setupDrivesFixture('documents-http', { routes: ROUTES });
  onAccessLossInTx(async (tx, change) => {
    const result = await tx.execute(sql`SELECT txid_current_if_assigned()::text AS txid`);
    lossesInTx.push({ change, txid: (result.rows[0] as { txid: string | null }).txid });
    return [];
  });
  unsubscribe.push(onDocumentAccessChanged((change) => { accessChanges.push(change); }));
  unsubscribe.push(onDocumentEvent((event) => { lifecycle.push(event); }));
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
  lifecycle.length = 0;
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

/** A private drive with `manager` holding full access. */
async function privateDrive(manager: string, name?: string): Promise<string> {
  const drive = await fx!.insertDrive({ kind: 'private', name });
  await fx!.addDriveMember(drive, { user: manager }, 'full');
  return drive;
}

async function rows(ids: string[]): Promise<Map<string, any>> {
  const { rows: found } = await fx!.client.query(`SELECT id, drive_id, folder_id, parent_document_id, title, position, is_deleted,
      deleted_at, deleted_by FROM documents WHERE id = ANY($1::text[])`, [ids]);
  return new Map(found.map((row) => [row.id, row]));
}

const paragraph = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const sorted = (ids: string[]) => [...ids].sort();

test('a document created with no drive goes to My drive, and My drive is created once', async (t) => {
  if (!fx) return t.skip(SKIP);
  const person = await fx.addPerson();
  resetEvents();
  const first = (await call(person, 'POST', '/api/documents', { title: 'First' }, 201)).document;
  const second = (await call(person, 'POST', '/api/documents', { json: paragraph('Hello there') }, 201)).document;
  const { rows: personal } = await fx.client.query(`SELECT id, name FROM drives WHERE org_id = $1 AND owner_user_id = $2 AND kind = 'personal'`,
    [fx.orgId, person]);
  assert.equal(personal.length, 1, 'one My drive');
  assert.equal(personal[0].name, 'My drive');
  assert.equal(first.drive_id, personal[0].id);
  assert.equal(second.drive_id, personal[0].id);
  assert.equal(first.title, 'First');
  assert.ok(second.position > first.position, 'a new document goes after its siblings');
  const { rows: stored } = await fx.client.query(`SELECT id, content_json, content_text, ydoc_state, created_by, last_edited_by
    FROM documents WHERE id = ANY($1::text[]) ORDER BY title`, [[first.id, second.id]]);
  const byId = new Map(stored.map((row) => [row.id, row]));
  assert.equal(byId.get(second.id).content_text, 'Hello there');
  assert.equal(byId.get(first.id).content_json.type, 'doc', 'an empty document');
  for (const row of stored) {
    assert.equal(row.ydoc_state, null, 'the live state waits for the first live load');
    assert.ok(row.content_json.content[0].attrs.id, 'blocks carry ids');
    assert.equal(row.created_by, person);
    assert.equal(row.last_edited_by, person);
  }
  assert.ok(lifecycle.some((event) => event.type === 'created' && isDeepStrictEqual(event.documentIds, [first.id]) && event.actorId === person));
  // Content outside the schema is refused.
  const invalid = await call(person, 'POST', '/api/documents', { json: { type: 'doc', content: [{ type: 'no_such_node' }] } }, 400);
  assert.equal(invalid.code, 'VALIDATION_ERROR');
});

test('a folder from another drive is refused with 400 FOLDER_NOT_IN_DRIVE', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const elsewhere = await privateDrive(member);
  const foreignFolder = await fx.insertFolder({ driveId: elsewhere });
  const refused = await call(member, 'POST', '/api/documents', { drive_id: fx.workspaceDriveId, folder_id: foreignFolder, title: 'x' }, 400);
  assert.equal(refused.code, 'FOLDER_NOT_IN_DRIVE');
  const folderRefused = await call(member, 'POST', '/api/doc-folders', { drive_id: fx.workspaceDriveId, parent_folder_id: foreignFolder, name: 'x' }, 400);
  assert.equal(folderRefused.code, 'FOLDER_NOT_IN_DRIVE');
  const here = await fx.insertFolder({ driveId: fx.workspaceDriveId });
  const created = (await call(member, 'POST', '/api/documents', { drive_id: fx.workspaceDriveId, folder_id: here }, 201)).document;
  assert.equal(created.folder_id, here);
});

test('a frozen drive gives no edit: nothing is created in it', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const frozen = await fx.insertDrive({ kind: 'private', frozen: true });
  await fx.addDriveMember(frozen, { user: member }, 'full');
  assert.equal((await call(member, 'POST', '/api/documents', { drive_id: frozen, title: 'x' }, 404)).code, 'NOT_FOUND');
  assert.equal((await call(member, 'POST', '/api/doc-folders', { drive_id: frozen, name: 'x' }, 404)).code, 'NOT_FOUND');
  const { rows: [{ count }] } = await fx.client.query('SELECT count(*)::int AS count FROM documents WHERE drive_id = $1', [frozen]);
  assert.equal(count, 0);
});

test("a sub-page lives in its parent's drive", async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const drive = await privateDrive(member);
  const parent = await fx.insertDocument({ driveId: drive, title: 'Parent' });
  const sub = (await call(member, 'POST', '/api/documents', { parent_document_id: parent, title: 'Sub' }, 201)).document;
  assert.equal(sub.drive_id, drive);
  assert.equal(sub.parent_document_id, parent);
  assert.equal(sub.folder_id, null);
  const elsewhere = await call(member, 'POST', '/api/documents', { drive_id: fx.workspaceDriveId, parent_document_id: parent }, 400);
  assert.equal(elsewhere.code, 'PARENT_NOT_IN_DRIVE');
  const folder = await fx.insertFolder({ driveId: drive });
  const both = await call(member, 'POST', '/api/documents', { drive_id: drive, folder_id: folder, parent_document_id: parent }, 400);
  assert.equal(both.code, 'VALIDATION_ERROR');
  // A parent the caller can't see is not found.
  assert.equal((await call(fx.people.member2, 'POST', '/api/documents', { parent_document_id: parent }, 404)).code, 'NOT_FOUND');
});

test("GET returns role, breadcrumb and live; someone who can't see it gets 404", async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2, guest, outsider, agentUser } = fx.people;
  const drive = await privateDrive(member, 'Plans');
  const folder = await fx.insertFolder({ driveId: drive });
  const doc = await fx.insertDocument({ driveId: drive, folderId: folder, title: 'Roadmap', json: paragraph('Quarterly roadmap') });
  const sub = await fx.insertDocument({ driveId: drive, parentDocumentId: doc, title: 'Q1' });
  const got = (await call(member, 'GET', `/api/documents/${doc}`, undefined, 200)).document;
  assert.equal(got.role, 'full');
  assert.equal(got.live, true);
  assert.equal(got.title, 'Roadmap');
  assert.equal(got.folder_id, folder);
  assert.equal(got.content_json, undefined, 'content comes through live editing');
  assert.deepEqual(got.drive, { id: drive, name: 'Plans', kind: 'private' });
  assert.deepEqual(got.breadcrumb, [
    { type: 'drive', id: drive, title: 'Plans' },
    { type: 'folder', id: folder, title: 'Folder' },
    { type: 'document', id: doc, title: 'Roadmap' },
  ]);
  const withContent = (await call(member, 'GET', `/api/documents/${doc}?content=1`, undefined, 200)).document;
  assert.equal(withContent.content_json.content[0].content[0].text, 'Quarterly roadmap');
  const subPage = (await call(member, 'GET', `/api/documents/${sub}`, undefined, 200)).document;
  assert.deepEqual(subPage.breadcrumb.map((crumb: any) => crumb.id), [drive, folder, doc, sub]);
  for (const stranger of [member2, guest, outsider, agentUser]) {
    assert.equal((await call(stranger, 'GET', `/api/documents/${doc}`, undefined, 404)).code, 'NOT_FOUND');
  }
});

test('a document shared on its own shows "Shared with you" instead of its hidden folders and parent page', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, guest } = fx.people;
  const drive = await privateDrive(member, 'Secret drive');
  const folder = await fx.insertFolder({ driveId: drive });
  const parent = await fx.insertDocument({ driveId: drive, folderId: folder, title: 'Secret parent' });
  const child = await fx.insertDocument({ driveId: drive, parentDocumentId: parent, title: 'Shared child' });
  await fx.share(child, { user: guest }, 'view');
  const res = await fx.request(guest, 'GET', `/api/documents/${child}`);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const got = JSON.parse(text).document;
  assert.equal(got.role, 'view');
  assert.deepEqual(got.breadcrumb, [
    { type: 'shared', title: 'Shared with you' },
    { type: 'document', id: child, title: 'Shared child' },
  ]);
  assert.deepEqual(got.drive, { id: drive, name: null, kind: null }, 'the drive is named only to those who can view it');
  for (const hidden of ['Secret drive', 'Secret parent', 'Folder']) assert.ok(!text.includes(hidden), `no "${hidden}"`);
  // With the parent page shared too, it shows; the drive and folder still don't.
  await fx.share(parent, { user: guest }, 'view');
  const again = (await call(guest, 'GET', `/api/documents/${child}`, undefined, 200)).document;
  assert.deepEqual(again.breadcrumb, [
    { type: 'shared', title: 'Shared with you' },
    { type: 'document', id: parent, title: 'Secret parent' },
    { type: 'document', id: child, title: 'Shared child' },
  ]);
});

test("a viewer can't rename (403 FORBIDDEN_ROLE)", async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2, guest } = fx.people;
  const drive = await privateDrive(member);
  const doc = await fx.insertDocument({ driveId: drive, title: 'Original' });
  await fx.share(doc, { user: guest }, 'view');
  assert.equal((await call(guest, 'PATCH', `/api/documents/${doc}`, { title: 'Renamed' }, 403)).code, 'FORBIDDEN_ROLE');
  assert.equal((await call(member2, 'PATCH', `/api/documents/${doc}`, { title: 'Renamed' }, 404)).code, 'NOT_FOUND');
  assert.equal((await call(member, 'PATCH', `/api/documents/${doc}`, { content: 'x' }, 400)).code, 'VALIDATION_ERROR', 'only title, icon and template');
  assert.equal((await rows([doc])).get(doc).title, 'Original');
  const renamed = (await call(member, 'PATCH', `/api/documents/${doc}`, { title: 'Renamed', icon: '📄', is_template: true }, 200)).document;
  assert.equal(renamed.title, 'Renamed');
  assert.equal(renamed.icon, '📄');
  assert.equal(renamed.is_template, true);
});

test('renaming emits document:updated carrying only the id and drive id, to org members and to a guest who holds a share', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { agentUser, guest, member, member2, owner } = fx.people;
  const doc = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Before' });
  await fx.share(doc, { user: guest }, 'view');
  const harness = await socketHarness(fx.orgId, [owner, member2, guest, agentUser]);
  try {
    await call(member, 'PATCH', `/api/documents/${doc}`, { title: 'After' }, 200);
    const expected = { id: doc, drive_id: fx.workspaceDriveId };
    await waitFor(() => [owner, member2, guest].every((id) => harness.updates(id).length > 0), 'the viewers are told');
    await new Promise((r) => setTimeout(r, 300));
    for (const viewer of [owner, member2, guest]) assert.deepEqual(harness.updates(viewer), [expected]);
    assert.deepEqual(harness.updates(agentUser), [], 'an agent in the org-members room with no grant is not told');
    for (const update of harness.updates(guest)) assert.deepEqual(Object.keys(update).sort(), ['drive_id', 'id'], 'ids only, no title');
  } finally {
    await harness.close();
  }
});

test('moving a document with sub-pages into a private drive moves the sub-pages, needs edit on both drives, and emits access and lifecycle events', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { guest, member, member2, owner } = fx.people;
  const doc = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Moving' });
  const sub = await fx.insertDocument({ driveId: fx.workspaceDriveId, parentDocumentId: doc, title: 'Sub' });
  const subsub = await fx.insertDocument({ driveId: fx.workspaceDriveId, parentDocumentId: sub, title: 'Subsub' });
  const target = await privateDrive(member, 'Target');
  await fx.addDriveMember(target, { user: member2 }, 'view');
  // View on the target isn't enough; nor is edit on the target with view on the source.
  assert.equal((await call(member2, 'POST', `/api/documents/${doc}/move`, { drive_id: target }, 403)).code, 'FORBIDDEN_ROLE');
  const viewSource = await fx.insertDrive({ kind: 'open', defaultRole: 'view' });
  const viewOnly = await fx.insertDocument({ driveId: viewSource });
  assert.equal((await call(member, 'POST', `/api/documents/${viewOnly}/move`, { drive_id: target }, 403)).code, 'FORBIDDEN_ROLE');
  // A drive the caller can't see, or a document they can't see, is not found.
  const hidden = await fx.insertDrive({ kind: 'private' });
  assert.equal((await call(member, 'POST', `/api/documents/${doc}/move`, { drive_id: hidden }, 404)).code, 'NOT_FOUND');
  assert.equal((await call(guest, 'POST', `/api/documents/${doc}/move`, { drive_id: target }, 404)).code, 'NOT_FOUND');
  assert.equal((await rows([doc])).get(doc).drive_id, fx.workspaceDriveId, 'nothing moved yet');

  const harness = await socketHarness(fx.orgId, [owner, member]);
  try {
    resetEvents();
    const generation = currentAccessGeneration();
    const moved = await call(member, 'POST', `/api/documents/${doc}/move`, { drive_id: target }, 200);
    const ids = sorted([doc, sub, subsub]);
    assert.deepEqual(sorted(moved.moved_ids), ids);
    const after = await rows(ids);
    for (const id of ids) assert.equal(after.get(id).drive_id, target, 'the whole sub-page tree moved');
    assert.equal(after.get(doc).parent_document_id, null);
    assert.equal(after.get(doc).folder_id, null);
    assert.equal(after.get(sub).parent_document_id, doc);
    assert.equal(after.get(subsub).parent_document_id, sub);

    const fromChange: DocumentAccessChange = { orgId: fx.orgId, driveId: fx.workspaceDriveId, documentIds: ids };
    const toChange: DocumentAccessChange = { orgId: fx.orgId, driveId: target, documentIds: ids };
    assert.equal(lossesInTx.length, 1, JSON.stringify(lossesInTx));
    assert.deepEqual(lossesInTx[0]!.change, fromChange);
    assert.ok(lossesInTx[0]!.txid, 'the loss ran inside the move’s transaction');
    assert.ok(accessChanges.some((change) => isDeepStrictEqual(change, fromChange)), 'the source drive’s access change');
    assert.ok(accessChanges.some((change) => isDeepStrictEqual(change, toChange)), 'the target drive’s access change');
    assert.ok(currentAccessGeneration() > generation, 'the access generation moved');
    assert.deepEqual(lifecycle, [{ type: 'moved', orgId: fx.orgId, documentIds: ids, fromDriveId: fx.workspaceDriveId, toDriveId: target, actorId: member }]);

    // The workspace owner could open them through the open drive and now can't; member2 keeps view.
    assert.equal(await documentRoleFor(owner, fx.orgId, subsub), null);
    assert.equal(await documentRoleFor(member2, fx.orgId, subsub), 'view');

    // Only the people who can view the documents now are sent document:updated, ids only. The
    // owner, who lost access, hears only through the access change above (rule C3).
    await waitFor(() => harness.updates(member).length >= 3, 'the current viewers are told');
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(harness.updates(member).map((u: any) => u.id).sort(), ids);
    for (const update of harness.updates(member)) assert.deepEqual(update, { id: update.id, drive_id: target });
    assert.deepEqual(harness.updates(owner), [], 'a former viewer is sent no document event');
  } finally {
    await harness.close();
  }
});

test('moving a document under its own sub-page is refused with 409 MOVE_CYCLE', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const drive = await privateDrive(member);
  const doc = await fx.insertDocument({ driveId: drive, title: 'Top' });
  const sub = await fx.insertDocument({ driveId: drive, parentDocumentId: doc, title: 'Below' });
  const deeper = await fx.insertDocument({ driveId: drive, parentDocumentId: sub, title: 'Deeper' });
  for (const under of [sub, deeper, doc]) {
    assert.equal((await call(member, 'POST', `/api/documents/${doc}/move`, { drive_id: drive, parent_document_id: under }, 409)).code, 'MOVE_CYCLE');
  }
  assert.equal((await rows([doc])).get(doc).parent_document_id, null, 'unchanged');
  // A move inside one drive, into a folder at a position, loses nobody access.
  const folder = await fx.insertFolder({ driveId: drive });
  resetEvents();
  await call(member, 'POST', `/api/documents/${deeper}/move`, { drive_id: drive, folder_id: folder, position: 5 }, 200);
  const moved = (await rows([deeper])).get(deeper);
  assert.equal(moved.folder_id, folder);
  assert.equal(moved.parent_document_id, null);
  assert.equal(moved.position, 5);
  assert.deepEqual(lossesInTx, [], 'no access loss inside one drive');
});

test('delete trashes the sub-pages too; restore brings them back; a sub-page restored without its parent goes to the drive root', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const drive = await privateDrive(member);
  const a = await fx.insertDocument({ driveId: drive, title: 'A' });
  const b = await fx.insertDocument({ driveId: drive, parentDocumentId: a, title: 'B' });
  const c = await fx.insertDocument({ driveId: drive, parentDocumentId: b, title: 'C' });
  const all = sorted([a, b, c]);
  resetEvents();
  assert.deepEqual(sorted((await call(member, 'DELETE', `/api/documents/${a}`, undefined, 200)).deleted_ids), all);
  const deleted = await rows(all);
  for (const id of all) {
    assert.equal(deleted.get(id).is_deleted, true);
    assert.equal(deleted.get(id).deleted_by, member);
  }
  assert.ok(lifecycle.some((event) => event.type === 'deleted' && isDeepStrictEqual(event.documentIds, all) && event.fromDriveId === drive));
  assert.equal((await call(member, 'GET', `/api/documents/${c}`, undefined, 404)).code, 'NOT_FOUND');
  assert.equal((await call(member, 'POST', `/api/documents/${a}/restore`, undefined, 200)).restored_ids.length, 3);
  const restored = await rows(all);
  for (const id of all) assert.equal(restored.get(id).is_deleted, false);
  assert.equal(restored.get(b).parent_document_id, a);
  assert.equal(restored.get(c).parent_document_id, b);
  assert.ok(lifecycle.some((event) => event.type === 'restored' && isDeepStrictEqual(event.documentIds, all)));
  assert.equal((await call(member, 'POST', `/api/documents/${a}/restore`, undefined, 409)).code, 'NOT_IN_TRASH');

  // B deleted on its own, then A: restoring B alone puts it at the drive root, with C under it; A stays in the trash.
  await call(member, 'DELETE', `/api/documents/${b}`, undefined, 200);
  assert.deepEqual((await call(member, 'DELETE', `/api/documents/${a}`, undefined, 200)).deleted_ids, [a]);
  assert.deepEqual(sorted((await call(member, 'POST', `/api/documents/${b}/restore`, undefined, 200)).restored_ids), sorted([b, c]));
  const partly = await rows(all);
  assert.equal(partly.get(a).is_deleted, true);
  assert.equal(partly.get(b).is_deleted, false);
  assert.equal(partly.get(b).parent_document_id, null, 'its parent is still in the trash');
  assert.equal(partly.get(b).drive_id, drive);
  assert.equal(partly.get(c).parent_document_id, b);
  assert.deepEqual((await call(member, 'POST', `/api/documents/${a}/restore`, undefined, 200)).restored_ids, [a]);
});

test('deleting a document closes its open connections', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const drive = await privateDrive(member);
  const doc = await fx.insertDocument({ driveId: drive, title: 'Open in an editor' });
  const sub = await fx.insertDocument({ driveId: drive, parentDocumentId: doc, title: 'Also open' });
  const other = await fx.insertDocument({ driveId: drive, title: 'Untouched' });
  // Live editing (F7) closes a document's connections when an access change names it.
  const open = new Set([doc, sub, other]);
  const stop = onDocumentAccessChanged((change) => {
    if (change.orgId === fx!.orgId) for (const id of change.documentIds ?? []) open.delete(id);
  });
  const harness = await socketHarness(fx.orgId, [member]);
  try {
    resetEvents();
    const generation = currentAccessGeneration();
    await call(member, 'DELETE', `/api/documents/${doc}`, undefined, 200);
    const expected: DocumentAccessChange = { orgId: fx.orgId, driveId: drive, documentIds: sorted([doc, sub]) };
    assert.equal(lossesInTx.length, 1);
    assert.deepEqual(lossesInTx[0]!.change, expected);
    assert.ok(lossesInTx[0]!.txid, 'the loss ran inside the delete’s transaction');
    assert.ok(currentAccessGeneration() > generation, 'connections re-check their role before their next update');
    assert.deepEqual([...open], [other], 'the deleted document and its sub-page are closed; nothing else');
    // Nobody can view a deleted document, so nobody is sent document:updated for it (rule C4).
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(harness.updates(member), [], 'the people who could view it hear only through the access change');
  } finally {
    stop();
    await harness.close();
  }
});

test('a new sub-page of a shared document inherits its shares', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { guest, member, member2 } = fx.people;
  const drive = await privateDrive(member);
  const parent = await fx.insertDocument({ driveId: drive, title: 'Shared parent' });
  await fx.share(parent, { user: guest }, 'view');
  await fx.share(parent, { user: member2 }, 'edit');
  await fx.share(parent, { space: fx.spaces.team }, 'comment');
  const sub = (await call(member, 'POST', '/api/documents', { parent_document_id: parent, title: 'Inherits' }, 201)).document;
  const sharesOf = async (id: string) => (await fx!.client.query(`SELECT org_id, principal_type, principal_id, role, shared_by FROM document_shares
    WHERE document_id = $1 ORDER BY principal_type, principal_id`, [id])).rows;
  const inherited = await sharesOf(sub.id);
  assert.equal(inherited.length, 3);
  assert.deepEqual(inherited, await sharesOf(parent));
  // The guest is also in the team chat: the higher of its own view and the chat's comment.
  assert.equal((await call(guest, 'GET', `/api/documents/${sub.id}`, undefined, 200)).document.role, 'comment');
  assert.equal((await call(member2, 'GET', `/api/documents/${sub.id}`, undefined, 200)).document.role, 'edit');
});

test('the trash lists only the last 30 days', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { guest, member, member2 } = fx.people;
  const drive = await privateDrive(member);
  await fx.addDriveMember(drive, { user: member2 }, 'view');
  const recent = await fx.insertDocument({ driveId: drive, title: 'Recent' });
  await fx.insertDocument({ driveId: drive, parentDocumentId: recent, title: 'Its sub-page' });
  const old = await fx.insertDocument({ driveId: drive, title: 'Old' });
  await fx.insertDocument({ driveId: drive, title: 'Still here' });
  await call(member, 'DELETE', `/api/documents/${recent}`, undefined, 200);
  await call(member, 'DELETE', `/api/documents/${old}`, undefined, 200);
  await fx.client.query(`UPDATE documents SET deleted_at = now() - interval '31 days' WHERE id = $1`, [old]);
  const trash = (await call(member, 'GET', `/api/drives/${drive}/trash`, undefined, 200)).items;
  assert.deepEqual(trash.map((item: any) => item.id), [recent], 'its sub-page is restored with it, so it isn’t listed apart');
  assert.equal(trash[0].title, 'Recent');
  assert.equal(trash[0].deleted_by, member);
  assert.ok(trash[0].deleted_at);
  assert.equal((await call(member, 'POST', `/api/documents/${old}/restore`, undefined, 404)).code, 'NOT_FOUND');
  assert.equal((await call(member2, 'GET', `/api/drives/${drive}/trash`, undefined, 403)).code, 'FORBIDDEN_ROLE');
  assert.equal((await call(member2, 'POST', `/api/documents/${recent}/restore`, undefined, 403)).code, 'FORBIDDEN_ROLE');
  assert.equal((await call(guest, 'GET', `/api/drives/${drive}/trash`, undefined, 404)).code, 'NOT_FOUND');
});

test('favourites are per person', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { guest, member, member2 } = fx.people;
  const doc = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Starred' });
  const favouritesOf = async (userId: string) =>
    ((await call(userId, 'GET', '/api/documents/favorites', undefined, 200)).documents as Array<{ id: string }>).map((d) => d.id);
  await call(member, 'POST', `/api/documents/${doc}/favorite`, undefined, 200);
  await call(member, 'POST', `/api/documents/${doc}/favorite`, undefined, 200);
  assert.deepEqual(await favouritesOf(member), [doc], 'once');
  assert.deepEqual(await favouritesOf(member2), []);
  await call(member2, 'DELETE', `/api/documents/${doc}/favorite`, undefined, 200);
  assert.deepEqual(await favouritesOf(member), [doc], 'someone else’s unstar leaves it');
  assert.equal((await call(guest, 'POST', `/api/documents/${doc}/favorite`, undefined, 404)).code, 'NOT_FOUND');
  // A favourite its holder can no longer open is left out.
  const drive = await privateDrive(member);
  const shared = await fx.insertDocument({ driveId: drive, title: 'Was shared' });
  await fx.share(shared, { user: member2 }, 'view');
  await call(member2, 'POST', `/api/documents/${shared}/favorite`, undefined, 200);
  assert.deepEqual(await favouritesOf(member2), [shared]);
  await fx.client.query('DELETE FROM document_shares WHERE document_id = $1', [shared]);
  assert.deepEqual(await favouritesOf(member2), []);
  await call(member, 'DELETE', `/api/documents/${doc}/favorite`, undefined, 200);
  assert.deepEqual(await favouritesOf(member), []);
});

test('the recent list is the 20 most recently edited documents the caller can see', async (t) => {
  if (!fx) return t.skip(SKIP);
  const reader = await fx.addPerson({ role: 'guest' });
  const drive = await privateDrive(fx.people.member);
  const visible: string[] = [];
  for (let at = 0; at < 22; at += 1) {
    const id = await fx.insertDocument({ driveId: drive, title: `Recent ${at}` });
    await fx.share(id, { user: reader }, 'view');
    await fx.client.query(`UPDATE documents SET last_edited_at = now() - make_interval(mins => $2) WHERE id = $1`, [id, at]);
    visible.push(id);
  }
  const unseen = await fx.insertDocument({ driveId: drive, title: 'Not shared' });
  await fx.client.query('UPDATE documents SET last_edited_at = now() + interval \'1 minute\' WHERE id = $1', [unseen]);
  const recent = (await call(reader, 'GET', '/api/documents/recent', undefined, 200)).documents as Array<{ id: string }>;
  assert.deepEqual(recent.map((d) => d.id), visible.slice(0, 20), 'newest first, at most 20');
});

test('deleting a folder moves its contents to the parent folder', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const drive = await privateDrive(member);
  await fx.addDriveMember(drive, { user: member2 }, 'view');
  const top = await fx.insertFolder({ driveId: drive });
  const middle = await fx.insertFolder({ driveId: drive, parentFolderId: top });
  const inner = await fx.insertFolder({ driveId: drive, parentFolderId: middle });
  const doc = await fx.insertDocument({ driveId: drive, folderId: middle, title: 'In the middle' });
  const trashed = await fx.insertDocument({ driveId: drive, folderId: middle, title: 'Trashed', deleted: true });
  assert.equal((await call(member2, 'DELETE', `/api/doc-folders/${middle}`, undefined, 403)).code, 'FORBIDDEN_ROLE');
  await call(member, 'DELETE', `/api/doc-folders/${middle}`, undefined, 200);
  const { rows: folders } = await fx.client.query('SELECT id, parent_folder_id, is_deleted FROM doc_folders WHERE id = ANY($1::text[])', [[middle, inner]]);
  const folderById = new Map(folders.map((row) => [row.id, row]));
  assert.equal(folderById.get(middle).is_deleted, true);
  assert.equal(folderById.get(inner).parent_folder_id, top);
  const docs = await rows([doc, trashed]);
  assert.equal(docs.get(doc).folder_id, top);
  assert.equal(docs.get(trashed).folder_id, top, 'a trashed document restores into the parent folder too');
  const tree = await call(member, 'GET', `/api/drives/${drive}/tree`, undefined, 200);
  assert.deepEqual(tree.folders.map((f: any) => f.id).sort(), sorted([top, inner]));
  // A top-level folder's contents go to the drive root.
  await call(member, 'DELETE', `/api/doc-folders/${top}`, undefined, 200);
  assert.equal((await rows([doc])).get(doc).folder_id, null);
  const { rows: [innerAfter] } = await fx.client.query('SELECT parent_folder_id FROM doc_folders WHERE id = $1', [inner]);
  assert.equal(innerAfter.parent_folder_id, null);
});

test("folders: creating, renaming and nesting need edit on the drive; a folder can't move under itself", async (t) => {
  if (!fx) return t.skip(SKIP);
  const { guest, member, member2 } = fx.people;
  const drive = await privateDrive(member);
  await fx.addDriveMember(drive, { user: member2 }, 'view');
  const specs = (await call(member, 'POST', '/api/doc-folders', { drive_id: drive, name: 'Specs' }, 201)).folder;
  assert.equal(specs.name, 'Specs');
  assert.equal(specs.parent_folder_id, null);
  const child = (await call(member, 'POST', '/api/doc-folders', { drive_id: drive, parent_folder_id: specs.id, name: 'Child' }, 201)).folder;
  assert.equal(child.parent_folder_id, specs.id);
  assert.equal((await call(member2, 'POST', '/api/doc-folders', { drive_id: drive, name: 'x' }, 403)).code, 'FORBIDDEN_ROLE');
  assert.equal((await call(guest, 'POST', '/api/doc-folders', { drive_id: drive, name: 'x' }, 404)).code, 'NOT_FOUND');
  assert.equal((await call(member2, 'PATCH', `/api/doc-folders/${specs.id}`, { name: 'x' }, 403)).code, 'FORBIDDEN_ROLE');
  assert.equal((await call(member, 'PATCH', `/api/doc-folders/${specs.id}`, { name: 'Renamed', position: 3 }, 200)).folder.name, 'Renamed');
  for (const under of [child.id, specs.id]) {
    assert.equal((await call(member, 'PATCH', `/api/doc-folders/${specs.id}`, { parent_folder_id: under }, 409)).code, 'MOVE_CYCLE');
  }
  const foreign = await fx.insertFolder({ driveId: fx.workspaceDriveId });
  assert.equal((await call(member, 'PATCH', `/api/doc-folders/${child.id}`, { parent_folder_id: foreign }, 400)).code, 'FOLDER_NOT_IN_DRIVE');
  assert.equal((await call(member, 'PATCH', `/api/doc-folders/${child.id}`, { parent_folder_id: null }, 200)).folder.parent_folder_id, null);
});

test('the tree shows only what the caller can see, ordered by position', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { guest, member, member2, outsider } = fx.people;
  const drive = await privateDrive(member);
  const folder = await fx.insertFolder({ driveId: drive });
  const second = await fx.insertDocument({ driveId: drive, title: 'B' });
  const zed = await fx.insertDocument({ driveId: drive, title: 'Zed' });
  const alpha = await fx.insertDocument({ driveId: drive, folderId: folder, title: 'Alpha' });
  const gone = await fx.insertDocument({ driveId: drive, title: 'Deleted', deleted: true });
  await fx.client.query('UPDATE documents SET position = CASE id WHEN $1 THEN 2 WHEN $2 THEN 1 WHEN $3 THEN 1 ELSE 0 END WHERE id = ANY($4::text[])',
    [second, zed, alpha, [second, zed, alpha, gone]]);
  await fx.share(alpha, { user: guest }, 'view');
  const tree = await call(member, 'GET', `/api/drives/${drive}/tree`, undefined, 200);
  assert.deepEqual(tree.documents.map((d: any) => d.id), [alpha, zed, second], 'by position, then title; nothing deleted');
  assert.deepEqual(Object.keys(tree.documents[0]).sort(), ['folder_id', 'icon', 'id', 'parent_document_id', 'position', 'title', 'updated_at']);
  assert.equal(tree.documents[0].folder_id, folder);
  assert.deepEqual(tree.folders.map((f: any) => f.id), [folder]);
  // A share of one document gives no view of its drive's tree.
  for (const stranger of [guest, member2, outsider]) {
    assert.equal((await call(stranger, 'GET', `/api/drives/${drive}/tree`, undefined, 404)).code, 'NOT_FOUND');
  }
});

test('every new document and folder route answers malformed JSON with 400', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const doc = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Malformed' });
  const folder = await fx.insertFolder({ driveId: fx.workspaceDriveId });
  for (const [method, path] of [
    ['POST', '/api/documents'], ['PATCH', `/api/documents/${doc}`], ['POST', `/api/documents/${doc}/move`],
    ['POST', '/api/doc-folders'], ['PATCH', `/api/doc-folders/${folder}`],
  ] as const) {
    const res = await fx.requestRaw(member, method, path, '{"title": ');
    assert.equal(res.status, 400, `${method} ${path}`);
    assert.equal((await json(res)).code, 'VALIDATION_ERROR');
  }
  assert.equal((await rows([doc])).get(doc).title, 'Malformed');
});

// ---------------------------------------------------------------------------
// Fix round 1

test('creating a document in My drive does not deadlock with a concurrent ensure of the same drive', async (t) => {
  if (!fx) return t.skip(SKIP);
  const person = await fx.addPerson();
  const first = (await call(person, 'POST', '/api/documents', { title: 'Makes My drive' }, 201)).document;
  const holder = new pg.Client({ connectionString: url!, connectionTimeoutMillis: 3000 });
  await holder.connect();
  try {
    await holder.query("SET lock_timeout = '15s'");
    const { rows: [{ pid }] } = await holder.query('SELECT pg_backend_pid() AS pid');
    await holder.query('BEGIN');
    // A standalone ensurePersonalDrive, part way: the drive FOR SHARE ...
    await holder.query('SELECT id FROM drives WHERE id = $1 FOR SHARE', [first.drive_id]);
    const creating = fx.request(person, 'POST', '/api/documents', { title: 'While another ensure runs' });
    const deadline = Date.now() + 5_000;
    let waiting = 0;
    while (waiting === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      // The create's backend: the one the holder blocks.
      const { rows: [row] } = await fx.client.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND $1::int = ANY(pg_blocking_pids(pid))`, [pid]);
      waiting = row.n;
    }
    assert.ok(waiting > 0, 'the create waits for the other ensure');
    // ... then the owner row, as ensurePersonalDrive writes it.
    await holder.query(`INSERT INTO drive_members (id, org_id, drive_id, principal_type, principal_id, role, added_by)
      SELECT gen_random_uuid()::text, d.org_id, d.id, 'user', $2, 'full', $2 FROM drives d WHERE d.id = $1
      ON CONFLICT (drive_id, principal_type, principal_id) DO UPDATE SET role = 'full', updated_at = now()
        WHERE drive_members.role <> 'full'`, [first.drive_id, person]);
    await holder.query('COMMIT');
    const res = await creating;
    const body = await json(res);
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.document.drive_id, first.drive_id);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    await holder.end();
  }
});

test('the breadcrumb follows the whole page chain, however deep, and shows what the viewer can see after a hidden run', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { guest, member } = fx.people;
  const drive = await privateDrive(member, 'Deep drive');
  const folder = await fx.insertFolder({ driveId: drive });
  const chain: string[] = [];
  for (let at = 0; at < 70; at += 1) {
    chain.push(await fx.insertDocument({
      driveId: drive, folderId: at === 0 ? folder : undefined, parentDocumentId: chain[at - 1], title: `Level ${at}`,
    }));
  }
  const deepest = chain[chain.length - 1]!;
  const full = (await call(member, 'GET', `/api/documents/${deepest}`, undefined, 200)).document;
  assert.deepEqual(full.breadcrumb.map((crumb: any) => crumb.id), [drive, folder, ...chain], 'every ancestor, 70 pages deep');
  // Shared with the guest on its own, and one page far above it: each hidden run is one "Shared with you".
  await fx.share(deepest, { user: guest }, 'view');
  await fx.share(chain[10]!, { user: guest }, 'view');
  const shared = (await call(guest, 'GET', `/api/documents/${deepest}`, undefined, 200)).document;
  assert.deepEqual(shared.breadcrumb, [
    { type: 'shared', title: 'Shared with you' },
    { type: 'document', id: chain[10], title: 'Level 10' },
    { type: 'shared', title: 'Shared with you' },
    { type: 'document', id: deepest, title: 'Level 69' },
  ]);
});

test("a viewer is never shown the id of a folder or parent page they can't see", async (t) => {
  if (!fx) return t.skip(SKIP);
  const { guest, member, member2 } = fx.people;
  const drive = await privateDrive(member, 'Hidden drive');
  const folder = await fx.insertFolder({ driveId: drive });
  const inFolder = await fx.insertDocument({ driveId: drive, folderId: folder, title: 'In a hidden folder' });
  const parent = await fx.insertDocument({ driveId: drive, title: 'Hidden parent' });
  const sub = await fx.insertDocument({ driveId: drive, parentDocumentId: parent, title: 'Shared sub-page' });
  await fx.share(inFolder, { user: guest }, 'view');
  await fx.share(sub, { user: guest }, 'view');
  await fx.share(sub, { user: member2 }, 'edit');
  assert.equal((await call(guest, 'GET', `/api/documents/${inFolder}`, undefined, 200)).document.folder_id, null);
  assert.equal((await call(guest, 'GET', `/api/documents/${sub}`, undefined, 200)).document.parent_document_id, null);
  // Recent and favourites use the same projection.
  const recent = (await call(guest, 'GET', '/api/documents/recent', undefined, 200)).documents as Array<Record<string, unknown>>;
  assert.equal(recent.find((d) => d.id === inFolder)?.folder_id, null);
  assert.equal(recent.find((d) => d.id === sub)?.parent_document_id, null);
  await call(guest, 'POST', `/api/documents/${sub}/favorite`, undefined, 200);
  const favourites = (await call(guest, 'GET', '/api/documents/favorites', undefined, 200)).documents as Array<Record<string, unknown>>;
  assert.deepEqual(favourites.map((d) => [d.id, d.parent_document_id]), [[sub, null]]);
  // So does the answer to a change made through a share.
  assert.equal((await call(member2, 'PATCH', `/api/documents/${sub}`, { title: 'Renamed' }, 200)).document.parent_document_id, null);
  // Someone who can view the drive is shown both.
  assert.equal((await call(member, 'GET', `/api/documents/${sub}`, undefined, 200)).document.parent_document_id, parent);
  assert.equal((await call(member, 'GET', `/api/documents/${inFolder}`, undefined, 200)).document.folder_id, folder);
  // A parent page the caller can't see is not found, whichever drive is named.
  for (const body of [{ parent_document_id: parent, drive_id: fx.workspaceDriveId }, { parent_document_id: parent }]) {
    assert.equal((await call(member2, 'POST', '/api/documents', body, 404)).code, 'NOT_FOUND');
  }
});

test('deleting a page shared on its own answers with only the ids the caller could see', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member, member2 } = fx.people;
  const drive = await privateDrive(member);
  const page = await fx.insertDocument({ driveId: drive, title: 'Shared page' });
  const hiddenSub = await fx.insertDocument({ driveId: drive, parentDocumentId: page, title: 'Not shared' });
  await fx.share(page, { user: member2 }, 'edit');
  resetEvents();
  assert.deepEqual((await call(member2, 'DELETE', `/api/documents/${page}`, undefined, 200)).deleted_ids, [page]);
  const all = sorted([page, hiddenSub]);
  const after = await rows(all);
  for (const id of all) assert.equal(after.get(id).is_deleted, true, 'the whole sub-page tree is trashed');
  assert.deepEqual(lossesInTx[0]?.change.documentIds, all, 'the access loss names every page');
  assert.ok(lifecycle.some((event) => event.type === 'deleted' && isDeepStrictEqual(event.documentIds, all)), 'so does the lifecycle event');
});

test('a sub-page deleted on its own keeps its trash row when its parent is restored, and comes back under it', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const drive = await privateDrive(member);
  const parent = await fx.insertDocument({ driveId: drive, title: 'Parent' });
  const child = await fx.insertDocument({ driveId: drive, parentDocumentId: parent, title: 'Child' });
  const trashIds = async () => ((await call(member, 'GET', `/api/drives/${drive}/trash`, undefined, 200)).items as Array<{ id: string }>)
    .map((item) => item.id).sort();
  await call(member, 'DELETE', `/api/documents/${child}`, undefined, 200);
  assert.deepEqual((await call(member, 'DELETE', `/api/documents/${parent}`, undefined, 200)).deleted_ids, [parent]);
  assert.deepEqual(await trashIds(), sorted([parent, child]), 'each delete has its own row');
  assert.deepEqual((await call(member, 'POST', `/api/documents/${parent}/restore`, undefined, 200)).restored_ids, [parent]);
  assert.equal((await rows([child])).get(child).is_deleted, true, 'deleted on its own, it stays deleted');
  assert.deepEqual(await trashIds(), [child], 'and still listed');
  assert.deepEqual((await call(member, 'POST', `/api/documents/${child}/restore`, undefined, 200)).restored_ids, [child]);
  assert.equal((await rows([child])).get(child).parent_document_id, parent, 'back under its parent');
});

test('routes that take no body refuse a malformed one before changing anything', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const drive = await privateDrive(member);
  const doc = await fx.insertDocument({ driveId: drive, title: 'Stays live' });
  const trashed = await fx.insertDocument({ driveId: drive, title: 'Stays trashed', deleted: true });
  const starred = await fx.insertDocument({ driveId: drive, title: 'Stays starred' });
  const folder = await fx.insertFolder({ driveId: drive });
  await call(member, 'POST', `/api/documents/${starred}/favorite`, undefined, 200);
  for (const [method, path] of [
    ['DELETE', `/api/documents/${doc}`], ['POST', `/api/documents/${trashed}/restore`], ['POST', `/api/documents/${doc}/favorite`],
    ['DELETE', `/api/documents/${starred}/favorite`], ['DELETE', `/api/doc-folders/${folder}`],
  ] as const) {
    const res = await fx.requestRaw(member, method, path, '{"oops": ');
    assert.equal(res.status, 400, `${method} ${path}`);
    assert.equal((await json(res)).code, 'VALIDATION_ERROR');
  }
  const state = await rows([doc, trashed]);
  assert.equal(state.get(doc).is_deleted, false, 'not deleted');
  assert.equal(state.get(trashed).is_deleted, true, 'not restored');
  const { rows: stars } = await fx.client.query(`SELECT target_id FROM doc_favorites WHERE user_id = $1 AND target_id = ANY($2::text[])`,
    [member, [doc, starred]]);
  assert.deepEqual(stars.map((row) => row.target_id), [starred], 'not starred, not unstarred');
  const { rows: [folderRow] } = await fx.client.query('SELECT is_deleted FROM doc_folders WHERE id = $1', [folder]);
  assert.equal(folderRow.is_deleted, false, 'the folder is not deleted');
  // A blank body, or well-formed JSON, is accepted.
  assert.equal((await fx.requestRaw(member, 'POST', `/api/documents/${trashed}/restore`, '')).status, 200);
  assert.equal((await fx.requestRaw(member, 'DELETE', `/api/doc-folders/${folder}`, '{}')).status, 200);
});

test('createDocumentInTx creates in the caller’s transaction and hands back the post-commit step', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const input = { orgId: fx.orgId, userId: member, driveId: fx.workspaceDriveId };
  resetEvents();
  const made = await db.transaction((tx) => documentsLib.createDocumentInTx(tx, { ...input, title: 'In a caller’s transaction' }));
  assert.equal((await rows([made.document.id])).get(made.document.id).title, 'In a caller’s transaction');
  assert.deepEqual(lifecycle, [], 'nothing is raised until the caller runs finish');
  await made.finish();
  assert.ok(lifecycle.some((event) => event.type === 'created' && isDeepStrictEqual(event.documentIds, [made.document.id])));
  // Rolled back with the caller's transaction, it leaves nothing.
  const title = `Rolled back ${randomUUID()}`;
  await assert.rejects(db.transaction(async (tx) => {
    await documentsLib.createDocumentInTx(tx, { ...input, title });
    throw new Error('roll back');
  }), /roll back/);
  const { rows: left } = await fx.client.query('SELECT id FROM documents WHERE org_id = $1 AND title = $2', [fx.orgId, title]);
  assert.deepEqual(left, []);
});

// ---------------------------------------------------------------------------
// Fix round 2

test('two deletes in the same millisecond never share a stamp: a sub-page deleted first keeps its own trash row', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const drive = await privateDrive(member);
  const parent = await fx.insertDocument({ driveId: drive, title: 'Parent' });
  const child = await fx.insertDocument({ driveId: drive, parentDocumentId: parent, title: 'Child' });
  // The API's JavaScript clock is frozen an hour ahead, so both deletes fall in the same millisecond, and
  // the child carries exactly the stamp that frozen clock gives: the parent's stamp must step past it.
  const frozen = new Date(Math.floor(Date.now() / 1000) * 1000 + 60 * 60 * 1000);
  mock.timers.enable({ apis: ['Date'], now: frozen });
  try {
    await call(member, 'DELETE', `/api/documents/${child}`, undefined, 200);
    await fx.client.query('UPDATE documents SET deleted_at = $2::timestamp WHERE id = $1', [child, frozen.toISOString().replace('Z', '')]);
    assert.deepEqual((await call(member, 'DELETE', `/api/documents/${parent}`, undefined, 200)).deleted_ids, [parent]);
    const { rows: [order] } = await fx.client.query(`SELECT later_doc.deleted_at > earlier_doc.deleted_at AS later
      FROM documents later_doc, documents earlier_doc WHERE later_doc.id = $1 AND earlier_doc.id = $2`, [parent, child]);
    assert.equal(order.later, true, 'the parent’s stamp is later than the child’s');
    const trash = ((await call(member, 'GET', `/api/drives/${drive}/trash`, undefined, 200)).items as Array<{ id: string }>).map((item) => item.id);
    assert.deepEqual(trash.sort(), sorted([parent, child]), 'the child keeps its own trash row');
    assert.deepEqual((await call(member, 'POST', `/api/documents/${parent}/restore`, undefined, 200)).restored_ids, [parent]);
    assert.equal((await rows([child])).get(child).is_deleted, true, 'restoring the parent leaves the child in the trash');
  } finally {
    mock.timers.reset();
  }
});

test('a body of only a no-break space is not empty: a bodyless route refuses it before changing anything', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const drive = await privateDrive(member);
  const doc = await fx.insertDocument({ driveId: drive, title: 'Not deleted' });
  const res = await fx.requestRaw(member, 'DELETE', `/api/documents/${doc}`, ' ');
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'VALIDATION_ERROR');
  assert.equal((await rows([doc])).get(doc).is_deleted, false, 'not deleted');
  // JSON's own whitespace is still an empty body.
  assert.equal((await fx.requestRaw(member, 'DELETE', `/api/documents/${doc}`, ' \t\r\n')).status, 200);
});

// ---------------------------------------------------------------------------
// Fix round 3

test('a body of only a byte order mark is not empty: a bodyless route refuses it; a mark before a JSON value is tolerated', async (t) => {
  if (!fx) return t.skip(SKIP);
  const { member } = fx.people;
  const drive = await privateDrive(member);
  const doc = await fx.insertDocument({ driveId: drive, title: 'Before' });
  // U+FEFF goes out as the UTF-8 bytes EF BB BF.
  for (const body of ['﻿', '﻿ \r\n']) {
    const res = await fx.requestRaw(member, 'DELETE', `/api/documents/${doc}`, body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} is not an empty body`);
    assert.equal((await json(res)).code, 'VALIDATION_ERROR');
  }
  assert.equal((await rows([doc])).get(doc).is_deleted, false, 'not deleted');
  // A mark before a JSON value: a route with a body reads it, and a bodyless route accepts it.
  const patched = await fx.requestRaw(member, 'PATCH', `/api/documents/${doc}`, '﻿{"title":"After"}');
  const patchedBody = await json(patched);
  assert.equal(patched.status, 200, JSON.stringify(patchedBody));
  assert.equal(patchedBody.document.title, 'After');
  assert.equal((await fx.requestRaw(member, 'DELETE', `/api/documents/${doc}`, '﻿{}')).status, 200);
  assert.equal((await rows([doc])).get(doc).is_deleted, true);
});
