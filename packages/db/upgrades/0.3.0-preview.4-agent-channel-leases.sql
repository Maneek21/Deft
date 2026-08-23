ALTER TABLE agent_channel_events
  ADD COLUMN IF NOT EXISTS claim_owner text,
  ADD COLUMN IF NOT EXISTS claim_token text,
  ADD COLUMN IF NOT EXISTS claimed_at timestamp,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamp,
  ADD COLUMN IF NOT EXISTS work_outcome text,
  ADD COLUMN IF NOT EXISTS outcome_detail text,
  ADD COLUMN IF NOT EXISTS outcome_at timestamp,
  ADD COLUMN IF NOT EXISTS runtime_session_key text;

-- Pre-lease deliveries cannot prove that a runtime still owns them. Make all
-- non-terminal rows immediately reclaimable instead of preserving a phantom
-- owner across the migration.
UPDATE agent_channel_events
SET claim_owner = NULL,
    claim_token = NULL,
    claimed_at = NULL,
    lease_expires_at = NULL
WHERE status NOT IN ('completed', 'failed', 'cancelled');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_channel_event_claim_shape_check'
  ) THEN
    ALTER TABLE agent_channel_events
      ADD CONSTRAINT agent_channel_event_claim_shape_check CHECK (
        (
          claim_token IS NULL
          AND claim_owner IS NULL
          AND claimed_at IS NULL
          AND lease_expires_at IS NULL
        ) OR (
          claim_token IS NOT NULL
          AND claim_owner IS NOT NULL
          AND claimed_at IS NOT NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_channel_event_work_outcome_check'
  ) THEN
    ALTER TABLE agent_channel_events
      ADD CONSTRAINT agent_channel_event_work_outcome_check CHECK (
        work_outcome IS NULL
        OR work_outcome IN ('completed', 'needs_human', 'blocked', 'failed', 'cancelled')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS agent_channel_event_lease_idx
  ON agent_channel_events (agent_employee_id, status, lease_expires_at);
CREATE INDEX IF NOT EXISTS agent_channel_event_outcome_idx
  ON agent_channel_events (agent_employee_id, work_outcome, outcome_at);
