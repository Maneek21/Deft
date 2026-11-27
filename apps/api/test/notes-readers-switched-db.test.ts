/**
 * Every notes reader reads documents (spec 5.12; plan Task F15).
 *
 * The notes move (F14) leaves one note_document_map row per moved note and
 * canvas. Here those rows are written directly, next to legacy notes and a
 * canvas, so each reader is seen to answer from the mapped document's
 * current access (lib/document-access.ts) and never from the old note rule.
 * The old note writes answer 410, a chat canvas is read only, an old link
 * finds its document, and nothing under apps/api/src imports the deleted
 * note rule. The new list forms plan within F3's budget.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/notes-readers-switched-db.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { and, between, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { documents, noteDocumentMap } from '@deft/db/documents';
import { entityTags, notes } from '@deft/db/schema';
import { closeDb, db } from '../src/lib/db.js';
import { visibleDocumentCondition, visibleDocumentIdSql } from '../src/lib/document-access.js';
import { calendarRoutes } from '../src/routes/calendar.js';
import { canvasRoutes } from '../src/routes/canvas.js';
import { dailyNoteRoutes } from '../src/routes/daily-notes.js';
import { documentRoutes } from '../src/routes/documents.js';
import { searchRoutes } from '../src/routes/search.js';
import { tagRoutes } from '../src/routes/tags.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { planningGrowth, type Growth } from './fixtures/planning-growth.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const skip = !url;
let fx: DrivesFixture;
const marker = `fifteen${randomUUID().replace(/-/g, '').slice(0, 10)}`;

before(async () => {
  if (skip) return;
  fx = await setupDrivesFixture('f15', {
    routes: [
      { path: '/api/daily-notes', app: dailyNoteRoutes },
      { path: '/api/documents', app: documentRoutes },
      { path: '/api/spaces', app: canvasRoutes },
      { path: '/api/search', app: searchRoutes },
      { path: '/api/calendar', app: calendarRoutes },
      { path: '/api/tags', app: tagRoutes },
    ],
  });
});

after(async () => {
  if (skip) return;
  if (fx) {
    const q = (text: string) => fx.client.query(text, [[fx.orgId, fx.otherOrgId]]);
    await q('DELETE FROM entity_tags WHERE org_id = ANY($1::text[])');
    await q('DELETE FROM tags WHERE org_id = ANY($1::text[])');
    await q('DELETE FROM note_shares WHERE note_id IN (SELECT id FROM notes WHERE org_id = ANY($1::text[]))');
    await q('DELETE FROM notes WHERE org_id = ANY($1::text[])');
    await q('DELETE FROM canvases WHERE org_id = ANY($1::text[])');
    await q('DELETE FROM doc_favorites WHERE org_id = ANY($1::text[])');
    await fx.teardown();
  }
  await closeDb();
});

/** A legacy note row, as Notes wrote it. */
async function insertNote(i: { userId: string; title?: string; visibility?: 'private' | 'org' | 'space'; spaceId?: string; sharedWith?: string[] }): Promise<string> {
  const id = randomUUID();
  await fx.client.query(`INSERT INTO notes (id, org_id, user_id, title, content, visibility, visibility_space_id)
    VALUES ($1, $2, $3, $4, '<p>legacy body</p>', $5, $6)`,
  [id, fx.orgId, i.userId, i.title ?? `note ${id.slice(0, 6)}`, i.visibility ?? 'private', i.spaceId ?? null]);
  for (const user of i.sharedWith ?? []) {
    await fx.client.query('INSERT INTO note_shares (id, note_id, shared_with_user_id, permission) VALUES ($1, $2, $3, $4)',
      [randomUUID(), id, user, 'view']);
  }
  return id;
}

/** The map row the move writes for a source. */
async function mapSource(sourceType: 'note' | 'canvas', sourceId: string, documentId: string): Promise<void> {
  await fx.client.query(`INSERT INTO note_document_map (id, org_id, source_type, source_id, target_type, target_id)
    VALUES ($1, $2, $3, $4, 'document', $5)`, [randomUUID(), fx.orgId, sourceType, sourceId, documentId]);
}

