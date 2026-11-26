/**
 * The notes move (plan Task F14, spec 5.11): notes, note folders and chat
 * canvases become documents in drives, once, idempotently, with nothing
 * lost. Everything is seeded with SQL into the drives fixture's workspace,
 * the move runs once for it in `before`, and each test reads what it made.
 * The last tests run the move again (nothing changes), the post-move check
 * (and each kind of corruption it must find), the Workspace drive for a
 * workspace with no notes, and the startup path: the API moves and checks
 * before it listens, records the run, skips the move while paused, refuses
 * to listen on a failed check, checks again after an interrupted check, and
 * never re-checks a workspace whose run was ok.
 *
 * Run:
 *   DATABASE_URL=... DEFT_TEST_DATABASE_URL=... pnpm --filter @deft/api test test/drives-move-db.test.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { after, before } from 'node:test';
import { jsonToText } from '@deft/doc-schema';
import { closeDb } from '../src/lib/db.js';
import { documentRoleFor } from '../src/lib/document-access.js';
import { LocalFileStore, localFileStore } from '../src/lib/file-store.js';
import * as placementModule from '../src/lib/drives-move/placement.js';
import * as runsModule from '../src/lib/drives-move/runs.js';
import { _setPausedStartForTest } from '../src/lib/paused-start.js';
import { postMoveCheck } from '../src/lib/drives-move/check.js';
import { moveOrg, type MoveReport } from '../src/lib/drives-move/move-org.js';
import { moveNotesBeforeListen } from '../src/lib/drives-move/startup.js';
/** The move release drives_move_runs rows are kept under (pending.ts DRIVES_MOVE_RELEASE). */
const DRIVES_MOVE_RELEASE = '0.3.0-preview.155';
import { documentRoutes } from '../src/routes/documents.js';
import { driveRoutes } from '../src/routes/drives.js';
import { setupDrivesFixture, type DrivesFixture } from './fixtures/drives-fixture.js';
import { ensureNoteFilesTable } from './fixtures/note-files-table.js';
import { safeTestDatabaseUrl } from './fixtures/safe-test-database.js';

const url = safeTestDatabaseUrl();
const SKIP = url ? false : 'Set DEFT_TEST_DATABASE_URL to a disposable test database';

type JSONContent = Parameters<typeof jsonToText>[0];
type Row = Record<string, any>;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 9, 8, 7, 6]);
const run = randomUUID().slice(0, 8);

let fx: DrivesFixture;
let report: MoveReport;
const storageKeys: string[] = [];
/** A workspace with no drives at all until the move. */
const bareOrg = randomUUID();
const bareUser = randomUUID();

type SeedId = 'folderA' | 'folderB' | 'folderC' | 'nested' | 'workspace' | 'space' | 'spaceless' | 'shared' | 'versioned' | 'template'
  | 'pinned' | 'deleted' | 'imageA' | 'imageB' | 'imaged' | 'hostile' | 'foreignImage' | 'messageImage' | 'borrowed' | 'inactiveNote'
  | 'agentNote' | 'canvasOther' | 'canvasGuest' | 'emptySpace1' | 'emptySpace2' | 'canvasEmpty' | 'canvasBlank' | 'huge' | 'tagged' | 'tag'
  | 'crossTask' | 'team' | 'bareNote' | 'historyImage' | 'historySplit' | 'longHistory' | 'tied'
  | 'tiedMicro' | 'bigHistory' | 'lostFile' | 'lostBytes' | 'heldImage' | 'holderHistory' | 'holderTemplate' | 'holderCopy' | 'editorsFile'
  | 'foreignVersion' | 'deletedWorkspace' | 'bareDeletedWorkspace' | 'emptyDocSpace' | 'canvasEmptyDoc' | 'leftSpace' | 'canvasLeft' | 'ownersFile'
  | 'ownerFileSpace' | 'canvasOwnersFile';
/** Every id the tests need, filled by `before`. */
const s = {} as Record<SeedId, string>;
/** The 3 MB note's text, built from the same pieces as its HTML (no tag stripping). */
let hugeText = '';
const people = {} as Record<keyof DrivesFixture['people'] | 'inactive' | 'agentAuthor', string>;

const q = (text: string, values: unknown[] = []) => fx.client.query(text, values);
const one = async (text: string, values: unknown[] = []): Promise<Row | undefined> => (await q(text, values)).rows[0];
const at = (iso: string) => new Date(iso);

async function insertNote(i: {
  user: string; title?: string; content?: string | null; visibility?: 'private' | 'org' | 'space'; spaceId?: string | null; folderId?: string;
  pinned?: boolean; template?: boolean; deleted?: boolean; createdAt?: Date; updatedAt?: Date; orgId?: string;
}): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO notes (id, org_id, user_id, folder_id, title, content, is_pinned, is_template, is_deleted, visibility, visibility_space_id,
      created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
  [id, i.orgId ?? fx.orgId, i.user, i.folderId ?? null, i.title ?? 'A note', i.content === undefined ? '<p>Some words.</p>' : i.content,
    i.pinned ?? false, i.template ?? false, i.deleted ?? false, i.visibility ?? 'private', i.spaceId ?? null,
    i.createdAt ?? at('2026-03-01T09:00:00Z'), i.updatedAt ?? at('2026-03-02T10:00:00Z')]);
  return id;
}

async function insertFolder(user: string, name: string, parent?: string, deleted = false): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO note_folders (id, org_id, user_id, name, parent_folder_id, is_deleted) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, fx.orgId, user, name, parent ?? null, deleted]);
  return id;
}

async function insertVersion(noteId: string, version: number, v: { title: string; content: string; editedBy: string; createdAt: Date }): Promise<void> {
  await q(`INSERT INTO note_versions (id, note_id, version, title, content, edited_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), noteId, version, v.title, v.content, v.editedBy, v.createdAt]);
}

/** A staged image upload with its bytes in the file store, as POST /api/upload leaves a note image. */
async function upload(uploader: string, extra: { messageId?: string } = {}): Promise<string> {
  const id = randomUUID();
  const key = `drives-move-${run}-${id}`;
  storageKeys.push(key);
  await localFileStore.put(key, PNG);
  await q(`INSERT INTO files (id, org_id, uploaded_by, filename, mime_type, size_bytes, storage_key, processing_status, attachment_kind,
      staged_expires_at, message_id)
    VALUES ($1, $2, $3, 'pasted.png', 'image/png', $4, $5, 'ready', 'image', now() + interval '24 hours', $6)`,
  [id, fx.orgId, uploader, PNG.length, key, extra.messageId ?? null]);
  return id;
}

async function insertSpace(name: string, createdBy: string, members: string[]): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, $3, 'public', $4)`, [id, fx.orgId, `${name}-${run}`, createdBy]);
  for (const member of members) await q('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), id, member]);
  return id;
}

async function insertPrivateSpace(name: string, createdBy: string, members: string[]): Promise<string> {
  const id = await insertSpace(name, createdBy, members);
  await q(`UPDATE spaces SET type = 'private' WHERE id = $1`, [id]);
  return id;
}

async function insertCanvas(spaceId: string, title: string, content: unknown, lastEditedBy: string | null): Promise<string> {
  const id = randomUUID();
  await q(`INSERT INTO canvases (id, org_id, space_id, title, content, last_edited_by, last_edited_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, now())`,
    [id, fx.orgId, spaceId, title, content === null ? null : JSON.stringify(content), lastEditedBy]);
  return id;
}

const paragraphDoc = (...texts: string[]): JSONContent => ({ type: 'doc', content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });

async function mapOf(sourceType: 'note' | 'note_folder' | 'canvas', sourceId: string): Promise<Row | undefined> {
  return one('SELECT * FROM note_document_map WHERE source_type = $1 AND source_id = $2', [sourceType, sourceId]);
}

async function documentOf(noteId: string, sourceType: 'note' | 'canvas' = 'note'): Promise<Row> {
  const map = await mapOf(sourceType, noteId);
  assert.ok(map, `${sourceType} ${noteId} has a map row`);
  assert.equal(map.target_type, 'document');
  const doc = await one('SELECT * FROM documents WHERE id = $1', [map.target_id]);
  assert.ok(doc, 'the mapped document exists');
  return doc;
}

const driveOf = async (driveId: string) => (await one('SELECT * FROM drives WHERE id = $1', [driveId]))!;
const byPrincipal = (a: Row, b: Row) => (a.principal_type + a.principal_id < b.principal_type + b.principal_id ? -1 : 1);
const sharesOf = async (documentId: string) => (await q('SELECT principal_type, principal_id, role FROM document_shares WHERE document_id = $1',
  [documentId])).rows.sort(byPrincipal);
const roleOf = (userId: string, documentId: string) => documentRoleFor(userId, fx.orgId, documentId);

/** Every image node's attributes in a document's JSON. */
function imagesIn(json: JSONContent): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (node: JSONContent) => {
    if (node.type === 'image') found.push(node.attrs ?? {});
    node.content?.forEach(walk);
  };
  walk(json);
  return found;
}

const squash = (text: string) => text.replace(/\s+/g, '');

/** Counts of everything the move writes, for the run-twice test. */
async function snapshot(orgId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ['drives', 'drive_members', 'doc_folders', 'documents', 'document_shares', 'document_versions', 'document_attachments',
    'doc_favorites', 'note_document_map', 'entity_tags', 'cross_references', 'team_resources', 'attention_items']) {
    counts[table] = Number((await one(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [orgId]))!.n);
  }
  counts.revisions = Number((await one('SELECT coalesce(sum(revision), 0)::int AS n FROM documents WHERE org_id = $1', [orgId]))!.n);
  for (const table of ['documents', 'doc_folders', 'drives', 'drive_members', 'document_shares', 'entity_tags', 'cross_references', 'attention_items']) {
    counts[`${table}_last_change`] = Number((await one(`SELECT coalesce(extract(epoch FROM max(updated_at)) * 1000, 0)::float8 AS n FROM ${table}
      WHERE org_id = $1`, [orgId]))!.n);
  }
  return counts;
}

