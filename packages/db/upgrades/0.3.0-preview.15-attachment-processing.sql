DO $$
BEGIN
  CREATE TYPE "attachment_processing_status" AS ENUM ('pending', 'ready', 'blocked', 'failed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "files"
  ADD COLUMN IF NOT EXISTS "detected_mime_type" text,
  ADD COLUMN IF NOT EXISTS "attachment_kind" text DEFAULT 'binary' NOT NULL,
  ADD COLUMN IF NOT EXISTS "content_sha256" text,
  ADD COLUMN IF NOT EXISTS "processing_status" "attachment_processing_status" DEFAULT 'pending' NOT NULL,
  ADD COLUMN IF NOT EXISTS "processing_error" text,
  ADD COLUMN IF NOT EXISTS "processed_at" timestamp,
  ADD COLUMN IF NOT EXISTS "staged_expires_at" timestamp;

CREATE INDEX IF NOT EXISTS "files_staged_expiry_idx"
  ON "files" ("staged_expires_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.files'::regclass
      AND conname = 'files_attachment_kind_check'
  ) THEN
    ALTER TABLE "files" ADD CONSTRAINT "files_attachment_kind_check"
      CHECK ("attachment_kind" IN ('text', 'image', 'spreadsheet', 'pdf', 'document', 'archive', 'binary'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.files'::regclass
      AND conname = 'files_content_sha256_check'
  ) THEN
    ALTER TABLE "files" ADD CONSTRAINT "files_content_sha256_check"
      CHECK ("content_sha256" IS NULL OR "content_sha256" ~ '^sha256:[a-f0-9]{64}$');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "attachment_derivatives" (
  "org_id" text NOT NULL,
  "file_id" text NOT NULL,
  "kind" text NOT NULL,
  "mime_type" text NOT NULL,
  "content" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "attachment_derivatives_file_id_kind_pk" PRIMARY KEY ("file_id", "kind"),
  CONSTRAINT "attachment_derivatives_org_file_fk"
    FOREIGN KEY ("org_id", "file_id") REFERENCES "files" ("org_id", "id") ON DELETE CASCADE,
  CONSTRAINT "attachment_derivatives_size_check" CHECK ("size_bytes" >= 0)
);

CREATE INDEX IF NOT EXISTS "attachment_derivatives_org_file_idx"
  ON "attachment_derivatives" ("org_id", "file_id");