/** A personal drive for `userId`, as F4 makes it. */
const myDrives = new Map<string, string>();
async function myDrive(userId: string): Promise<string> {
  let id = myDrives.get(userId);
  if (!id) myDrives.set(userId, id = await fx.insertDrive({ kind: 'personal', ownerUserId: userId, name: 'My drive' }));
  return id;
}

/** A moved note: the legacy row and its document in the author's My drive, mapped. */
async function movedNote(i: Parameters<typeof insertNote>[0] & { documentTitle?: string }): Promise<{ noteId: string; documentId: string }> {
  const noteId = await insertNote(i);
  const documentId = await fx.insertDocument({ driveId: await myDrive(i.userId), title: i.documentTitle ?? i.title ?? 'moved note' });
  await mapSource('note', noteId, documentId);
  return { noteId, documentId };
}

const docJson = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

test('writing to a moved note answers 410 NOTES_MOVED with the document id', { skip }, async () => {
  const { member, member2 } = fx.people;
  const { noteId, documentId } = await movedNote({ userId: member });

  for (const [method, path, body] of [
    ['PATCH', `/api/daily-notes/${noteId}`, { title: 'changed' }],
    ['DELETE', `/api/daily-notes/${noteId}`, undefined],
    ['POST', `/api/daily-notes/${noteId}/shares`, { user_id: member2 }],
  ] as const) {
    const response = await fx.request(member, method, path, body);
    assert.equal(response.status, 410, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: 'Notes are documents now. Open it in Drive.', code: 'NOTES_MOVED', document_id: documentId });
  }
  // Someone who can't open the document learns nothing about it: the answer for an id that never existed.
  const stranger = await fx.request(member2, 'PATCH', `/api/daily-notes/${noteId}`, { title: 'changed' });
  const unknown = await fx.request(member2, 'PATCH', `/api/daily-notes/${randomUUID()}`, { title: 'changed' });
  assert.equal(stranger.status, 410);
  assert.deepEqual(await stranger.json(), await unknown.json());
  // Creating a note is gone too, and nothing was written.
  const create = await fx.request(member, 'POST', '/api/daily-notes', { title: 'new note' });
  assert.equal(create.status, 410);
  assert.equal((await create.json() as any).code, 'NOTES_MOVED');
  const { rows } = await fx.client.query('SELECT title FROM notes WHERE id = $1', [noteId]);
  assert.notEqual(rows[0].title, 'changed');
  const { rows: created } = await fx.client.query(`SELECT count(*)::int AS n FROM notes WHERE org_id = $1 AND title = 'new note'`, [fx.orgId]);
  assert.equal(created[0].n, 0);
});

test('after the move, creating a note through the old route answers 410 and inserts no notes or canvases row', { skip }, async () => {
  const { executeAction } = await import('../src/lib/agent-actions.js');
  const { member } = fx.people;
  // The move's record for this workspace (F14): finished and checked.
  await fx.client.query(`INSERT INTO drives_move_runs (id, org_id, release_version, completed_at, check_ok)
    VALUES ($1, $2, 'f15-test', now(), true)`, [randomUUID(), fx.orgId]);
  const count = async (table: 'notes' | 'canvases' | 'note_folders') =>
    (await fx.client.query(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [fx.orgId])).rows[0].n as number;
  const before = { notes: await count('notes'), canvases: await count('canvases'), folders: await count('note_folders') };

  for (const body of [{ title: 'after the move' }, { title: 'org after the move', visibility: 'org' },
    { title: 'space after the move', visibility: 'space', visibility_space_id: fx.spaces.team }]) {
    const response = await fx.request(member, 'POST', '/api/daily-notes', body);
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), { error: 'Notes are documents now. Open it in Drive.', code: 'NOTES_MOVED' });
  }
  assert.equal((await fx.request(member, 'POST', '/api/daily-notes/folders', { name: 'after the move' })).status, 410);
  // The tools create documents, and a chat with no canvas gets none.
  assert.equal((await executeAction(randomUUID(), 'create_note', { title: 'tool after the move' }, fx.orgId, member)).success, true);
  const { rows: [team] } = await fx.client.query('SELECT name FROM spaces WHERE id = $1', [fx.spaces.team]);
  const canvas = await executeAction(randomUUID(), 'write_canvas', { space_name: team.name, content: 'words' }, fx.orgId, member);
  assert.equal(canvas.success, false);
  assert.match(canvas.error ?? '', /no canvas/);
  assert.deepEqual({ notes: await count('notes'), canvases: await count('canvases'), folders: await count('note_folders') }, before);
});