before(async () => {
  if (!url) return;
  await ensureNoteFilesTable(url);
  fx = await setupDrivesFixture('drives-move', {
    routes: [{ path: '/api/drives', app: driveRoutes }, { path: '/api/documents', app: documentRoutes }],
  });
  Object.assign(people, fx.people);
  people.inactive = await fx.addPerson({ active: false });
  people.agentAuthor = await fx.addPerson({ kind: 'agent', agentEmployeeId: randomUUID() });
  const { member, member2, admin, guest, owner } = fx.people;

  // A private note in nested folders.
  s.folderA = await insertFolder(member, 'Projects');
  s.folderB = await insertFolder(member, 'Launch', s.folderA);
  s.folderC = await insertFolder(member, 'Week one', s.folderB);
  s.nested = await insertNote({ user: member, title: 'Deep note', folderId: s.folderC });

  // A note visible to the whole workspace, a space note, and a space note whose chat is gone.
  s.workspace = await insertNote({ user: member, title: 'For everyone', visibility: 'org', content: '<p>Read me, all.</p>' });
  s.space = await insertNote({ user: member2, title: 'Team only', visibility: 'space', spaceId: fx.spaces.team, content: '<p>Team words.</p>' });
  s.spaceless = await insertNote({ user: member2, title: 'Chat gone', visibility: 'space', spaceId: null });

  // Shares.
  s.shared = await insertNote({ user: member, title: 'Shared out' });
  await q(`INSERT INTO note_shares (id, note_id, shared_with_user_id, permission) VALUES ($1, $2, $3, 'edit'), ($4, $2, $5, 'view')`,
    [randomUUID(), s.shared, member2, randomUUID(), admin]);

  // Versions, oldest first, each with its own title and editor.
  s.versioned = await insertNote({ user: member, title: 'Final title', content: '<p>Third words.</p>' });
  await insertVersion(s.versioned, 1, { title: 'Draft one', content: '<p>First words.</p>', editedBy: member, createdAt: at('2026-01-05T08:00:00Z') });
  await insertVersion(s.versioned, 2, { title: 'Draft two', content: '<p>Second words.</p>', editedBy: member, createdAt: at('2026-01-06T08:00:00Z') });
  await insertVersion(s.versioned, 3, { title: 'Draft three', content: '<p>Almost.</p>', editedBy: member, createdAt: at('2026-01-07T08:00:00Z') });

  // A template, a pinned note, a deleted note.
  s.template = await insertNote({ user: member, title: 'Meeting template', template: true });
  s.pinned = await insertNote({ user: member, title: 'Pinned', pinned: true });
  s.deleted = await insertNote({ user: member, title: 'Gone', deleted: true, updatedAt: at('2026-02-14T12:30:00Z') });

  // Images: one by data-file-id, one by a full API address; both staged.
  s.imageA = await upload(member);
  s.imageB = await upload(member);
  s.imaged = await insertNote({ user: member, title: 'Pictures',
    content: `<p>Look:</p><img data-file-id="${s.imageA}" alt="a"><img src="http://localhost:3001/api/files/${s.imageB}" alt="b">` });
  await q('INSERT INTO note_files (org_id, note_id, file_id) VALUES ($1, $2, $3), ($1, $2, $4)', [fx.orgId, s.imaged, s.imageA, s.imageB]);

  // Hostile HTML and a swept image.
  s.hostile = await insertNote({ user: member, title: 'Hostile',
    content: `<p onclick="steal()">Hello there</p><script>alert(1)</script><iframe src="https://evil.example"></iframe><img data-file-id="${randomUUID()}">` });

  // An image someone else uploaded, and one already on a chat message.
  const message = randomUUID();
  await q('INSERT INTO messages (id, org_id, space_id, user_id, content) VALUES ($1, $2, $3, $4, $5)', [message, fx.orgId, fx.spaces.team, member, 'pic']);
  s.foreignImage = await upload(member2);
  s.messageImage = await upload(member, { messageId: message });
  s.borrowed = await insertNote({ user: member, title: 'Borrowed pictures',
    content: `<img data-file-id="${s.foreignImage}"><p>between</p><img data-file-id="${s.messageImage}">` });
  await q('INSERT INTO note_files (org_id, note_id, file_id) VALUES ($1, $2, $3)', [fx.orgId, s.borrowed, s.messageImage]);

  // A deactivated author and an agent author.
  s.inactiveNote = await insertNote({ user: people.inactive, title: 'Left behind' });
  s.agentNote = await insertNote({ user: people.agentAuthor, title: 'Agent jotting' });

  // Canvases: one with content edited by a member, one edited by a guest, two empty.
  s.canvasOther = await insertCanvas(fx.spaces.other, 'Plan board', paragraphDoc('Ship it on Friday.'), member2);
  s.canvasGuest = await insertCanvas(fx.spaces.team, 'Guest board', paragraphDoc('A guest wrote this.'), guest);
  s.emptySpace1 = await insertSpace('empty-one', owner, [member]);
  s.emptySpace2 = await insertSpace('empty-two', owner, [member]);
  s.canvasEmpty = await insertCanvas(s.emptySpace1, 'Canvas', null, member);
  s.canvasBlank = await insertCanvas(s.emptySpace2, 'Canvas', { type: 'doc', content: [{ type: 'paragraph' }, { type: 'paragraph', content: [{ type: 'text', text: '   ' }] }] }, member);

  // A note of about 3.4 MB: a section of paragraphs, then one paragraph of 2.6 MB in lines.
  const line = 'The quick brown fox jumps over the lazy dog and keeps on running far away. '.repeat(4);
  const paragraphs = Array.from({ length: 2400 }, (_, n) => `Section A paragraph ${n}: ${line}`);
  const lines = Array.from({ length: 8500 }, (_, n) => `Line ${n} ${line}`);
  hugeText = ['Intro.', 'Section A', ...paragraphs, 'Section B', ...lines].join('');
  s.huge = await insertNote({ user: member, title: 'Huge',
    content: `<p>Intro.</p><h1>Section A</h1>${paragraphs.map((p) => `<p>${p}</p>`).join('')}<h1>Section B</h1><p>${lines.join('<br>')}</p>` });

  // A split note whose history holds an oversized version, and whose image sits in a later part and in its history.
  s.historyImage = await upload(member);
  const filler = (label: string, count: number) => Array.from({ length: count }, (_, n) => `<p>${label} ${n}: ${line}</p>`).join('');
  s.historySplit = await insertNote({ user: member, title: 'Split with history',
    content: `<p>Intro.</p><h1>Part one</h1>${filler('One', 3000)}<h1>Part two</h1>${filler('Two', 3000)}<img data-file-id="${s.historyImage}">` });
  await q('INSERT INTO note_files (org_id, note_id, file_id) VALUES ($1, $2, $3)', [fx.orgId, s.historySplit, s.historyImage]);
  await insertVersion(s.historySplit, 1, { title: 'Very long draft', content: `${filler('Old', 9000)}<img data-file-id="${s.historyImage}">`,
    editedBy: member, createdAt: at('2026-01-10T08:00:00Z') });
  await insertVersion(s.historySplit, 2, { title: 'Short draft', content: `<p>Short.</p><img data-file-id="${s.historyImage}">`,
    editedBy: member, createdAt: at('2026-01-11T08:00:00Z') });

  // A long history (200 versions), and 12 versions that share one time.
  s.longHistory = await insertNote({ user: member, title: 'Long history', content: '<p>Now.</p>' });
  for (let v = 1; v <= 200; v += 1) {
    await insertVersion(s.longHistory, v, { title: `Draft ${v}`, content: `<p>Draft ${v} ${line}</p>`, editedBy: member,
      createdAt: new Date(Date.UTC(2026, 0, 1) + v * 60_000) });
  }
  s.tied = await insertNote({ user: member, title: 'Tied history', content: '<p>Latest.</p>' });
  for (let v = 1; v <= 12; v += 1) {
    await insertVersion(s.tied, v, { title: `Same time ${v}`, content: `<p>Version ${v}.</p>`, editedBy: member, createdAt: at('2026-02-01T09:30:00Z') });
  }

  // Consult fixes.
  // S-F6: versions at T, T and T+1 µs.
  s.tiedMicro = await insertNote({ user: member, title: 'Tied to the microsecond', content: '<p>Now.</p>' });
  for (const [v, time] of [[1, '2026-02-02 10:00:00'], [2, '2026-02-02 10:00:00'], [3, '2026-02-02 10:00:00.000001']] as const) {
    await q(`INSERT INTO note_versions (id, note_id, version, title, content, edited_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamp)`,
      [randomUUID(), s.tiedMicro, v, `Micro ${v}`, `<p>Micro ${v}.</p>`, member, time]);
  }
  // S-F2: a note too small to split whose old version is over the cap.
  s.bigHistory = await insertNote({ user: member, title: 'Small now, big before', content: '<p>Small.</p>' });
  await insertVersion(s.bigHistory, 1, { title: 'Big draft', content: filler('Big', 9000), editedBy: member, createdAt: at('2026-01-12T08:00:00Z') });
  // O-F2: an image whose row exists but whose bytes are gone.
  s.lostFile = randomUUID();
  await q(`INSERT INTO files (id, org_id, uploaded_by, filename, mime_type, size_bytes, storage_key, processing_status, attachment_kind, staged_expires_at)
    VALUES ($1, $2, $3, 'lost.png', 'image/png', 20, $4, 'ready', 'image', now() + interval '24 hours')`, [s.lostFile, fx.orgId, member, `drives-move-lost-${run}`]);
  s.lostBytes = await insertNote({ user: member, title: 'Lost bytes', content: `<p>Before.</p><img data-file-id="${s.lostFile}">` });
  // O-F7: a history-only claim (oldest), a template showing the image, and a later copy showing it too.
  s.heldImage = await upload(member);
  s.holderHistory = await insertNote({ user: member, title: 'Had it once', content: '<p>No picture now.</p>', createdAt: at('2026-01-01T08:00:00Z') });
  await insertVersion(s.holderHistory, 1, { title: 'With picture', content: `<img data-file-id="${s.heldImage}">`, editedBy: member,
    createdAt: at('2026-01-02T08:00:00Z') });
  s.holderTemplate = await insertNote({ user: member, title: 'Template with picture', template: true, createdAt: at('2026-01-05T08:00:00Z'),
    content: `<p>Template.</p><img data-file-id="${s.heldImage}">` });
  s.holderCopy = await insertNote({ user: member, title: 'Copy with picture', createdAt: at('2026-01-06T08:00:00Z'),
    content: `<p>Copy.</p><img data-file-id="${s.heldImage}">` });
  // S-F1: the current content names a file only a version's editor uploaded.
  s.editorsFile = await upload(member2);
  s.foreignVersion = await insertNote({ user: member, title: 'Someone else\'s picture', content: `<p>Now.</p><img data-file-id="${s.editorsFile}">` });
  await insertVersion(s.foreignVersion, 1, { title: 'Their edit', content: `<p>Then.</p><img data-file-id="${s.editorsFile}">`, editedBy: member2,
    createdAt: at('2026-01-03T08:00:00Z') });
  // O-F10: a deleted workspace note by someone with no live one.
  s.deletedWorkspace = await insertNote({ user: member2, title: 'Gone from everyone', visibility: 'org', deleted: true });
  // O-F1: a canvas holding a document that keeps no block.
  s.emptyDocSpace = await insertSpace('empty-doc', owner, [member]);
  s.canvasEmptyDoc = await insertCanvas(s.emptyDocSpace, 'Canvas', { type: 'doc', content: [] }, member);
  // O-F5: a private chat whose last editor and creator are no longer in it; its earliest eligible member owns the canvas.
  s.leftSpace = await insertPrivateSpace('left', owner, [member, guest]);
  s.canvasLeft = await insertCanvas(s.leftSpace, 'Left behind board', paragraphDoc('Still here.'), member2);
  // O-F6: a private chat's canvas naming its owner's file, written by a guest.
  s.ownersFile = await upload(member);
  s.ownerFileSpace = await insertPrivateSpace('owner-file', member, [member, guest]);
  s.canvasOwnersFile = await insertCanvas(s.ownerFileSpace, 'Board with a borrowed picture',
    { type: 'doc', content: [{ type: 'image', attrs: { fileId: s.ownersFile } }, { type: 'paragraph', content: [{ type: 'text', text: 'Look.' }] }] }, guest);

  // References: tags (one note tagged twice, as note and daily_note), a cross reference, a team link and an attention item.
  s.tagged = await insertNote({ user: member, title: 'Tagged' });
  s.tag = randomUUID();
  await q('INSERT INTO tags (id, org_id, name) VALUES ($1, $2, $3)', [s.tag, fx.orgId, `t-${run}`]);
  await q(`INSERT INTO entity_tags (id, org_id, tag_id, entity_type, entity_id) VALUES ($1, $2, $3, 'note', $4), ($5, $2, $3, 'daily_note', $4)`,
    [randomUUID(), fx.orgId, s.tag, s.tagged, randomUUID()]);
  s.crossTask = randomUUID();
  await q(`INSERT INTO cross_references (id, org_id, source_type, source_id, target_type, target_id, created_by) VALUES ($1, $2, 'note', $3, 'task', $4, $5)`,
    [randomUUID(), fx.orgId, s.tagged, s.crossTask, member]);
  s.team = randomUUID();
  await q(`INSERT INTO teams (id, org_id, name, handle, created_by) VALUES ($1, $2, 'Docs team', $3, $4)`, [s.team, fx.orgId, `docs-${run}`, owner]);
  await q(`INSERT INTO team_resources (id, org_id, team_id, resource_type, resource_id, created_by) VALUES ($1, $2, $3, 'note', $4, $5)`,
    [randomUUID(), fx.orgId, s.team, s.tagged, owner]);
  await q(`INSERT INTO attention_items (id, org_id, user_id, kind, lane, dedupe_key, source_type, source_id, title)
    VALUES ($1, $2, $3, 'mention', 'inbox', $4, 'note', $5, 'Mentioned in a note')`, [randomUUID(), fx.orgId, member2, `note:${s.tagged}`, s.tagged]);

  // A workspace with a note and no drives yet.
  await q('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)', [bareOrg, `Bare ${run}`, `bare-${run}`]);
  await q(`INSERT INTO users (id, email, name, kind) VALUES ($1, $2, 'Bare', 'human')`, [bareUser, `bare-${run}@drives.test`]);
  await q(`INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'owner')`, [randomUUID(), bareOrg, bareUser]);
  s.bareNote = await insertNote({ user: bareUser, orgId: bareOrg, title: 'Bare note' });
  // O-F10: its only workspace note is deleted, so it gets no Shared notes drive.
  s.bareDeletedWorkspace = await insertNote({ user: bareUser, orgId: bareOrg, title: 'Deleted for everyone', visibility: 'org', deleted: true });

  report = await moveOrg(fx.orgId);
});

