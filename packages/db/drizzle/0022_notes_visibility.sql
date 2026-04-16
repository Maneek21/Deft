ALTER TABLE notes ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private';
ALTER TABLE notes ADD COLUMN IF NOT EXISTS visibility_space_id text REFERENCES spaces(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS notes_visibility_idx ON notes(visibility) WHERE visibility <> 'private';
