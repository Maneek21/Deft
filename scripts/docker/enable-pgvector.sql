-- Run once at first-boot of the postgres container (mounted into
-- /docker-entrypoint-initdb.d by docker-compose.yml). Enables the pgvector
-- extension in the `deft` database so Drizzle `db:push` can create the
-- `vector(1536)` embedding columns on wiki_pages and tasks.
CREATE EXTENSION IF NOT EXISTS vector;
