-- Forward-only, default-off host-owned resource sync ancestry.
-- Reconciles fresh Drizzle pushes and upgrades supported predecessor schemas.
ALTER TABLE app_runtime_registrations
  DROP CONSTRAINT IF EXISTS app_runtime_registrations_contract_check;
ALTER TABLE app_runtime_registrations
  ADD CONSTRAINT app_runtime_registrations_contract_check CHECK
    (contract_version IN ('deft.app_runtime_channel.v1', 'deft.app_runtime_channel.v2'));
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'app_runtime_registrations_contract_ancestry_unique'
        AND conrelid = 'app_runtime_registrations'::regclass) THEN
    ALTER TABLE app_runtime_registrations
      ADD CONSTRAINT app_runtime_registrations_contract_ancestry_unique UNIQUE
        (org_id, app_installation_id, app_version_id, grant_snapshot_id, id, contract_version);
  END IF;
END $$;

-- Existing v1 action bindings remain v1, including when new v2 registrations exist.
ALTER TABLE app_runtime_bindings
  ADD COLUMN IF NOT EXISTS registration_contract_version text NOT NULL DEFAULT 'deft.app_runtime_channel.v1';
ALTER TABLE app_runtime_bindings
  DROP CONSTRAINT IF EXISTS app_runtime_bindings_registration_contract_check;
ALTER TABLE app_runtime_bindings
  ADD CONSTRAINT app_runtime_bindings_registration_contract_check CHECK
    (registration_contract_version = 'deft.app_runtime_channel.v1');
ALTER TABLE app_runtime_bindings DROP CONSTRAINT IF EXISTS app_runtime_bindings_registration_fk;
ALTER TABLE app_runtime_bindings
  ADD CONSTRAINT app_runtime_bindings_registration_fk FOREIGN KEY
    (org_id, app_installation_id, app_version_id, grant_snapshot_id,
     runtime_registration_id, registration_contract_version)
    REFERENCES app_runtime_registrations
    (org_id, app_installation_id, app_version_id, grant_snapshot_id, id, contract_version)
    ON DELETE RESTRICT;
CREATE OR REPLACE FUNCTION enforce_app_runtime_binding_v1_contract() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.registration_contract_version IS DISTINCT FROM OLD.registration_contract_version THEN
    RAISE EXCEPTION 'APP_RUNTIME_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_runtime_binding_v1_contract_trigger ON app_runtime_bindings;
CREATE TRIGGER app_runtime_binding_v1_contract_trigger BEFORE UPDATE ON app_runtime_bindings
  FOR EACH ROW EXECUTE FUNCTION enforce_app_runtime_binding_v1_contract();