after(async () => {
  if (fx) {
    const orgs = [fx.orgId, fx.otherOrgId, bareOrg];
    await q('DELETE FROM document_attachments WHERE org_id = ANY($1::text[])', [orgs]);
    await q('DELETE FROM team_resources WHERE org_id = ANY($1::text[])', [orgs]);
    await q('DELETE FROM teams WHERE org_id = ANY($1::text[])', [orgs]);
    await q('DELETE FROM entity_tags WHERE org_id = ANY($1::text[])', [orgs]);
    await q('DELETE FROM tags WHERE org_id = ANY($1::text[])', [orgs]);
    await q('DELETE FROM cross_references WHERE org_id = ANY($1::text[])', [orgs]);
    await q('DELETE FROM note_files WHERE org_id = ANY($1::text[])', [orgs]);
    await q('DELETE FROM note_shares WHERE note_id IN (SELECT id FROM notes WHERE org_id = ANY($1::text[]))', [orgs]);
    await q('DELETE FROM note_versions WHERE note_id IN (SELECT id FROM notes WHERE org_id = ANY($1::text[]))', [orgs]);
    await q('DELETE FROM notes WHERE org_id = ANY($1::text[])', [orgs]);
    await q('DELETE FROM note_folders WHERE org_id = ANY($1::text[])', [orgs]);
    await q('DELETE FROM canvases WHERE org_id = ANY($1::text[])', [orgs]);
    await q('DELETE FROM files WHERE org_id = ANY($1::text[])', [orgs]);
    await q('DELETE FROM messages WHERE org_id = ANY($1::text[])', [orgs]);
    for (const table of ['drives_move_runs', 'note_document_map', 'doc_favorites', 'document_versions', 'document_shares', 'documents', 'doc_folders',
      'drive_members', 'drives']) {
      await q(`DELETE FROM ${table} WHERE org_id = $1`, [bareOrg]);
    }
    await q('DELETE FROM org_members WHERE org_id = $1', [bareOrg]);
    await q('DELETE FROM orgs WHERE id = $1', [bareOrg]);
    await fx.teardown();
    const cleanup = new (await import('pg')).default.Client({ connectionString: url! });
    await cleanup.connect();
    await cleanup.query('DELETE FROM users WHERE id = $1', [bareUser]).finally(() => cleanup.end());
    for (const key of storageKeys) await localFileStore.delete(key).catch(() => undefined);
  }
  _setPausedStartForTest(false);
  await closeDb();
});

test('a private note in nested folders lands in My drive with the same folder tree', { skip: SKIP }, async () => {
  const doc = await documentOf(s.nested);
  const drive = await driveOf(doc.drive_id);
  assert.equal(drive.kind, 'personal');
  assert.equal(drive.owner_user_id, fx.people.member);
  assert.equal(drive.frozen_at, null);
  const names: string[] = [];
  let folderId: string | null = doc.folder_id;
  while (folderId) {
    const folder = (await one('SELECT * FROM doc_folders WHERE id = $1', [folderId]))!;
    assert.equal(folder.drive_id, drive.id, 'every folder is in My drive');
    names.unshift(folder.name);
    folderId = folder.parent_folder_id;
  }
  assert.deepEqual(names, ['Projects', 'Launch', 'Week one']);
  for (const folder of [s.folderA, s.folderB, s.folderC]) {
    const map = await mapOf('note_folder', folder);
    assert.equal(map?.target_type, 'doc_folder', 'each note folder has its doc folder');
  }
  assert.equal((await mapOf('note_folder', s.folderC))!.target_id, doc.folder_id);
  assert.equal(await roleOf(fx.people.member, doc.id), 'full');
  assert.equal(await roleOf(fx.people.member2, doc.id), null);
});

test('a workspace note lands in Shared notes in its author\'s folder; members can view, the author can edit, a guest can\'t', { skip: SKIP }, async () => {
  const doc = await documentOf(s.workspace);
  const drive = await driveOf(doc.drive_id);
  assert.equal(drive.system_key, 'shared_notes');
  assert.equal(drive.kind, 'open');
  assert.equal(drive.default_role, 'view');
  const folder = (await one('SELECT * FROM doc_folders WHERE id = $1', [doc.folder_id]))!;
  assert.equal(folder.name, 'member', 'the folder is named after the author');
  assert.equal(folder.parent_folder_id, null);
  assert.equal(await roleOf(fx.people.member, doc.id), 'edit');
  assert.equal(await roleOf(fx.people.member2, doc.id), 'view');
  assert.equal(await roleOf(fx.people.owner, doc.id), 'full');
  assert.equal(await roleOf(fx.people.guest, doc.id), null);
  // O-F3: agents who could read workspace notes on master keep reading them.
  assert.equal(await roleOf(fx.people.agentUser, doc.id), 'view', 'an agent who could see the note on master still can');
  assert.equal(await roleOf(people.agentAuthor, doc.id), 'view');
  assert.ok(await one(`SELECT 1 FROM drive_members WHERE drive_id = $1 AND principal_type = 'user' AND principal_id = $2 AND role = 'view'`,
    [drive.id, fx.people.agentUser]));
  assert.ok(report.agentsKeptOnSharedNotes >= 2);
  assert.ok(report.guestsPotentiallyAffected.guests >= 1, 'the report counts the guests potentially affected');
  assert.ok(report.guestsPotentiallyAffected.workspaceNotes >= 1, 'and the workspace notes involved');
});

