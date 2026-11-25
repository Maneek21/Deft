// An image pasted into a note is uploaded with no task or message
// (POST /api/upload), so it is staged: it gets a 24-hour expiry and the
// retention sweep (attachment-retention.ts) deletes the row and the bytes of
// every staged file still unclaimed after that.
//
// Saving a note keeps `note_files` (one row per note and file it shows) in
// step with its content, in the transaction that saves it:
// - a file the saved content shows is linked when the person saving it
//   uploaded it, in the note's workspace, as an image the editor can show
//   (attachment_kind 'image', not blocked), and it is on no task or message.
//   Linking claims it: its expiry is cleared, so the sweep keeps it. Nobody
//   can link, keep alive or share someone else's upload by naming it.
// - a file already linked to this note stays linked while the content shows it.
// - a link whose image the content no longer shows is removed. A file that
//   loses its last link and is on no task or message is staged again: it
//   expires 24 hours later (or 24 hours after a pending scheduled message
//   that carries it is due), and the sweep deletes it then.
//
// Who may read a linked file: everyone who can read a note of its workspace
// that links it and is not deleted (attachment-access.ts). A deleted note
// keeps its links, which grant nothing while it is deleted.
//
// The images a note shows are read as the editor reads them
// (apps/web/src/app/(app)/notes/protected-note-image.tsx): an <img> with
// `data-file-id`, else an older <img src="/api/files/…">.
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { files } from '@deft/db/schema';
import { noteFiles } from '@deft/db/note-files';
import type { db } from './db.js';
import { STAGED_ATTACHMENT_TTL_MS, stagedAttachmentExpiry } from './attachment-retention.js';

const CLAIM_BATCH = 500;
const FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;
// HTML whitespace is ASCII only (a non-breaking space is not whitespace).
const WS = /[\t\n\f\r ]/;
const SPACE = /[\t\n\f\r /]/;
const TAG_END = /[\t\n\f\r />]/;
const NAME_END = /[\t\n\f\r />=]/;
const UNQUOTED_END = /[\t\n\f\r >]/;
// Elements whose content a browser reads as text up to their end tag.
const RAW_TEXT = new Set(['textarea', 'title', 'script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
// Elements whose content the editor never shows: a template's content is an
// inert fragment, and the editor's parser ignores an object's subtree. (A
// <head> tag inside the body, where note content is parsed, is ignored.)
const HIDDEN = new Set(['template', 'object']);
const NAMED_REFS: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** An attribute value with its character references decoded, as a browser reads it. */
function decodeReferences(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#[xX]([0-9A-Fa-f]{1,6})|([A-Za-z]{2,8}));?/g, (whole, dec, hex, named) => {
    if (named) return NAMED_REFS[named] ?? whole;
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}

/**
 * The attributes of every <img> start tag in `html`, read in one forward
 * pass (no regular expression can backtrack on a long note). Comments are
 * skipped (an unclosed one runs to the end, as a browser reads it), the
 * content of text-only elements such as <textarea> is skipped to their end
 * tag, and every other tag is read whole, so a quoted value never starts a
 * tag or a comment. An image inside a template or an object (until its end
 * tag) is not shown by the editor and is left out. Values have character references decoded; the
 * first of a repeated attribute wins, as in a browser.
 */
function imageTags(html: string): Array<Map<string, string>> {
  const images: Array<Map<string, string>> = [];
  // Open hidden elements, outermost first. A template's end tag closes
  // whatever opened inside it; an end tag with no matching open element, or
  // one for an element opened outside the innermost template, is ignored.
  const hidden: string[] = [];
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf('<', i);
    if (open < 0) break;
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      if (close < 0) break;
      i = close + 3;
      continue;
    }
    const closing = html[open + 1] === '/';
    const nameStart = open + (closing ? 2 : 1);
    if (!/[A-Za-z]/.test(html[nameStart] ?? '')) { i = open + 1; continue; }
    let j = nameStart;
    while (j < html.length && !TAG_END.test(html[j]!)) j++;
    const tagName = html.slice(nameStart, j).toLowerCase();
    const attrs = new Map<string, string>();
    let ended = false;
    while (j < html.length) {
      const ch = html[j]!;
      if (ch === '>') { ended = true; j++; break; }
      if (SPACE.test(ch)) { j++; continue; }
      const nameStart = j;
      while (j < html.length && !NAME_END.test(html[j]!)) j++;
      const name = html.slice(nameStart, j).toLowerCase();
      while (j < html.length && WS.test(html[j]!)) j++;
      let value = '';
      if (html[j] === '=') {
        j++;
        while (j < html.length && WS.test(html[j]!)) j++;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, j + 1);
          if (close < 0) { j = html.length; break; }
          value = html.slice(j + 1, close);
          j = close + 1;
        } else {
          const valueStart = j;
          while (j < html.length && !UNQUOTED_END.test(html[j]!)) j++;
          value = html.slice(valueStart, j);
        }
      }
      if (name && !attrs.has(name)) attrs.set(name, decodeReferences(value));
    }
    if (!ended) break;
    if (closing) {
      const at = hidden.lastIndexOf(tagName);
      if (HIDDEN.has(tagName) && at >= 0 && (tagName === 'template' || !hidden.includes('template', at))) hidden.length = at;
      i = j;
      continue;
    }
    if (tagName === 'img' && hidden.length === 0) images.push(attrs);
    if (HIDDEN.has(tagName)) hidden.push(tagName);
    if (tagName === 'plaintext') break;
    if (RAW_TEXT.has(tagName)) {
      const endTag = new RegExp(`</${tagName}(?=[\\t\\n\\f\\r />])`, 'gi');
      endTag.lastIndex = j;
      const end = endTag.exec(html);
      if (!end) break;
      j = end.index;
    }
    i = j;
  }
  return images;
}

