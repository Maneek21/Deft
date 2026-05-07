-- Phase 9: Agent architecture simplification
-- Remove OpenClaw sidecar columns and provider infrastructure
-- KEEP trigger_subscriptions — it's the trigger-system routing key, not OpenClaw plumbing

-- Migrate any legacy non-BYOA employees to BYOA before dropping columns
UPDATE "agent_employees" SET "is_byoa" = true WHERE "is_byoa" = false;

ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "kind";
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "connection_url";
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "gateway_token_encrypted";
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "connection_status";
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "template_slug";
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "template_version";
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "provider_hint";
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "provider_instance_id";
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "connection_error";
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "last_gateway_ping_at";
ALTER TABLE "agent_employees" DROP COLUMN IF EXISTS "gateway_ping_fail_count";

DROP TABLE IF EXISTS "provider_instances";
