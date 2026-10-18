-- Forward-only cutover gate for the still-dormant governed App Run engine.
-- This adds no execution consumer and does not modify legacy action rows.

ALTER TABLE app_runs
  ADD COLUMN IF NOT EXISTS execution_release_kind text,
  ADD COLUMN IF NOT EXISTS execution_released_at timestamp,
  ADD COLUMN IF NOT EXISTS budget_reserved_at timestamp,
  ADD COLUMN IF NOT EXISTS budget_reserved_count integer,
  ADD COLUMN IF NOT EXISTS budget_limit_at_reservation integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_runs_execution_release_shape_check') THEN
    ALTER TABLE app_runs ADD CONSTRAINT app_runs_execution_release_shape_check CHECK (
      (execution_release_kind IS NULL AND execution_released_at IS NULL)
      OR (
        execution_release_kind IS NOT NULL
        AND execution_released_at IS NOT NULL
        AND (
          (review_requirement = 'always' AND execution_release_kind = 'approved')
          OR (review_requirement = 'policy' AND execution_release_kind IN ('policy_satisfied', 'approved'))
        )
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_runs_budget_reservation_shape_check') THEN
    ALTER TABLE app_runs ADD CONSTRAINT app_runs_budget_reservation_shape_check CHECK (
      (budget_reserved_at IS NULL AND budget_reserved_count IS NULL AND budget_limit_at_reservation IS NULL)
      OR (
        budget_reserved_at IS NOT NULL
        AND budget_reserved_count BETWEEN 1 AND 1000000
        AND budget_limit_at_reservation >= budget_reserved_count
      )
    );
  END IF;
END $$;

ALTER TABLE agent_actions DROP CONSTRAINT IF EXISTS agent_actions_app_run_shape_check;
ALTER TABLE agent_actions ADD CONSTRAINT agent_actions_app_run_shape_check CHECK (
  (app_run_id IS NULL AND action <> 'app_run_invoke')
  OR (
    app_run_id IS NOT NULL
    AND action = 'app_run_invoke'
    AND jsonb_typeof(params) = 'object'
    AND params ? 'run_id'
    AND jsonb_typeof(params->'run_id') = 'string'
    AND params->>'run_id' = app_run_id
    AND (params - ARRAY['run_id', 'capability_label', 'provider_label', 'resource_ids', 'safe_preview']::text[]) = '{}'::jsonb
    AND octet_length(params::text) <= 32768
  )
);

DROP INDEX IF EXISTS app_runs_idempotency_unique;
CREATE INDEX IF NOT EXISTS app_runs_idempotency_lookup_idx ON app_runs(
  org_id, initiating_actor_type, initiating_actor_id, provider_kind,
  provider_instance_id, operation_name, idempotency_key_version,
  idempotency_fingerprint, idempotency_expires_at
);

CREATE OR REPLACE FUNCTION enforce_app_run_cutover_gate() RETURNS trigger AS $$
BEGIN
  IF OLD.execution_release_kind IS NOT NULL AND (
    NEW.execution_release_kind IS DISTINCT FROM OLD.execution_release_kind
    OR NEW.execution_released_at IS DISTINCT FROM OLD.execution_released_at
  ) THEN
    RAISE EXCEPTION 'APP_RUN_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;
  IF OLD.budget_reserved_at IS NOT NULL AND (
    NEW.budget_reserved_at IS DISTINCT FROM OLD.budget_reserved_at
    OR NEW.budget_reserved_count IS DISTINCT FROM OLD.budget_reserved_count
    OR NEW.budget_limit_at_reservation IS DISTINCT FROM OLD.budget_limit_at_reservation
  ) THEN
    RAISE EXCEPTION 'APP_RUN_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;
  IF NEW.state = 'running' AND NEW.execution_released_at IS NULL THEN
    RAISE EXCEPTION 'APP_RUN_EXECUTION_NOT_RELEASED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_runs_cutover_gate_trigger ON app_runs;
CREATE TRIGGER app_runs_cutover_gate_trigger
  BEFORE UPDATE ON app_runs
  FOR EACH ROW EXECUTE FUNCTION enforce_app_run_cutover_gate();

CREATE OR REPLACE FUNCTION enforce_app_run_attempt_execution_release() RETURNS trigger AS $$
DECLARE
  released_at timestamp;
BEGIN
  IF NEW.state IN ('pending', 'claimed', 'provider_call_started') THEN
    SELECT execution_released_at INTO released_at
      FROM app_runs
      WHERE org_id = NEW.org_id AND id = NEW.run_id;
    IF released_at IS NULL THEN
      RAISE EXCEPTION 'APP_RUN_EXECUTION_NOT_RELEASED' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_run_attempts_execution_release_trigger ON app_run_attempts;
CREATE TRIGGER app_run_attempts_execution_release_trigger
  BEFORE INSERT OR UPDATE ON app_run_attempts
  FOR EACH ROW EXECUTE FUNCTION enforce_app_run_attempt_execution_release();