test('a space note lands in My drive shared with the chat as view', { skip: SKIP }, async () => {
  const doc = await documentOf(s.space);
  const drive = await driveOf(doc.drive_id);
  assert.equal(drive.kind, 'personal');
  assert.equal(drive.owner_user_id, fx.people.member2);
  assert.deepEqual(await sharesOf(doc.id), [{ principal_type: 'space', principal_id: fx.spaces.team, role: 'view' }]);
  assert.equal(await roleOf(fx.people.member, doc.id), 'view');
  assert.equal(await roleOf(fx.people.guest, doc.id), 'view', 'a guest in the chat reads it, as before');
  assert.equal(await roleOf(fx.people.admin, doc.id), null);
  // A space note whose chat is gone becomes private, and is reported.
  const lost = await documentOf(s.spaceless);
  assert.deepEqual(await sharesOf(lost.id), []);
  assert.equal((await mapOf('note', s.spaceless))!.details.made_private, 'no_space');
  assert.ok(report.spaceNotesMadePrivate >= 1);
});

test('an edit note share becomes an edit document share', { skip: SKIP }, async () => {
  const doc = await documentOf(s.shared);
  const shares = await sharesOf(doc.id);
  assert.deepEqual(shares, [
    { principal_type: 'user', principal_id: fx.people.admin, role: 'view' },
    { principal_type: 'user', principal_id: fx.people.member2, role: 'edit' },
  ].sort(byPrincipal));
  assert.equal(await roleOf(fx.people.member2, doc.id), 'edit');
  assert.equal(await roleOf(fx.people.admin, doc.id), 'view');
});

test('note versions become moved versions in order with their original times', { skip: SKIP }, async () => {
  const doc = await documentOf(s.versioned);
  const versions = (await q(`SELECT kind, created_at, content_json FROM document_versions WHERE document_id = $1 ORDER BY created_at, id`, [doc.id])).rows;
  assert.deepEqual(versions.map((v) => v.kind), ['moved', 'moved', 'moved']);
  assert.deepEqual(versions.map((v) => (v.created_at as Date).toISOString()),
    ['2026-01-05T08:00:00.000Z', '2026-01-06T08:00:00.000Z', '2026-01-07T08:00:00.000Z']);
  assert.deepEqual(versions.map((v) => jsonToText(v.content_json)), ['First words.', 'Second words.', 'Almost.']);
  assert.equal(jsonToText(doc.content_json), 'Third words.');
});

test('a template stays a template; a pinned note becomes a favourite; a deleted note becomes a deleted document', { skip: SKIP }, async () => {
  const template = await documentOf(s.template);
  assert.equal(template.is_template, true);
  assert.equal((await driveOf(template.drive_id)).owner_user_id, fx.people.member, 'in the author\'s personal drive');
  const pinned = await documentOf(s.pinned);
  assert.ok(await one(`SELECT 1 FROM doc_favorites WHERE user_id = $1 AND target_type = 'document' AND target_id = $2`, [fx.people.member, pinned.id]));
  const deleted = await documentOf(s.deleted);
  assert.equal(deleted.is_deleted, true);
  assert.equal((deleted.deleted_at as Date).toISOString(), '2026-02-14T12:30:00.000Z');
  assert.ok(report.favourites >= 1);
});

test('every moved document has use_in_knowledge = false', { skip: SKIP }, async () => {
  const rows = (await q(`SELECT d.use_in_knowledge FROM documents d JOIN note_document_map m ON m.target_id = d.id AND m.target_type = 'document'
    WHERE m.org_id = $1 UNION ALL SELECT d.use_in_knowledge FROM documents d WHERE d.org_id = $1 AND d.parent_document_id IS NOT NULL`, [fx.orgId])).rows;
  assert.ok(rows.length >= 15, 'the moved documents are there');
  assert.deepEqual([...new Set(rows.map((r) => r.use_in_knowledge))], [false]);
});

test('a canvas with content becomes a document shared with its chat as edit; an empty canvas is dropped and counted', { skip: SKIP }, async () => {
  const doc = await documentOf(s.canvasOther, 'canvas');
  assert.equal(doc.title, 'Plan board');
  assert.equal(jsonToText(doc.content_json), 'Ship it on Friday.');
  assert.equal((await driveOf(doc.drive_id)).owner_user_id, fx.people.member2, 'in the personal drive of the person who last edited it');
  assert.deepEqual(await sharesOf(doc.id), [{ principal_type: 'space', principal_id: fx.spaces.other, role: 'edit' }]);
  assert.equal(await roleOf(fx.people.member2, doc.id), 'full');
  assert.equal(await mapOf('canvas', s.canvasEmpty), undefined);
  assert.equal(await mapOf('canvas', s.canvasBlank), undefined);
  assert.equal(await mapOf('canvas', s.canvasEmptyDoc), undefined, 'a document keeping no block is empty too (O-F1)');
  assert.equal(report.emptyCanvases, 3);
  assert.equal(report.canvases, 4);
  assert.ok(!report.errors.some((error) => error.sourceId === s.canvasEmptyDoc), 'and never refused');
});

test('an image whose file exists is linked and loses its staged expiry', { skip: SKIP }, async () => {
  const doc = await documentOf(s.imaged);
  assert.deepEqual(imagesIn(doc.content_json).map((a) => a.fileId), [s.imageA, s.imageB], 'both images name their files, the full address too');
  assert.deepEqual(imagesIn(doc.content_json).map((a) => a.src), [null, null]);
  const links = (await q('SELECT file_id, in_current FROM document_attachments WHERE document_id = $1 ORDER BY file_id', [doc.id])).rows;
  assert.deepEqual(links, [s.imageA, s.imageB].sort().map((file_id) => ({ file_id, in_current: true })));
  for (const file of [s.imageA, s.imageB]) {
    assert.equal((await one('SELECT staged_expires_at FROM files WHERE id = $1', [file]))!.staged_expires_at, null);
  }
  assert.equal(await roleOf(fx.people.member, doc.id), 'full');
});

test('a note with a script, an iframe, an onclick and a missing image moves; unsafe content is dropped and both are counted', { skip: SKIP }, async () => {
  const doc = await documentOf(s.hostile);
  const text = jsonToText(doc.content_json);
  assert.match(text, /Hello there/);
  assert.match(text, /Image not available/);
  assert.doesNotMatch(JSON.stringify(doc.content_json), /alert|steal|evil\.example/);
  assert.deepEqual(imagesIn(doc.content_json), []);
  const map = (await mapOf('note', s.hostile))!;
  assert.equal(map.outcome, 'unsafe_and_missing');
  assert.equal(map.details.unsafe_dropped, 3);
  assert.equal(map.details.missing_images, 1);
  const all = (await q('SELECT details FROM note_document_map WHERE org_id = $1', [fx.orgId])).rows;
  assert.equal(report.unsafeDropped, all.reduce((sum, r) => sum + Number(r.details?.unsafe_dropped ?? 0), 0));
  assert.equal(report.missingImages, all.reduce((sum, r) => sum + Number(r.details?.missing_images ?? 0), 0));
  assert.ok(report.missingImages >= 1 && report.unsafeDropped >= 3);
});

test('cross references and entity tags point at the new documents', { skip: SKIP }, async () => {
  const doc = await documentOf(s.tagged);
  const tags = (await q('SELECT entity_type, entity_id FROM entity_tags WHERE tag_id = $1', [s.tag])).rows;
  assert.deepEqual(tags, [{ entity_type: 'document', entity_id: doc.id }], 'one tag row, the duplicate removed');
  const refs = (await q('SELECT source_type, source_id, target_type, target_id FROM cross_references WHERE org_id = $1', [fx.orgId])).rows;
  assert.deepEqual(refs, [{ source_type: 'document', source_id: doc.id, target_type: 'task', target_id: s.crossTask }]);
});

test('an image uploaded by someone else, or attached to a chat message, is not linked', { skip: SKIP }, async () => {
  const doc = await documentOf(s.borrowed);
  assert.deepEqual(imagesIn(doc.content_json), []);
  assert.equal(jsonToText(doc.content_json).match(/Image not available/g)?.length, 2);
  assert.equal((await q('SELECT 1 FROM document_attachments WHERE file_id = ANY($1::text[])', [[s.foreignImage, s.messageImage]])).rowCount, 0);
  for (const file of [s.foreignImage, s.messageImage]) {
    assert.notEqual((await one('SELECT staged_expires_at FROM files WHERE id = $1', [file]))!.staged_expires_at, null, 'its expiry is left alone');
  }
  assert.equal((await mapOf('note', s.borrowed))!.details.missing_images, 2);
});

test('versions keep their titles and editors', { skip: SKIP }, async () => {
  const doc = await documentOf(s.versioned);
  const versions = (await q('SELECT title, created_by FROM document_versions WHERE document_id = $1 ORDER BY created_at, id', [doc.id])).rows;
  assert.deepEqual(versions, ['Draft one', 'Draft two', 'Draft three'].map((title) => ({ title, created_by: fx.people.member })));
  assert.equal(doc.title, 'Final title');
});

test('a deactivated author\'s notes land in a frozen personal drive', { skip: SKIP }, async () => {
  for (const [noteId, author] of [[s.inactiveNote, people.inactive], [s.agentNote, people.agentAuthor]] as const) {
    const doc = await documentOf(noteId);
    const drive = await driveOf(doc.drive_id);
    assert.equal(drive.kind, 'personal');
    assert.equal(drive.owner_user_id, author);
    assert.notEqual(drive.frozen_at, null, 'frozen until the workspace owner hands it on');
    assert.ok(await one(`SELECT 1 FROM drive_members WHERE drive_id = $1 AND principal_type = 'user' AND principal_id = $2 AND role = 'full'`,
      [drive.id, author]), 'the owner\'s full row, as ensurePersonalDrive writes it');
    for (const viewer of [fx.people.owner, fx.people.admin, fx.people.member, author]) assert.equal(await roleOf(viewer, doc.id), null);
  }
});

test('a guest-edited public canvas goes to Shared notes, credited to an eligible member of the chat', { skip: SKIP }, async () => {
  const doc = await documentOf(s.canvasGuest, 'canvas');
  const drive = await driveOf(doc.drive_id);
  assert.equal(drive.system_key, 'shared_notes', 'a public chat\'s canvas stays readable by the workspace (O-F4)');
  const folder = (await one('SELECT name, created_by FROM doc_folders WHERE id = $1', [doc.folder_id]))!;
  assert.deepEqual(folder, { name: 'Chat canvases', created_by: null });
  // The guest isn't eligible and the chat's creator (the owner) has no seat in it: the earliest eligible member is credited (O-F5).
  assert.equal(doc.created_by, fx.people.member);
  assert.equal((await mapOf('canvas', s.canvasGuest))!.details.owner_rule, 'earliest_member');
  assert.deepEqual(await sharesOf(doc.id), [{ principal_type: 'space', principal_id: fx.spaces.team, role: 'edit' }]);
  assert.equal(await roleOf(fx.people.guest, doc.id), 'edit', 'the guest can still write it through the chat');
});