test('by-legacy maps a note id to its document for someone who could see the note, and 404 for someone who couldn\'t', { skip }, async () => {
  const { member, member2, guest, outsider } = fx.people;
  // Shared with member2 as a note, but its document is no longer shared with them: they could see it before the move.
  const { noteId, documentId } = await movedNote({ userId: member, sharedWith: [member2] });
  const byLegacy = (userId: string, type: string, id: string) => fx.request(userId, 'GET', `/api/documents/by-legacy/${type}/${id}`);

  for (const userId of [member, member2]) {
    const response = await byLegacy(userId, 'note', noteId);
    assert.equal(response.status, 200, `could see: ${userId}`);
    assert.deepEqual(await response.json(), { document_id: documentId });
  }
  for (const userId of [guest, outsider]) {
    const response = await byLegacy(userId, 'note', noteId);
    assert.equal(response.status, 404, `couldn't see: ${userId}`);
    assert.equal((await response.json() as any).document_id, undefined);
  }
  // Someone who can open the document now, though the note was never theirs to see.
  await fx.share(documentId, { user: guest }, 'view');
  assert.equal((await byLegacy(guest, 'note', noteId)).status, 200);
  // A note that never moved, an unknown id and another source type are all the same 404.
  const unmoved = await insertNote({ userId: member });
  for (const [type, id] of [['note', unmoved], ['note', randomUUID()], ['task', noteId], ['note_folder', noteId]]) {
    assert.equal((await byLegacy(member, type!, id!)).status, 404, `${type} ${id}`);
  }
});

test('GET on a moved note answers from the document\'s access, not the old note rule', { skip }, async () => {
  const { member, member2 } = fx.people;
  // Private as a note (only its author), but its document is shared with member2.
  const shared = await movedNote({ userId: member, visibility: 'private' });
  await fx.share(shared.documentId, { user: member2 }, 'view');
  // Visible to the whole workspace as a note, but its document sits in its author's My drive, shared with nobody.
  const kept = await movedNote({ userId: member, visibility: 'org' });

  const open = await fx.request(member2, 'GET', `/api/daily-notes/${shared.noteId}`);
  assert.equal(open.status, 200);
  const body = await open.json() as any;
  assert.equal(body.id, shared.noteId);
  assert.equal(body.document_id, shared.documentId);
  assert.equal((await fx.request(member2, 'GET', `/api/daily-notes/${kept.noteId}`)).status, 404);
  // The list follows the same rule.
  const list = await (await fx.request(member2, 'GET', '/api/daily-notes')).json() as any[];
  assert.ok(list.some((row) => row.id === shared.noteId && row.document_id === shared.documentId));
  assert.ok(!list.some((row) => row.id === kept.noteId));
  // A deleted document opens for nobody, its note included.
  await fx.client.query('UPDATE documents SET is_deleted = true, deleted_at = now() WHERE id = $1', [shared.documentId]);
  assert.equal((await fx.request(member2, 'GET', `/api/daily-notes/${shared.noteId}`)).status, 404);
  assert.equal((await fx.request(member, 'GET', `/api/daily-notes/${shared.noteId}`)).status, 404);
});

