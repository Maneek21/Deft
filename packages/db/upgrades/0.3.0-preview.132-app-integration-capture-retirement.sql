-- Retire ended capture policies without deleting their audit history.
-- The delivery loop already selects only enabled=true rows, so a retired policy
-- drops out of the knowledge-repair cycle automatically while its claims,
-- threads and sources remain queryable.
ALTER TABLE app_integration_capture_policies
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS retired_reason text,
  ADD COLUMN IF NOT EXISTS last_error text;
