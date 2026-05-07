-- Phase 8 — integrations table for third-party OAuth connections that Deft
-- uses to orchestrate deployments on the user's behalf. One row per
-- (org_id, provider) pair. Tokens are AES-GCM encrypted using env.ENCRYPTION_KEY.
--
-- Today: Railway (for managed OpenClaw employee deployments). In v1.1 this
-- same table will hold Fly.io + DigitalOcean rows for additional managed
-- providers. The `provider` column is a text enum rather than a DB pgEnum so
-- new providers can be added without schema migrations.
CREATE TABLE IF NOT EXISTS "integrations" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "provider" text NOT NULL,
  "account_label" text,
  "access_token_encrypted" text NOT NULL,
  "refresh_token_encrypted" text,
  "access_token_expires_at" timestamp,
  "scopes" text[],
  "external_workspace_id" text,
  "external_workspace_name" text,
  "external_default_project_id" text,
  "status" text DEFAULT 'connected' NOT NULL,
  "connected_by" text,
  "last_used_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "integrations_provider_chk"
    CHECK ("provider" IN ('railway', 'fly', 'digitalocean')),
  CONSTRAINT "integrations_status_chk"
    CHECK ("status" IN ('connected', 'revoked', 'error'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "integrations_org_provider_idx"
  ON "integrations" ("org_id", "provider");

DO $$ BEGIN
  ALTER TABLE "integrations"
    ADD CONSTRAINT "integrations_connected_by_fk"
    FOREIGN KEY ("connected_by") REFERENCES "users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