test('search returns documents the caller can see, including ones shared only with them (the old notes search missed shares)', { skip }, async () => {
  const { member, member2, guest } = fx.people;
  const word = `${marker}search`;
  const sharedOnly = await fx.insertDocument({ driveId: await myDrive(member), title: `${word} shared plan`, json: docJson(`the ${word} plan`) });
  await fx.share(sharedOnly, { user: member2 }, 'view');
  const hidden = await fx.insertDocument({ driveId: await myDrive(member), title: `${word} hidden plan`, json: docJson(`the ${word} plan`) });
  const search = async (userId: string) => (await (await fx.request(userId, 'GET', `/api/search?q=${word}`)).json() as any);

  const forMember2 = await search(member2);
  assert.deepEqual(forMember2.documents.map((row: any) => row.id), [sharedOnly]);
  assert.equal(forMember2.documents[0].url, `/d/${sharedOnly}`);
  assert.deepEqual(forMember2.notes, []);
  assert.deepEqual((await search(member)).documents.map((row: any) => row.id).sort(), [sharedOnly, hidden].sort());
  assert.deepEqual((await search(guest)).documents, []);
});

test('create_note creates a document in My drive and returns its id', { skip }, async () => {
  const { executeAction } = await import('../src/lib/agent-actions.js');
  const { member } = fx.people;
  const result = await executeAction(randomUUID(), 'create_note', { title: `${marker} saved note`, content: '<p>saved body</p>' }, fx.orgId, member);
  assert.equal(result.success, true, result.error);
  const documentId = result.result.document_id as string;
  assert.ok(documentId);
  assert.equal(result.result.note_id, documentId);
  const { rows: [row] } = await fx.client.query(`SELECT d.title, d.content_text, d.created_by, drive.kind, drive.owner_user_id
    FROM documents d JOIN drives drive ON drive.id = d.drive_id WHERE d.id = $1`, [documentId]);
  assert.deepEqual({ ...row, content_text: row.content_text.trim() },
    { title: `${marker} saved note`, content_text: 'saved body', created_by: member, kind: 'personal', owner_user_id: member });
  const { rows: written } = await fx.client.query(`SELECT count(*)::int AS n FROM notes WHERE org_id = $1 AND title = $2`, [fx.orgId, `${marker} saved note`]);
  assert.equal(written[0].n, 0, 'no note row');

  // A space note: My drive, shared with the chat as "can view". An org note: Shared notes, in the author's folder, with an edit share.
  const space = await executeAction(randomUUID(), 'create_note',
    { title: `${marker} space note`, visibility: 'space', visibility_space_id: fx.spaces.team }, fx.orgId, member);
  assert.equal(space.success, true, space.error);
  const { rows: spaceShares } = await fx.client.query('SELECT principal_type, principal_id, role FROM document_shares WHERE document_id = $1',
    [space.result.document_id]);
  assert.deepEqual(spaceShares, [{ principal_type: 'space', principal_id: fx.spaces.team, role: 'view' }]);
  const org = await executeAction(randomUUID(), 'create_note', { title: `${marker} org note`, visibility: 'org' }, fx.orgId, member);
  assert.equal(org.success, true, org.error);
  const { rows: [placed] } = await fx.client.query(`SELECT drive.system_key, folder.created_by AS folder_owner,
      (SELECT array_agg(principal_id || ':' || role) FROM document_shares s WHERE s.document_id = d.id) AS shares
    FROM documents d JOIN drives drive ON drive.id = d.drive_id LEFT JOIN doc_folders folder ON folder.id = d.folder_id WHERE d.id = $1`,
  [org.result.document_id]);
  assert.deepEqual(placed, { system_key: 'shared_notes', folder_owner: member, shares: [`${member}:edit`] });
});

