/**
 * Task 5.1 — notes cross-reference worker, since notes became documents (F15)
 *
 * Covers:
 *   1. A queued job cannot write after its human actor is offboarded.
 *   2. A private document containing PREFIX-N creates a cross_references row
 *      with source_type='document', and copies no text into task comments.
 *   3. The handler is idempotent — same (document, task) pair does not
 *      insert a second row or duplicate comment.
 *   4. A note job queued before the move reads the document the note moved
 *      to, and records the reference from that document.
 *   5. Only a document in an open drive leaves the org-wide task comment.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeDb } from '../src/lib/db.js';
import { handleCrossReference } from '../src/workers/handlers/cross-reference.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const skip = !safeTestDatabaseUrl();
let fx: DrivesFixture;
let user: string;
let prefix: string;
let projectId: string;
let taskId: string;
let documentId: string;

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const job = (data: Record<string, unknown>) => handleCrossReference({ id: randomUUID(), name: 'cross-reference', data: { content: '', orgId: fx.orgId, userId: user, ...data } } as never);
const refsFrom = async (sourceId: string) => (await fx.client.query(
  `SELECT source_type, target_id, context FROM cross_references WHERE org_id = $1 AND source_id = $2`, [fx.orgId, sourceId])).rows;
const comments = async () => (await fx.client.query('SELECT content FROM task_comments WHERE task_id = $1', [taskId])).rows;

before(async () => {
  if (skip) return;
  fx = await setupDrivesFixture('notes-xref');
  user = fx.people.member;
  prefix = `NX${randomUUID().replace(/[^a-f]/g, '').slice(0, 4).toUpperCase()}`;
  projectId = randomUUID();
  taskId = randomUUID();
  await fx.client.query(`INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter) VALUES ($1, $2, $3, $4, $5, 0)`,
    [projectId, fx.orgId, `Notes Xref ${prefix}`, prefix, user]);
  await fx.client.query(`INSERT INTO tasks (id, org_id, project_id, number, title, status, priority, created_by)
    VALUES ($1, $2, $3, 7, 'Cross-ref target', 'todo', 'p2', $4)`, [taskId, fx.orgId, projectId, user]);
  const myDrive = await fx.insertDrive({ kind: 'personal', ownerUserId: user, name: 'My drive' });
  documentId = await fx.insertDocument({ driveId: myDrive, title: 'Design doc', json: doc(`see ${prefix}-7 for context`) });
});

after(async () => {
  if (skip) return;
  if (fx) {
    await fx.client.query('DELETE FROM cross_references WHERE org_id = $1', [fx.orgId]);
    for (const table of ['task_comments', 'task_activity']) await fx.client.query(`DELETE FROM ${table} WHERE task_id = $1`, [taskId]);
    await fx.client.query('DELETE FROM tasks WHERE id = $1', [taskId]);
    await fx.client.query('DELETE FROM projects WHERE id = $1', [projectId]);
    await fx.client.query('DELETE FROM notes WHERE org_id = $1', [fx.orgId]);
    await fx.teardown();
  }
  await closeDb();
});

test('cross-reference worker rejects a stale job after actor deactivation', { skip }, async () => {
  await fx.client.query('UPDATE org_members SET is_active = false WHERE org_id = $1 AND user_id = $2', [fx.orgId, user]);
  try {
    await job({ sourceType: 'document', sourceId: documentId });
    assert.deepEqual(await refsFrom(documentId), [], 'offboarded actor must not create a cross-reference');
  } finally {
    await fx.client.query('UPDATE org_members SET is_active = true WHERE org_id = $1 AND user_id = $2', [fx.orgId, user]);
  }
});

test('cross-reference worker links a private document without leaking its content', { skip }, async () => {
  await job({ sourceType: 'document', sourceId: documentId });
  assert.deepEqual(await refsFrom(documentId), [{ source_type: 'document', target_id: taskId, context: null }]);
  assert.deepEqual(await comments(), [], 'a private document must not create a task-visible comment');
});

test('cross-reference worker is idempotent — second call adds no new rows', { skip }, async () => {
  await job({ sourceType: 'document', sourceId: documentId });
  assert.equal((await refsFrom(documentId)).length, 1, 'xref should remain 1 after re-run');
  assert.deepEqual(await comments(), []);
});

test('a note job queued before the move reads the note\'s document and records the reference from it', { skip }, async () => {
  const noteId = randomUUID();
  const myDrive = (await fx.client.query(`SELECT drive_id FROM documents WHERE id = $1`, [documentId])).rows[0].drive_id;
  const moved = await fx.insertDocument({ driveId: myDrive, title: 'Moved note', json: doc(`also ${prefix}-7`) });
  // The old row says nothing about the task: the document is what is read.
  await fx.client.query(`INSERT INTO notes (id, org_id, user_id, title, content) VALUES ($1, $2, $3, 'Moved note', '<p>no reference</p>')`,
    [noteId, fx.orgId, user]);
  await fx.client.query(`INSERT INTO note_document_map (id, org_id, source_type, source_id, target_type, target_id)
    VALUES ($1, $2, 'note', $3, 'document', $4)`, [randomUUID(), fx.orgId, noteId, moved]);
  await job({ sourceType: 'note', noteId });
  assert.deepEqual(await refsFrom(moved), [{ source_type: 'document', target_id: taskId, context: null }]);
  assert.deepEqual(await refsFrom(noteId), [], 'nothing names the old note');
  // A note that never moved is skipped.
  const unmoved = randomUUID();
  await fx.client.query(`INSERT INTO notes (id, org_id, user_id, title, content) VALUES ($1, $2, $3, 'Unmoved', $4)`,
    [unmoved, fx.orgId, user, `<p>${prefix}-7</p>`]);
  await job({ sourceType: 'note', sourceId: unmoved });
  assert.deepEqual(await refsFrom(unmoved), []);
});

test('only a document in an open drive leaves the org-wide task comment', { skip }, async () => {
  const open = await fx.insertDocument({ driveId: fx.workspaceDriveId, title: 'Open doc', json: doc(`${prefix}-7 is next`) });
  await job({ sourceType: 'document', sourceId: open });
  assert.equal((await refsFrom(open)).length, 1);
  assert.deepEqual(await comments(), [{ content: 'Referenced from a document in an open drive' }]);
  // Someone who can't open the document records nothing.
  const hidden = await fx.insertDocument({ driveId: (await fx.client.query(`SELECT drive_id FROM documents WHERE id = $1`, [documentId])).rows[0].drive_id,
    title: 'Hidden', json: doc(`${prefix}-7`) });
  await handleCrossReference({ id: randomUUID(), name: 'cross-reference',
    data: { sourceType: 'document', sourceId: hidden, content: '', orgId: fx.orgId, userId: fx.people.member2 } } as never);
  assert.deepEqual(await refsFrom(hidden), []);
});
