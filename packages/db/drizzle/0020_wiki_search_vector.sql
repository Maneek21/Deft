-- Adds the tsvector search_vector column + trigger + GIN index on wiki_pages.
-- Required by every FTS code path (retrieveContext, agent-runner wiki auto-load,
-- memory_recall MCP tool, platform_context). Local dev had this from an unrecorded
-- manual migration; prod Neon was missing it, silently breaking all wiki FTS.

-- Column (populated by trigger below)
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- Trigger function: weighted tsvector from title (A) + summary (B) + content (C)
CREATE OR REPLACE FUNCTION wiki_pages_search_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.summary, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.content, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- BEFORE INSERT OR UPDATE trigger
DROP TRIGGER IF EXISTS wiki_pages_search_trigger ON wiki_pages;
CREATE TRIGGER wiki_pages_search_trigger
  BEFORE INSERT OR UPDATE OF title, summary, content ON wiki_pages
  FOR EACH ROW EXECUTE FUNCTION wiki_pages_search_update();

-- Backfill existing rows (the UPDATE triggers the function)
UPDATE wiki_pages SET title = title WHERE search_vector IS NULL;

-- GIN index for fast FTS
CREATE INDEX IF NOT EXISTS wiki_pages_search_idx ON wiki_pages USING GIN (search_vector);