test('search_notes finds a document shared with the asker and not one they can\'t open', { skip }, async () => {
  const { executeAction } = await import('../src/lib/agent-actions.js');
  const { member, member2 } = fx.people;
  const word = `${marker}tool`;
  const shared = await fx.insertDocument({ driveId: await myDrive(member), title: `${word} shared`, json: docJson(`${word} text`) });
  await fx.share(shared, { user: member2 }, 'view');
  const hidden = await fx.insertDocument({ driveId: await myDrive(member), title: `${word} hidden`, json: docJson(`${word} text`) });
  // A legacy note with the word, readable by member2 under the old rule, is not what the tool reads.
  await insertNote({ userId: member, title: `${word} legacy`, visibility: 'org' });

  const result = await executeAction(randomUUID(), 'search_notes', { query: word }, fx.orgId, member2);
  assert.equal(result.success, true, result.error);
  assert.deepEqual(result.result.notes.map((row: any) => row.id), [shared]);
  assert.equal(result.result.notes[0].url, `/d/${shared}`);
  const read = await executeAction(randomUUID(), 'read_note', { note_id: hidden }, fx.orgId, member2);
  assert.equal(read.success, false);
});

test('the calendar returns documents for the day, not notes', { skip }, async () => {
  const { member } = fx.people;
  const today = await fx.insertDocument({ driveId: await myDrive(member), title: `${marker} today` });
  await fx.client.query('UPDATE documents SET created_by = $2 WHERE id = $1', [today, member]);
  const noteId = await insertNote({ userId: member, title: `${marker} legacy today` });
  const day = 86_400_000;
  const response = await fx.request(member, 'GET',
    `/api/calendar?from=${new Date(Date.now() - day).toISOString()}&to=${new Date(Date.now() + day).toISOString()}`);
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.ok(body.documents.some((row: any) => row.id === today && row.url === `/d/${today}`));
  assert.ok(!body.documents.some((row: any) => row.id === noteId));
  assert.deepEqual(body.notes, []);
});

test('a tag on a document is listed under the document', { skip }, async () => {
  const { member, member2 } = fx.people;
  const documentId = await fx.insertDocument({ driveId: await myDrive(member), title: `${marker} tagged` });
  const created = await fx.request(member, 'POST', '/api/tags', { name: `${marker}tag` });
  const tag = await created.json() as any;
  const applied = await fx.request(member, 'POST', `/api/tags/${tag.id}/apply`, { entity_type: 'document', entity_id: documentId });
  assert.equal(applied.status, 200);

  const listed = await (await fx.request(member, 'GET', `/api/tags/${tag.id}/entities`)).json() as any[];
  assert.deepEqual(listed.map((row) => [row.entity_type, row.entity_id, row.title]), [['document', documentId, `${marker} tagged`]]);
  const counts = await (await fx.request(member, 'GET', '/api/tags')).json() as any[];
  assert.equal(counts.find((row) => row.id === tag.id)?.count, 1);
  // Someone who can't open the document sees neither the item nor a count.
  assert.deepEqual(await (await fx.request(member2, 'GET', `/api/tags/${tag.id}/entities`)).json(), []);
  assert.equal((await (await fx.request(member2, 'GET', '/api/tags')).json() as any[]).find((row) => row.id === tag.id)?.count, 0);
  assert.equal((await fx.request(member2, 'POST', `/api/tags/${tag.id}/apply`, { entity_type: 'document', entity_id: documentId })).status, 404);
  // An old note id stands for its document.
  const moved = await movedNote({ userId: member });
  assert.equal((await fx.request(member, 'POST', `/api/tags/${tag.id}/apply`, { entity_type: 'note', entity_id: moved.noteId })).status, 200);
  const rows = await db.select({ type: entityTags.entity_type, id: entityTags.entity_id }).from(entityTags)
    .where(and(eq(entityTags.tag_id, tag.id), eq(entityTags.entity_id, moved.documentId)));
  assert.deepEqual(rows.map((row) => row.type as string), ['document']);
});