test('a member who never joined a public chat can view its canvas but not edit it; a chat member can edit (O-F4)', { skip: SKIP }, async () => {
  const doc = await documentOf(s.canvasGuest, 'canvas');
  const outsiderMember = await fx.addPerson();
  const outsiderGuest = await fx.addPerson({ role: 'guest' });
  assert.equal(await roleOf(outsiderMember, doc.id), 'view', 'readable before joining, as canReadSpace allowed');
  assert.equal(await roleOf(fx.people.member, doc.id), 'edit', 'a member of the chat writes it');
  assert.equal(await roleOf(outsiderGuest, doc.id), null, 'a guest outside the chat still can\'t read it');
  // A private chat's canvas keeps its owner's My drive and the chat's edit share.
  const other = await documentOf(s.canvasOther, 'canvas');
  assert.equal((await driveOf(other.drive_id)).kind, 'personal');
  assert.equal(await roleOf(outsiderMember, other.id), null);
});

test('a last editor who has left a private chat doesn\'t own its canvas (O-F5)', { skip: SKIP }, async () => {
  const doc = await documentOf(s.canvasLeft, 'canvas');
  const drive = await driveOf(doc.drive_id);
  assert.equal(drive.owner_user_id, fx.people.member, 'the earliest eligible member of the chat, not the last editor or the absent creator');
  assert.equal(drive.frozen_at, null);
  assert.equal(await roleOf(fx.people.member2, doc.id), null, 'the former member gains nothing');
  assert.equal(await roleOf(fx.people.guest, doc.id), 'edit', 'the chat still writes it');
});

test('a canvas naming its owner\'s file, written by someone else, shows the placeholder and the file isn\'t linked (O-F6)', { skip: SKIP }, async () => {
  const doc = await documentOf(s.canvasOwnersFile, 'canvas');
  assert.equal((await driveOf(doc.drive_id)).owner_user_id, fx.people.member, 'the chat\'s creator owns it');
  assert.deepEqual(imagesIn(doc.content_json), []);
  assert.match(jsonToText(doc.content_json), /Image not available/);
  assert.equal((await q('SELECT 1 FROM document_attachments WHERE file_id = $1', [s.ownersFile])).rowCount, 0);
  assert.notEqual((await one('SELECT staged_expires_at FROM files WHERE id = $1', [s.ownersFile]))!.staged_expires_at, null);
});

test('the first-owner fallback never picks a frozen drive (O-F5)', { skip: SKIP }, async () => {
  // A workspace whose only owner is deactivated: a private chat's canvas with no eligible member has nobody to own it.
  const org = randomUUID();
  const gone = randomUUID();
  const admin = randomUUID();
  const chat = randomUUID();
  await q('INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)', [org, `Gone owner ${run}`, `gone-owner-${run}`]);
  await q(`INSERT INTO users (id, email, name, kind) VALUES ($1, $2, 'Gone', 'human'), ($3, $4, 'Admin', 'human')`,
    [gone, `gone-${run}@drives.test`, admin, `gone-admin-${run}@drives.test`]);
  await q(`INSERT INTO org_members (id, org_id, user_id, role, is_active) VALUES ($1, $2, $3, 'owner', false), ($4, $2, $5, 'admin', true)`,
    [randomUUID(), org, gone, randomUUID(), admin]);
  await q(`INSERT INTO spaces (id, org_id, name, type, created_by) VALUES ($1, $2, 'quiet', 'private', $3)`, [chat, org, gone]);
  await q('INSERT INTO space_members (id, space_id, user_id) VALUES ($1, $2, $3)', [randomUUID(), chat, gone]);
  const canvas = randomUUID();
  await q(`INSERT INTO canvases (id, org_id, space_id, title, content, last_edited_by) VALUES ($1, $2, $3, 'Quiet', $4::jsonb, $5)`,
    [canvas, org, chat, JSON.stringify(paragraphDoc('Nobody to hold it.')), gone]);
  try {
    const moved = await moveOrg(org);
    assert.equal((await q(`SELECT 1 FROM drives WHERE org_id = $1 AND frozen_at IS NOT NULL`, [org])).rowCount, 0, 'no frozen drive takes it');
    assert.ok(moved.errors.some((error) => error.sourceId === canvas), 'without an active human owner it is refused, not frozen');
    assert.equal(await mapOf('canvas', canvas), undefined);
  } finally {
    for (const table of ['document_attachments', 'note_document_map', 'document_shares', 'document_versions', 'documents', 'doc_folders', 'drive_members', 'drives']) {
      await q(`DELETE FROM ${table} WHERE org_id = $1`, [org]);
    }
    await q('DELETE FROM canvases WHERE org_id = $1', [org]);
    await q('DELETE FROM space_members WHERE space_id = $1', [chat]);
    await q('DELETE FROM spaces WHERE org_id = $1', [org]);
    await q('DELETE FROM org_members WHERE org_id = $1', [org]);
    await q('DELETE FROM orgs WHERE id = $1', [org]);
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[gone, admin]]);
  }
});

test('the workspace\'s first owner holds a private canvas no chat member can (O-F5)', { skip: SKIP }, async () => {
  const lonely = await insertPrivateSpace('lonely', people.inactive, [people.inactive]);
  const canvas = await insertCanvas(lonely, 'Lonely board', paragraphDoc('Only the departed were here.'), people.inactive);
  const moved = await moveOrg(fx.orgId);
  assert.deepEqual(moved.errors, []);
  const doc = await documentOf(canvas, 'canvas');
  const drive = await driveOf(doc.drive_id);
  assert.equal(drive.owner_user_id, fx.people.owner, 'the earliest active human owner');
  assert.equal(drive.frozen_at, null, 'never a frozen drive');
  assert.equal(moved.canvasesPlacedWithWorkspaceOwner, 1);
});

test('a 3 MB note is split into sub-pages with nothing lost', { skip: SKIP }, async () => {
  const main = await documentOf(s.huge);
  const parts = [main, ...(await q('SELECT * FROM documents WHERE parent_document_id = $1 ORDER BY position, id', [main.id])).rows];
  assert.ok(parts.length >= 3, `split into a main page and sub-pages (${parts.length})`);
  for (const part of parts) {
    assert.ok(part.size_bytes <= 2_097_152, `each part is within the 2 MB cap (${part.size_bytes})`);
    assert.equal(part.drive_id, main.drive_id);
    assert.equal(part.use_in_knowledge, false);
  }
  assert.ok(parts.slice(1).some((part) => part.title === 'Section A' || part.title === 'Section B'), 'a sub-page is titled by its heading');
  // The expected text is built from the same pieces as the note's HTML, not by stripping its tags.
  assert.equal(squash(parts.map((part) => jsonToText(part.content_json)).join('')), squash(hugeText), 'every character is kept, in order');
  const map = (await mapOf('note', s.huge))!;
  assert.equal(map.details.parts.length, parts.length);
  assert.ok(map.details.split_blocks >= 1, 'the 2.6 MB paragraph was split at its lines');
  assert.ok(report.splitNotes >= 1 && report.subPages >= 2);
});

test('team links and note attention items point at documents', { skip: SKIP }, async () => {
  const doc = await documentOf(s.tagged);
  assert.deepEqual((await q('SELECT resource_type, resource_id FROM team_resources WHERE team_id = $1', [s.team])).rows,
    [{ resource_type: 'document', resource_id: doc.id }]);
  assert.deepEqual((await q('SELECT source_type, source_id FROM attention_items WHERE org_id = $1 AND user_id = $2', [fx.orgId, fx.people.member2])).rows,
    [{ source_type: 'document', source_id: doc.id }]);
});

test('running the move twice changes nothing', { skip: SKIP }, async () => {
  assert.deepEqual(report.errors, []);
  // Every note and note folder, and the 5 canvases with content, were mapped (the first run, and the owner-fallback test's).
  const expected = await one(`SELECT (SELECT count(*) FROM notes WHERE org_id = $1) + (SELECT count(*) FROM note_folders WHERE org_id = $1) + 5 AS n`,
    [fx.orgId]);
  assert.equal(Number((await one('SELECT count(*)::int AS n FROM note_document_map WHERE org_id = $1', [fx.orgId]))!.n), Number(expected!.n));
  const before = await snapshot(fx.orgId);
  const again = await moveOrg(fx.orgId);
  assert.deepEqual(await snapshot(fx.orgId), before);
  assert.equal(again.notes, 0);
  assert.equal(again.folders, 0);
  assert.equal(again.canvases, 0);
  assert.equal(again.versions, 0);
  assert.equal(again.shares, 0);
  const sources = Number((await one('SELECT count(*)::int AS n FROM note_document_map WHERE org_id = $1', [fx.orgId]))!.n);
  assert.equal(again.skippedAlreadyMoved, sources);
  assert.deepEqual(again.errors, []);
});

test('postMoveCheck reports ok: counts match the map and a sample opens with history and images', { skip: SKIP }, async () => {
  const check = await postMoveCheck(fx.orgId, 200);
  assert.deepEqual(check.mismatches, []);
  assert.deepEqual(check.sampleFailed, []);
  assert.equal(check.ok, true);
  assert.equal(check.notesExpected, check.documentsMapped);
  assert.equal(check.notesExpected, Number((await one('SELECT count(*)::int AS n FROM note_document_map WHERE org_id = $1', [fx.orgId]))!.n));
  const documents = Number((await one(`SELECT count(*)::int AS n FROM note_document_map WHERE org_id = $1 AND target_type = 'document'`, [fx.orgId]))!.n);
  assert.ok(documents >= 18);
  assert.equal(check.sampleOpened, documents, 'every moved document opened, with its history and images');
  // A broken link is found: an image's bytes gone.
  const [key] = (await q('SELECT f.storage_key FROM files f WHERE f.id = $1', [s.imageA])).rows.map((r) => r.storage_key as string);
  await localFileStore.delete(key!);
  try {
    const broken = await postMoveCheck(fx.orgId, 200);
    assert.equal(broken.ok, false);
    assert.ok(broken.mismatches.some((m) => m.includes(s.imageA!)), 'the missing bytes are named');
  } finally {
    await localFileStore.put(key!, PNG);
  }
});

