-- Phase 2 — space_memory: per-channel KV bag for OpenClaw employees.
CREATE TABLE IF NOT EXISTS "space_memory" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "space_id" text NOT NULL,
  "key" text NOT NULL,
  "value" jsonb NOT NULL,
  "updated_by_employee_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "space_memory"
    ADD CONSTRAINT "space_memory_space_id_fk"
    FOREIGN KEY ("space_id") REFERENCES "spaces"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "space_memory"
    ADD CONSTRAINT "space_memory_updated_by_employee_id_fk"
    FOREIGN KEY ("updated_by_employee_id") REFERENCES "agent_employees"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "space_memory_key_unique"
  ON "space_memory" ("space_id", "key");