test('GET canvas on a chat with no canvas creates nothing', { skip }, async () => {
  const { member, member2 } = fx.people;
  const count = async () => (await fx.client.query('SELECT count(*)::int AS n FROM canvases WHERE space_id = $1', [fx.spaces.team])).rows[0].n;
  const response = await fx.request(member, 'GET', `/api/spaces/${fx.spaces.team}/canvas`);
  assert.equal(response.status, 404);
  assert.equal(await count(), 0);

  // A moved canvas reads as its document, for a member who can open it; PATCH is gone.
  const canvasId = randomUUID();
  await fx.client.query(`INSERT INTO canvases (id, org_id, space_id, title, content) VALUES ($1, $2, $3, 'Canvas', $4::jsonb)`,
    [canvasId, fx.orgId, fx.spaces.team, JSON.stringify(docJson('canvas words'))]);
  const documentId = await fx.insertDocument({ driveId: await myDrive(member), title: 'Team canvas', json: docJson('canvas words') });
  await fx.share(documentId, { space: fx.spaces.team }, 'edit');
  await mapSource('canvas', canvasId, documentId);
  const read = await fx.request(member2, 'GET', `/api/spaces/${fx.spaces.team}/canvas`);
  assert.equal(read.status, 200);
  const body = await read.json() as any;
  assert.equal(body.document_id, documentId);
  assert.equal(body.read_only, true);
  const patch = await fx.request(member2, 'PATCH', `/api/spaces/${fx.spaces.team}/canvas`, { title: 'x' });
  assert.equal(patch.status, 410);
  assert.deepEqual(await patch.json(), { error: 'This canvas is a document now. Open it in Drive.', code: 'CANVAS_MOVED', document_id: documentId });
  assert.equal(await count(), 1);
});

