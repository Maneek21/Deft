-- Block 2.6 — decision implementation tracking.
-- `implemented_at` marks when a decision was acted on (via mark_decision_implemented
-- agent tool or the decision wiki UI). NULL means not yet implemented.

ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS implemented_at timestamp;

CREATE INDEX IF NOT EXISTS decisions_implemented_idx
  ON decisions (implemented_at);
