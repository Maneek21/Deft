// An image pasted into a note is uploaded with no task or message
// (POST /api/upload), so it is staged: it gets a 24-hour expiry and the
// retention sweep (attachment-retention.ts) deletes the row and the bytes of
// every staged file still unclaimed after that. Saving a note claims the
// files its content shows by clearing that expiry, so they are kept.
//
// A file is claimed only when all three hold:
// - an image of the saved note content shows it, read as the editor reads it
//   (apps/web/src/app/(app)/notes/protected-note-image.tsx): an <img> with
//   `data-file-id`, else an older <img src="/api/files/…">;
// - it is in the note's workspace;
// - the person saving the note uploaded it;
// - it is an image the editor can show (attachment_kind 'image', not blocked).
// So nobody can keep someone else's staged upload alive by naming it. A file
// the sweep would not delete anyway (attached to a task or a message) is left
// as it is.
//
// Claiming never changes who may read a file (attachment-access.ts): an
// unattached file is still served only to the person who uploaded it.
//
// Removing an image from a note does not stage its file again: the file is
// kept. Deleting such files is a follow-up.
import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { files } from '@deft/db/schema';
import type { db } from './db.js';

const CLAIM_BATCH = 500;
const FILE_ID = /^[A-Za-z0-9_-]{1,64}$/;
// A comment (to its end, or to the end of the content when unclosed, as a
// browser reads it), or an <img> start tag, where a quoted attribute value
// may hold '>'. Each step of the tag takes a different first character, so
// the match is linear. Comments are matched only to be skipped: an image
// inside one is not shown.
const COMMENT_OR_IMG = /<!--[\s\S]*?(?:-->|$)|<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

/** The value of attribute `name` in one tag, quoted or not, HTML entities for quotes left as they are. */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, 'i').exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

/** The file id of an older image's `src`: the path `/api/files/<id>`, as the editor reads it. */
function fileIdFromLegacyUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.replace(/&amp;/g, '&'), 'http://deft.invalid');
    const match = url.pathname.match(/^\/api\/files\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]!) : null;
  } catch {
    return null;
  }
}

/** The ids of the uploaded files a note's images show, in order of first appearance. */
export function noteFileIds(content: string | null | undefined): string[] {
  if (!content) return [];
  const ids = new Set<string>();
  for (const [tag] of content.matchAll(COMMENT_OR_IMG)) {
    if (tag.startsWith('<!--')) continue;
    const id = attribute(tag, 'data-file-id') || fileIdFromLegacyUrl(attribute(tag, 'src'));
    if (id && FILE_ID.test(id)) ids.add(id);
  }
  return [...ids];
}

/**
 * Clears the staged expiry of the files `content` shows that `user` uploaded
 * in `user.org_id`. Run it in the transaction that saves the note. Returns
 * how many files were claimed.
 */
export async function claimNoteFiles(
  database: Pick<typeof db, 'update'>,
  user: Readonly<{ id: string; org_id: string }>,
  content: string | null | undefined,
): Promise<number> {
  const ids = noteFileIds(content);
  let claimed = 0;
  for (let start = 0; start < ids.length; start += CLAIM_BATCH) {
    const rows = await database.update(files)
      .set({ staged_expires_at: null })
      .where(and(
        inArray(files.id, ids.slice(start, start + CLAIM_BATCH)),
        eq(files.org_id, user.org_id),
        eq(files.uploaded_by, user.id),
        isNotNull(files.staged_expires_at),
        eq(files.attachment_kind, 'image'),
        ne(files.processing_status, 'blocked'),
        isNull(files.message_id),
        isNull(files.task_id),
        sql`NOT EXISTS (SELECT 1 FROM message_attachments
          WHERE message_attachments.org_id = ${files.org_id} AND message_attachments.file_id = ${files.id})`,
        sql`NOT EXISTS (SELECT 1 FROM task_attachments
          WHERE task_attachments.org_id = ${files.org_id} AND task_attachments.file_id = ${files.id})`,
      ))
      .returning({ id: files.id });
    claimed += rows.length;
  }
  return claimed;
}
