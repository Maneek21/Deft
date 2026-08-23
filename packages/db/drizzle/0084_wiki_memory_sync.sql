CREATE TABLE IF NOT EXISTS "wiki_memory_syncs" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "agent_employee_id" text NOT NULL REFERENCES "agent_employees"("id") ON DELETE CASCADE,
  "idempotency_key" text NOT NULL,
  "content_digest" text NOT NULL,
  "page_id" text NOT NULL REFERENCES "wiki_pages"("id") ON DELETE CASCADE,
  "page_version" integer NOT NULL,
  "runtime_session_id" text,
  "provenance" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "wiki_memory_sync_identity_unique"
  ON "wiki_memory_syncs" ("org_id", "agent_employee_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "wiki_memory_sync_page_idx"
  ON "wiki_memory_syncs" ("page_id");
CREATE INDEX IF NOT EXISTS "wiki_memory_sync_employee_updated_idx"
  ON "wiki_memory_syncs" ("org_id", "agent_employee_id", "updated_at");
