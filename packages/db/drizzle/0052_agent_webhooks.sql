-- Block 3.3 — per-agent webhook URLs.
--
-- An agent-employee can expose a shared-secret HMAC URL that accepts
-- POST payloads from external systems. The webhook dispatcher fires an
-- employee-trigger (trigger_kind='webhook') so the agent runs its
-- existing trigger playbook with the incoming payload as context.

CREATE TABLE IF NOT EXISTS agent_webhooks (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  agent_employee_id text NOT NULL REFERENCES agent_employees(id) ON DELETE CASCADE,
  slug            text NOT NULL,
  secret_hash     text NOT NULL,
  label           text,
  enabled         boolean NOT NULL DEFAULT true,
  last_fired_at   timestamp,
  fire_count      integer NOT NULL DEFAULT 0,
  created_by      text REFERENCES users(id),
  created_at      timestamp NOT NULL DEFAULT now(),
  updated_at      timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_webhooks_slug_uniq ON agent_webhooks (slug);
CREATE INDEX IF NOT EXISTS agent_webhooks_org_idx ON agent_webhooks (org_id);
CREATE INDEX IF NOT EXISTS agent_webhooks_employee_idx ON agent_webhooks (agent_employee_id);
