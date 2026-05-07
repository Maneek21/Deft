-- Phase 8 — provider_instances table. One row per deployed employee that
-- lives on a managed provider (Railway today, Fly/DO/Deft-Cloud later) or on
-- BYO infrastructure (pure metadata row with `integration_id` null). The
-- DeploymentProvider abstraction reads/writes this table exclusively.
--
-- Commercial scaffolding: `cost_usd_cents_monthly` +
-- `deft_orchestration_fee_usd_cents_monthly` are populated during provisioning
-- but not yet hooked into any billing logic. Wiring happens in v1.1.
CREATE TABLE IF NOT EXISTS "provider_instances" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "employee_id" text NOT NULL,
  "provider" text NOT NULL,
  "integration_id" text,
  "external_instance_id" text,
  "external_project_id" text,
  "external_environment_id" text,
  "provider_metadata" jsonb,
  "cost_usd_cents_monthly" integer,
  "deft_orchestration_fee_usd_cents_monthly" integer,
  "status" text DEFAULT 'provisioning' NOT NULL,
  "last_status_check_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "provider_instances_provider_chk"
    CHECK ("provider" IN ('railway', 'fly', 'digitalocean', 'deft_cloud', 'byo')),
  CONSTRAINT "provider_instances_status_chk"
    CHECK ("status" IN ('provisioning', 'running', 'crashed', 'stopped', 'destroyed', 'unknown'))
);

CREATE INDEX IF NOT EXISTS "provider_instances_employee_idx"
  ON "provider_instances" ("employee_id");
CREATE INDEX IF NOT EXISTS "provider_instances_org_idx"
  ON "provider_instances" ("org_id");

DO $$ BEGIN
  ALTER TABLE "provider_instances"
    ADD CONSTRAINT "provider_instances_employee_fk"
    FOREIGN KEY ("employee_id") REFERENCES "agent_employees"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "provider_instances"
    ADD CONSTRAINT "provider_instances_integration_fk"
    FOREIGN KEY ("integration_id") REFERENCES "integrations"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
