-- Self-hosted v1 delete sweep (3/3).
--
-- Drops three tables whose producing / consuming code was removed in
-- parts 1 + 2 of the sweep:
--
--   * org_spend_caps    — per-org LLM spend gating. Self-hosted v1 runs a
--                         single org on the operator's own API keys, so
--                         there is nothing left to gate against.
--   * clawhub_allowlist — VoltAgent-curated OpenClaw skill allowlist.
--                         Refresh cron + Library ClawHub tab removed.
--   * skill_secrets     — per-org encrypted secrets keyed by skill_id.
--                         Written by the pre-deploy install flow; that
--                         flow is retired alongside the managed provider.
--
-- Kept for PR 4 (Connect Agent rewrite), will be dropped there:
--   * provider_instances, integrations
--   * agent_employees.gateway_token_encrypted
--   * agent_employees.connection_url
--   * agent_employees.deployment_provider
--   * agent_employees.provider_instance_id
--   * agent_employees.capability_packs
--   * agent_employee_templates.default_capability_packs

DROP TABLE IF EXISTS skill_secrets;
DROP TABLE IF EXISTS clawhub_allowlist;
DROP TABLE IF EXISTS org_spend_caps;
