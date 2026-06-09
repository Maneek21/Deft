ALTER TABLE agent_employees
  ADD COLUMN IF NOT EXISTS runtime_kind text NOT NULL DEFAULT 'custom_mcp',
  ADD COLUMN IF NOT EXISTS job_title text,
  ADD COLUMN IF NOT EXISTS wake_mode text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS certification_status text NOT NULL DEFAULT 'token_issued',
  ADD COLUMN IF NOT EXISTS last_verified_at timestamp,
  ADD COLUMN IF NOT EXISTS last_mcp_call_at timestamp,
  ADD COLUMN IF NOT EXISTS last_work_outcome_at timestamp,
  ADD COLUMN IF NOT EXISTS connection_notes text;

CREATE TABLE IF NOT EXISTS agent_certification_challenges (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  employee_id text NOT NULL REFERENCES agent_employees(id) ON DELETE CASCADE,
  nonce text NOT NULL,
  required_tools text[] NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  failure_reason text,
  started_at timestamp NOT NULL DEFAULT now(),
  completed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_cert_employee_idx
  ON agent_certification_challenges (employee_id, created_at);

CREATE INDEX IF NOT EXISTS agent_cert_org_status_idx
  ON agent_certification_challenges (org_id, status, created_at);

CREATE TABLE IF NOT EXISTS agent_mcp_call_audit (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  employee_id text NOT NULL REFERENCES agent_employees(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  success boolean NOT NULL DEFAULT false,
  error text,
  metadata jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_mcp_audit_employee_idx
  ON agent_mcp_call_audit (employee_id, created_at);

CREATE INDEX IF NOT EXISTS agent_mcp_audit_org_tool_idx
  ON agent_mcp_call_audit (org_id, tool_name, created_at);
