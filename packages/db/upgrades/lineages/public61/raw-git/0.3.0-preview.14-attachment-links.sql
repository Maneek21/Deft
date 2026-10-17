DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.messages'::regclass
      AND conname = 'messages_org_id_id_unique'
  ) THEN
    IF to_regclass('public.messages_org_id_id_unique') IS NOT NULL THEN
      ALTER TABLE "messages"
        ADD CONSTRAINT "messages_org_id_id_unique"
        UNIQUE USING INDEX "messages_org_id_id_unique";
    ELSE
      ALTER TABLE "messages"
        ADD CONSTRAINT "messages_org_id_id_unique" UNIQUE ("org_id", "id");
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.files'::regclass
      AND conname = 'files_org_id_id_unique'
  ) THEN
    IF to_regclass('public.files_org_id_id_unique') IS NOT NULL THEN
      ALTER TABLE "files"
        ADD CONSTRAINT "files_org_id_id_unique"
        UNIQUE USING INDEX "files_org_id_id_unique";
    ELSE
      ALTER TABLE "files"
        ADD CONSTRAINT "files_org_id_id_unique" UNIQUE ("org_id", "id");
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tasks'::regclass
      AND conname = 'tasks_org_id_id_unique'
  ) THEN
    IF to_regclass('public.tasks_org_id_id_unique') IS NOT NULL THEN
      ALTER TABLE "tasks"
        ADD CONSTRAINT "tasks_org_id_id_unique"
        UNIQUE USING INDEX "tasks_org_id_id_unique";
    ELSE
      ALTER TABLE "tasks"
        ADD CONSTRAINT "tasks_org_id_id_unique" UNIQUE ("org_id", "id");
    END IF;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "files_org_idx"
  ON "files" ("org_id");

CREATE TABLE IF NOT EXISTS "message_attachments" (
  "org_id" text NOT NULL,
  "message_id" text NOT NULL,
  "file_id" text NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "message_attachments_message_id_file_id_pk" PRIMARY KEY ("message_id", "file_id"),
  CONSTRAINT "message_attachments_org_message_fk"
    FOREIGN KEY ("org_id", "message_id") REFERENCES "messages" ("org_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_attachments_org_file_fk"
    FOREIGN KEY ("org_id", "file_id") REFERENCES "files" ("org_id", "id") ON DELETE CASCADE,
  CONSTRAINT "message_attachments_position_check" CHECK ("position" >= 0)
);

CREATE INDEX IF NOT EXISTS "message_attachments_org_message_position_idx"
  ON "message_attachments" ("org_id", "message_id", "position");
CREATE INDEX IF NOT EXISTS "message_attachments_file_idx"
  ON "message_attachments" ("file_id");

CREATE TABLE IF NOT EXISTS "task_attachments" (
  "org_id" text NOT NULL,
  "task_id" text NOT NULL,
  "file_id" text NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "task_attachments_task_id_file_id_pk" PRIMARY KEY ("task_id", "file_id"),
  CONSTRAINT "task_attachments_org_task_fk"
    FOREIGN KEY ("org_id", "task_id") REFERENCES "tasks" ("org_id", "id") ON DELETE CASCADE,
  CONSTRAINT "task_attachments_org_file_fk"
    FOREIGN KEY ("org_id", "file_id") REFERENCES "files" ("org_id", "id") ON DELETE CASCADE,
  CONSTRAINT "task_attachments_position_check" CHECK ("position" >= 0)
);

CREATE INDEX IF NOT EXISTS "task_attachments_org_task_position_idx"
  ON "task_attachments" ("org_id", "task_id", "position");
CREATE INDEX IF NOT EXISTS "task_attachments_file_idx"
  ON "task_attachments" ("file_id");

INSERT INTO "message_attachments" ("org_id", "message_id", "file_id", "position", "created_at")
SELECT
  "org_id",
  "message_id",
  "id",
  (row_number() OVER (PARTITION BY "message_id" ORDER BY "created_at", "id") - 1)::integer,
  "created_at"
FROM "files"
WHERE "message_id" IS NOT NULL
ON CONFLICT ("message_id", "file_id") DO NOTHING;

INSERT INTO "task_attachments" ("org_id", "task_id", "file_id", "position", "created_at")
SELECT
  "org_id",
  "task_id",
  "id",
  (row_number() OVER (PARTITION BY "task_id" ORDER BY "created_at", "id") - 1)::integer,
  "created_at"
FROM "files"
WHERE "task_id" IS NOT NULL
ON CONFLICT ("task_id", "file_id") DO NOTHING;
