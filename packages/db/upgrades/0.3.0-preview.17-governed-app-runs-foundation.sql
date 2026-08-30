-- Dormant governed App Run foundation. This migration is additive: it does not
-- backfill legacy actions, alter current execution, or rewrite ciphertext.

CREATE TABLE IF NOT EXISTS capability_provider_snapshots (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider_kind text NOT NULL,
  provider_instance_id text NOT NULL,
  adapter_contract_version text NOT NULL,
  snapshot_digest text NOT NULL,
  safe_snapshot jsonb NOT NULL,
  captured_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT capability_provider_snapshots_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT capability_provider_snapshots_kind_check CHECK (provider_kind IN ('mcp')),
  CONSTRAINT capability_provider_snapshots_digest_check CHECK (snapshot_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT capability_provider_snapshots_json_check CHECK (jsonb_typeof(safe_snapshot) = 'object'),
  CONSTRAINT capability_provider_snapshots_size_check CHECK (octet_length(safe_snapshot::text) <= 1048576)
);

CREATE UNIQUE INDEX IF NOT EXISTS capability_provider_snapshots_identity_digest_unique
  ON capability_provider_snapshots(org_id, provider_kind, provider_instance_id, snapshot_digest);
CREATE INDEX IF NOT EXISTS capability_provider_snapshots_provider_idx
  ON capability_provider_snapshots(org_id, provider_kind, provider_instance_id, captured_at);

CREATE TABLE IF NOT EXISTS app_runs (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  contract_version text NOT NULL,
  origin_kind text NOT NULL,
  initiating_actor_type text NOT NULL,
  initiating_actor_id text NOT NULL,
  execution_actor_type text NOT NULL,
  execution_actor_id text NOT NULL,
  provider_kind text NOT NULL,
  provider_instance_id text NOT NULL,
  operation_name text NOT NULL,
  provider_snapshot_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  risk_class text NOT NULL,
  review_requirement text NOT NULL,
  review_scope text NOT NULL,
  retry_class text NOT NULL,
  retention_class text NOT NULL,
  idempotency_key_version text NOT NULL,
  idempotency_fingerprint text NOT NULL,
  input_fingerprint_key_version text NOT NULL,
  input_fingerprint text NOT NULL,
  authorization_snapshot jsonb NOT NULL,
  safe_preview jsonb NOT NULL,
  safe_outcome jsonb,
  root_run_id text NOT NULL,
  parent_run_id text,
  depth integer NOT NULL DEFAULT 0,
  input_expires_at timestamp NOT NULL,
  result_expires_at timestamp NOT NULL,
  input_purged_at timestamp,
  result_purged_at timestamp,
  started_at timestamp,
  terminal_at timestamp,
  unknown_outcome_at timestamp,
  reconciled_at timestamp,
  cancelled_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_runs_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT app_runs_org_provider_snapshot_fk FOREIGN KEY (org_id, provider_snapshot_id)
    REFERENCES capability_provider_snapshots(org_id, id) ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT app_runs_contract_version_check CHECK (contract_version = 'deft.app_run.v1'),
  CONSTRAINT app_runs_origin_check CHECK (origin_kind IN ('core', 'legacy_connector', 'app')),
  CONSTRAINT app_runs_app_origin_disabled_check CHECK (origin_kind <> 'app'),
  CONSTRAINT app_runs_actor_type_check CHECK (
    initiating_actor_type IN ('human', 'agent_employee', 'system', 'automation')
    AND execution_actor_type IN ('human', 'agent_employee', 'system', 'automation')
  ),
  CONSTRAINT app_runs_provider_kind_check CHECK (provider_kind IN ('mcp')),
  CONSTRAINT app_runs_state_check CHECK (state IN (
    'pending', 'pending_approval', 'running', 'waiting_external', 'succeeded',
    'failed', 'cancelled', 'expired', 'unknown_outcome'
  )),
  CONSTRAINT app_runs_risk_check CHECK (risk_class IN (
    'read', 'internal_write', 'external_write', 'destructive', 'privileged'
  )),
  CONSTRAINT app_runs_review_requirement_check CHECK (review_requirement IN ('policy', 'always')),
  CONSTRAINT app_runs_review_scope_check CHECK (review_scope IN (
    'per_invocation', 'immutable_batch', 'approved_automation_definition', 'forbidden_in_automation'
  )),
  CONSTRAINT app_runs_retry_class_check CHECK (retry_class IN ('safe', 'idempotent_with_key', 'unsafe_or_unknown')),
  CONSTRAINT app_runs_retention_class_check CHECK (retention_class IN ('ephemeral', 'standard', 'extended')),
  CONSTRAINT app_runs_fingerprint_check CHECK (
    idempotency_fingerprint ~ '^hmac-sha256:[a-f0-9]{64}$'
    AND input_fingerprint ~ '^hmac-sha256:[a-f0-9]{64}$'
  ),
  CONSTRAINT app_runs_key_version_check CHECK (
    idempotency_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND input_fingerprint_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  CONSTRAINT app_runs_json_check CHECK (
    jsonb_typeof(authorization_snapshot) = 'object'
    AND jsonb_typeof(safe_preview) = 'object'
    AND (safe_outcome IS NULL OR jsonb_typeof(safe_outcome) = 'object')
  ),
  CONSTRAINT app_runs_json_size_check CHECK (
    octet_length(authorization_snapshot::text) <= 65536
    AND octet_length(safe_preview::text) <= 16384
    AND (safe_outcome IS NULL OR octet_length(safe_outcome::text) <= 32768)
  ),
  CONSTRAINT app_runs_ancestry_check CHECK (
    depth >= 0 AND depth <= 8
    AND (
      (depth = 0 AND parent_run_id IS NULL AND root_run_id = id)
      OR (depth > 0 AND parent_run_id IS NOT NULL)
    )
  ),
  CONSTRAINT app_runs_expiry_check CHECK (result_expires_at >= input_expires_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS app_runs_idempotency_unique ON app_runs(
  org_id, initiating_actor_type, initiating_actor_id, provider_kind,
  provider_instance_id, operation_name, idempotency_key_version, idempotency_fingerprint
);
CREATE INDEX IF NOT EXISTS app_runs_org_state_idx ON app_runs(org_id, state, created_at);
CREATE INDEX IF NOT EXISTS app_runs_root_idx ON app_runs(org_id, root_run_id, created_at);
CREATE INDEX IF NOT EXISTS app_runs_parent_idx ON app_runs(org_id, parent_run_id);
CREATE INDEX IF NOT EXISTS app_runs_secret_expiry_idx ON app_runs(state, input_expires_at, result_expires_at);

ALTER TABLE app_runs
  ALTER CONSTRAINT app_runs_org_provider_snapshot_fk DEFERRABLE INITIALLY DEFERRED;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_runs_org_root_run_fk') THEN
    ALTER TABLE app_runs ADD CONSTRAINT app_runs_org_root_run_fk
      FOREIGN KEY (org_id, root_run_id) REFERENCES app_runs(org_id, id) ON DELETE NO ACTION
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_runs_org_parent_run_fk') THEN
    ALTER TABLE app_runs ADD CONSTRAINT app_runs_org_parent_run_fk
      FOREIGN KEY (org_id, parent_run_id) REFERENCES app_runs(org_id, id) ON DELETE NO ACTION
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS app_run_attempts (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  run_id text NOT NULL,
  attempt_number integer NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  claim_owner text,
  claim_token text,
  claimed_at timestamp,
  lease_expires_at timestamp,
  provider_call_started_at timestamp,
  provider_call_finished_at timestamp,
  provider_idempotency_key_version text,
  provider_idempotency_fingerprint text,
  safe_outcome jsonb,
  error_code text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_run_attempts_org_run_fk FOREIGN KEY (org_id, run_id)
    REFERENCES app_runs(org_id, id) ON DELETE CASCADE,
  CONSTRAINT app_run_attempts_org_run_id_unique UNIQUE (org_id, run_id, id),
  CONSTRAINT app_run_attempts_number_check CHECK (attempt_number >= 1),
  CONSTRAINT app_run_attempts_state_check CHECK (state IN (
    'pending', 'claimed', 'provider_call_started', 'succeeded', 'failed', 'cancelled', 'unknown_outcome'
  )),
  CONSTRAINT app_run_attempts_claim_shape_check CHECK (
    (claim_owner IS NULL AND claim_token IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL)
    OR (claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT app_run_attempts_provider_call_time_check CHECK (
    provider_call_finished_at IS NULL
    OR (provider_call_started_at IS NOT NULL AND provider_call_finished_at >= provider_call_started_at)
  ),
  CONSTRAINT app_run_attempts_idempotency_shape_check CHECK (
    (provider_idempotency_key_version IS NULL AND provider_idempotency_fingerprint IS NULL)
    OR (
      provider_idempotency_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      AND provider_idempotency_fingerprint ~ '^hmac-sha256:[a-f0-9]{64}$'
    )
  ),
  CONSTRAINT app_run_attempts_safe_outcome_check CHECK (
    safe_outcome IS NULL
    OR (jsonb_typeof(safe_outcome) = 'object' AND octet_length(safe_outcome::text) <= 32768)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS app_run_attempts_number_unique
  ON app_run_attempts(org_id, run_id, attempt_number);
CREATE INDEX IF NOT EXISTS app_run_attempts_lease_idx
  ON app_run_attempts(state, lease_expires_at);

CREATE TABLE IF NOT EXISTS app_run_secret_payloads (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text,
  payload_kind text NOT NULL,
  envelope_version text NOT NULL,
  algorithm text NOT NULL,
  key_version text NOT NULL,
  nonce_b64 text NOT NULL,
  ciphertext_b64 text NOT NULL,
  auth_tag_b64 text NOT NULL,
  payload_bytes integer NOT NULL,
  expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_run_secret_payloads_org_run_fk FOREIGN KEY (org_id, run_id)
    REFERENCES app_runs(org_id, id) ON DELETE CASCADE,
  CONSTRAINT app_run_secret_payloads_org_attempt_fk FOREIGN KEY (org_id, run_id, attempt_id)
    REFERENCES app_run_attempts(org_id, run_id, id) ON DELETE CASCADE,
  CONSTRAINT app_run_secret_payloads_kind_shape_check CHECK (
    (payload_kind = 'input' AND attempt_id IS NULL AND payload_bytes BETWEEN 1 AND 262144)
    OR (payload_kind = 'output' AND attempt_id IS NOT NULL AND payload_bytes BETWEEN 1 AND 1048576)
  ),
  CONSTRAINT app_run_secret_payloads_envelope_check CHECK (
    envelope_version = 'deft.secret.v1'
    AND algorithm = 'aes-256-gcm'
    AND key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND nonce_b64 ~ '^[A-Za-z0-9+/]{16}$'
    AND auth_tag_b64 ~ '^[A-Za-z0-9+/]{22}==$'
    AND ciphertext_b64 ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
  ),
  CONSTRAINT app_run_secret_payloads_size_check CHECK (
    octet_length(decode(ciphertext_b64, 'base64')) = payload_bytes
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS app_run_secret_payloads_input_unique
  ON app_run_secret_payloads(org_id, run_id, payload_kind) WHERE payload_kind = 'input';
CREATE UNIQUE INDEX IF NOT EXISTS app_run_secret_payloads_output_unique
  ON app_run_secret_payloads(org_id, attempt_id, payload_kind) WHERE payload_kind = 'output';
CREATE INDEX IF NOT EXISTS app_run_secret_payloads_expiry_idx ON app_run_secret_payloads(expires_at);

CREATE TABLE IF NOT EXISTS app_run_events (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  run_id text NOT NULL,
  event_version text NOT NULL DEFAULT 'deft.app_run_event.v1',
  sequence integer NOT NULL,
  event_type text NOT NULL,
  actor_type text,
  actor_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_run_events_org_run_fk FOREIGN KEY (org_id, run_id)
    REFERENCES app_runs(org_id, id) ON DELETE CASCADE,
  CONSTRAINT app_run_events_sequence_check CHECK (sequence >= 1),
  CONSTRAINT app_run_events_version_check CHECK (event_version = 'deft.app_run_event.v1'),
  CONSTRAINT app_run_events_type_check CHECK (event_type IN (
    'run_created', 'approval_requested', 'approval_resolved', 'attempt_created',
    'attempt_claimed', 'provider_call_started', 'attempt_terminal', 'run_transitioned',
    'secrets_purged', 'reconciliation_recorded', 'repair_gap'
  )),
  CONSTRAINT app_run_events_actor_shape_check CHECK (
    (actor_type IS NULL AND actor_id IS NULL)
    OR (actor_type IN ('human', 'agent_employee', 'system', 'automation') AND actor_id IS NOT NULL)
  ),
  CONSTRAINT app_run_events_payload_check CHECK (
    jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 32768
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS app_run_events_sequence_unique
  ON app_run_events(org_id, run_id, sequence);
CREATE INDEX IF NOT EXISTS app_run_events_run_idx ON app_run_events(org_id, run_id, created_at);

CREATE TABLE IF NOT EXISTS app_run_receipts (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text,
  receipt_version text NOT NULL DEFAULT 'deft.app_run_receipt.v1',
  receipt_key text NOT NULL,
  receipt_kind text NOT NULL,
  envelope jsonb NOT NULL,
  envelope_digest text NOT NULL,
  signing_key_version text NOT NULL,
  signature_hmac text NOT NULL,
  signed_at timestamp NOT NULL DEFAULT now(),
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_run_receipts_org_run_fk FOREIGN KEY (org_id, run_id)
    REFERENCES app_runs(org_id, id) ON DELETE CASCADE,
  CONSTRAINT app_run_receipts_org_attempt_fk FOREIGN KEY (org_id, run_id, attempt_id)
    REFERENCES app_run_attempts(org_id, run_id, id) ON DELETE CASCADE,
  CONSTRAINT app_run_receipts_version_check CHECK (receipt_version = 'deft.app_run_receipt.v1'),
  CONSTRAINT app_run_receipts_kind_check CHECK (receipt_kind IN (
    'approval', 'attempt_terminal', 'reconciliation', 'repair'
  )),
  CONSTRAINT app_run_receipts_envelope_check CHECK (
    jsonb_typeof(envelope) = 'object' AND octet_length(envelope::text) <= 32768
  ),
  CONSTRAINT app_run_receipts_digest_check CHECK (envelope_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT app_run_receipts_signature_check CHECK (signature_hmac ~ '^hmac-sha256:[a-f0-9]{64}$'),
  CONSTRAINT app_run_receipts_key_version_check CHECK (
    signing_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS app_run_receipts_key_unique
  ON app_run_receipts(org_id, run_id, receipt_key);
CREATE INDEX IF NOT EXISTS app_run_receipts_run_idx ON app_run_receipts(org_id, run_id, signed_at);

ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS app_run_id text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_actions_org_app_run_fk') THEN
    ALTER TABLE agent_actions ADD CONSTRAINT agent_actions_org_app_run_fk
      FOREIGN KEY (org_id, app_run_id) REFERENCES app_runs(org_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS agent_action_app_run_unique
  ON agent_actions(org_id, app_run_id) WHERE app_run_id IS NOT NULL;

-- A nested FK cascade (for example organization deletion) remains possible.
-- Direct deletion is reserved for a bounded maintenance transaction which uses
-- SET LOCAL deft.app_run_maintenance = 'on'.
CREATE OR REPLACE FUNCTION enforce_app_run_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (
    pg_trigger_depth() > 1
    OR current_setting('deft.app_run_maintenance', true) = 'on'
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'APP_RUN_APPEND_ONLY' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

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
      NEW.safe_preview, NEW.root_run_id, NEW.depth, NEW.input_expires_at, NEW.result_expires_at)
    IS DISTINCT FROM
     (OLD.org_id, OLD.contract_version, OLD.origin_kind, OLD.initiating_actor_type, OLD.initiating_actor_id,
      OLD.execution_actor_type, OLD.execution_actor_id, OLD.provider_kind,
      OLD.provider_instance_id, OLD.operation_name, OLD.provider_snapshot_id,
      OLD.risk_class, OLD.review_requirement, OLD.review_scope, OLD.retry_class,
      OLD.retention_class, OLD.idempotency_key_version, OLD.idempotency_fingerprint,
      OLD.input_fingerprint_key_version, OLD.input_fingerprint, OLD.authorization_snapshot,
      OLD.safe_preview, OLD.root_run_id, OLD.depth, OLD.input_expires_at, OLD.result_expires_at)
  THEN
    RAISE EXCEPTION 'APP_RUN_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;

  IF NEW.parent_run_id IS DISTINCT FROM OLD.parent_run_id THEN
    RAISE EXCEPTION 'APP_RUN_IMMUTABLE_FIELD' USING ERRCODE = '55000';
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

  IF (NEW.org_id, NEW.run_id, NEW.attempt_number,
      NEW.provider_idempotency_key_version, NEW.provider_idempotency_fingerprint)
    IS DISTINCT FROM
     (OLD.org_id, OLD.run_id, OLD.attempt_number,
      OLD.provider_idempotency_key_version, OLD.provider_idempotency_fingerprint)
  THEN
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

DROP TRIGGER IF EXISTS capability_provider_snapshots_append_only_trigger ON capability_provider_snapshots;
CREATE TRIGGER capability_provider_snapshots_append_only_trigger
  BEFORE UPDATE OR DELETE ON capability_provider_snapshots
  FOR EACH ROW EXECUTE FUNCTION enforce_app_run_append_only();

DROP TRIGGER IF EXISTS app_runs_state_identity_trigger ON app_runs;
CREATE TRIGGER app_runs_state_identity_trigger
  BEFORE UPDATE OR DELETE ON app_runs
  FOR EACH ROW EXECUTE FUNCTION enforce_app_run_state_and_identity();

DROP TRIGGER IF EXISTS app_run_attempts_state_identity_trigger ON app_run_attempts;
CREATE TRIGGER app_run_attempts_state_identity_trigger
  BEFORE UPDATE OR DELETE ON app_run_attempts
  FOR EACH ROW EXECUTE FUNCTION enforce_app_run_attempt_state_and_identity();

DROP TRIGGER IF EXISTS app_run_secret_payloads_append_only_trigger ON app_run_secret_payloads;
CREATE TRIGGER app_run_secret_payloads_append_only_trigger
  BEFORE UPDATE OR DELETE ON app_run_secret_payloads
  FOR EACH ROW EXECUTE FUNCTION enforce_app_run_append_only();

DROP TRIGGER IF EXISTS app_run_events_append_only_trigger ON app_run_events;
CREATE TRIGGER app_run_events_append_only_trigger
  BEFORE UPDATE OR DELETE ON app_run_events
  FOR EACH ROW EXECUTE FUNCTION enforce_app_run_append_only();

DROP TRIGGER IF EXISTS app_run_receipts_append_only_trigger ON app_run_receipts;
CREATE TRIGGER app_run_receipts_append_only_trigger
  BEFORE UPDATE OR DELETE ON app_run_receipts
  FOR EACH ROW EXECUTE FUNCTION enforce_app_run_append_only();