test('the Workspace drive exists for every org after the move', { skip: SKIP }, async () => {
  for (const orgId of [fx.orgId, fx.otherOrgId, bareOrg]) {
    if (orgId !== fx.orgId) assert.deepEqual((await moveOrg(orgId)).errors, []);
    const rows = (await q(`SELECT kind, default_role FROM drives WHERE org_id = $1 AND system_key = 'workspace' AND NOT is_deleted`, [orgId])).rows;
    assert.deepEqual(rows, [{ kind: 'open', default_role: 'edit' }]);
  }
  assert.ok(await mapOf('note', s.bareNote));
  assert.equal((await q(`SELECT 1 FROM drives WHERE org_id = $1 AND system_key = 'shared_notes'`, [bareOrg])).rowCount, 0,
    'Shared notes only where live workspace notes exist: a deleted one alone makes none (O-F10)');
  const deleted = await documentOf(s.bareDeletedWorkspace);
  assert.equal(deleted.is_deleted, true);
  assert.equal((await driveOf(deleted.drive_id)).owner_user_id, bareUser, 'in its author\'s drive, in the trash');
});

test('a deleted workspace note goes to the root of Shared notes, in the trash, with no author folder (O-F10)', { skip: SKIP }, async () => {
  const doc = await documentOf(s.deletedWorkspace);
  assert.equal(doc.is_deleted, true);
  assert.equal((await driveOf(doc.drive_id)).system_key, 'shared_notes');
  assert.equal(doc.folder_id, null);
  assert.equal((await q(`SELECT 1 FROM doc_folders WHERE drive_id = $1 AND created_by = $2`, [doc.drive_id, fx.people.member2])).rowCount, 0,
    'no empty folder named after its author');
});

test('an image whose bytes are gone shows the placeholder and is counted; the check still passes (O-F2)', { skip: SKIP }, async () => {
  const doc = await documentOf(s.lostBytes);
  assert.deepEqual(imagesIn(doc.content_json), []);
  assert.match(jsonToText(doc.content_json), /Image not available/);
  assert.equal((await mapOf('note', s.lostBytes))!.details.image_refusals[s.lostFile], 'bytes_missing');
  assert.equal(report.missingImageBytes, 1);
  assert.equal((await q('SELECT 1 FROM document_attachments WHERE file_id = $1', [s.lostFile])).rowCount, 0);
  assert.equal((await postMoveCheck(fx.orgId, 0)).ok, true);
});

test('a live note showing an image in its current content holds it over a history-only claim (O-F7)', { skip: SKIP }, async () => {
  const template = await documentOf(s.holderTemplate);
  const history = await documentOf(s.holderHistory);
  const copy = await documentOf(s.holderCopy);
  assert.deepEqual((await q('SELECT document_id, in_current FROM document_attachments WHERE file_id = $1', [s.heldImage])).rows,
    [{ document_id: template.id, in_current: true }], 'the earliest live note showing it links it');
  assert.deepEqual(imagesIn(template.content_json).map((attrs) => attrs.fileId), [s.heldImage]);
  assert.deepEqual(imagesIn(copy.content_json), [], 'a later copy shows the placeholder (one file, one document)');
  const [old] = (await q(`SELECT content_json FROM document_versions WHERE document_id = $1 AND kind = 'moved'`, [history.id])).rows;
  assert.deepEqual(imagesIn(old.content_json), [], 'the older history-only claim doesn\'t take it');
  assert.equal((await mapOf('note', s.holderHistory))!.details.image_refusals[s.heldImage], 'held_by_another_note');
});

test('a version edited by another person can\'t authorize a file in the current content (S-F1)', { skip: SKIP }, async () => {
  const doc = await documentOf(s.foreignVersion);
  assert.deepEqual(imagesIn(doc.content_json), [], 'the author didn\'t upload it: the current content shows the placeholder');
  const [version] = (await q(`SELECT content_json FROM document_versions WHERE document_id = $1 AND kind = 'moved'`, [doc.id])).rows;
  assert.deepEqual(imagesIn(version.content_json).map((attrs) => attrs.fileId), [s.editorsFile], 'the version its uploader edited keeps it');
  assert.deepEqual((await q('SELECT in_current FROM document_attachments WHERE document_id = $1 AND file_id = $2', [doc.id, s.editorsFile])).rows,
    [{ in_current: false }], 'linked for the history only');
});

test('a split note keeps an oversized old version viewable but not restorable, and links its history images to the main page', { skip: SKIP }, async () => {
  const main = await documentOf(s.historySplit);
  const subPages = (await q('SELECT id FROM documents WHERE parent_document_id = $1 ORDER BY position, id', [main.id])).rows.map((r) => r.id as string);
  assert.ok(subPages.length >= 1, 'the note was split');
  const links = (await q('SELECT document_id, in_current FROM document_attachments WHERE file_id = $1', [s.historyImage])).rows;
  const holder = links.find((link) => subPages.includes(link.document_id));
  assert.deepEqual(holder && { in_current: holder.in_current }, { in_current: true }, 'the sub-page that shows the image links it as current');
  assert.deepEqual(links.filter((link) => link.document_id === main.id), [{ document_id: main.id, in_current: false }],
    'the main page, which holds the history, links it as history');
  const versions = (await q(`SELECT id, title, size_bytes FROM document_versions WHERE document_id = $1 AND kind = 'moved' ORDER BY created_at`,
    [main.id])).rows;
  assert.equal(versions.length, 2);
  const long = versions.find((v) => v.title === 'Very long draft')!;
  assert.ok(long.size_bytes > 2_097_152, `the old version is kept whole, over the cap (${long.size_bytes})`);
  const viewed = await fx.request(fx.people.member, 'GET', `/api/documents/${main.id}/versions/${long.id}`);
  assert.equal(viewed.status, 200, 'it can be viewed');
  assert.equal(((await viewed.json()) as { version: { id: string } }).version.id, long.id);
  // S-F2: the history of a split note can be viewed and copied, not restored (it would rewrite only the first page).
  for (const version of versions) {
    const restored = await fx.request(fx.people.member, 'POST', `/api/documents/${main.id}/versions/${version.id}/restore`);
    assert.equal(restored.status, 409, `restoring "${version.title}" is refused`);
    assert.deepEqual(await restored.json(), {
      error: 'This note was split into pages when it moved. Earlier versions can be viewed and copied, not restored.', code: 'SPLIT_HISTORY',
    });
  }
  // A note that wasn't split: restoring a version over the cap is refused by the writer, 413 TOO_LARGE.
  const small = await documentOf(s.bigHistory);
  const [big] = (await q(`SELECT id, size_bytes FROM document_versions WHERE document_id = $1 AND kind = 'moved'`, [small.id])).rows;
  assert.ok(big.size_bytes > 2_097_152);
  const tooLarge = await fx.request(fx.people.member, 'POST', `/api/documents/${small.id}/versions/${big.id}/restore`);
  assert.equal(tooLarge.status, 413);
  assert.equal(((await tooLarge.json()) as { code: string }).code, 'TOO_LARGE');
});

