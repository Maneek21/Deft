-- Self-hosted v1 — drop orphaned managed-deploy columns from agent_employees.
--
-- deployment_provider: every writer was deleted in PRs 1-3 and grep
--                      confirms no live readers remain.
-- capability_packs:    the last reader (clone-as-template) was refactored
--                      to source default packs from the template side
--                      rather than the employee row.
--
-- The remaining managed-deploy columns (gateway_token_encrypted,
-- connection_url, provider_instance_id) stay — they're still read by
-- openclaw-client, openclaw-dispatch, gateway-ping, the developer-tab
-- route, and the MCP token issuer.

ALTER TABLE agent_employees DROP COLUMN IF EXISTS deployment_provider;
ALTER TABLE agent_employees DROP COLUMN IF EXISTS capability_packs;
