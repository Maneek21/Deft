-- Phase 8 — agent_employees gains three deployment-provider columns so the
-- wizard can record which DeploymentProvider spawned each employee and where
-- the corresponding provider_instances row lives. Existing Alex PM
-- (kind='native') row keeps all three NULL.
--
-- `connection_error` stores the last failure message surfaced by the
-- DeploymentProvider.provision() pipeline so the UI can render the
-- "Provisioning failed: …" banner without an extra join.
ALTER TABLE "agent_employees" ADD COLUMN IF NOT EXISTS "deployment_provider" text;
ALTER TABLE "agent_employees" ADD COLUMN IF NOT EXISTS "provider_instance_id" text;
ALTER TABLE "agent_employees" ADD COLUMN IF NOT EXISTS "connection_error" text;
ALTER TABLE "agent_employees" ADD COLUMN IF NOT EXISTS "capability_packs" text[];

DO $$ BEGIN
  ALTER TABLE "agent_employees"
    ADD CONSTRAINT "agent_employees_provider_instance_fk"
    FOREIGN KEY ("provider_instance_id") REFERENCES "provider_instances"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "agent_employees"
    ADD CONSTRAINT "agent_employees_deployment_provider_chk"
    CHECK ("deployment_provider" IS NULL OR "deployment_provider" IN
      ('railway', 'fly', 'digitalocean', 'deft_cloud', 'byo'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
