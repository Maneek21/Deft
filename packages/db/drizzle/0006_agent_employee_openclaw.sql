-- Phase 2 — agent_employees gains OpenClaw sidecar columns.
-- New columns document how Deft connects to an external OpenClaw gateway:
--   kind:                    which runtime implements this employee
--   connection_url:          gateway base URL (e.g. https://vps:18789)
--   gateway_token_encrypted: AES-GCM ciphertext Deft replays in Authorization: Bearer
--   mcp_token_hash:          bcrypt hash the gateway presents TO Deft (compared, not replayed)
--   connection_status:       pending|connected|error|revoked
--   template_slug/version:   provenance for upgrade prompts
--   trigger_subscriptions:   which trigger kinds this employee claims
--   provider_hint:           ui-only hint about where the gateway runs
ALTER TABLE "agent_employees" ADD COLUMN "kind" text DEFAULT 'openclaw' NOT NULL;
ALTER TABLE "agent_employees" ADD COLUMN "connection_url" text;
ALTER TABLE "agent_employees" ADD COLUMN "gateway_token_encrypted" text;
ALTER TABLE "agent_employees" ADD COLUMN "mcp_token_hash" text;
ALTER TABLE "agent_employees" ADD COLUMN "connection_status" text DEFAULT 'pending' NOT NULL;
ALTER TABLE "agent_employees" ADD COLUMN "template_slug" text;
ALTER TABLE "agent_employees" ADD COLUMN "template_version" text;
ALTER TABLE "agent_employees" ADD COLUMN "trigger_subscriptions" text[];
ALTER TABLE "agent_employees" ADD COLUMN "provider_hint" text;

-- Preserve the existing Alex PM 2026-04-13 native demo path: explicitly mark that row native.
UPDATE "agent_employees"
   SET "kind" = 'native',
       "connection_status" = 'connected'
 WHERE "id" = '7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633';
