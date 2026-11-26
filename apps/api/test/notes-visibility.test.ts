/**
 * Task 5.1 — notes visibility, since notes became documents (F15).
 *
 * Run: pnpm --filter @deft/api test -- test/notes-visibility.test.ts
 *
 * The notes move (F14) put a workspace note in the open Shared notes drive
 * (everyone may view; its author holds an edit share) and a private note in
 * its author's My drive, and mapped each in note_document_map. GET
 * /api/daily-notes answers from those documents' access; every write is 410.
 *   1. user-B can see user-A's workspace note in GET /api/daily-notes
 *   2. user-A's private note is NOT returned to user-B
 *   3. user-B attempting PATCH on user-A's note → 410 NOTES_MOVED (they can open its document)
 *   4. user-A PATCHing their own note → 410 NOTES_MOVED with its document, nothing changed
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeDb } from '../src/lib/db.js';
import { dailyNoteRoutes } from '../src/routes/daily-notes.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const skip = !safeTestDatabaseUrl();
let fx: DrivesFixture;
let userA: string;
let userB: string;
let orgNote: { noteId: string; documentId: string };
let privateNote: { noteId: string; documentId: string };

async function movedNote(visibility: 'private' | 'org', title: string, driveId: string): Promise<{ noteId: string; documentId: string }> {
  const noteId = randomUUID();
  await fx.client.query(`INSERT INTO notes (id, org_id, user_id, title, content, visibility) VALUES ($1, $2, $3, $4, '<p>body</p>', $5)`,
    [noteId, fx.orgId, userA, title, visibility]);
  const documentId = await fx.insertDocument({ driveId, title });
  if (visibility === 'org') await fx.share(documentId, { user: userA }, 'edit');
  await fx.client.query(`INSERT INTO note_document_map (id, org_id, source_type, source_id, target_type, target_id)
    VALUES ($1, $2, 'note', $3, 'document', $4)`, [randomUUID(), fx.orgId, noteId, documentId]);
  return { noteId, documentId };
}

before(async () => {
  if (skip) return;
  fx = await setupDrivesFixture('notes-vis', { routes: [{ path: '/api/daily-notes', app: dailyNoteRoutes }] });
  userA = fx.people.member;
  userB = fx.people.member2;
  const sharedNotes = await fx.insertDrive({ kind: 'open', defaultRole: 'view', name: 'Shared notes' });
  const myDrive = await fx.insertDrive({ kind: 'personal', ownerUserId: userA, name: 'My drive' });
  orgNote = await movedNote('org', 'Org note from A', sharedNotes);
  privateNote = await movedNote('private', 'Private note from A', myDrive);
});

after(async () => {
  if (skip) return;
  if (fx) {
    await fx.client.query('DELETE FROM notes WHERE org_id = $1', [fx.orgId]);
    await fx.teardown();
  }
  await closeDb();
});

test('1. user-B can see user-A\'s workspace note in GET list', { skip }, async () => {
  const notes = await (await fx.request(userB, 'GET', '/api/daily-notes')).json() as any[];
  const found = notes.find((n) => n.id === orgNote.noteId);
  assert.ok(found, 'user-B should see user-A\'s workspace note');
  assert.equal(found.document_id, orgNote.documentId);
});

test('2. user-A\'s private note is NOT visible to user-B', { skip }, async () => {
  const notes = await (await fx.request(userB, 'GET', '/api/daily-notes')).json() as any[];
  assert.equal(notes.find((n) => n.id === privateNote.noteId), undefined, 'user-B should NOT see user-A\'s private note');
  assert.ok(notes.find((n) => n.id === orgNote.noteId), 'user-B should still see user-A\'s workspace note');
  assert.equal((await fx.request(userB, 'GET', `/api/daily-notes/${privateNote.noteId}`)).status, 404);
  const own = await (await fx.request(userA, 'GET', '/api/daily-notes')).json() as any[];
  assert.ok(own.find((n) => n.id === privateNote.noteId));
});

test('3. user-B attempting PATCH on user-A\'s workspace note → 410 NOTES_MOVED', { skip }, async () => {
  const res = await fx.request(userB, 'PATCH', `/api/daily-notes/${orgNote.noteId}`, { title: 'Hijacked title' });
  assert.equal(res.status, 410);
  const body = await res.json() as any;
  assert.equal(body.code, 'NOTES_MOVED');
  assert.equal(body.document_id, orgNote.documentId);
  // A note B can't open answers like one that doesn't exist: no document named.
  const hidden = await fx.request(userB, 'PATCH', `/api/daily-notes/${privateNote.noteId}`, { title: 'x' });
  assert.equal(hidden.status, 410);
  assert.equal((await hidden.json() as any).document_id, undefined);
});

test('4. user-A PATCHing their own note → 410 NOTES_MOVED, nothing changed', { skip }, async () => {
  const res = await fx.request(userA, 'PATCH', `/api/daily-notes/${orgNote.noteId}`, { title: 'Updated by owner' });
  assert.equal(res.status, 410);
  assert.equal((await res.json() as any).document_id, orgNote.documentId);
  const { rows: [note] } = await fx.client.query('SELECT title FROM notes WHERE id = $1', [orgNote.noteId]);
  assert.equal(note.title, 'Org note from A');
});
