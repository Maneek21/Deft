-- Task 3.8 — Semantic task search via retrieveContext.
-- Adds FTS search_vector + pgvector embedding columns to tasks so
-- retrieveContext({ types: ['tasks'] }) can do hybrid ranking the
-- same way it already does for wiki_pages.
--
-- Additive, idempotent. Safe to re-run.

-- ─── Embedding column ─────────────────────────────────────────────────────────
-- 1536 dims to match OpenAI text-embedding-3-small (same as wiki_pages).
-- Guarded: if the pgvector extension is available we use vector(1536) +
-- ivfflat index; otherwise we fall back to bytea so the column exists and
-- the BYTEA path in embed-content.ts can still persist JSON-encoded vectors.
-- Matches the behaviour baked into wiki_pages by migration 0011 + runtime.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
    EXECUTE 'ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "embedding" vector(1536)';
    -- ivfflat requires `lists` tuned per dataset size; 100 is a reasonable
    -- default for dev (<50k rows). Rebuild with a larger lists value in prod.
    EXECUTE 'CREATE INDEX IF NOT EXISTS "tasks_embedding_ivfflat_idx" ON "tasks" USING ivfflat ("embedding" vector_cosine_ops) WITH (lists = 100)';
  ELSE
    EXECUTE 'ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "embedding" bytea';
  END IF;
END $$;

-- ─── FTS search_vector column ─────────────────────────────────────────────────
-- Generated tsvector over (title || description). Using STORED so planner can
-- use the GIN index without re-computing per row. Matches the spirit of the
-- wiki_pages.search_vector pattern but without the trigger (no weight tiers
-- needed — tasks have just title + description).
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS "tasks_search_vector_idx"
  ON "tasks" USING GIN ("search_vector");