test('a note with 200 versions moves them all, in order, one version at a time', { skip: SKIP }, async () => {
  const doc = await documentOf(s.longHistory);
  const versions = (await q(`SELECT title, (edit_details->>'note_version')::int AS v FROM document_versions
    WHERE document_id = $1 AND kind = 'moved' ORDER BY created_at, id`, [doc.id])).rows;
  assert.equal(versions.length, 200);
  assert.deepEqual(versions.map((row) => row.v), Array.from({ length: 200 }, (_, n) => n + 1));
  assert.deepEqual(versions.map((row) => row.title), Array.from({ length: 200 }, (_, n) => `Draft ${n + 1}`));
  // The history is never held whole: the version list reads no content, and each version's content is read on its own.
  const source = readFileSync(resolve(import.meta.dirname, '../src/lib/drives-move/move-notes.ts'), 'utf8');
  const listing = source.match(
    /SELECT ((?:(?!SELECT)[^`])*?)\s+FROM note_versions history_row JOIN notes history_note ON history_note\.id = history_row\.note_id\s+WHERE history_row\.note_id = /,
  )?.[1] ?? '';
  assert.ok(listing && !/\bcontent\b/.test(listing), `the version list reads no content (${listing})`);
  assert.match(source, /SELECT history_row\.content\s+FROM note_versions history_row[^`]*?WHERE history_row\.id = /, 'one version\'s content at a time');
});

test('versions that share one time keep their order, a microsecond apart', { skip: SKIP }, async () => {
  const doc = await documentOf(s.tied);
  const rows = (await q(`SELECT (edit_details->>'note_version')::int AS v, created_at::text AS at,
      extract(epoch FROM created_at - min(created_at) OVER ()) * 1000000 AS micros
    FROM document_versions WHERE document_id = $1 AND kind = 'moved' ORDER BY created_at DESC, id DESC`, [doc.id])).rows;
  assert.equal(rows.length, 12);
  assert.deepEqual(rows.map((row) => row.v), Array.from({ length: 12 }, (_, n) => 12 - n), 'newest first, as the history lists them');
  assert.deepEqual(rows.map((row) => Math.round(Number(row.micros))), Array.from({ length: 12 }, (_, n) => 11 - n));
  assert.equal(new Set(rows.map((row) => row.at)).size, 12);
});

/** Runs postMoveCheck with `corrupt` applied, then undoes it; returns the check. */
async function checkWith(corrupt: () => Promise<void>, undo: () => Promise<void>, sampleSize = 0) {
  assert.equal((await postMoveCheck(fx.orgId, sampleSize)).ok, true, 'ok before the corruption');
  await corrupt();
  try {
    return await postMoveCheck(fx.orgId, sampleSize);
  } finally {
    await undo();
  }
}

test('versions at T, T and T+1 µs are stored strictly increasing, in version order (S-F6)', { skip: SKIP }, async () => {
  const doc = await documentOf(s.tiedMicro);
  const rows = (await q(`SELECT (edit_details->>'note_version')::int AS v, created_at::text AS at FROM document_versions
    WHERE document_id = $1 AND kind = 'moved' ORDER BY created_at, id`, [doc.id])).rows;
  assert.deepEqual(rows, [
    { v: 1, at: '2026-02-02 10:00:00' }, { v: 2, at: '2026-02-02 10:00:00.000001' }, { v: 3, at: '2026-02-02 10:00:00.000002' },
  ]);
});

test('postMoveCheck finds a document in the wrong drive (O-F9)', { skip: SKIP }, async () => {
  const doc = await documentOf(s.pinned);
  const check = await checkWith(
    () => q('UPDATE documents SET drive_id = $1 WHERE id = $2', [fx.workspaceDriveId, doc.id]).then(() => undefined),
    () => q('UPDATE documents SET drive_id = $1 WHERE id = $2', [doc.drive_id, doc.id]).then(() => undefined));
  assert.equal(check.ok, false);
  assert.ok(check.mismatches.includes(`note ${s.pinned}: its document is in the wrong drive`), check.mismatches.join('\n'));
});

test('postMoveCheck finds an agent without its view on Shared notes (O-F3)', { skip: SKIP }, async () => {
  const [row] = (await q(`SELECT member.* FROM drive_members member JOIN drives shared ON shared.id = member.drive_id AND shared.system_key = 'shared_notes'
    WHERE member.org_id = $1 AND member.principal_id = $2`, [fx.orgId, fx.people.agentUser])).rows;
  assert.ok(row, 'the agent holds view on Shared notes');
  const check = await checkWith(
    () => q('DELETE FROM drive_members WHERE id = $1', [row.id]).then(() => undefined),
    () => q(`INSERT INTO drive_members (id, org_id, drive_id, principal_type, principal_id, role, added_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.id, row.org_id, row.drive_id, row.principal_type, row.principal_id, row.role, row.added_by]).then(() => undefined));
  assert.ok(check.mismatches.includes(`agent ${fx.people.agentUser} has no view on Shared notes`), check.mismatches.join('\n'));
});

test('postMoveCheck finds an extra share', { skip: SKIP }, async () => {
  const doc = await documentOf(s.shared);
  const id = randomUUID();
  const check = await checkWith(
    () => q(`INSERT INTO document_shares (id, org_id, document_id, principal_type, principal_id, role) VALUES ($1, $2, $3, 'user', $4, 'view')`,
      [id, fx.orgId, doc.id, fx.people.guest]).then(() => undefined),
    () => q('DELETE FROM document_shares WHERE id = $1', [id]).then(() => undefined));
  assert.equal(check.ok, false);
  assert.ok(check.mismatches.some((m) => m.includes(`has an extra share for user ${fx.people.guest}`)), check.mismatches.join('\n'));
});

test('postMoveCheck finds a raised role', { skip: SKIP }, async () => {
  const doc = await documentOf(s.space);
  const where = `document_id = '${doc.id}' AND principal_type = 'space'`;
  const check = await checkWith(
    () => q(`UPDATE document_shares SET role = 'edit' WHERE ${where}`).then(() => undefined),
    () => q(`UPDATE document_shares SET role = 'view' WHERE ${where}`).then(() => undefined));
  assert.equal(check.ok, false);
  assert.ok(check.mismatches.some((m) => m.includes(`has the wrong role for space ${fx.spaces.team}`)), check.mismatches.join('\n'));
});

test('postMoveCheck finds a rewritten reference that no longer names its note\'s document', { skip: SKIP }, async () => {
  const doc = await documentOf(s.tagged);
  const elsewhere = await documentOf(s.pinned);
  const [tag] = (await q(`SELECT id FROM entity_tags WHERE tag_id = $1`, [s.tag])).rows;
  const check = await checkWith(
    () => q('UPDATE entity_tags SET entity_id = $1 WHERE id = $2', [elsewhere.id, tag.id]).then(() => undefined),
    () => q('UPDATE entity_tags SET entity_id = $1 WHERE id = $2', [doc.id, tag.id]).then(() => undefined));
  assert.equal(check.ok, false);
  assert.ok(check.mismatches.some((m) => m.includes(`entity_tags row ${tag.id} no longer names the document of note ${s.tagged}`)),
    check.mismatches.join('\n'));
});

test('postMoveCheck finds a missing or misplaced split part', { skip: SKIP }, async () => {
  const map = (await mapOf('note', s.huge))!;
  const ghost = randomUUID();
  const missing = await checkWith(
    () => q(`UPDATE note_document_map SET details = jsonb_set(details, '{parts}', (details->'parts') || to_jsonb($1::text)) WHERE id = $2`,
      [ghost, map.id]).then(() => undefined),
    () => q(`UPDATE note_document_map SET details = $1::jsonb WHERE id = $2`, [JSON.stringify(map.details), map.id]).then(() => undefined));
  assert.ok(missing.mismatches.some((m) => m.includes(`(document ${ghost}) is missing`)), missing.mismatches.join('\n'));
  const last = map.details.parts[map.details.parts.length - 1] as string;
  const detached = await checkWith(
    () => q('UPDATE documents SET parent_document_id = NULL WHERE id = $1', [last]).then(() => undefined),
    () => q('UPDATE documents SET parent_document_id = $1 WHERE id = $2', [map.target_id, last]).then(() => undefined));
  assert.ok(detached.mismatches.some((m) => m.includes(`(document ${last}) is not in place`)), detached.mismatches.join('\n'));
});

test('postMoveCheck finds a history image whose link was deleted', { skip: SKIP }, async () => {
  const main = await documentOf(s.historySplit);
  const [link] = (await q('SELECT * FROM document_attachments WHERE document_id = $1 AND file_id = $2', [main.id, s.historyImage])).rows;
  assert.ok(link, 'the history link exists');
  const check = await checkWith(
    () => q('DELETE FROM document_attachments WHERE id = $1', [link.id]).then(() => undefined),
    () => q(`INSERT INTO document_attachments (id, org_id, document_id, file_id, in_current, added_by, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`, [link.id, link.org_id, link.document_id, link.file_id, link.in_current, link.added_by, link.created_at])
      .then(() => undefined));
  assert.equal(check.ok, false);
  assert.ok(check.mismatches.some((m) => m.includes(`image ${s.historyImage}: in the history of document ${main.id} but not linked to it`)),
    check.mismatches.join('\n'));
});

test('postMoveCheck opens the sampled history and finds a version that does not open', { skip: SKIP }, async () => {
  const doc = await documentOf(s.versioned);
  const [version] = (await q(`SELECT id, content_json FROM document_versions WHERE document_id = $1 AND kind = 'moved' ORDER BY created_at LIMIT 1`,
    [doc.id])).rows;
  const check = await checkWith(
    () => q(`UPDATE document_versions SET content_json = '{"type":"doc","content":[{"type":"noSuchBlock"}]}' WHERE id = $1`, [version.id])
      .then(() => undefined),
    () => q('UPDATE document_versions SET content_json = $1::jsonb WHERE id = $2', [JSON.stringify(version.content_json), version.id]).then(() => undefined),
    200);
  assert.equal(check.ok, false);
  assert.ok(check.sampleFailed.some((m) => m.includes(`moved version ${version.id} does not open`)), check.sampleFailed.join('\n'));
});

test('a reference rewrite that would repeat another workspace\'s row is reported, and nothing is deleted', { skip: SKIP }, async () => {
  const doc = await documentOf(s.tagged);
  const task = randomUUID();
  const ours = randomUUID();
  const theirs = randomUUID();
  // Another workspace already holds the edge the rewrite would make; this workspace's row still names the note.
  await q(`INSERT INTO cross_references (id, org_id, source_type, source_id, target_type, target_id, created_by)
    VALUES ($1, $2, 'document', $3, 'task', $4, $5)`, [theirs, fx.otherOrgId, doc.id, task, fx.people.outsider]);
  await q(`INSERT INTO cross_references (id, org_id, source_type, source_id, target_type, target_id, created_by)
    VALUES ($1, $2, 'note', $3, 'task', $4, $5)`, [ours, fx.orgId, s.tagged, task, fx.people.member]);
  try {
    const again = await moveOrg(fx.orgId);
    assert.deepEqual(again.references.conflicts, [{
      table: 'cross_references', id: ours, key: { source_type: 'document', source_id: doc.id, target_type: 'task', target_id: task },
    }], 'the conflict names this workspace\'s row and the key it would take');
    assert.ok(again.errors.some((error) => error.sourceId === ours), 'reported as an error, so the move does not finish');
    const reported = JSON.stringify(again);
    for (const other of [theirs, fx.otherOrgId, fx.people.outsider]) {
      assert.equal(reported.includes(other), false, 'the report carries no id of the other workspace');
    }
    assert.deepEqual((await q('SELECT org_id, source_type, source_id FROM cross_references WHERE id = ANY($1::text[]) ORDER BY org_id = $2',
      [[ours, theirs], fx.orgId])).rows, [
      { org_id: fx.otherOrgId, source_type: 'document', source_id: doc.id },
      { org_id: fx.orgId, source_type: 'note', source_id: s.tagged },
    ], 'both rows are left as they were');
  } finally {
    await q('DELETE FROM cross_references WHERE id = ANY($1::text[])', [[ours, theirs]]);
  }
});

test('an unreachable file store refuses the note without mapping it, and a run with the store back links its image (O-F2)', { skip: SKIP }, async () => {
  const file = await upload(fx.people.member);
  const note = await insertNote({ user: fx.people.member, title: 'Picture behind a missing mount', content: `<img data-file-id="${file}">` });
  const seam = placementModule as { _setMoveFileStoreForTest?: (store: unknown) => void };
  seam._setMoveFileStoreForTest?.(new LocalFileStore(resolve(import.meta.dirname, `../.no-such-uploads-${run}`)));
  let refused: MoveReport;
  try {
    refused = await moveOrg(fx.orgId);
  } finally {
    seam._setMoveFileStoreForTest?.(null);
  }
  assert.ok(refused.errors.some((error) => error.sourceId === note && /storage is unreachable or empty/.test(error.message)),
    'the note is refused, with the reason');
  assert.equal(await mapOf('note', note), undefined, 'and not mapped, so a later run decides again');
  assert.equal((await q('SELECT 1 FROM document_attachments WHERE file_id = $1', [file])).rowCount, 0);
  const again = await moveOrg(fx.orgId);
  assert.deepEqual(again.errors, []);
  const doc = await documentOf(note);
  assert.deepEqual(imagesIn(doc.content_json).map((attrs) => attrs.fileId), [file]);
  assert.deepEqual((await q('SELECT in_current FROM document_attachments WHERE document_id = $1 AND file_id = $2', [doc.id, file])).rows,
    [{ in_current: true }]);
});

test('the API refuses to listen until the move completes, and skips the move while paused', { skip: SKIP }, async () => {
  // server.ts awaits the move before it calls serve().
  const server = readFileSync(resolve(import.meta.dirname, '../src/server.ts'), 'utf8');
  const moveAt = server.indexOf('await moveNotesBeforeListen(');
  assert.ok(moveAt > 0 && moveAt < server.indexOf('serve({'), 'the move is awaited before the server listens');

  const late = await insertNote({ user: fx.people.member, title: 'Written after the move' });
  const pending = async () => {
    const res = await fx.request(fx.people.member, 'GET', '/api/drives');
    assert.equal(res.status, 200);
    return ((await res.json()) as { notes_move_pending?: boolean }).notes_move_pending;
  };

  // Paused: the move is skipped and the drive pages say the notes move when the workspace resumes.
  _setPausedStartForTest(true);
  try {
    let listened = false;
    await moveNotesBeforeListen({ orgIds: [fx.orgId] }).then(() => { listened = true; });
    assert.equal(listened, true);
    assert.equal(await mapOf('note', late), undefined, 'nothing moved while paused');
    assert.equal(await pending(), true);
  } finally {
    _setPausedStartForTest(false);
  }

  // Not paused: listening waits for the move.
  const atListen: { called: boolean; map?: Row } = { called: false };
  await moveNotesBeforeListen({ orgIds: [fx.orgId] }).then(async () => {
    atListen.called = true;
    atListen.map = await mapOf('note', late);
  });
  assert.equal(atListen.called, true);
  assert.ok(atListen.map, 'the note was moved before the server listened');
  assert.equal(await pending(), false);
  const recorded = (await runRow())!;
  assert.equal(recorded.check_ok, true, 'the run is recorded as done');
  assert.notEqual(recorded.completed_at, null);

  // A note the move can't place (its author isn't in the workspace) stops the start of a workspace not yet done.
  await q('DELETE FROM drives_move_runs WHERE org_id = $1', [fx.orgId]);
  const stray = await insertNote({ user: fx.people.outsider, title: 'Nowhere to go' });
  try {
    let listened = false;
    await assert.rejects(moveNotesBeforeListen({ orgIds: [fx.orgId] }).then(() => { listened = true; }));
    assert.equal(listened, false);
    assert.equal(await mapOf('note', stray), undefined);
    const failed = (await runRow())!;
    assert.equal(failed.check_ok, false);
    assert.equal(failed.completed_at, null, 'the move did not complete');
  } finally {
    await q('DELETE FROM notes WHERE id = $1', [stray]);
  }
});

/** The workspace's move run for this release. */
const runRow = async () => one(`SELECT completed_at, check_ok, report, updated_at, updated_at::text AS changed FROM drives_move_runs
  WHERE org_id = $1 AND release_version = $2`, [fx.orgId, DRIVES_MOVE_RELEASE]);

/** An extra share on a moved document: the post-move check fails on it. Returns the undo. */
async function addExtraShare(): Promise<() => Promise<void>> {
  const doc = await documentOf(s.shared);
  const id = randomUUID();
  await q(`INSERT INTO document_shares (id, org_id, document_id, principal_type, principal_id, role) VALUES ($1, $2, $3, 'user', $4, 'view')`,
    [id, fx.orgId, doc.id, fx.people.guest]);
  return async () => { await q('DELETE FROM document_shares WHERE id = $1', [id]); };
}

/** Runs `fn` with console.error collected. */
async function collectErrors(fn: () => Promise<unknown>): Promise<{ lines: string[]; error: unknown }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
    return { lines, error: null };
  } catch (error) {
    return { lines, error };
  } finally {
    console.error = original;
  }
}

test('a failed reconciliation refuses to listen, logs the report and records the failed check', { skip: SKIP }, async () => {
  assert.notEqual((await runRow())?.check_ok, true, 'the workspace is not done yet');
  const undo = await addExtraShare();
  try {
    let listened = false;
    const { lines, error } = await collectErrors(() => moveNotesBeforeListen({ orgIds: [fx.orgId] }).then(() => { listened = true; }));
    assert.ok(error instanceof Error && /Refusing to listen/.test(error.message));
    assert.equal(listened, false);
    assert.equal(lines[0], '[startup] The notes move or its post-move check failed for a workspace; its report follows');
    const logged = JSON.parse(lines[1]!) as { orgId: string; check: { ok: boolean; mismatches: string[] } };
    assert.equal(logged.orgId, fx.orgId);
    assert.equal(logged.check.ok, false);
    assert.ok(logged.check.mismatches.some((m) => m.includes('has an extra share')));
    const row = (await runRow())!;
    assert.notEqual(row.completed_at, null, 'the move completed');
    assert.equal(row.check_ok, false, 'its check failed');
    assert.equal(row.report.check.ok, false);
  } finally {
    await undo();
  }
});

test('a restart after an interrupted final check runs the check again', { skip: SKIP }, async () => {
  // As a process leaves it when it stops during the check: the move recorded as complete, no check result.
  await q(`UPDATE drives_move_runs SET completed_at = now(), check_ok = false, report = jsonb_build_object('move', report->'move')
    WHERE org_id = $1 AND release_version = $2`, [fx.orgId, DRIVES_MOVE_RELEASE]);
  const before = (await runRow())!;
  assert.equal(before.report.check, undefined);
  let listened = false;
  await moveNotesBeforeListen({ orgIds: [fx.orgId] }).then(() => { listened = true; });
  assert.equal(listened, true);
  const after = (await runRow())!;
  assert.equal(after.check_ok, true);
  assert.equal(after.report.check.ok, true, 'the check ran again and passed');
  assert.notEqual(after.changed, before.changed);
});

test('a workspace whose run was ok is not moved or checked again', { skip: SKIP }, async () => {
  const before = (await runRow())!;
  assert.equal(before.check_ok, true);
  // An edit after the move that the check would flag: it must not stop a later start.
  const undo = await addExtraShare();
  try {
    let listened = false;
    await moveNotesBeforeListen({ orgIds: [fx.orgId] }).then(() => { listened = true; });
    assert.equal(listened, true);
    const after = (await runRow())!;
    assert.equal(after.changed, before.changed, 'the run was not touched');
    assert.deepEqual(after.report, before.report);
  } finally {
    await undo();
  }
});

/** `pnpm drives:move` as the upgrade container runs it: the script's own entry point, in a child process against the test database. */
function drivesMoveScript(...args: string[]): { status: number | null; report: any } {
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/drives-move.ts', ...args], {
    cwd: resolve(import.meta.dirname, '..'), env: { ...process.env, DATABASE_URL: url! }, encoding: 'utf8', timeout: 240_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const json = run.stdout.slice(run.stdout.indexOf('{'));
  return { status: run.status, report: json ? JSON.parse(json) : null };
}

test('a routine drives:move rerun skips a workspace whose run was ok, and --check-only reports without writing', { skip: SKIP }, async () => {
  const before = (await runRow())!;
  assert.equal(before.check_ok, true);
  const mapped = await snapshot(fx.orgId);
  // A legitimate edit after the move that an exact reconciliation would flag.
  const undo = await addExtraShare();
  try {
    const rerun = drivesMoveScript('--org', fx.orgId);
    assert.equal(rerun.status, 0, 'the upgrade step passes');
    assert.deepEqual(rerun.report.orgs.map((org: Row) => ({ skipped: org.skipped, ok: org.ok, move: org.move, check: org.check })),
      [{ skipped: 'already_done', ok: true, move: null, check: null }], 'the done workspace is skipped, not moved or checked');
    const checked = drivesMoveScript('--org', fx.orgId, '--check-only');
    assert.equal(checked.status, 1, '--check-only reports the edit');
    assert.ok(checked.report.orgs[0].check.mismatches.some((m: string) => m.includes('has an extra share')));
    const after = (await runRow())!;
    assert.equal(after.check_ok, true, 'still done');
    assert.equal(after.changed, before.changed, 'neither run wrote the run row');
    assert.deepEqual(after.report, before.report);
    const { document_shares: _shares, document_shares_last_change: _sharesChanged, ...rest } = await snapshot(fx.orgId);
    const { document_shares: _before, document_shares_last_change: _beforeChanged, ...restBefore } = mapped;
    assert.deepEqual(rest, restBefore, 'nothing was moved again');
    let listened = false;
    await moveNotesBeforeListen({ orgIds: [fx.orgId] }).then(() => { listened = true; });
    assert.equal(listened, true, 'and the API still listens');
  } finally {
    await undo();
  }
});

test('a mover whose check fails after another mover recorded the workspace ok reports ok (S-F3)', { skip: SKIP }, async () => {
  await q('DELETE FROM drives_move_runs WHERE org_id = $1', [fx.orgId]);
  const undo = await addExtraShare();
  const seam = runsModule as { _setBeforeFailureReportForTest?: (hook: (() => Promise<void>) | null) => void };
  // The other mover finishes while this one is still checking (and meets an edit made after it started serving).
  seam._setBeforeFailureReportForTest?.(async () => {
    await q(`UPDATE drives_move_runs SET completed_at = coalesce(completed_at, now()), check_ok = true WHERE org_id = $1 AND release_version = $2`,
      [fx.orgId, DRIVES_MOVE_RELEASE]);
  });
  try {
    const run = await runsModule.runOrgMove(fx.orgId);
    assert.equal(run.ok, true, 'the workspace is done: the other mover recorded it');
    const row = (await runRow())!;
    assert.equal(row.check_ok, true, 'and its ok run stands');
  } finally {
    seam._setBeforeFailureReportForTest?.(null);
    await undo();
  }
});
