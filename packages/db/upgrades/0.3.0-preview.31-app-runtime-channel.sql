-- Forward-only, default-off App Runtime channel ancestry. This adds no public
-- App Kit contract, execution entrance, scheduler, or provider call path.
ALTER TABLE capability_provider_snapshots
  DROP CONSTRAINT IF EXISTS capability_provider_snapshots_kind_check;
ALTER TABLE capability_provider_snapshots
  ADD CONSTRAINT capability_provider_snapshots_kind_check
  CHECK (provider_kind IN ('mcp', 'app_runtime'));
ALTER TABLE app_runs DROP CONSTRAINT IF EXISTS app_runs_provider_kind_check;
ALTER TABLE app_runs ADD CONSTRAINT app_runs_provider_kind_check
  CHECK (provider_kind IN ('mcp', 'app_runtime'));

CREATE TABLE IF NOT EXISTS app_runtime_registrations (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  app_installation_id text NOT NULL,
  app_version_id text NOT NULL,
  grant_snapshot_id text NOT NULL,
  grant_snapshot_kind text NOT NULL DEFAULT 'effective',
  operator_user_id text NOT NULL,
  contract_version text NOT NULL,
  state text NOT NULL DEFAULT 'disabled',
  runtime_epoch integer NOT NULL DEFAULT 0,
  reviewed_by_user_id text,
  reviewed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_runtime_registrations_version_fk FOREIGN KEY
    (org_id, app_installation_id, app_version_id) REFERENCES
    app_versions(org_id, installation_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_runtime_registrations_grant_fk FOREIGN KEY
    (org_id, app_installation_id, app_version_id, grant_snapshot_id, grant_snapshot_kind)
    REFERENCES app_grant_snapshots
    (org_id, app_installation_id, app_version_id, id, snapshot_kind) ON DELETE RESTRICT,
  CONSTRAINT app_runtime_registrations_operator_fk FOREIGN KEY (org_id, operator_user_id)
    REFERENCES org_members(org_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT app_runtime_registrations_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT app_runtime_registrations_ancestry_unique UNIQUE
    (org_id, app_installation_id, app_version_id, grant_snapshot_id, id),
  CONSTRAINT app_runtime_registrations_kind_check CHECK (grant_snapshot_kind = 'effective'),
  CONSTRAINT app_runtime_registrations_state_check CHECK (state IN ('disabled','active','revoked')),
  CONSTRAINT app_runtime_registrations_epoch_check CHECK (runtime_epoch >= 0),
  CONSTRAINT app_runtime_registrations_review_check CHECK
    ((state = 'disabled' AND reviewed_at IS NULL AND reviewed_by_user_id IS NULL)
     OR (state <> 'disabled' AND reviewed_at IS NOT NULL AND reviewed_by_user_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS app_runtime_bindings (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  app_installation_id text NOT NULL,
  app_version_id text NOT NULL,
  grant_snapshot_id text NOT NULL,
  runtime_registration_id text NOT NULL,
  action_key text NOT NULL,
  interface_identity text NOT NULL,
  provider_kind text NOT NULL DEFAULT 'app_runtime',
  provider_instance_id text NOT NULL,
  provider_snapshot_id text NOT NULL,
  operation_name text NOT NULL,
  risk_class text NOT NULL,
  review_requirement text NOT NULL,
  retry_class text NOT NULL,
  retention_class text NOT NULL,
  state text NOT NULL DEFAULT 'disabled',
  reviewed_by_user_id text,
  reviewed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_runtime_bindings_registration_fk FOREIGN KEY
    (org_id, app_installation_id, app_version_id, grant_snapshot_id, runtime_registration_id)
    REFERENCES app_runtime_registrations
    (org_id, app_installation_id, app_version_id, grant_snapshot_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_runtime_bindings_provider_fk FOREIGN KEY
    (org_id, provider_kind, provider_instance_id, provider_snapshot_id)
    REFERENCES capability_provider_snapshots
    (org_id, provider_kind, provider_instance_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_runtime_bindings_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT app_runtime_bindings_registration_identity_unique UNIQUE
    (org_id, runtime_registration_id, id),
  CONSTRAINT app_runtime_bindings_run_identity_unique UNIQUE
    (org_id, app_installation_id, app_version_id, grant_snapshot_id, id,
     provider_kind, provider_instance_id, operation_name, provider_snapshot_id,
     risk_class, review_requirement, retry_class, retention_class),
  CONSTRAINT app_runtime_bindings_kind_check CHECK (provider_kind = 'app_runtime'),
  CONSTRAINT app_runtime_bindings_identity_check CHECK
    (provider_instance_id = runtime_registration_id
     AND action_key ~ '^[a-z][a-z0-9_]{0,47}$'
     AND action_key !~ '^(deft|core|system)(_|$)'
     AND interface_identity = 'deft.runtime.v1:' || lower(org_id) || ':' ||
       lower(app_installation_id) || ':' || action_key),
  CONSTRAINT app_runtime_bindings_state_check CHECK (state IN ('disabled','active','revoked')),
  CONSTRAINT app_runtime_bindings_review_check CHECK
    ((state = 'disabled' AND reviewed_at IS NULL AND reviewed_by_user_id IS NULL)
     OR (state <> 'disabled' AND reviewed_at IS NOT NULL AND reviewed_by_user_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS app_runtime_sessions (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  runtime_registration_id text NOT NULL,
  runtime_binding_id text NOT NULL,
  operator_user_id text NOT NULL,
  token_hash text NOT NULL,
  audience text NOT NULL DEFAULT 'app_runtime',
  session_epoch integer NOT NULL DEFAULT 0,
  runtime_epoch integer NOT NULL,
  lifecycle_epoch integer NOT NULL,
  grant_epoch integer NOT NULL,
  next_sequence integer NOT NULL DEFAULT 1,
  expires_at timestamp NOT NULL,
  revoked_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_runtime_sessions_binding_fk FOREIGN KEY
    (org_id, runtime_registration_id, runtime_binding_id)
    REFERENCES app_runtime_bindings (org_id, runtime_registration_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_runtime_sessions_operator_fk FOREIGN KEY (org_id, operator_user_id)
    REFERENCES org_members(org_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT app_runtime_sessions_attempt_identity_unique UNIQUE
    (org_id, runtime_binding_id, id, session_epoch, runtime_epoch),
  CONSTRAINT app_runtime_sessions_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT app_runtime_sessions_audience_check CHECK (audience = 'app_runtime'),
  CONSTRAINT app_runtime_sessions_epoch_check CHECK
    (session_epoch >= 0 AND runtime_epoch >= 0 AND lifecycle_epoch >= 0
     AND grant_epoch >= 0 AND next_sequence >= 1),
  CONSTRAINT app_runtime_sessions_token_check CHECK (token_hash ~ '^sha256:[a-f0-9]{64}$')
);

ALTER TABLE app_runs ADD COLUMN IF NOT EXISTS origin_runtime_binding_id text;
ALTER TABLE app_run_attempts
  ADD COLUMN IF NOT EXISTS runtime_binding_id text,
  ADD COLUMN IF NOT EXISTS runtime_session_id text,
  ADD COLUMN IF NOT EXISTS runtime_session_epoch integer,
  ADD COLUMN IF NOT EXISTS runtime_epoch integer,
  ADD COLUMN IF NOT EXISTS runtime_sequence integer,
  ADD COLUMN IF NOT EXISTS runtime_result_hmac text;

ALTER TABLE app_runs DROP CONSTRAINT IF EXISTS app_runs_app_origin_coherence_check;
ALTER TABLE app_runs ADD CONSTRAINT app_runs_app_origin_coherence_check CHECK (
  (origin_kind = 'app' AND provider_kind = 'mcp'
   AND origin_app_installation_id IS NOT NULL AND origin_app_version_id IS NOT NULL
   AND origin_app_binding_key IS NOT NULL AND origin_runtime_binding_id IS NULL
   AND origin_app_grant_snapshot_id IS NOT NULL
   AND risk_class = 'external_write' AND review_requirement = 'always'
   AND retry_class = 'idempotent_with_key' AND retention_class = 'standard'
   AND ((review_scope = 'per_invocation'
         AND origin_app_automation_definition_id IS NULL AND origin_app_automation_fire_id IS NULL
         AND initiating_actor_type <> 'automation' AND execution_actor_type <> 'automation')
     OR (review_scope = 'approved_automation_definition'
         AND origin_app_automation_definition_id IS NOT NULL AND origin_app_automation_fire_id IS NOT NULL
         AND initiating_actor_type = 'human' AND execution_actor_type = 'automation'
         AND execution_actor_id = origin_app_automation_definition_id)))
  OR (origin_kind = 'app' AND provider_kind = 'app_runtime'
   AND origin_app_installation_id IS NOT NULL AND origin_app_version_id IS NOT NULL
   AND origin_app_grant_snapshot_id IS NOT NULL AND origin_app_binding_key IS NULL
   AND origin_runtime_binding_id IS NOT NULL
   AND origin_app_automation_definition_id IS NULL AND origin_app_automation_fire_id IS NULL
   AND initiating_actor_type <> 'automation' AND execution_actor_type <> 'automation'
   AND review_scope = 'per_invocation')
  OR (origin_kind <> 'app' AND provider_kind = 'mcp'
   AND origin_app_installation_id IS NULL AND origin_app_version_id IS NULL
   AND origin_app_binding_key IS NULL AND origin_runtime_binding_id IS NULL
   AND origin_app_grant_snapshot_id IS NULL
   AND origin_app_automation_definition_id IS NULL AND origin_app_automation_fire_id IS NULL
   AND initiating_actor_type <> 'automation' AND execution_actor_type <> 'automation')
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_runs_runtime_binding_fk') THEN
    ALTER TABLE app_runs ADD CONSTRAINT app_runs_runtime_binding_fk FOREIGN KEY
      (org_id, origin_app_installation_id, origin_app_version_id,
       origin_app_grant_snapshot_id, origin_runtime_binding_id, provider_kind,
       provider_instance_id, operation_name, provider_snapshot_id,
       risk_class, review_requirement, retry_class, retention_class)
      REFERENCES app_runtime_bindings
      (org_id, app_installation_id, app_version_id, grant_snapshot_id, id,
       provider_kind, provider_instance_id, operation_name, provider_snapshot_id,
       risk_class, review_requirement, retry_class, retention_class) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_run_attempts_runtime_session_fk') THEN
    ALTER TABLE app_run_attempts ADD CONSTRAINT app_run_attempts_runtime_session_fk FOREIGN KEY
      (org_id, runtime_binding_id, runtime_session_id, runtime_session_epoch, runtime_epoch)
      REFERENCES app_runtime_sessions
      (org_id, runtime_binding_id, id, session_epoch, runtime_epoch) ON DELETE RESTRICT;
  END IF;
END $$;
ALTER TABLE app_run_attempts DROP CONSTRAINT IF EXISTS app_run_attempts_runtime_shape_check;
ALTER TABLE app_run_attempts ADD CONSTRAINT app_run_attempts_runtime_shape_check CHECK (
  (runtime_binding_id IS NULL AND runtime_session_id IS NULL
   AND runtime_session_epoch IS NULL AND runtime_epoch IS NULL
   AND runtime_sequence IS NULL AND runtime_result_hmac IS NULL)
  OR (runtime_binding_id IS NOT NULL AND runtime_session_id IS NOT NULL
      AND runtime_session_epoch IS NOT NULL AND runtime_session_epoch >= 0
      AND runtime_epoch IS NOT NULL AND runtime_epoch >= 0
      AND runtime_sequence IS NOT NULL AND runtime_sequence >= 1)
);

-- Additive guards preserve the old transition functions byte-for-byte. A
-- claim can pin its session exactly once; a known result can pin its digest
-- exactly once. Revocation/expiry is checked by the API on every call.
CREATE OR REPLACE FUNCTION enforce_app_runtime_run_identity() RETURNS trigger AS $$
BEGIN
  IF NEW.origin_runtime_binding_id IS DISTINCT FROM OLD.origin_runtime_binding_id THEN
    RAISE EXCEPTION 'APP_RUN_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_runtime_run_identity_trigger ON app_runs;
CREATE TRIGGER app_runtime_run_identity_trigger BEFORE UPDATE ON app_runs
  FOR EACH ROW EXECUTE FUNCTION enforce_app_runtime_run_identity();

CREATE OR REPLACE FUNCTION enforce_app_runtime_attempt_identity() RETURNS trigger AS $$
BEGIN
  IF OLD.runtime_session_id IS NOT NULL AND
     (NEW.runtime_binding_id, NEW.runtime_session_id, NEW.runtime_session_epoch,
      NEW.runtime_epoch, NEW.runtime_sequence) IS DISTINCT FROM
     (OLD.runtime_binding_id, OLD.runtime_session_id, OLD.runtime_session_epoch,
      OLD.runtime_epoch, OLD.runtime_sequence) THEN
    RAISE EXCEPTION 'APP_RUN_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;
  IF OLD.runtime_session_id IS NULL AND NEW.runtime_session_id IS NOT NULL AND
     NOT (OLD.state = 'pending' AND NEW.state = 'claimed') THEN
    RAISE EXCEPTION 'APP_RUN_ILLEGAL_TRANSITION' USING ERRCODE = '55000';
  END IF;
  IF OLD.runtime_result_hmac IS NOT NULL AND NEW.runtime_result_hmac IS DISTINCT FROM OLD.runtime_result_hmac THEN
    RAISE EXCEPTION 'APP_RUN_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;
  IF OLD.runtime_result_hmac IS NULL AND NEW.runtime_result_hmac IS NOT NULL AND
     NOT (OLD.state = 'provider_call_started' AND
       (NEW.provider_call_finished_at IS NOT NULL OR NEW.state = 'unknown_outcome')) THEN
    RAISE EXCEPTION 'APP_RUN_ILLEGAL_TRANSITION' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_runtime_attempt_identity_trigger ON app_run_attempts;
CREATE TRIGGER app_runtime_attempt_identity_trigger BEFORE UPDATE ON app_run_attempts
  FOR EACH ROW EXECUTE FUNCTION enforce_app_runtime_attempt_identity();

-- Review transitions are one-way. Live workers still check mutable installation,
-- operator and grant state on every channel call.
CREATE OR REPLACE FUNCTION enforce_app_runtime_registration() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APP_RUNTIME_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.org_id, NEW.app_installation_id, NEW.app_version_id, NEW.grant_snapshot_id,
        NEW.grant_snapshot_kind, NEW.operator_user_id, NEW.contract_version,
        NEW.created_at) IS DISTINCT FROM
       (OLD.org_id, OLD.app_installation_id, OLD.app_version_id, OLD.grant_snapshot_id,
        OLD.grant_snapshot_kind, OLD.operator_user_id, OLD.contract_version,
        OLD.created_at)
    THEN RAISE EXCEPTION 'APP_RUNTIME_IMMUTABLE_FIELD' USING ERRCODE = '55000'; END IF;
    IF (NEW.reviewed_by_user_id, NEW.reviewed_at) IS DISTINCT FROM
       (OLD.reviewed_by_user_id, OLD.reviewed_at)
       AND NOT (OLD.state = 'disabled' AND NEW.state = 'active'
         AND OLD.reviewed_by_user_id IS NULL AND OLD.reviewed_at IS NULL
         AND NEW.reviewed_by_user_id IS NOT NULL AND NEW.reviewed_at IS NOT NULL)
    THEN RAISE EXCEPTION 'APP_RUNTIME_IMMUTABLE_FIELD' USING ERRCODE = '55000'; END IF;
    IF NOT ((OLD.state = 'disabled' AND NEW.state = 'active'
             AND NEW.runtime_epoch = OLD.runtime_epoch + 1)
         OR (OLD.state = 'active' AND NEW.state = 'revoked'
             AND NEW.runtime_epoch = OLD.runtime_epoch + 1)
         OR (OLD.state = NEW.state AND NEW.runtime_epoch = OLD.runtime_epoch)) THEN
      RAISE EXCEPTION 'APP_RUNTIME_ILLEGAL_TRANSITION' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW.state = 'active' AND NOT EXISTS (
    SELECT 1 FROM org_members WHERE org_id = NEW.org_id
      AND user_id = NEW.reviewed_by_user_id AND is_active
      AND role IN ('owner','admin')
  ) THEN RAISE EXCEPTION 'APP_RUNTIME_REVIEW_INVALID' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_runtime_registration_guard_trigger ON app_runtime_registrations;
CREATE TRIGGER app_runtime_registration_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON app_runtime_registrations
  FOR EACH ROW EXECUTE FUNCTION enforce_app_runtime_registration();

CREATE OR REPLACE FUNCTION enforce_app_runtime_binding() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APP_RUNTIME_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.org_id, NEW.app_installation_id, NEW.app_version_id, NEW.grant_snapshot_id,
        NEW.runtime_registration_id, NEW.action_key, NEW.interface_identity,
        NEW.provider_kind, NEW.provider_instance_id, NEW.provider_snapshot_id,
        NEW.operation_name, NEW.risk_class, NEW.review_requirement,
        NEW.retry_class, NEW.retention_class, NEW.created_at) IS DISTINCT FROM
       (OLD.org_id, OLD.app_installation_id, OLD.app_version_id, OLD.grant_snapshot_id,
        OLD.runtime_registration_id, OLD.action_key, OLD.interface_identity,
        OLD.provider_kind, OLD.provider_instance_id, OLD.provider_snapshot_id,
        OLD.operation_name, OLD.risk_class, OLD.review_requirement,
        OLD.retry_class, OLD.retention_class, OLD.created_at)
    THEN RAISE EXCEPTION 'APP_RUNTIME_IMMUTABLE_FIELD' USING ERRCODE = '55000'; END IF;
    IF (NEW.reviewed_by_user_id, NEW.reviewed_at) IS DISTINCT FROM
       (OLD.reviewed_by_user_id, OLD.reviewed_at)
       AND NOT (OLD.state = 'disabled' AND NEW.state = 'active'
         AND OLD.reviewed_by_user_id IS NULL AND OLD.reviewed_at IS NULL
         AND NEW.reviewed_by_user_id IS NOT NULL AND NEW.reviewed_at IS NOT NULL)
    THEN RAISE EXCEPTION 'APP_RUNTIME_IMMUTABLE_FIELD' USING ERRCODE = '55000'; END IF;
    IF NOT ((OLD.state = 'disabled' AND NEW.state = 'active')
         OR (OLD.state = 'active' AND NEW.state = 'revoked')
         OR OLD.state = NEW.state) THEN
      RAISE EXCEPTION 'APP_RUNTIME_ILLEGAL_TRANSITION' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW.state = 'active' AND NOT EXISTS (
    SELECT 1 FROM org_members WHERE org_id = NEW.org_id
      AND user_id = NEW.reviewed_by_user_id AND is_active
      AND role IN ('owner','admin')
  ) THEN RAISE EXCEPTION 'APP_RUNTIME_REVIEW_INVALID' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_runtime_binding_guard_trigger ON app_runtime_bindings;
CREATE TRIGGER app_runtime_binding_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON app_runtime_bindings
  FOR EACH ROW EXECUTE FUNCTION enforce_app_runtime_binding();

CREATE OR REPLACE FUNCTION enforce_app_runtime_session() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APP_RUNTIME_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.org_id, NEW.runtime_registration_id, NEW.runtime_binding_id,
        NEW.operator_user_id, NEW.token_hash, NEW.audience, NEW.session_epoch,
        NEW.runtime_epoch, NEW.lifecycle_epoch, NEW.grant_epoch,
        NEW.expires_at, NEW.created_at) IS DISTINCT FROM
       (OLD.org_id, OLD.runtime_registration_id, OLD.runtime_binding_id,
        OLD.operator_user_id, OLD.token_hash, OLD.audience, OLD.session_epoch,
        OLD.runtime_epoch, OLD.lifecycle_epoch, OLD.grant_epoch,
        OLD.expires_at, OLD.created_at)
      OR NEW.next_sequence < OLD.next_sequence
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    THEN RAISE EXCEPTION 'APP_RUNTIME_IMMUTABLE_FIELD' USING ERRCODE = '55000'; END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_runtime_session_guard_trigger ON app_runtime_sessions;
CREATE TRIGGER app_runtime_session_guard_trigger
  BEFORE UPDATE OR DELETE ON app_runtime_sessions
  FOR EACH ROW EXECUTE FUNCTION enforce_app_runtime_session();
