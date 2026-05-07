-- Phase 2 — agent_employee_templates: the template marketplace schema.
-- Seed rows are added separately in migration 0012 during Phase 9.
-- The version column is guarded by a DB-level semver CHECK constraint so that
-- invalid versions are rejected regardless of whether the caller used
-- @deft/shared/schemas.assertSemver at insert time.
CREATE TABLE IF NOT EXISTS "agent_employee_templates" (
  "id" text PRIMARY KEY NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "version" text NOT NULL,
  "role" "agent_employee_role" NOT NULL,
  "description" text NOT NULL,
  "soul_md" text NOT NULL,
  "agents_md" text NOT NULL,
  "user_md_template" text NOT NULL,
  "tools_md" text NOT NULL,
  "default_tools" text[] NOT NULL,
  "default_trust_level" "trust_level" DEFAULT 'standard' NOT NULL,
  "default_trigger_subscriptions" text[],
  "model_recommendation" text NOT NULL,
  "fallback_models" text[],
  "source" text DEFAULT 'first-party' NOT NULL,
  "source_attribution" text,
  "download_count" integer DEFAULT 0 NOT NULL,
  "is_public" boolean DEFAULT true NOT NULL,
  "created_by" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "agent_employee_templates_slug_unique" UNIQUE ("slug"),
  CONSTRAINT "agent_employee_templates_version_semver"
    CHECK ("version" ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$')
);

DO $$ BEGIN
  ALTER TABLE "agent_employee_templates"
    ADD CONSTRAINT "agent_employee_templates_created_by_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
