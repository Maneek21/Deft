DO $$ BEGIN
  CREATE TYPE "work_intent_kind" AS ENUM (
    'task_candidate',
    'blocker_candidate',
    'decision_candidate',
    'resource_candidate',
    'note_candidate',
    'question_candidate'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "work_intent_status" AS ENUM (
    'proposed',
    'converted',
    'dismissed',
    'expired',
    'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "work_intents" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
  "space_id" text REFERENCES "spaces"("id") ON DELETE set null,
  "source_message_id" text REFERENCES "messages"("id") ON DELETE set null,
  "source_user_id" text REFERENCES "users"("id") ON DELETE set null,
  "agent_employee_id" text REFERENCES "agent_employees"("id") ON DELETE set null,
  "kind" "work_intent_kind" NOT NULL,
  "status" "work_intent_status" DEFAULT 'proposed' NOT NULL,
  "title" text NOT NULL,
  "summary" text,
  "confidence" real,
  "proposed_action" text DEFAULT 'task_create' NOT NULL,
  "proposed_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "dedupe_key" text NOT NULL,
  "converted_action_id" text,
  "converted_task_id" text REFERENCES "tasks"("id") ON DELETE set null,
  "converted_by" text REFERENCES "users"("id") ON DELETE set null,
  "converted_at" timestamp,
  "dismissed_by" text REFERENCES "users"("id") ON DELETE set null,
  "dismissed_at" timestamp,
  "failure_reason" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "work_intent_dedupe_unique"
  ON "work_intents" ("org_id","dedupe_key");
CREATE INDEX IF NOT EXISTS "work_intent_org_status_idx"
  ON "work_intents" ("org_id","status","created_at");
CREATE INDEX IF NOT EXISTS "work_intent_source_message_idx"
  ON "work_intents" ("source_message_id");
CREATE INDEX IF NOT EXISTS "work_intent_space_idx"
  ON "work_intents" ("space_id");
CREATE INDEX IF NOT EXISTS "work_intent_converted_task_idx"
  ON "work_intents" ("converted_task_id");
