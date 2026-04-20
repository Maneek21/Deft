-- Self-hosted v1 — cooperative knowledge log.
--
-- Append-only stream of records volunteered by BYOA agents via the MCP
-- `record_conversation_turn`, `record_decision`, `record_outcome`,
-- `record_reasoning_step`, and `record_action_attempt` tools.
--
-- Aspirational surface: no trust gating, no approval. The table is
-- intentionally lightweight — a later session inspector / Defty roll-up
-- renders it.

CREATE TABLE IF NOT EXISTS agent_cooperative_log (
  id           text PRIMARY KEY,
  org_id       text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  employee_id  text NOT NULL REFERENCES agent_employees(id) ON DELETE CASCADE,
  kind         text NOT NULL
    CHECK (kind IN ('conversation_turn', 'decision', 'outcome', 'reasoning_step', 'action_attempt')),
  summary      text NOT NULL,
  metadata     jsonb,
  session_turn_id text,
  created_at   timestamp NOT NULL DEFAULT now(),
  updated_at   timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_coop_log_employee_idx
  ON agent_cooperative_log (employee_id, created_at);

CREATE INDEX IF NOT EXISTS agent_coop_log_org_kind_idx
  ON agent_cooperative_log (org_id, kind, created_at);
