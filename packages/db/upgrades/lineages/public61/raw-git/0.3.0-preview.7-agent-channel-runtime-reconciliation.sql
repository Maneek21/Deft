ALTER TABLE agent_actions
  ADD COLUMN IF NOT EXISTS channel_event_id text,
  ADD COLUMN IF NOT EXISTS runtime_request_key text;

CREATE INDEX IF NOT EXISTS agent_action_runtime_request_idx
  ON agent_actions (org_id, agent_employee_id, runtime_request_key);

CREATE UNIQUE INDEX IF NOT EXISTS agent_channel_attempt_active_runtime_unique
  ON agent_channel_delivery_attempts (org_id, agent_employee_id)
  WHERE direction = 'outbound_runtime' AND status = 'started';

ALTER TABLE agent_channel_events
  DROP CONSTRAINT IF EXISTS agent_channel_event_work_outcome_check;

ALTER TABLE agent_channel_events
  ADD CONSTRAINT agent_channel_event_work_outcome_check CHECK (
    work_outcome IS NULL
    OR work_outcome IN (
      'completed',
      'needs_human',
      'blocked',
      'failed',
      'cancelled',
      'work_completed_handoff_uncertain'
    )
  );