/** The file id of an older image's `src`: the path `/api/files/<id>`, as the editor reads it. */
function fileIdFromLegacyUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, 'http://deft.invalid');
    const match = url.pathname.match(/^\/api\/files\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]!) : null;
  } catch {
    return null;
  }
}

/**
 * The ids of the uploaded files a note's images show, in order of first
 * appearance. As the editor: an <img> is a note image when it has a
 * `data-file-id` attribute or its `src` contains `/api/files/`; its id is
 * `data-file-id`, else the id in `src`, trimmed (protected-file.ts).
 */
export function noteFileIds(content: string | null | undefined): string[] {
  if (!content) return [];
  const ids = new Set<string>();
  for (const attrs of imageTags(content)) {
    const src = attrs.get('src') ?? null;
    if (!attrs.has('data-file-id') && !src?.includes('/api/files/')) continue;
    const id = (attrs.get('data-file-id') || fileIdFromLegacyUrl(src))?.trim();
    if (id && FILE_ID.test(id)) ids.add(id);
  }
  return [...ids];
}

type NoteFileDatabase = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)) return result.rows as T[];
  return [];
}

function batches<T>(values: T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < values.length; start += CLAIM_BATCH) out.push(values.slice(start, start + CLAIM_BATCH));
  return out;
}

/** The file is on a task or a message (legacy column or typed link): the sweep never deletes it. */
const onTaskOrMessage = sql`(${files.message_id} IS NOT NULL OR ${files.task_id} IS NOT NULL
  OR EXISTS (SELECT 1 FROM message_attachments
    WHERE message_attachments.org_id = ${files.org_id} AND message_attachments.file_id = ${files.id})
  OR EXISTS (SELECT 1 FROM task_attachments
    WHERE task_attachments.org_id = ${files.org_id} AND task_attachments.file_id = ${files.id}))`;

