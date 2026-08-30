-- Forward-only hardening for the still-dormant governed App Run engine.
-- This adds no execution consumer and does not modify legacy action paths.

ALTER TABLE app_runs
  ADD COLUMN IF NOT EXISTS idempotency_expires_at timestamp,
  ADD COLUMN IF NOT EXISTS attempt_limit integer,
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamp;

UPDATE app_runs
SET idempotency_expires_at = created_at + CASE retention_class
      WHEN 'ephemeral' THEN interval '7 days'
      WHEN 'standard' THEN interval '30 days'
      WHEN 'extended' THEN interval '90 days'
    END,
    attempt_limit = COALESCE(attempt_limit, 3)
WHERE idempotency_expires_at IS NULL OR attempt_limit IS NULL;

ALTER TABLE app_runs
  ALTER COLUMN idempotency_expires_at SET NOT NULL,
  ALTER COLUMN attempt_limit SET NOT NULL;

ALTER TABLE app_run_attempts
  ADD COLUMN IF NOT EXISTS retry_of_attempt_id text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_runs_idempotency_expiry_check') THEN
    ALTER TABLE app_runs ADD CONSTRAINT app_runs_idempotency_expiry_check
      CHECK (idempotency_expires_at >= result_expires_at);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_runs_attempt_limit_check') THEN
    ALTER TABLE app_runs ADD CONSTRAINT app_runs_attempt_limit_check
      CHECK (attempt_limit BETWEEN 1 AND 10);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_runs_cancel_request_check') THEN
    ALTER TABLE app_runs ADD CONSTRAINT app_runs_cancel_request_check
      CHECK (cancel_requested_at IS NULL OR started_at IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_run_attempts_retry_shape_check') THEN
    ALTER TABLE app_run_attempts ADD CONSTRAINT app_run_attempts_retry_shape_check
      CHECK (
        (attempt_number = 1 AND retry_of_attempt_id IS NULL)
        OR (attempt_number > 1 AND retry_of_attempt_id IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_run_attempts_retry_of_fk') THEN
    ALTER TABLE app_run_attempts ADD CONSTRAINT app_run_attempts_retry_of_fk
      FOREIGN KEY (org_id, run_id, retry_of_attempt_id)
      REFERENCES app_run_attempts(org_id, run_id, id) ON DELETE NO ACTION
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS app_runs_idempotency_expiry_idx
  ON app_runs(idempotency_expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS app_run_attempts_one_active_unique
  ON app_run_attempts(org_id, run_id)
  WHERE state IN ('pending', 'claimed', 'provider_call_started');

ALTER TABLE app_run_events DROP CONSTRAINT IF EXISTS app_run_events_type_check;
ALTER TABLE app_run_events ADD CONSTRAINT app_run_events_type_check CHECK (event_type IN (
  'run_created', 'approval_requested', 'approval_resolved', 'attempt_created',
  'attempt_claimed', 'provider_call_started', 'cancellation_requested',
  'attempt_terminal', 'run_transitioned', 'secrets_purged',
  'reconciliation_recorded', 'repair_gap'
));

CREATE OR REPLACE FUNCTION enforce_app_run_state_and_identity() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 OR current_setting('deft.app_run_maintenance', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'APP_RUN_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;

  IF (NEW.org_id, NEW.contract_version, NEW.origin_kind, NEW.initiating_actor_type, NEW.initiating_actor_id,
      NEW.execution_actor_type, NEW.execution_actor_id, NEW.provider_kind,
      NEW.provider_instance_id, NEW.operation_name, NEW.provider_snapshot_id,
      NEW.risk_class, NEW.review_requirement, NEW.review_scope, NEW.retry_class,
      NEW.retention_class, NEW.idempotency_key_version, NEW.idempotency_fingerprint,
      NEW.input_fingerprint_key_version, NEW.input_fingerprint, NEW.authorization_snapshot,
      NEW.safe_preview, NEW.root_run_id, NEW.parent_run_id, NEW.depth,
      NEW.input_expires_at, NEW.result_expires_at, NEW.idempotency_expires_at, NEW.attempt_limit)
    IS DISTINCT FROM
     (OLD.org_id, OLD.contract_version, OLD.origin_kind, OLD.initiating_actor_type, OLD.initiating_actor_id,
      OLD.execution_actor_type, OLD.execution_actor_id, OLD.provider_kind,
      OLD.provider_instance_id, OLD.operation_name, OLD.provider_snapshot_id,
      OLD.risk_class, OLD.review_requirement, OLD.review_scope, OLD.retry_class,
      OLD.retention_class, OLD.idempotency_key_version, OLD.idempotency_fingerprint,
      OLD.input_fingerprint_key_version, OLD.input_fingerprint, OLD.authorization_snapshot,
      OLD.safe_preview, OLD.root_run_id, OLD.parent_run_id, OLD.depth,
      OLD.input_expires_at, OLD.result_expires_at, OLD.idempotency_expires_at, OLD.attempt_limit)
  THEN
    RAISE EXCEPTION 'APP_RUN_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;

  IF (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at)
    OR (OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at)
    OR (OLD.unknown_outcome_at IS NOT NULL AND NEW.unknown_outcome_at IS DISTINCT FROM OLD.unknown_outcome_at)
    OR (OLD.reconciled_at IS NOT NULL AND NEW.reconciled_at IS DISTINCT FROM OLD.reconciled_at)
    OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at)
    OR (OLD.cancel_requested_at IS NOT NULL AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at)
    OR (OLD.input_purged_at IS NOT NULL AND NEW.input_purged_at IS DISTINCT FROM OLD.input_purged_at)
    OR (OLD.result_purged_at IS NOT NULL AND NEW.result_purged_at IS DISTINCT FROM OLD.result_purged_at)
    OR (OLD.safe_outcome IS NOT NULL AND NEW.safe_outcome IS NULL)
  THEN
    RAISE EXCEPTION 'APP_RUN_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;

  IF OLD.cancel_requested_at IS NULL AND NEW.cancel_requested_at IS NOT NULL
     AND OLD.state NOT IN ('running', 'waiting_external') THEN
    RAISE EXCEPTION 'APP_RUN_ILLEGAL_TRANSITION' USING ERRCODE = '55000';
  END IF;

  IF NEW.state <> OLD.state AND NOT (
    (OLD.state = 'pending' AND NEW.state IN ('pending_approval', 'running', 'cancelled', 'expired'))
    OR (OLD.state = 'pending_approval' AND NEW.state IN ('running', 'cancelled', 'expired'))
    OR (OLD.state = 'running' AND NEW.state IN ('waiting_external', 'succeeded', 'failed', 'unknown_outcome'))
    OR (OLD.state = 'waiting_external' AND NEW.state IN ('running', 'succeeded', 'failed', 'cancelled', 'unknown_outcome'))
    OR (OLD.state = 'unknown_outcome' AND NEW.state IN ('succeeded', 'failed'))
  ) THEN
    RAISE EXCEPTION 'APP_RUN_ILLEGAL_TRANSITION' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_app_run_attempt_state_and_identity() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 OR current_setting('deft.app_run_maintenance', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'APP_RUN_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;

  IF (NEW.org_id, NEW.run_id, NEW.attempt_number, NEW.retry_of_attempt_id,
      NEW.provider_idempotency_key_version, NEW.provider_idempotency_fingerprint)
    IS DISTINCT FROM
     (OLD.org_id, OLD.run_id, OLD.attempt_number, OLD.retry_of_attempt_id,
      OLD.provider_idempotency_key_version, OLD.provider_idempotency_fingerprint)
  THEN
    RAISE EXCEPTION 'APP_RUN_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;

  IF OLD.claim_token IS NOT NULL AND (
    NEW.claim_owner IS DISTINCT FROM OLD.claim_owner
    OR NEW.claim_token IS DISTINCT FROM OLD.claim_token
    OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
  ) THEN
    RAISE EXCEPTION 'APP_RUN_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;
  IF OLD.claim_token IS NULL AND NEW.claim_token IS NOT NULL
     AND NOT (OLD.state = 'pending' AND NEW.state = 'claimed') THEN
    RAISE EXCEPTION 'APP_RUN_ILLEGAL_TRANSITION' USING ERRCODE = '55000';
  END IF;
  IF OLD.lease_expires_at IS NOT NULL AND NEW.lease_expires_at < OLD.lease_expires_at THEN
    RAISE EXCEPTION 'APP_RUN_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_call_started_at IS NOT NULL
     AND NEW.provider_call_started_at IS DISTINCT FROM OLD.provider_call_started_at THEN
    RAISE EXCEPTION 'APP_RUN_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_call_started_at IS NULL AND NEW.provider_call_started_at IS NOT NULL
     AND NOT (OLD.state = 'claimed' AND NEW.state = 'provider_call_started') THEN
    RAISE EXCEPTION 'APP_RUN_ILLEGAL_TRANSITION' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_call_finished_at IS NOT NULL
     AND NEW.provider_call_finished_at IS DISTINCT FROM OLD.provider_call_finished_at THEN
    RAISE EXCEPTION 'APP_RUN_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;
  IF OLD.provider_call_finished_at IS NULL AND NEW.provider_call_finished_at IS NOT NULL
     AND OLD.state <> 'provider_call_started' THEN
    RAISE EXCEPTION 'APP_RUN_ILLEGAL_TRANSITION' USING ERRCODE = '55000';
  END IF;
  IF OLD.safe_outcome IS NOT NULL AND NEW.safe_outcome IS DISTINCT FROM OLD.safe_outcome THEN
    RAISE EXCEPTION 'APP_RUN_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;
  IF OLD.safe_outcome IS NULL AND NEW.safe_outcome IS NOT NULL
     AND (OLD.state <> 'provider_call_started' OR NEW.provider_call_finished_at IS NULL) THEN
    RAISE EXCEPTION 'APP_RUN_ILLEGAL_TRANSITION' USING ERRCODE = '55000';
  END IF;
  IF OLD.error_code IS NOT NULL AND NEW.error_code IS DISTINCT FROM OLD.error_code THEN
    RAISE EXCEPTION 'APP_RUN_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;

  IF NEW.state <> OLD.state AND NOT (
    (OLD.state = 'pending' AND NEW.state IN ('claimed', 'cancelled'))
    OR (OLD.state = 'claimed' AND NEW.state IN ('provider_call_started', 'failed', 'cancelled'))
    OR (OLD.state = 'provider_call_started' AND NEW.state IN ('succeeded', 'failed', 'cancelled', 'unknown_outcome'))
  ) THEN
    RAISE EXCEPTION 'APP_RUN_ILLEGAL_TRANSITION' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
