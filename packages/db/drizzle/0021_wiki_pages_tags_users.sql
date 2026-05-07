-- Adds tags (text[]) and referenced_user_ids (text[]) columns to wiki_pages.
-- Required by the oneone-prep commitments read path (Task 2.1) and the
-- memory-extract ingest path that tags commitment wiki pages.
-- GIN indexes enable fast array containment (@>) queries.

ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS tags text[] DEFAULT ARRAY[]::text[];
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS referenced_user_ids text[] DEFAULT ARRAY[]::text[];

CREATE INDEX IF NOT EXISTS wiki_pages_tags_gin ON wiki_pages USING GIN (tags);
CREATE INDEX IF NOT EXISTS wiki_pages_ref_users_gin ON wiki_pages USING GIN (referenced_user_ids);