/** The person saving a note may link this file: they uploaded it, as an image the editor shows, and it is on no task or message. */
const linkable = (userId: string) => sql`(${files.uploaded_by} = ${userId} AND ${files.attachment_kind} = 'image'
  AND ${files.processing_status} <> 'blocked' AND NOT ${onTaskOrMessage})`;

export type NoteFileSync = { linked: number; claimed: number; unlinked: number; restaged: number };

/**
 * Brings `note`'s file links in step with its saved content (see the top of
 * this file). Run it in the transaction that saved the note, after the save,
 * with the person who saved it. Returns what changed.
 */
export async function syncNoteFiles(
  database: NoteFileDatabase,
  user: Readonly<{ id: string; org_id: string }>,
  note: Readonly<{ id: string; org_id: string; content: string | null }>,
): Promise<NoteFileSync> {
  if (note.org_id !== user.org_id) throw new Error('A note is saved in its own workspace');
  const shown = noteFileIds(note.content);
  const current = (await database.select({ file_id: noteFiles.file_id }).from(noteFiles)
    .where(and(eq(noteFiles.org_id, note.org_id), eq(noteFiles.note_id, note.id))))
    .map((row) => row.file_id);
  const linked = new Set(current);
  const shownSet = new Set(shown);
  const removed = current.filter((id) => !shownSet.has(id));
  const candidates = shown.filter((id) => !linked.has(id));
  const result: NoteFileSync = { linked: 0, claimed: 0, unlinked: 0, restaged: 0 };
  if (removed.length === 0 && candidates.length === 0) return result;

  // Lock, in one id order, every file this save may link or release, so two
  // saves (or a save and a schedule or a cancel) that touch the same files
  // wait for each other instead of deadlocking. A file to link is locked only
  // when it qualifies; it is then checked again in a fresh statement, which
  // sees a task or message link committed while this one waited.
  const removedSet = new Set(removed);
  const touched = [...new Set([...candidates, ...removed])].sort();
  const toLink: string[] = [];
  for (const ids of batches(touched)) {
    const releasing = ids.filter((id) => removedSet.has(id));
    const locked = rowsOf<{ id: string }>(await database.execute(sql`
      SELECT ${files.id} AS id
      FROM ${files}
      WHERE ${files.org_id} = ${note.org_id} AND ${inArray(files.id, ids)}
        AND (${releasing.length > 0 ? inArray(files.id, releasing) : sql`false`} OR ${linkable(user.id)})
      ORDER BY ${files.id}
      FOR UPDATE OF ${files}`)).map((row) => row.id).filter((id) => !removedSet.has(id));
    if (locked.length === 0) continue;
    const qualifying = rowsOf<{ id: string }>(await database.execute(sql`
      SELECT ${files.id} AS id FROM ${files}
      WHERE ${files.org_id} = ${note.org_id} AND ${inArray(files.id, locked)} AND ${linkable(user.id)}`));
    toLink.push(...qualifying.map((row) => row.id));
  }

  for (const ids of batches(toLink)) {
    const inserted = await database.insert(noteFiles)
      .values(ids.map((file_id) => ({ org_id: note.org_id, note_id: note.id, file_id })))
      .onConflictDoNothing()
      .returning({ file_id: noteFiles.file_id });
    result.linked += inserted.length;
    const claimed = await database.update(files)
      .set({ staged_expires_at: null })
      .where(and(eq(files.org_id, note.org_id), inArray(files.id, ids), isNotNull(files.staged_expires_at)))
      .returning({ id: files.id });
    result.claimed += claimed.length;
  }

  for (const ids of batches(removed)) {
    const deleted = await database.delete(noteFiles)
      .where(and(eq(noteFiles.org_id, note.org_id), eq(noteFiles.note_id, note.id), inArray(noteFiles.file_id, ids)))
      .returning({ file_id: noteFiles.file_id });
    result.unlinked += deleted.length;
    if (deleted.length === 0) continue;
    // Staged again only when no note links it any more and it is on no task
    // or message. A pending scheduled message that carries it keeps it until
    // 24 hours after it is due, as cancelling one does (scheduled-message-cancel.ts).
    const restaged = await database.update(files)
      .set({ staged_expires_at: sql`greatest(${stagedAttachmentExpiry().toISOString()}::timestamp, (
        SELECT max(pending.scheduled_for) + ${STAGED_ATTACHMENT_TTL_MS} * interval '1 millisecond'
        FROM scheduled_messages AS pending
        WHERE pending.org_id = ${files.org_id} AND pending.user_id = ${files.uploaded_by}
          AND pending.status IN ('pending', 'sending')
          AND position(('[[file:' || ${files.id} || ':') in pending.content) > 0
      ))` })
      .where(and(
        eq(files.org_id, note.org_id),
        inArray(files.id, deleted.map((row) => row.file_id)),
        sql`NOT ${onTaskOrMessage}`,
        sql`NOT EXISTS (SELECT 1 FROM note_files AS other
          WHERE other.org_id = ${files.org_id} AND other.file_id = ${files.id})`,
      ))
      .returning({ id: files.id });
    result.restaged += restaged.length;
  }
  return result;
}

