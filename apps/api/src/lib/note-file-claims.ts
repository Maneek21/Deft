// An image pasted into a note is uploaded with no task or message
// (POST /api/upload), so it is staged: it gets a 24-hour expiry and the
// retention sweep (attachment-retention.ts) deletes the row and the bytes of
// every staged file still unclaimed after that. Saving a note claims the
// files its content embeds by clearing that expiry, so they are kept.
//
// A file is claimed only when all three hold:
// - the saved note content names it (the editor stores
//   `<img data-file-id="…">`; older notes `<img src="/api/files/…">`);
// - it is in the note's workspace;
// - the person saving the note uploaded it.
// So nobody can keep someone else's staged upload alive by naming it.
//
// Claiming never changes who may read a file (attachment-access.ts): an
// unattached file is still served only to the person who uploaded it.
//
// Removing an image from a note does not stage its file again: the file is
// kept. Deleting such files is a follow-up.
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { files } from '@deft/db/schema';
import type { db } from './db.js';

/** At most this many distinct files are claimed per save; a note naming more keeps the first ones. */
export const MAX_NOTE_FILE_CLAIMS = 500;

const FILE_ID = '[A-Za-z0-9_-]{1,64}';
const DATA_FILE_ID = new RegExp(`data-file-id\\s*=\\s*["'](${FILE_ID})["']`, 'gi');
const FILE_URL = new RegExp(`/api/files/(${FILE_ID})(?![A-Za-z0-9_-])`, 'g');

/** The ids of the uploaded files a note's HTML embeds, in order of first appearance. */
export function noteFileIds(content: string | null | undefined): string[] {
  if (!content) return [];
  const ids = new Set<string>();
  for (const pattern of [DATA_FILE_ID, FILE_URL]) {
    for (const match of content.matchAll(pattern)) {
      if (ids.size >= MAX_NOTE_FILE_CLAIMS) break;
      ids.add(match[1]!);
    }
  }
  return [...ids];
}

/**
 * Clears the staged expiry of the files `content` embeds that `user`
 * uploaded in `user.org_id`. Returns how many files were claimed.
 */
export async function claimNoteFiles(
  database: Pick<typeof db, 'update'>,
  user: Readonly<{ id: string; org_id: string }>,
  content: string | null | undefined,
): Promise<number> {
  const ids = noteFileIds(content);
  if (ids.length === 0) return 0;
  const claimed = await database.update(files)
    .set({ staged_expires_at: null })
    .where(and(
      inArray(files.id, ids),
      eq(files.org_id, user.org_id),
      eq(files.uploaded_by, user.id),
      isNotNull(files.staged_expires_at),
    ))
    .returning({ id: files.id });
  return claimed.length;
}
