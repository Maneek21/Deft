-- Phase 2 — wiki_pages.embedding: pgvector column for hybrid search.
-- We enable pgvector (no-op if already present), add the 1536-dim column,
-- and build an ivfflat index for cosine similarity search.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "wiki_pages" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);

-- ivfflat requires lists to be tuned per dataset size; 100 is a reasonable default
-- for dev (under 50k rows). Rebuild with a larger lists value in prod if needed.
CREATE INDEX IF NOT EXISTS "wiki_pages_embedding_ivfflat_idx"
  ON "wiki_pages" USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);
