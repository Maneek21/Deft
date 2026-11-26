// The old Notes routes, read-only since notes became documents (spec 5.12;
// plan Task F15; lib/legacy-notes.ts).
//
// Every write answers 410 NOTES_MOVED and writes nothing. A write to one note
// says where it went (`document_id`) only when the note moved and the caller
// can open its document now; a note they can't open answers exactly like one
// that doesn't exist.
//
// The reads stay for old links and clients (the web redirects /notes?id= to
// the document, F16). The map only finds a note's document: each read is
// authorized against that document's current access (lib/document-access.ts),
// never the old note rule, and answers with the document's current title,
// icon, template flag, times and content (HTML, the shape Notes had, from the
// document as it is now), never the old row's. Each note it returns carries
// its `document_id`:
// - GET / and GET /templates: live notes whose document the caller can open
//   (`q` searches the document's title);
// - GET /:id: the note, when they can open its document;
// - GET /:id/history and GET /:id/shares: history and sharing live on the
//   document now, so a moved note answers 410 NOTES_MOVED with its
//   document's id to someone who can open it, and 404 to anyone else;
// - GET /folders: the caller's own folders, as before (folders carry no
//   access of their own).
import { Hono, type Context } from 'hono';
import { eq, and, desc, ilike, type SQL } from 'drizzle-orm';
import { documents, noteDocumentMap } from '@deft/db/documents';
import { db } from '../lib/db.js';
import { notes, noteFolders } from '@deft/db/schema';
import { documentRoleFor, visibleDocumentCondition } from '../lib/document-access.js';
import { documentHtml, documentJsonNow, mappedTargetId, NOTES_MOVED, type JSONContent } from '../lib/legacy-notes.js';

export const dailyNoteRoutes = new Hono();

const NOTE_NOT_FOUND = { error: 'Note not found', code: 'NOT_FOUND' } as const;

/** A note row joined to the document it moved to. */
const mappedNoteJoin = and(
  eq(noteDocumentMap.org_id, notes.org_id),
  eq(noteDocumentMap.source_type, 'note'),
  eq(noteDocumentMap.source_id, notes.id),
);
const mappedDocumentJoin = and(eq(documents.id, noteDocumentMap.target_id), eq(documents.org_id, noteDocumentMap.org_id));

/** A live note of the caller's workspace whose document they can open now. */
function visibleMovedNotes(user: { id: string; org_id: string }, ...conditions: Array<SQL | undefined>) {
  return and(
    eq(notes.org_id, user.org_id),
    eq(notes.is_deleted, false),
    visibleDocumentCondition(user.id, user.org_id),
    ...conditions,
  );
}

/** A note as the old routes answered it, from its document: the old row gives only the id and its own placement. */
const noteColumns = {
  id: notes.id,
  title: documents.title,
  content_json: documents.content_json,
  icon: documents.icon,
  is_pinned: notes.is_pinned,
  is_template: documents.is_template,
  folder_id: notes.folder_id,
  visibility: notes.visibility,
  visibility_space_id: notes.visibility_space_id,
  user_id: notes.user_id,
  created_at: documents.created_at,
  updated_at: documents.updated_at,
  document_id: documents.id,
};

/** The row with its document's content as HTML in place of the content's JSON. */
function asNote<T extends { content_json: unknown }>(row: T, json: JSONContent = row.content_json as JSONContent) {
  const { content_json: _json, ...rest } = row;
  return { ...rest, content: documentHtml(json) };
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

/** A read that lives on the document now: 410 with the document to someone who can open it, else 404. */
async function movedToDocument(c: Context, noteId: string) {
  const user = c.get('user');
  const documentId = await mappedTargetId(user.org_id, 'note', noteId);
  if (!documentId || !(await documentRoleFor(user.id, user.org_id, documentId))) return c.json(NOTE_NOT_FOUND, 404);
  return c.json({ ...NOTES_MOVED, document_id: documentId }, 410);
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
    title: documents.title,
    content_json: documents.content_json,
    icon: documents.icon,
    document_id: documents.id,
  }).from(notes)
    .innerJoin(noteDocumentMap, mappedNoteJoin)
    .innerJoin(documents, mappedDocumentJoin)
    .where(visibleMovedNotes(user, eq(documents.is_template, true)))
    .orderBy(documents.title);
  return c.json({ templates: rows.map((row) => asNote(row)) });
});

// ── Notes ──

// GET / — notes whose document the caller can open
dailyNoteRoutes.get('/', async (c) => {
  const user = c.get('user');
  const q = c.req.query('q')?.trim();
  const folderId = c.req.query('folder_id');

  const rows = await db.select(noteColumns).from(notes)
    .innerJoin(noteDocumentMap, mappedNoteJoin)
    .innerJoin(documents, mappedDocumentJoin)
    .where(visibleMovedNotes(
      user,
      eq(documents.is_template, false),
      q ? ilike(documents.title, `%${q.replace(/[\\%_]/g, '\\$&')}%`) : undefined,
      folderId ? eq(notes.folder_id, folderId) : undefined,
    ))
    .orderBy(desc(notes.is_pinned), desc(documents.updated_at))
    .limit(100);

  return c.json(rows.map((row) => asNote(row)));
});

dailyNoteRoutes.post('/', (c) => c.json(NOTES_MOVED, 410));

// GET /:id — one note, when the caller can open its document; its content as the document holds it now
dailyNoteRoutes.get('/:id', async (c) => {
  const user = c.get('user');
  const noteId = c.req.param('id');

  const [note] = await db.select(noteColumns).from(notes)
    .innerJoin(noteDocumentMap, mappedNoteJoin)
    .innerJoin(documents, mappedDocumentJoin)
    .where(and(eq(notes.id, noteId), visibleMovedNotes(user)))
    .limit(1);

  if (!note) return c.json(NOTE_NOT_FOUND, 404);
  return c.json(asNote(note, await documentJsonNow(user.org_id, note.document_id, note.content_json)));
});

dailyNoteRoutes.patch('/:id', (c) => noteWriteRefusal(c, c.req.param('id')));
dailyNoteRoutes.delete('/:id', (c) => noteWriteRefusal(c, c.req.param('id')));

// ── Version History and Sharing: on the document now ──

// GET /:id/history
dailyNoteRoutes.get('/:id/history', (c) => movedToDocument(c, c.req.param('id')));

// GET /:id/shares
dailyNoteRoutes.get('/:id/shares', (c) => movedToDocument(c, c.req.param('id')));

dailyNoteRoutes.post('/:id/shares', (c) => noteWriteRefusal(c, c.req.param('id')));
dailyNoteRoutes.delete('/:id/shares/:userId', (c) => noteWriteRefusal(c, c.req.param('id')));
