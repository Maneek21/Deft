-- Which uploaded files a note's images show. Add-only.
-- The API writes these rows in the transaction that saves a note
-- (apps/api/src/lib/note-file-claims.ts) and serves a linked file to everyone
-- who can read the note. Links for notes saved before this upgrade are
-- written by the API when it starts (backfillNoteFileLinks), not here:
-- upgrades do not rewrite or insert rows.
-- No IF NOT EXISTS: a same-named leftover fails the upgrade instead of being
-- recorded as applied.
CREATE TABLE note_files (
  org_id text NOT NULL,
  note_id text NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  file_id text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT note_files_pkey PRIMARY KEY (note_id, file_id),
  CONSTRAINT note_files_org_file_fk FOREIGN KEY (org_id, file_id) REFERENCES files (org_id, id) ON DELETE CASCADE
);

-- The file-read check: which notes show this file.
CREATE INDEX note_files_org_file_idx ON note_files (org_id, file_id);
