// The old Notes routes, read-only since notes became documents (spec 5.12;
// plan Task F15; lib/legacy-notes.ts).
//
// Every write answers 410 NOTES_MOVED and writes nothing. A write to one note
// says where it went (`document_id`) only when the note moved and the caller
// can open its document now; a note they can't open answers exactly like one
// that doesn't exist.
//
// The reads stay for old links and clients (the web redirects /notes?id= to
// the document, F16). Each is authorized against the mapped document's
// current access (lib/document-access.ts), never the old note rule, and each
// note it returns carries its `document_id`:
// - GET / and GET /templates: live notes whose document the caller can open;
// - GET /:id: the note, when they can open its document;
// - GET /:id/history and GET /:id/shares: the owner's own note, while they
//   hold edit on its document (history and share lists need edit, rule C4);
// - GET /folders: the caller's own folders, as before (folders carry no
//   access of their own).
import { Hono, type Context } from 'hono';
import { eq, and, desc, ilike, sql, type SQL } from 'drizzle-orm';
import { noteDocumentMap } from '@deft/db/documents';
import { db } from '../lib/db.js';
import { canSeePerson, emailFor, peopleViewer, visiblePersonIds } from '../lib/people-visibility.js';
import { notes, noteFolders, noteVersions, noteShares, users, orgMembers } from '@deft/db/schema';
import { documentRoleFor, roleAtLeast, visibleDocumentIdSql, type DocRole } from '../lib/document-access.js';
import { mappedTargetId, NOTES_MOVED } from '../lib/legacy-notes.js';

export const dailyNoteRoutes = new Hono();

const NOTE_NOT_FOUND = { error: 'Note not found', code: 'NOT_FOUND' } as const;

/** A note row joined to the document it moved to; `document_id` is that document. */
const mappedNoteJoin = and(
  eq(noteDocumentMap.org_id, notes.org_id),
  eq(noteDocumentMap.source_type, 'note'),
  eq(noteDocumentMap.source_id, notes.id),
);

/** A live note of the caller's workspace whose document they can open now. */
function visibleMovedNotes(user: { id: string; org_id: string }, ...conditions: Array<SQL | undefined>) {
  return and(
    eq(notes.org_id, user.org_id),
    eq(notes.is_deleted, false),
    visibleDocumentIdSql(user.id, user.org_id, sql`${noteDocumentMap.target_id}`),
    ...conditions,
  );
}

/**
 * A write to one note: 410, with its document only when the note moved and
 * the caller can open that document now. A note they can't open and one that
 * never existed get the same answer, so nothing says which.
 */
async function noteWriteRefusal(c: Context, noteId: string) {
  const user = c.get('user');
  const documentId = await mappedTargetId(user.org_id, 'note', noteId);
  if (!documentId || !(await documentRoleFor(user.id, user.org_id, documentId))) return c.json(NOTES_MOVED, 410);
  return c.json({ ...NOTES_MOVED, document_id: documentId }, 410);
}

/** The caller's own live note and its document, when they hold at least `min` on the document now. */
async function ownMovedNote(user: { id: string; org_id: string }, noteId: string, min: DocRole) {
  const [note] = await db.select({ id: notes.id, document_id: noteDocumentMap.target_id }).from(notes)
    .innerJoin(noteDocumentMap, mappedNoteJoin)
    .where(and(eq(notes.id, noteId), eq(notes.org_id, user.org_id), eq(notes.user_id, user.id)))
    .limit(1);
  if (!note) return null;
  return roleAtLeast(await documentRoleFor(user.id, user.org_id, note.document_id), min) ? note : null;
}

// ── Folder endpoints ──

// GET /folders — the caller's own folders
dailyNoteRoutes.get('/folders', async (c) => {
  const user = c.get('user');
  const rows = await db.select().from(noteFolders)
    .where(and(eq(noteFolders.org_id, user.org_id), eq(noteFolders.user_id, user.id), eq(noteFolders.is_deleted, false)))
    .orderBy(noteFolders.sort_order, noteFolders.name);
  return c.json({ folders: rows });
});

dailyNoteRoutes.post('/folders', (c) => c.json(NOTES_MOVED, 410));
dailyNoteRoutes.patch('/folders/:id', (c) => c.json(NOTES_MOVED, 410));
dailyNoteRoutes.delete('/folders/:id', (c) => c.json(NOTES_MOVED, 410));

// ── Templates ──