CREATE TABLE IF NOT EXISTS app_resource_bindings (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  app_installation_id text NOT NULL,
  app_version_id text NOT NULL,
  grant_snapshot_id text NOT NULL,
  grant_snapshot_kind text NOT NULL DEFAULT 'effective',
  runtime_registration_id text NOT NULL,
  registration_contract_version text NOT NULL DEFAULT 'deft.app_runtime_channel.v2',
  provider_kind text NOT NULL DEFAULT 'app_runtime',
  provider_instance_id text NOT NULL,
  provider_snapshot_id text NOT NULL,
  resource_key text NOT NULL,
  resource_family text NOT NULL,
  operation_name text NOT NULL,
  interface_identity text NOT NULL,
  reviewed_descriptor jsonb NOT NULL,
  descriptor_digest text NOT NULL,
  owner_user_id text NOT NULL,
  owner_scope text NOT NULL DEFAULT 'private_user',
  risk_class text NOT NULL DEFAULT 'internal_write',
  review_requirement text NOT NULL DEFAULT 'policy',
  review_scope text NOT NULL DEFAULT 'reviewed_resource_sync',
  retry_class text NOT NULL DEFAULT 'unsafe_or_unknown',
  retention_class text NOT NULL DEFAULT 'standard',
  max_records_per_page integer NOT NULL,
  max_page_bytes integer NOT NULL,
  max_retained_records integer NOT NULL,
  max_retained_bytes integer NOT NULL,
  min_interval_seconds integer NOT NULL,
  consent_expires_at timestamp,
  state text NOT NULL DEFAULT 'disabled',
  reviewed_by_user_id text,
  reviewed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_resource_bindings_grant_fk FOREIGN KEY
    (org_id, app_installation_id, app_version_id, grant_snapshot_id, grant_snapshot_kind)
    REFERENCES app_grant_snapshots
    (org_id, app_installation_id, app_version_id, id, snapshot_kind) ON DELETE RESTRICT,
  CONSTRAINT app_resource_bindings_registration_fk FOREIGN KEY
    (org_id, app_installation_id, app_version_id, grant_snapshot_id,
     runtime_registration_id, registration_contract_version)
    REFERENCES app_runtime_registrations
    (org_id, app_installation_id, app_version_id, grant_snapshot_id, id, contract_version)
    ON DELETE RESTRICT,
  CONSTRAINT app_resource_bindings_provider_fk FOREIGN KEY
    (org_id, provider_kind, provider_instance_id, provider_snapshot_id)
    REFERENCES capability_provider_snapshots
    (org_id, provider_kind, provider_instance_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_resource_bindings_owner_fk FOREIGN KEY (org_id, owner_user_id)
    REFERENCES org_members(org_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT app_resource_bindings_reviewer_fk FOREIGN KEY (org_id, reviewed_by_user_id)
    REFERENCES org_members(org_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT app_resource_bindings_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT app_resource_bindings_registration_identity_unique UNIQUE
    (org_id, runtime_registration_id, id),
  CONSTRAINT app_resource_bindings_owner_identity_unique UNIQUE (org_id, id, owner_user_id),
  CONSTRAINT app_resource_bindings_descriptor_identity_unique UNIQUE
    (org_id, id, owner_user_id, descriptor_digest),
  CONSTRAINT app_resource_bindings_run_identity_unique UNIQUE
    (org_id, app_installation_id, app_version_id, grant_snapshot_id, id,
     provider_kind, provider_instance_id, operation_name, provider_snapshot_id,
     risk_class, review_requirement, review_scope, retry_class, retention_class),
  CONSTRAINT app_resource_bindings_identity_check CHECK (
    grant_snapshot_kind = 'effective'
    AND registration_contract_version = 'deft.app_runtime_channel.v2'
    AND provider_kind = 'app_runtime' AND provider_instance_id = runtime_registration_id
    AND owner_scope = 'private_user'
    AND resource_key ~ '^[a-z][a-z0-9_]{0,47}$'
    AND resource_family ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    AND octet_length(resource_family) <= 64
    AND operation_name = 'sync_' || resource_key
    AND interface_identity = 'deft.resource_sync.v2:' || lower(org_id) || ':' ||
      lower(app_installation_id) || ':' || resource_key
    AND descriptor_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT app_resource_bindings_descriptor_check CHECK (
    jsonb_typeof(reviewed_descriptor) = 'object'
    AND coalesce(jsonb_typeof(reviewed_descriptor->'schema_version'), '') = 'string'
    AND coalesce(reviewed_descriptor->>'schema_version', '') = 'deft.app_sync_descriptor.v1'
    AND octet_length(reviewed_descriptor::text) <= 65536),
  CONSTRAINT app_resource_bindings_policy_check CHECK (
    risk_class = 'internal_write' AND review_requirement = 'policy'
    AND review_scope = 'reviewed_resource_sync'
    AND retry_class = 'unsafe_or_unknown' AND retention_class = 'standard'),
  CONSTRAINT app_resource_bindings_limits_check CHECK (
    max_records_per_page BETWEEN 1 AND 100 AND max_page_bytes BETWEEN 1 AND 524288
    AND max_retained_records BETWEEN 1 AND 100000
    AND max_retained_bytes BETWEEN 1 AND 1073741824
    AND min_interval_seconds BETWEEN 60 AND 86400),
  CONSTRAINT app_resource_bindings_review_check CHECK (
    (state = 'disabled' AND reviewed_by_user_id IS NULL
      AND reviewed_at IS NULL AND consent_expires_at IS NULL)
    OR (state IN ('active','revoked') AND reviewed_by_user_id IS NOT NULL
      AND reviewed_by_user_id = owner_user_id AND reviewed_at IS NOT NULL
      AND consent_expires_at IS NOT NULL AND consent_expires_at > reviewed_at
      AND consent_expires_at <= reviewed_at + interval '90 days'))
);
CREATE INDEX IF NOT EXISTS app_resource_bindings_owner_idx
  ON app_resource_bindings(org_id, owner_user_id, state);

ALTER TABLE app_runs ADD COLUMN IF NOT EXISTS origin_resource_binding_id text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_runs_resource_attempt_identity_unique'
      AND conrelid = 'app_runs'::regclass) THEN
    ALTER TABLE app_runs ADD CONSTRAINT app_runs_resource_attempt_identity_unique UNIQUE
      (org_id, id, origin_resource_binding_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_runs_sync_intent_identity_unique'
      AND conrelid = 'app_runs'::regclass) THEN
    ALTER TABLE app_runs ADD CONSTRAINT app_runs_sync_intent_identity_unique UNIQUE
      (org_id, id, origin_app_installation_id, origin_app_version_id,
       origin_app_grant_snapshot_id, origin_resource_binding_id, provider_snapshot_id);
  END IF;
END $$;
ALTER TABLE app_runs DROP CONSTRAINT IF EXISTS app_runs_resource_binding_fk;
ALTER TABLE app_runs ADD CONSTRAINT app_runs_resource_binding_fk FOREIGN KEY
  (org_id, origin_app_installation_id, origin_app_version_id,
   origin_app_grant_snapshot_id, origin_resource_binding_id, provider_kind,
   provider_instance_id, operation_name, provider_snapshot_id,
   risk_class, review_requirement, review_scope, retry_class, retention_class)
  REFERENCES app_resource_bindings
  (org_id, app_installation_id, app_version_id, grant_snapshot_id, id, provider_kind,
   provider_instance_id, operation_name, provider_snapshot_id,
   risk_class, review_requirement, review_scope, retry_class, retention_class)
  ON DELETE RESTRICT;
ALTER TABLE app_runs DROP CONSTRAINT IF EXISTS app_runs_review_scope_check;
ALTER TABLE app_runs ADD CONSTRAINT app_runs_review_scope_check CHECK (
  review_scope IN ('per_invocation','immutable_batch','approved_automation_definition',
                   'forbidden_in_automation','reviewed_resource_sync'));
ALTER TABLE app_runs DROP CONSTRAINT IF EXISTS app_runs_app_origin_coherence_check;
ALTER TABLE app_runs ADD CONSTRAINT app_runs_app_origin_coherence_check CHECK (
  (origin_kind = 'app' AND origin_app_installation_id IS NOT NULL
   AND origin_app_version_id IS NOT NULL AND provider_kind = 'mcp'
   AND origin_app_binding_key IS NOT NULL AND origin_runtime_binding_id IS NULL
   AND origin_resource_binding_id IS NULL
   AND origin_public_endpoint_id IS NULL AND origin_public_ingress_id IS NULL
   AND origin_app_grant_snapshot_id IS NOT NULL
   AND risk_class = 'external_write' AND review_requirement = 'always'
   AND retry_class = 'idempotent_with_key' AND retention_class = 'standard'
   AND ((review_scope = 'per_invocation'
     AND origin_app_automation_definition_id IS NULL AND origin_app_automation_fire_id IS NULL
     AND initiating_actor_type <> 'automation' AND initiating_actor_type <> 'app_public'
     AND execution_actor_type <> 'automation')
     OR (review_scope = 'approved_automation_definition'
     AND origin_app_automation_definition_id IS NOT NULL
     AND origin_app_automation_fire_id IS NOT NULL
     AND initiating_actor_type = 'human' AND execution_actor_type = 'automation'
     AND execution_actor_id = origin_app_automation_definition_id)))
  OR (origin_kind = 'app' AND provider_kind = 'app_runtime'
   AND origin_app_installation_id IS NOT NULL AND origin_app_version_id IS NOT NULL
   AND origin_app_grant_snapshot_id IS NOT NULL AND origin_app_binding_key IS NULL
   AND origin_runtime_binding_id IS NOT NULL AND origin_resource_binding_id IS NULL
   AND origin_app_automation_definition_id IS NULL AND origin_app_automation_fire_id IS NULL
   AND ((initiating_actor_type = 'app_public' AND execution_actor_type = 'human'
     AND initiating_actor_id = origin_public_ingress_id
     AND origin_public_endpoint_id IS NOT NULL AND origin_public_ingress_id IS NOT NULL)
     OR (initiating_actor_type <> 'automation' AND initiating_actor_type <> 'app_public'
       AND execution_actor_type <> 'automation'
       AND origin_public_endpoint_id IS NULL AND origin_public_ingress_id IS NULL))
   AND review_scope = 'per_invocation')
  OR (origin_kind = 'app' AND provider_kind = 'app_runtime'
   AND origin_app_installation_id IS NOT NULL AND origin_app_version_id IS NOT NULL
   AND origin_app_grant_snapshot_id IS NOT NULL AND origin_resource_binding_id IS NOT NULL
   AND origin_runtime_binding_id IS NULL AND origin_app_binding_key IS NULL
   AND origin_public_endpoint_id IS NULL AND origin_public_ingress_id IS NULL
   AND origin_app_automation_definition_id IS NULL AND origin_app_automation_fire_id IS NULL
   AND initiating_actor_type = 'system' AND execution_actor_type = 'system'
   AND initiating_actor_id = origin_resource_binding_id
   AND execution_actor_id = origin_resource_binding_id
   AND risk_class = 'internal_write' AND review_requirement = 'policy'
   AND review_scope = 'reviewed_resource_sync' AND retry_class = 'unsafe_or_unknown'
   AND retention_class = 'standard')
  OR (origin_kind <> 'app' AND provider_kind = 'mcp'
   AND origin_app_installation_id IS NULL AND origin_app_version_id IS NULL
   AND origin_app_binding_key IS NULL AND origin_runtime_binding_id IS NULL
   AND origin_resource_binding_id IS NULL AND origin_app_grant_snapshot_id IS NULL
   AND origin_app_automation_definition_id IS NULL AND origin_app_automation_fire_id IS NULL
   AND origin_public_endpoint_id IS NULL AND origin_public_ingress_id IS NULL
   AND initiating_actor_type <> 'automation' AND initiating_actor_type <> 'app_public'
   AND execution_actor_type <> 'automation')
);
CREATE OR REPLACE FUNCTION enforce_app_run_resource_identity() RETURNS trigger AS $$
BEGIN
  IF NEW.origin_resource_binding_id IS DISTINCT FROM OLD.origin_resource_binding_id THEN
    RAISE EXCEPTION 'APP_RUN_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_run_resource_identity_trigger ON app_runs;
CREATE TRIGGER app_run_resource_identity_trigger BEFORE UPDATE ON app_runs
  FOR EACH ROW EXECUTE FUNCTION enforce_app_run_resource_identity();

-- An existing Runtime session or attempt has exactly one v1 or v2 target.
ALTER TABLE app_runtime_sessions ALTER COLUMN runtime_binding_id DROP NOT NULL;
ALTER TABLE app_runtime_sessions ADD COLUMN IF NOT EXISTS resource_binding_id text;
ALTER TABLE app_runtime_sessions DROP CONSTRAINT IF EXISTS app_runtime_sessions_resource_binding_fk;
ALTER TABLE app_runtime_sessions ADD CONSTRAINT app_runtime_sessions_resource_binding_fk FOREIGN KEY
  (org_id, runtime_registration_id, resource_binding_id)
  REFERENCES app_resource_bindings(org_id, runtime_registration_id, id) ON DELETE RESTRICT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname = 'app_runtime_sessions_resource_attempt_identity_unique'
        AND conrelid = 'app_runtime_sessions'::regclass) THEN
    ALTER TABLE app_runtime_sessions
      ADD CONSTRAINT app_runtime_sessions_resource_attempt_identity_unique UNIQUE
        (org_id, resource_binding_id, id, session_epoch, runtime_epoch);
  END IF;
END $$;
ALTER TABLE app_runtime_sessions DROP CONSTRAINT IF EXISTS app_runtime_sessions_audience_check;
ALTER TABLE app_runtime_sessions ADD CONSTRAINT app_runtime_sessions_audience_check CHECK (
  (audience = 'app_runtime' AND runtime_binding_id IS NOT NULL AND resource_binding_id IS NULL)
  OR (audience = 'app_resource_sync' AND runtime_binding_id IS NULL
    AND resource_binding_id IS NOT NULL));
CREATE OR REPLACE FUNCTION enforce_app_runtime_session_resource_identity() RETURNS trigger AS $$
BEGIN
  IF NEW.resource_binding_id IS DISTINCT FROM OLD.resource_binding_id THEN
    RAISE EXCEPTION 'APP_RUNTIME_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_runtime_session_resource_identity_trigger ON app_runtime_sessions;
CREATE TRIGGER app_runtime_session_resource_identity_trigger BEFORE UPDATE ON app_runtime_sessions
  FOR EACH ROW EXECUTE FUNCTION enforce_app_runtime_session_resource_identity();

ALTER TABLE app_run_attempts ADD COLUMN IF NOT EXISTS resource_binding_id text;
ALTER TABLE app_run_attempts DROP CONSTRAINT IF EXISTS app_run_attempts_resource_session_fk;
ALTER TABLE app_run_attempts ADD CONSTRAINT app_run_attempts_resource_session_fk FOREIGN KEY
  (org_id, resource_binding_id, runtime_session_id, runtime_session_epoch, runtime_epoch)
  REFERENCES app_runtime_sessions
  (org_id, resource_binding_id, id, session_epoch, runtime_epoch) ON DELETE RESTRICT;
ALTER TABLE app_run_attempts DROP CONSTRAINT IF EXISTS app_run_attempts_resource_run_fk;
ALTER TABLE app_run_attempts ADD CONSTRAINT app_run_attempts_resource_run_fk FOREIGN KEY
  (org_id, run_id, resource_binding_id)
  REFERENCES app_runs(org_id, id, origin_resource_binding_id) ON DELETE RESTRICT;
ALTER TABLE app_run_attempts DROP CONSTRAINT IF EXISTS app_run_attempts_runtime_shape_check;
ALTER TABLE app_run_attempts ADD CONSTRAINT app_run_attempts_runtime_shape_check CHECK (
  (runtime_binding_id IS NULL AND resource_binding_id IS NULL AND runtime_session_id IS NULL
   AND runtime_session_epoch IS NULL AND runtime_epoch IS NULL
   AND runtime_sequence IS NULL AND runtime_result_hmac IS NULL)
  OR (runtime_binding_id IS NOT NULL AND resource_binding_id IS NULL
   AND runtime_session_id IS NOT NULL AND runtime_session_epoch IS NOT NULL
   AND runtime_session_epoch >= 0 AND runtime_epoch IS NOT NULL AND runtime_epoch >= 0
   AND runtime_sequence IS NOT NULL AND runtime_sequence >= 1)
  OR (runtime_binding_id IS NULL AND resource_binding_id IS NOT NULL
   AND runtime_session_id IS NOT NULL AND runtime_session_epoch IS NOT NULL
   AND runtime_session_epoch >= 0 AND runtime_epoch IS NOT NULL AND runtime_epoch >= 0
   AND runtime_sequence IS NOT NULL AND runtime_sequence >= 1));
CREATE OR REPLACE FUNCTION enforce_app_runtime_attempt_resource_identity() RETURNS trigger AS $$
BEGIN
  IF OLD.runtime_session_id IS NOT NULL AND
    NEW.resource_binding_id IS DISTINCT FROM OLD.resource_binding_id THEN
    RAISE EXCEPTION 'APP_RUN_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;
  IF OLD.runtime_session_id IS NULL AND NEW.runtime_session_id IS NOT NULL
    AND NEW.resource_binding_id IS NOT NULL
    AND NOT (OLD.state = 'pending' AND NEW.state = 'claimed') THEN
    RAISE EXCEPTION 'APP_RUN_ILLEGAL_TRANSITION' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_runtime_attempt_resource_identity_trigger ON app_run_attempts;
CREATE TRIGGER app_runtime_attempt_resource_identity_trigger BEFORE UPDATE ON app_run_attempts
  FOR EACH ROW EXECUTE FUNCTION enforce_app_runtime_attempt_resource_identity();

CREATE TABLE IF NOT EXISTS app_sync_checkpoints (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  resource_binding_id text NOT NULL,
  generation integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'active',
  cursor_sequence integer NOT NULL DEFAULT 0,
  cursor_hmac_key_version text NOT NULL,
  cursor_hmac text NOT NULL,
  cursor_state text NOT NULL DEFAULT 'empty',
  cursor_envelope_version text,
  cursor_algorithm text,
  cursor_key_version text,
  cursor_nonce_b64 text,
  cursor_ciphertext_b64 text,
  cursor_auth_tag_b64 text,
  cursor_bytes integer NOT NULL DEFAULT 0,
  retained_record_count integer NOT NULL DEFAULT 0,
  retained_bytes integer NOT NULL DEFAULT 0,
  last_applied_run_id text,
  last_applied_page_digest text,
  last_applied_at timestamp,
  last_checked_at timestamp,
  fresh_until timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_sync_checkpoints_binding_fk FOREIGN KEY (org_id, resource_binding_id)
    REFERENCES app_resource_bindings(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_sync_checkpoints_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT app_sync_checkpoints_binding_unique UNIQUE (org_id, resource_binding_id),
  CONSTRAINT app_sync_checkpoints_intent_identity_unique UNIQUE (org_id, id, resource_binding_id),
  CONSTRAINT app_sync_checkpoints_state_check CHECK (state IN ('active','paused')),
  CONSTRAINT app_sync_checkpoints_counters_check CHECK (
    generation >= 1 AND cursor_sequence >= 0
    AND retained_record_count BETWEEN 0 AND 100000
    AND retained_bytes BETWEEN 0 AND 1073741824
    AND cursor_bytes BETWEEN 0 AND 16384),
  CONSTRAINT app_sync_checkpoints_hmac_check CHECK (
    cursor_hmac_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND cursor_hmac ~ '^hmac-sha256:[a-f0-9]{64}$'),
  CONSTRAINT app_sync_checkpoints_cursor_envelope_check CHECK (
    (cursor_state = 'empty' AND cursor_bytes = 0
      AND cursor_envelope_version IS NULL AND cursor_algorithm IS NULL
      AND cursor_key_version IS NULL AND cursor_nonce_b64 IS NULL
      AND cursor_ciphertext_b64 IS NULL AND cursor_auth_tag_b64 IS NULL)
    OR (cursor_state = 'value' AND cursor_bytes BETWEEN 1 AND 16384
      AND cursor_envelope_version IS NOT NULL AND cursor_algorithm IS NOT NULL
      AND cursor_key_version IS NOT NULL AND cursor_nonce_b64 IS NOT NULL
      AND cursor_ciphertext_b64 IS NOT NULL AND cursor_auth_tag_b64 IS NOT NULL
      AND cursor_envelope_version = 'deft.secret.v1' AND cursor_algorithm = 'aes-256-gcm'
      AND cursor_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      AND cursor_nonce_b64 ~ '^[A-Za-z0-9+/]{16}$'
      AND cursor_auth_tag_b64 ~ '^[A-Za-z0-9+/]{22}==$'
      AND cursor_ciphertext_b64 ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
      AND octet_length(decode(cursor_ciphertext_b64, 'base64')) = cursor_bytes)),
  CONSTRAINT app_sync_checkpoints_application_check CHECK (
    (cursor_sequence = 0 AND last_applied_run_id IS NULL
      AND last_applied_page_digest IS NULL AND last_applied_at IS NULL)
    OR (cursor_sequence > 0 AND last_applied_run_id IS NOT NULL
      AND last_applied_page_digest IS NOT NULL
      AND last_applied_page_digest ~ '^sha256:[a-f0-9]{64}$'
      AND last_applied_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS app_sync_checkpoints_freshness_idx
  ON app_sync_checkpoints(org_id, state, fresh_until);

CREATE TABLE IF NOT EXISTS app_sync_intents (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  run_id text NOT NULL,
  resource_binding_id text NOT NULL,
  checkpoint_id text NOT NULL,
  app_installation_id text NOT NULL,
  app_version_id text NOT NULL,
  grant_snapshot_id text NOT NULL,
  provider_snapshot_id text NOT NULL,
  owner_user_id text NOT NULL,
  descriptor_digest text NOT NULL,
  generation integer NOT NULL,
  expected_cursor_sequence integer NOT NULL,
  expected_cursor_hmac_key_version text NOT NULL,
  expected_cursor_hmac text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_sync_intents_run_fk FOREIGN KEY
    (org_id, run_id, app_installation_id, app_version_id, grant_snapshot_id,
     resource_binding_id, provider_snapshot_id)
    REFERENCES app_runs
    (org_id, id, origin_app_installation_id, origin_app_version_id,
     origin_app_grant_snapshot_id, origin_resource_binding_id, provider_snapshot_id)
    ON DELETE RESTRICT,
  CONSTRAINT app_sync_intents_checkpoint_fk FOREIGN KEY
    (org_id, checkpoint_id, resource_binding_id)
    REFERENCES app_sync_checkpoints(org_id, id, resource_binding_id) ON DELETE RESTRICT,
  CONSTRAINT app_sync_intents_owner_fk FOREIGN KEY
    (org_id, resource_binding_id, owner_user_id)
    REFERENCES app_resource_bindings(org_id, id, owner_user_id) ON DELETE RESTRICT,
  CONSTRAINT app_sync_intents_descriptor_fk FOREIGN KEY
    (org_id, resource_binding_id, owner_user_id, descriptor_digest)
    REFERENCES app_resource_bindings(org_id, id, owner_user_id, descriptor_digest)
    ON DELETE RESTRICT,
  CONSTRAINT app_sync_intents_org_run_unique UNIQUE (org_id, run_id),
  CONSTRAINT app_sync_intents_checkpoint_run_unique UNIQUE
    (org_id, run_id, resource_binding_id, checkpoint_id),
  CONSTRAINT app_sync_intents_start_check CHECK (
    generation >= 1 AND expected_cursor_sequence >= 0
    AND expected_cursor_hmac_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND expected_cursor_hmac ~ '^hmac-sha256:[a-f0-9]{64}$'
    AND descriptor_digest ~ '^sha256:[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS app_sync_intents_binding_idx
  ON app_sync_intents(org_id, resource_binding_id, created_at);
ALTER TABLE app_sync_checkpoints DROP CONSTRAINT IF EXISTS app_sync_checkpoints_last_intent_fk;
ALTER TABLE app_sync_checkpoints ADD CONSTRAINT app_sync_checkpoints_last_intent_fk FOREIGN KEY
  (org_id, last_applied_run_id, resource_binding_id, id)
  REFERENCES app_sync_intents(org_id, run_id, resource_binding_id, checkpoint_id)
  ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS app_resource_projections (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  resource_binding_id text NOT NULL,
  checkpoint_id text NOT NULL,
  generation integer NOT NULL,
  resource_id_hmac_key_version text NOT NULL,
  resource_id_hmac text NOT NULL,
  provider_id_envelope_version text NOT NULL,
  provider_id_algorithm text NOT NULL,
  provider_id_key_version text NOT NULL,
  provider_id_nonce_b64 text NOT NULL,
  provider_id_ciphertext_b64 text NOT NULL,
  provider_id_auth_tag_b64 text NOT NULL,
  provider_id_bytes integer NOT NULL,
  body_envelope_version text,
  body_algorithm text,
  body_key_version text,
  body_nonce_b64 text,
  body_ciphertext_b64 text,
  body_auth_tag_b64 text,
  body_bytes integer NOT NULL DEFAULT 0,
  state text NOT NULL,
  applied_sequence integer NOT NULL,
  first_seen_at timestamp NOT NULL,
  last_seen_at timestamp NOT NULL,
  source_updated_at timestamp,
  fresh_until timestamp,
  tombstoned_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_resource_projections_checkpoint_fk FOREIGN KEY
    (org_id, checkpoint_id, resource_binding_id)
    REFERENCES app_sync_checkpoints(org_id, id, resource_binding_id) ON DELETE RESTRICT,
  CONSTRAINT app_resource_projections_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT app_resource_projections_locator_unique UNIQUE
    (org_id, checkpoint_id, resource_id_hmac_key_version, resource_id_hmac),
  CONSTRAINT app_resource_projections_lineage_check CHECK (
    generation >= 1 AND applied_sequence >= 1 AND first_seen_at <= last_seen_at
    AND resource_id_hmac_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND resource_id_hmac ~ '^hmac-sha256:[a-f0-9]{64}$'),
  CONSTRAINT app_resource_projections_provider_envelope_check CHECK (
    provider_id_envelope_version = 'deft.secret.v1'
    AND provider_id_algorithm = 'aes-256-gcm'
    AND provider_id_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND provider_id_nonce_b64 ~ '^[A-Za-z0-9+/]{16}$'
    AND provider_id_auth_tag_b64 ~ '^[A-Za-z0-9+/]{22}==$'
    AND provider_id_ciphertext_b64 ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
    AND provider_id_bytes BETWEEN 1 AND 512
    AND octet_length(decode(provider_id_ciphertext_b64, 'base64')) = provider_id_bytes),
  CONSTRAINT app_resource_projections_body_check CHECK (
    (state = 'tombstone' AND tombstoned_at IS NOT NULL AND body_bytes = 0
      AND body_envelope_version IS NULL AND body_algorithm IS NULL
      AND body_key_version IS NULL AND body_nonce_b64 IS NULL
      AND body_ciphertext_b64 IS NULL AND body_auth_tag_b64 IS NULL)
    OR (state = 'live' AND tombstoned_at IS NULL
      AND body_envelope_version IS NOT NULL AND body_algorithm IS NOT NULL
      AND body_key_version IS NOT NULL AND body_nonce_b64 IS NOT NULL
      AND body_ciphertext_b64 IS NOT NULL AND body_auth_tag_b64 IS NOT NULL
      AND body_envelope_version = 'deft.secret.v1'
      AND body_algorithm = 'aes-256-gcm'
      AND body_key_version = provider_id_key_version
      AND body_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      AND body_nonce_b64 ~ '^[A-Za-z0-9+/]{16}$'
      AND body_auth_tag_b64 ~ '^[A-Za-z0-9+/]{22}==$'
      AND body_ciphertext_b64 ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
      AND body_bytes BETWEEN 1 AND 524288
      AND octet_length(decode(body_ciphertext_b64, 'base64')) = body_bytes))
);
CREATE INDEX IF NOT EXISTS app_resource_projections_binding_state_idx
  ON app_resource_projections(org_id, resource_binding_id, state, fresh_until);

-- Host review is monotonic and an old reviewed descriptor never changes in place.
CREATE OR REPLACE FUNCTION enforce_app_resource_binding() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APP_RESOURCE_BINDING_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'disabled' OR NEW.reviewed_by_user_id IS NOT NULL
      OR NEW.reviewed_at IS NOT NULL OR NEW.consent_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'APP_RESOURCE_BINDING_REVIEW_REQUIRED' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.org_id, NEW.app_installation_id, NEW.app_version_id, NEW.grant_snapshot_id,
        NEW.grant_snapshot_kind, NEW.runtime_registration_id, NEW.registration_contract_version,
        NEW.provider_kind, NEW.provider_instance_id, NEW.provider_snapshot_id,
        NEW.resource_key, NEW.resource_family, NEW.operation_name, NEW.interface_identity,
        NEW.reviewed_descriptor, NEW.descriptor_digest, NEW.owner_user_id, NEW.owner_scope,
        NEW.risk_class, NEW.review_requirement, NEW.review_scope, NEW.retry_class,
        NEW.retention_class, NEW.max_records_per_page, NEW.max_page_bytes,
        NEW.max_retained_records, NEW.max_retained_bytes, NEW.min_interval_seconds,
        NEW.created_at) IS DISTINCT FROM
       (OLD.id, OLD.org_id, OLD.app_installation_id, OLD.app_version_id, OLD.grant_snapshot_id,
        OLD.grant_snapshot_kind, OLD.runtime_registration_id, OLD.registration_contract_version,
        OLD.provider_kind, OLD.provider_instance_id, OLD.provider_snapshot_id,
        OLD.resource_key, OLD.resource_family, OLD.operation_name, OLD.interface_identity,
        OLD.reviewed_descriptor, OLD.descriptor_digest, OLD.owner_user_id, OLD.owner_scope,
        OLD.risk_class, OLD.review_requirement, OLD.review_scope, OLD.retry_class,
        OLD.retention_class, OLD.max_records_per_page, OLD.max_page_bytes,
        OLD.max_retained_records, OLD.max_retained_bytes, OLD.min_interval_seconds,
        OLD.created_at) THEN
      RAISE EXCEPTION 'APP_RESOURCE_BINDING_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF OLD.state = 'disabled' AND NEW.state = 'active' THEN
      IF OLD.reviewed_by_user_id IS NOT NULL OR OLD.reviewed_at IS NOT NULL
        OR OLD.consent_expires_at IS NOT NULL OR NEW.reviewed_by_user_id <> NEW.owner_user_id
        OR NEW.reviewed_at IS NULL OR NEW.consent_expires_at IS NULL
        OR NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = NEW.org_id
          AND user_id = NEW.owner_user_id AND is_active) THEN
        RAISE EXCEPTION 'APP_RESOURCE_BINDING_REVIEW_INVALID' USING ERRCODE = '55000';
      END IF;
    ELSIF OLD.state = 'active' AND NEW.state = 'revoked' THEN
      IF (NEW.reviewed_by_user_id, NEW.reviewed_at, NEW.consent_expires_at)
        IS DISTINCT FROM (OLD.reviewed_by_user_id, OLD.reviewed_at, OLD.consent_expires_at) THEN
        RAISE EXCEPTION 'APP_RESOURCE_BINDING_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
    ELSIF NEW.state = OLD.state THEN
      IF (NEW.reviewed_by_user_id, NEW.reviewed_at, NEW.consent_expires_at)
        IS DISTINCT FROM (OLD.reviewed_by_user_id, OLD.reviewed_at, OLD.consent_expires_at) THEN
        RAISE EXCEPTION 'APP_RESOURCE_BINDING_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
    ELSE
      RAISE EXCEPTION 'APP_RESOURCE_BINDING_ILLEGAL_TRANSITION' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_resource_binding_guard_trigger ON app_resource_bindings;
CREATE TRIGGER app_resource_binding_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON app_resource_bindings
  FOR EACH ROW EXECUTE FUNCTION enforce_app_resource_binding();

CREATE OR REPLACE FUNCTION enforce_app_sync_intent_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APP_SYNC_INTENT_APPEND_ONLY' USING ERRCODE = '55000';
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_sync_intent_immutable_trigger ON app_sync_intents;
CREATE TRIGGER app_sync_intent_immutable_trigger BEFORE UPDATE OR DELETE ON app_sync_intents
  FOR EACH ROW EXECUTE FUNCTION enforce_app_sync_intent_immutable();

CREATE OR REPLACE FUNCTION enforce_app_sync_intent_start() RETURNS trigger AS $$
DECLARE current_checkpoint record; current_run record;
BEGIN
  SELECT state, origin_resource_binding_id INTO current_run FROM app_runs
    WHERE org_id = NEW.org_id AND id = NEW.run_id FOR SHARE;
  SELECT generation, cursor_sequence, cursor_hmac_key_version, cursor_hmac, state
    INTO current_checkpoint FROM app_sync_checkpoints
    WHERE org_id = NEW.org_id AND id = NEW.checkpoint_id
      AND resource_binding_id = NEW.resource_binding_id FOR SHARE;
  IF current_checkpoint IS NULL OR current_run IS NULL
    OR current_checkpoint.state <> 'active'
    OR current_run.state <> 'pending'
    OR current_run.origin_resource_binding_id <> NEW.resource_binding_id
    OR (current_checkpoint.generation, current_checkpoint.cursor_sequence,
        current_checkpoint.cursor_hmac_key_version, current_checkpoint.cursor_hmac)
      IS DISTINCT FROM
       (NEW.generation, NEW.expected_cursor_sequence,
        NEW.expected_cursor_hmac_key_version, NEW.expected_cursor_hmac) THEN
    RAISE EXCEPTION 'APP_SYNC_INTENT_START_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_sync_intent_start_trigger ON app_sync_intents;
CREATE TRIGGER app_sync_intent_start_trigger BEFORE INSERT ON app_sync_intents
  FOR EACH ROW EXECUTE FUNCTION enforce_app_sync_intent_start();

-- Stored capacity is decoded ciphertext bytes, including encrypted provider
-- identifiers retained on tombstones, plus the current encrypted cursor.
-- It intentionally excludes base64/JSON/index overhead. Binding-specific
-- ceilings are enforced here; SQL CHECKs alone cannot compare parent rows.
CREATE OR REPLACE FUNCTION enforce_app_sync_checkpoint() RETURNS trigger AS $$
DECLARE binding_limit record; matching_intent boolean;
BEGIN
  SELECT max_retained_records, max_retained_bytes INTO binding_limit
    FROM app_resource_bindings
    WHERE org_id = NEW.org_id AND id = NEW.resource_binding_id;
  IF NOT FOUND OR NEW.retained_record_count > binding_limit.max_retained_records
    OR NEW.retained_bytes + NEW.cursor_bytes > binding_limit.max_retained_bytes THEN
    RAISE EXCEPTION 'APP_SYNC_CAPACITY_EXCEEDED' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.retained_record_count <> 0 OR NEW.retained_bytes <> 0
      OR NEW.generation <> 1 OR NEW.cursor_sequence <> 0 THEN
      RAISE EXCEPTION 'APP_SYNC_CHECKPOINT_INITIAL_STATE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.org_id, NEW.resource_binding_id, NEW.created_at) IS DISTINCT FROM
     (OLD.id, OLD.org_id, OLD.resource_binding_id, OLD.created_at) THEN
    RAISE EXCEPTION 'APP_SYNC_CHECKPOINT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  -- A generation reset requires its own reviewed host transition. This slice
  -- only permits page settlement in generation one.
  IF NEW.generation <> OLD.generation THEN
    RAISE EXCEPTION 'APP_SYNC_GENERATION_RESET_UNSUPPORTED' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'paused' AND NEW.state <> 'paused' THEN
    RAISE EXCEPTION 'APP_SYNC_CHECKPOINT_RESUME_UNSUPPORTED' USING ERRCODE = '55000';
  END IF;
  IF (NEW.retained_record_count, NEW.retained_bytes) IS DISTINCT FROM
     (OLD.retained_record_count, OLD.retained_bytes)
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'APP_SYNC_COUNTER_DIRECT_WRITE' USING ERRCODE = '55000';
  END IF;
  IF NEW.cursor_sequence < OLD.cursor_sequence
    OR NEW.cursor_sequence > OLD.cursor_sequence + 1 THEN
    RAISE EXCEPTION 'APP_SYNC_CURSOR_SEQUENCE' USING ERRCODE = '55000';
  END IF;
  IF NEW.cursor_sequence = OLD.cursor_sequence
    AND (NEW.cursor_hmac_key_version, NEW.cursor_hmac, NEW.cursor_state,
         NEW.cursor_envelope_version, NEW.cursor_algorithm, NEW.cursor_key_version,
         NEW.cursor_nonce_b64, NEW.cursor_ciphertext_b64, NEW.cursor_auth_tag_b64,
         NEW.cursor_bytes, NEW.last_applied_run_id, NEW.last_applied_page_digest,
         NEW.last_applied_at, NEW.last_checked_at, NEW.fresh_until) IS DISTINCT FROM
        (OLD.cursor_hmac_key_version, OLD.cursor_hmac, OLD.cursor_state,
         OLD.cursor_envelope_version, OLD.cursor_algorithm, OLD.cursor_key_version,
         OLD.cursor_nonce_b64, OLD.cursor_ciphertext_b64, OLD.cursor_auth_tag_b64,
         OLD.cursor_bytes, OLD.last_applied_run_id, OLD.last_applied_page_digest,
         OLD.last_applied_at, OLD.last_checked_at, OLD.fresh_until) THEN
    RAISE EXCEPTION 'APP_SYNC_CURSOR_CAS_REQUIRED' USING ERRCODE = '55000';
  END IF;
  IF NEW.cursor_sequence = OLD.cursor_sequence + 1 THEN
    IF OLD.state <> 'active' OR NEW.state <> 'active'
      OR NEW.last_applied_run_id IS NOT DISTINCT FROM OLD.last_applied_run_id
      OR NEW.last_checked_at IS NULL
      OR (NEW.fresh_until IS NOT NULL AND NEW.fresh_until < NEW.last_checked_at) THEN
      RAISE EXCEPTION 'APP_SYNC_CURSOR_SETTLEMENT_INVALID' USING ERRCODE = '55000';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM app_sync_intents i
      WHERE i.org_id = OLD.org_id AND i.run_id = NEW.last_applied_run_id
        AND i.resource_binding_id = OLD.resource_binding_id AND i.checkpoint_id = OLD.id
        AND i.generation = OLD.generation
        AND i.expected_cursor_sequence = OLD.cursor_sequence
        AND i.expected_cursor_hmac_key_version = OLD.cursor_hmac_key_version
        AND i.expected_cursor_hmac = OLD.cursor_hmac
    ) INTO matching_intent;
    IF NOT matching_intent THEN
      RAISE EXCEPTION 'APP_SYNC_CURSOR_INTENT_MISMATCH' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_sync_checkpoint_guard_trigger ON app_sync_checkpoints;
CREATE TRIGGER app_sync_checkpoint_guard_trigger
  BEFORE INSERT OR UPDATE ON app_sync_checkpoints
  FOR EACH ROW EXECUTE FUNCTION enforce_app_sync_checkpoint();

CREATE OR REPLACE FUNCTION enforce_app_resource_projection() RETURNS trigger AS $$
DECLARE cp record; rekey_mode boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APP_RESOURCE_PROJECTION_RETAINED' USING ERRCODE = '55000';
  END IF;
  -- All writers must acquire the checkpoint before projection rows. This
  -- trigger acquires it for direct SQL too, and page settlement holds it first.
  SELECT generation, cursor_sequence, state INTO cp FROM app_sync_checkpoints
    WHERE org_id = NEW.org_id AND id = NEW.checkpoint_id
      AND resource_binding_id = NEW.resource_binding_id FOR UPDATE;
  IF cp IS NULL OR cp.state <> 'active' THEN
    RAISE EXCEPTION 'APP_RESOURCE_PROJECTION_CHECKPOINT_INVALID' USING ERRCODE = '55000';
  END IF;
  rekey_mode := coalesce(current_setting('deft.app_resource_sync_rekey', true) = 'on', false);
  IF TG_OP = 'INSERT' THEN
    IF NEW.generation <> cp.generation OR NEW.applied_sequence <> cp.cursor_sequence + 1 THEN
      RAISE EXCEPTION 'APP_RESOURCE_PROJECTION_SEQUENCE' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.org_id, NEW.resource_binding_id, NEW.checkpoint_id, NEW.created_at,
        NEW.first_seen_at) IS DISTINCT FROM
       (OLD.id, OLD.org_id, OLD.resource_binding_id, OLD.checkpoint_id, OLD.created_at,
        OLD.first_seen_at) THEN
      RAISE EXCEPTION 'APP_RESOURCE_PROJECTION_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF NEW.generation <> cp.generation OR NEW.generation < OLD.generation THEN
      RAISE EXCEPTION 'APP_RESOURCE_PROJECTION_STALE' USING ERRCODE = '55000';
    END IF;
    IF NEW.applied_sequence = OLD.applied_sequence THEN
      -- Rekey is a separate host-verified transaction under checkpoint lock.
      -- The setting is an internal transaction marker, not a provider
      -- credential; host code must decrypt and compare the old/new provider
      -- ID and record plaintext. Both AES envelopes may be rewrapped.
      IF NOT rekey_mode
        OR (NEW.generation, NEW.state, NEW.last_seen_at,
            NEW.source_updated_at, NEW.fresh_until, NEW.tombstoned_at)
          IS DISTINCT FROM
           (OLD.generation, OLD.state, OLD.last_seen_at,
            OLD.source_updated_at, OLD.fresh_until, OLD.tombstoned_at) THEN
        RAISE EXCEPTION 'APP_RESOURCE_PROJECTION_REKEY_REQUIRED' USING ERRCODE = '55000';
      END IF;
    ELSIF NEW.applied_sequence = cp.cursor_sequence + 1
      AND NEW.applied_sequence > OLD.applied_sequence THEN
      IF (NEW.resource_id_hmac_key_version, NEW.resource_id_hmac,
          NEW.provider_id_envelope_version, NEW.provider_id_algorithm,
          NEW.provider_id_key_version, NEW.provider_id_nonce_b64,
          NEW.provider_id_ciphertext_b64, NEW.provider_id_auth_tag_b64,
          NEW.provider_id_bytes) IS DISTINCT FROM
         (OLD.resource_id_hmac_key_version, OLD.resource_id_hmac,
          OLD.provider_id_envelope_version, OLD.provider_id_algorithm,
          OLD.provider_id_key_version, OLD.provider_id_nonce_b64,
          OLD.provider_id_ciphertext_b64, OLD.provider_id_auth_tag_b64,
          OLD.provider_id_bytes) AND NOT rekey_mode THEN
        RAISE EXCEPTION 'APP_RESOURCE_PROJECTION_IDENTITY_REKEY_REQUIRED' USING ERRCODE = '55000';
      END IF;
    ELSE
      RAISE EXCEPTION 'APP_RESOURCE_PROJECTION_SEQUENCE' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_resource_projection_guard_trigger ON app_resource_projections;
CREATE TRIGGER app_resource_projection_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON app_resource_projections
  FOR EACH ROW EXECUTE FUNCTION enforce_app_resource_projection();

CREATE OR REPLACE FUNCTION account_app_resource_projection() RETURNS trigger AS $$
DECLARE count_delta integer; bytes_delta integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    count_delta := 1;
    bytes_delta := NEW.provider_id_bytes + NEW.body_bytes;
  ELSE
    count_delta := 0;
    bytes_delta := NEW.provider_id_bytes + NEW.body_bytes
      - OLD.provider_id_bytes - OLD.body_bytes;
  END IF;
  UPDATE app_sync_checkpoints AS cp SET
    retained_record_count = cp.retained_record_count + count_delta,
    retained_bytes = cp.retained_bytes + bytes_delta,
    updated_at = now()
  WHERE cp.org_id = NEW.org_id AND cp.id = NEW.checkpoint_id
    AND cp.resource_binding_id = NEW.resource_binding_id
    AND cp.generation = NEW.generation
    AND cp.retained_record_count + count_delta >= 0
    AND cp.retained_bytes + bytes_delta >= 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'APP_RESOURCE_PROJECTION_CHECKPOINT_STALE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_resource_projection_capacity_trigger ON app_resource_projections;
CREATE TRIGGER app_resource_projection_capacity_trigger
  AFTER INSERT OR UPDATE ON app_resource_projections
  FOR EACH ROW EXECUTE FUNCTION account_app_resource_projection();