test('nothing under apps/api/src imports note-visibility', async () => {
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const offenders: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
        if (entry.name === 'note-visibility.ts') offenders.push(`${path} (the module itself)`);
        else if (/from\s+['"][^'"]*note-visibility(\.js)?['"]|import\(\s*['"][^'"]*note-visibility/.test(await readFile(path, 'utf8'))) offenders.push(path);
      }
    }
  };
  await walk(src);
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// The new list forms over the access check plan within F3's budget
// (document-access-planning-db.test.ts): under 24 MB private, 48 MB peak, in
// workspaces of 10, 50 and 200 documents. The search and retrieval forms are
// F3's own ('search', 'retrieval').

const SIZES = [10, 50, 200] as const;
type Statement = { sql: string; params: unknown[] };
const query = (statement: SQL): Statement => new PgDialect().sqlToQuery(statement);

test('the notes readers\' document list forms plan within budget', { skip }, async (t: TestContext) => {
  if (await planningGrowth({ sql: 'SELECT 1', params: [] }) === null) return t.skip('this test database does not let a session read /proc/self/status');
  const { noteDocumentsSearchQuery, promotableDocumentSql } = await import('../src/lib/legacy-notes.js');
  const measured: Array<[string, number, Growth]> = [];
  for (const size of SIZES) {
    const planning = await setupDrivesFixture(`f15-planning-${size}`, { documents: size });
    try {
      await planning.client.query(`ANALYZE drives, drive_members, doc_folders, documents, document_shares, spaces, space_members,
        org_members, users, agent_employees, note_document_map, notes, entity_tags`);
      const { member } = planning.people;
      const orgId = planning.orgId;
      const ids = (await db.select({ id: documents.id }).from(documents).where(eq(documents.org_id, orgId)).limit(50)).map((row) => row.id);
      const day = 86_400_000;
      const forms: Array<[string, Statement]> = [
        ['calendar documents', db.select({ id: documents.id, title: documents.title }).from(documents).where(and(
          eq(documents.org_id, orgId), eq(documents.created_by, member),
          between(documents.created_at, new Date(Date.now() - day), new Date(Date.now() + day)), visibleDocumentCondition(member, orgId),
        )).orderBy(desc(documents.created_at)).limit(200).toSQL()],
        ['tag counts (documents)', db.select({ tag_id: entityTags.tag_id, count: sql<number>`count(*)::int` }).from(entityTags)
          .innerJoin(documents, and(eq(documents.id, entityTags.entity_id), eq(documents.org_id, orgId)))
          .where(and(eq(entityTags.org_id, orgId), sql`${entityTags.entity_type} = 'document'`, visibleDocumentCondition(member, orgId)))
          .groupBy(entityTags.tag_id).toSQL()],
        ['documents by id (tags, teams, cross-references)', db.select({ id: documents.id, title: documents.title }).from(documents)
          .where(and(inArray(documents.id, ids), visibleDocumentCondition(member, orgId))).toSQL()],
        // GET /api/daily-notes (fix round 1, A-I1): the note's document, its current title and content.
        ['legacy notes list', db.select({ id: notes.id, document_id: documents.id, title: documents.title, content_json: documents.content_json })
          .from(notes)
          .innerJoin(noteDocumentMap, and(eq(noteDocumentMap.org_id, notes.org_id), eq(noteDocumentMap.source_type, 'note'),
            eq(noteDocumentMap.source_id, notes.id)))
          .innerJoin(documents, and(eq(documents.id, noteDocumentMap.target_id), eq(documents.org_id, noteDocumentMap.org_id)))
          .where(and(eq(notes.org_id, orgId), eq(notes.is_deleted, false), visibleDocumentCondition(member, orgId),
            eq(documents.is_template, false)))
          .orderBy(desc(notes.is_pinned), desc(documents.updated_at)).limit(100).toSQL()],
        ['note tools search', noteDocumentsSearchQuery({ orgId, userId: member, query: 'seed document', scope: 'all', limit: 50 }).toSQL()],
        ['note tools search, mine', noteDocumentsSearchQuery({ orgId, userId: member, query: 'seed', scope: 'mine', limit: 50, templates: false }).toSQL()],
        ['note_to_wiki point lookup', db.select({ id: documents.id }).from(documents)
          .where(and(eq(documents.id, ids[0]!), promotableDocumentSql(member, orgId))).limit(1).toSQL()],
        ['export notes (member)', query(sql`SELECT export_note.id FROM notes export_note
          WHERE export_note.org_id = ${orgId} AND EXISTS (SELECT 1 FROM notes WHERE notes.id = export_note.id AND notes.org_id = ${orgId}
            AND notes.is_deleted = false AND ${visibleDocumentIdSql(member, orgId, sql`(SELECT exported_note_map.target_id
              FROM note_document_map exported_note_map WHERE exported_note_map.org_id = notes.org_id
                AND exported_note_map.source_type = 'note' AND exported_note_map.source_id = notes.id)`)})
          ORDER BY export_note.created_at, export_note.id`)],
        ['search documents group', db.select({ id: documents.id }).from(documents).where(and(
          eq(documents.org_id, orgId), visibleDocumentCondition(member, orgId),
          sql`${documents.search_vector} @@ websearch_to_tsquery('simple', ${'seed'})`,
        )).orderBy(sql`ts_rank(${documents.search_vector}, websearch_to_tsquery('simple', ${'seed'})) DESC`).limit(5).toSQL()],
        ['retrieval documents', db.select({ id: documents.id }).from(documents).where(and(
          eq(documents.org_id, orgId), eq(documents.is_deleted, false), visibleDocumentCondition(member, orgId),
          or(ilike(documents.title, '%seed%'), ilike(documents.content_text, '%seed%')),
        )).limit(10).toSQL()],
      ];
      for (const [name, statement] of forms) {
        const growth = await planningGrowth(statement);
        assert.ok(growth, `${name}: measured`);
        measured.push([name, size, growth]);
      }
    } finally {
      await planning.teardown();
    }
  }
  const mb = (kb: number) => Math.round(kb / 1024);
  t.diagnostic(`backend growth planning (private / peak MB): ${measured
    .map(([name, size, growth]) => `${name} at ${size} documents ${mb(growth.anon)} / ${mb(growth.peak)}`).join('; ')}`);
  for (const [name, size, growth] of measured) {
    assert.ok(growth.anon < 24 * 1024, `${name} at ${size} documents, private memory: ${growth.anon} kB`);
    assert.ok(growth.peak < 48 * 1024, `${name} at ${size} documents, peak: ${growth.peak} kB`);
  }
});
