import { index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/** The uploaded files a note's images show, one row per note and file. Kept
 * by the API in the transaction that saves the note
 * (apps/api/src/lib/note-file-claims.ts); a file a note links is served to
 * everyone who can read that note (apps/api/src/lib/attachment-access.ts).
 * Created by upgrade 0.3.0-preview.154 on both fresh installs and upgrades,
 * so it is exported as `@deft/db/note-files` rather than from schema.ts. The
 * upgrade also holds the foreign keys: `note_id` to notes (cascade) and
 * (`org_id`, `file_id`) to files (cascade). */
export const noteFiles = pgTable('note_files', {
  org_id: text('org_id').notNull(),
  note_id: text('note_id').notNull(),
  file_id: text('file_id').notNull(),
  created_at: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  primaryKey({ name: 'note_files_pkey', columns: [t.note_id, t.file_id] }),
  index('note_files_org_file_idx').on(t.org_id, t.file_id),
]);