/**
 * Links the images of notes saved before `note_files` existed, by the rule a
 * save uses: a file the note's content shows that the note's author uploaded
 * in its workspace, as an image (attachment_kind 'image', not blocked), on no
 * task or message. A linked file is claimed (an image still staged is kept).
 * Deleted notes are included, so a restored note shows its images. Runs when
 * the workers start; idempotent (an existing link is left as it is), and each
 * pass reads every note that names an image. Each note is read under a share
 * lock, so a save in flight finishes first and the content read is the saved
 * one; its files are locked before they are checked.
 */
export async function backfillNoteFileLinks(
  database: Pick<typeof db, 'execute' | 'transaction'>,
  options: { batchSize?: number } = {},
): Promise<number> {
  const batchSize = options.batchSize ?? 200;
  let after = '';
  let written = 0;
  for (;;) {
    const page = rowsOf<{ id: string }>(await database.execute(sql`
      SELECT id FROM notes
      WHERE id > ${after}
        AND strpos(lower(content), '<img') > 0
      ORDER BY id
      LIMIT ${batchSize}`));
    for (const { id } of page) {
      written += await database.transaction(async (tx) => {
        const [note] = rowsOf<{ id: string; org_id: string; user_id: string; content: string | null }>(await tx.execute(sql`
          SELECT id, org_id, user_id, content FROM notes WHERE id = ${id} FOR SHARE`));
        if (!note) return 0;
        let count = 0;
        for (const chunk of batches(noteFileIds(note.content).sort())) {
          // Lock first, then check on the locked rows in a fresh statement.
          await tx.execute(sql`SELECT ${files.id} FROM ${files}
            WHERE ${files.org_id} = ${note.org_id} AND ${inArray(files.id, chunk)}
            ORDER BY ${files.id} FOR UPDATE OF ${files}`);
          const linked = rowsOf<{ file_id: string }>(await tx.execute(sql`
            INSERT INTO note_files (org_id, note_id, file_id)
            SELECT ${files.org_id}, ${note.id}, ${files.id} FROM ${files}
            WHERE ${files.org_id} = ${note.org_id} AND ${inArray(files.id, chunk)} AND ${linkable(note.user_id)}
            ON CONFLICT DO NOTHING
            RETURNING file_id`));
          count += linked.length;
          if (linked.length > 0) {
            await tx.execute(sql`UPDATE ${files} SET staged_expires_at = NULL
              WHERE ${files.org_id} = ${note.org_id} AND ${inArray(files.id, linked.map((row) => row.file_id))}
                AND ${files.staged_expires_at} IS NOT NULL`);
          }
        }
        return count;
      });
    }
    if (page.length < batchSize) break;
    after = page[page.length - 1]!.id;
  }
  return written;
}
