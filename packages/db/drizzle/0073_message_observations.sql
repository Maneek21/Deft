DO $$ BEGIN
  CREATE TYPE "message_observation_status" AS ENUM (
    'queued',
    'processing',
    'ignored',
    'no_capture',
    'captured',
    'retrying',
    'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "message_observations" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
  "message_id" text NOT NULL REFERENCES "messages"("id") ON DELETE cascade,
  "space_id" text REFERENCES "spaces"("id") ON DELETE set null,
  "user_id" text REFERENCES "users"("id") ON DELETE set null,
  "observation_version" integer DEFAULT 1 NOT NULL,
  "status" "message_observation_status" DEFAULT 'queued' NOT NULL,
  "ignored_reason" text,
  "classifier_result" jsonb,
  "downstream_jobs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "capture_count" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "started_at" timestamp,
  "completed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "message_observation_message_version_unique"
  ON "message_observations" ("message_id","observation_version");
CREATE INDEX IF NOT EXISTS "message_observation_org_status_idx"
  ON "message_observations" ("org_id","status","created_at");
CREATE INDEX IF NOT EXISTS "message_observation_message_idx"
  ON "message_observations" ("message_id");
CREATE INDEX IF NOT EXISTS "message_observation_space_idx"
  ON "message_observations" ("space_id");