// GET /templates — note templates whose document the caller can open
dailyNoteRoutes.get('/templates', async (c) => {
  const user = c.get('user');
  const rows = await db.select({
    id: notes.id,
    title: notes.title,
    content: notes.content,
    icon: notes.icon,
    document_id: noteDocumentMap.target_id,
  }).from(notes)
    .innerJoin(noteDocumentMap, mappedNoteJoin)
    .where(visibleMovedNotes(user, eq(notes.is_template, true)))
    .orderBy(notes.title);
  return c.json({ templates: rows });
});

// ── Notes ──

// GET / — notes whose document the caller can open
dailyNoteRoutes.get('/', async (c) => {
  const user = c.get('user');
  const q = c.req.query('q');
  const folderId = c.req.query('folder_id');

  const rows = await db.select({
    id: notes.id,
    title: notes.title,
    content: notes.content,
    icon: notes.icon,
    is_pinned: notes.is_pinned,
    folder_id: notes.folder_id,
    visibility: notes.visibility,
    visibility_space_id: notes.visibility_space_id,
    user_id: notes.user_id,
    created_at: notes.created_at,
    updated_at: notes.updated_at,
    document_id: noteDocumentMap.target_id,
  }).from(notes)
    .innerJoin(noteDocumentMap, mappedNoteJoin)
    .where(visibleMovedNotes(
      user,
      eq(notes.is_template, false),
      q ? ilike(notes.title, `%${q}%`) : undefined,
      folderId ? eq(notes.folder_id, folderId) : undefined,
    ))
    .orderBy(desc(notes.is_pinned), desc(notes.updated_at))
    .limit(100);

  return c.json(rows);
});

dailyNoteRoutes.post('/', (c) => c.json(NOTES_MOVED, 410));

// GET /:id — one note, when the caller can open its document
dailyNoteRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const noteId = c.req.param('id');

  const [note] = await db.select({ note: notes, document_id: noteDocumentMap.target_id }).from(notes)
    .innerJoin(noteDocumentMap, mappedNoteJoin)
    .where(and(eq(notes.id, noteId), visibleMovedNotes(user)))
    .limit(1);

  if (!note) return c.json(NOTE_NOT_FOUND, 404);
  return c.json({ ...note.note, document_id: note.document_id });
});

dailyNoteRoutes.patch('/:id', (c) => noteWriteRefusal(c, c.req.param('id')));
dailyNoteRoutes.delete('/:id', (c) => noteWriteRefusal(c, c.req.param('id')));

// ── Version History ──

// GET /:id/history — the owner's note versions, while they can edit its document
dailyNoteRoutes.get('/:id/history', async (c) => {
  const user = c.get('user');
  const note = await ownMovedNote(user, c.req.param('id'), 'edit');
  if (!note) return c.json(NOTE_NOT_FOUND, 404);

  const versions = await db.select().from(noteVersions)
    .where(eq(noteVersions.note_id, note.id))
    .orderBy(desc(noteVersions.version));

  return c.json({ versions, document_id: note.document_id });
});

// ── Sharing ──

// GET /:id/shares — who the owner's note was shared with, while they can edit its document
dailyNoteRoutes.get('/:id/shares', async (c) => {
  const user = c.get('user');
  const note = await ownMovedNote(user, c.req.param('id'), 'edit');
  if (!note) return c.json(NOTE_NOT_FOUND, 404);

  const shares = await db.select({
    id: noteShares.id,
    user_id: noteShares.shared_with_user_id,
    permission: noteShares.permission,
    user_name: users.name,
    user_email: users.email,
    created_at: noteShares.created_at,
  })
    .from(noteShares)
    .innerJoin(users, eq(noteShares.shared_with_user_id, users.id))
    // Only recipients who belong to this org are listed; a share row for a
    // stranger never exposes their name or email (S4-c).
    .innerJoin(orgMembers, and(
      eq(orgMembers.user_id, users.id),
      eq(orgMembers.org_id, user.org_id),
      eq(orgMembers.is_active, true),
    ))
    .where(eq(noteShares.note_id, note.id));

  // A guest sees no email address but their own, and no name of someone they
  // no longer share a space with (lib/people-visibility.ts).
  const viewer = await peopleViewer(user.org_id, user.id);
  const visible = await visiblePersonIds(viewer);
  return c.json({
    document_id: note.document_id,
    shares: shares.map((share) => ({
      ...share,
      user_name: canSeePerson(visible, share.user_id) ? share.user_name : null,
      user_email: emailFor(viewer, share.user_id, share.user_email),
    })),
  });
});

dailyNoteRoutes.post('/:id/shares', (c) => noteWriteRefusal(c, c.req.param('id')));
dailyNoteRoutes.delete('/:id/shares/:userId', (c) => noteWriteRefusal(c, c.req.param('id')));
