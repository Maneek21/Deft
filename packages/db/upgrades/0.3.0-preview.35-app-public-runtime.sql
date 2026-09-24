-- Additive public Runtime lineage. Existing unsupported ingress receipts remain
-- terminal and retain their original shape; this migration does not replay them.
ALTER TABLE app_public_endpoints
  ADD COLUMN IF NOT EXISTS public_action_key text,
  ADD COLUMN IF NOT EXISTS runtime_binding_id text,
  ADD COLUMN IF NOT EXISTS approver_user_id text,
  ADD COLUMN IF NOT EXISTS input_mapping jsonb,
  ADD COLUMN IF NOT EXISTS mapping_digest text;

ALTER TABLE app_public_endpoints
  DROP CONSTRAINT IF EXISTS app_public_endpoints_runtime_binding_fk,
  DROP CONSTRAINT IF EXISTS app_public_endpoints_approver_fk,
  DROP CONSTRAINT IF EXISTS app_public_endpoints_action_shape_check;
ALTER TABLE app_public_endpoints
  ADD CONSTRAINT app_public_endpoints_runtime_binding_fk
    FOREIGN KEY (org_id, runtime_binding_id)
    REFERENCES app_runtime_bindings(org_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT app_public_endpoints_approver_fk
    FOREIGN KEY (org_id, approver_user_id)
    REFERENCES org_members(org_id, user_id) ON DELETE RESTRICT,
  ADD CONSTRAINT app_public_endpoints_action_shape_check CHECK (
    (public_action_key IS NULL AND runtime_binding_id IS NULL
      AND approver_user_id IS NULL AND input_mapping IS NULL AND mapping_digest IS NULL)
    OR (public_action_key IS NOT NULL
      AND public_action_key ~ '^[a-z][a-z0-9_]{0,47}$'
      AND runtime_binding_id IS NOT NULL AND approver_user_id IS NOT NULL
      AND input_mapping IS NOT NULL AND jsonb_typeof(input_mapping) = 'object'
      AND octet_length(input_mapping::text) <= 4096
      AND mapping_digest IS NOT NULL AND mapping_digest ~ '^sha256:[a-f0-9]{64}$')
  );

ALTER TABLE app_public_ingress
  DROP CONSTRAINT IF EXISTS app_public_ingress_follow_up_check;
ALTER TABLE app_public_ingress
  ADD CONSTRAINT app_public_ingress_follow_up_check CHECK (
    (follow_up_state = 'pending' AND follow_up_code IS NULL
      AND handled_at IS NULL)
    OR (follow_up_state = 'unsupported' AND follow_up_code IS NOT NULL
      AND follow_up_code IN ('APP_HANDLER_UNAVAILABLE', 'ENDPOINT_REVOKED')
      AND handled_at IS NOT NULL)
    OR (follow_up_state = 'run_created' AND follow_up_code IS NULL
      AND handled_at IS NOT NULL)
  );

ALTER TABLE app_runs
  ADD COLUMN IF NOT EXISTS origin_public_endpoint_id text,
  ADD COLUMN IF NOT EXISTS origin_public_ingress_id text;
ALTER TABLE app_runs
  DROP CONSTRAINT IF EXISTS app_runs_public_ingress_fk;
ALTER TABLE app_runs
  ADD CONSTRAINT app_runs_public_ingress_fk
    FOREIGN KEY (org_id, origin_public_endpoint_id, origin_public_ingress_id)
    REFERENCES app_public_ingress(org_id, endpoint_id, id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS app_runs_public_ingress_unique
  ON app_runs(org_id, origin_public_endpoint_id, origin_public_ingress_id)
  WHERE origin_public_ingress_id IS NOT NULL;
ALTER TABLE app_runs
  DROP CONSTRAINT IF EXISTS app_runs_app_origin_coherence_check;
ALTER TABLE app_runs
  ADD CONSTRAINT app_runs_app_origin_coherence_check CHECK (
    (
      origin_kind = 'app' AND origin_app_installation_id IS NOT NULL
      AND origin_app_version_id IS NOT NULL AND provider_kind = 'mcp'
      AND origin_app_binding_key IS NOT NULL AND origin_runtime_binding_id IS NULL
      AND origin_public_endpoint_id IS NULL AND origin_public_ingress_id IS NULL
      AND origin_app_grant_snapshot_id IS NOT NULL
      AND risk_class = 'external_write' AND review_requirement = 'always'
      AND retry_class = 'idempotent_with_key' AND retention_class = 'standard'
      AND ((review_scope = 'per_invocation'
        AND origin_app_automation_definition_id IS NULL
        AND origin_app_automation_fire_id IS NULL
        AND initiating_actor_type <> 'automation' AND initiating_actor_type <> 'app_public'
        AND execution_actor_type <> 'automation')
        OR (review_scope = 'approved_automation_definition'
        AND origin_app_automation_definition_id IS NOT NULL
        AND origin_app_automation_fire_id IS NOT NULL
        AND initiating_actor_type = 'human' AND execution_actor_type = 'automation'
        AND execution_actor_id = origin_app_automation_definition_id))
    ) OR (
      origin_kind = 'app' AND provider_kind = 'app_runtime'
      AND origin_app_installation_id IS NOT NULL AND origin_app_version_id IS NOT NULL
      AND origin_app_grant_snapshot_id IS NOT NULL AND origin_app_binding_key IS NULL
      AND origin_runtime_binding_id IS NOT NULL
      AND origin_app_automation_definition_id IS NULL AND origin_app_automation_fire_id IS NULL
      AND ((initiating_actor_type = 'app_public' AND execution_actor_type = 'human'
        AND initiating_actor_id = origin_public_ingress_id
        AND origin_public_endpoint_id IS NOT NULL AND origin_public_ingress_id IS NOT NULL)
        OR (initiating_actor_type <> 'automation' AND initiating_actor_type <> 'app_public'
          AND execution_actor_type <> 'automation'
          AND origin_public_endpoint_id IS NULL AND origin_public_ingress_id IS NULL))
      AND review_scope = 'per_invocation'
    ) OR (
      origin_kind <> 'app' AND provider_kind = 'mcp'
      AND origin_app_installation_id IS NULL AND origin_app_version_id IS NULL
      AND origin_app_binding_key IS NULL AND origin_runtime_binding_id IS NULL
      AND origin_app_grant_snapshot_id IS NULL
      AND origin_app_automation_definition_id IS NULL AND origin_app_automation_fire_id IS NULL
      AND origin_public_endpoint_id IS NULL AND origin_public_ingress_id IS NULL
      AND initiating_actor_type <> 'automation' AND initiating_actor_type <> 'app_public'
      AND execution_actor_type <> 'automation'
    )
  );
ALTER TABLE app_runs DROP CONSTRAINT IF EXISTS app_runs_actor_type_check;
ALTER TABLE app_runs ADD CONSTRAINT app_runs_actor_type_check CHECK (
  initiating_actor_type IN ('human', 'agent_employee', 'system', 'automation', 'app_public')
  AND execution_actor_type IN ('human', 'agent_employee', 'system', 'automation')
);
ALTER TABLE app_run_events DROP CONSTRAINT IF EXISTS app_run_events_actor_shape_check;
ALTER TABLE app_run_events ADD CONSTRAINT app_run_events_actor_shape_check CHECK (
  (actor_type IS NULL AND actor_id IS NULL)
  OR (actor_type IN ('human', 'agent_employee', 'system', 'automation', 'app_public')
    AND actor_id IS NOT NULL)
);

-- A public mapping may only be revised while disabled, with a new reviewed
-- epoch. Legacy unmapped endpoints retain their original state transitions.
CREATE OR REPLACE FUNCTION enforce_app_public_endpoint_mapping() RETURNS trigger AS $$
BEGIN
  IF (NEW.public_action_key, NEW.runtime_binding_id, NEW.approver_user_id,
      NEW.input_mapping, NEW.mapping_digest) IS DISTINCT FROM
     (OLD.public_action_key, OLD.runtime_binding_id, OLD.approver_user_id,
      OLD.input_mapping, OLD.mapping_digest) THEN
    IF OLD.state <> 'disabled' OR NEW.state <> 'disabled'
      OR NEW.endpoint_epoch <> OLD.endpoint_epoch + 1
      OR NEW.review_digest = OLD.review_digest
      OR NEW.reviewed_at <= OLD.reviewed_at THEN
      RAISE EXCEPTION 'APP_PUBLIC_MAPPING_REVIEW_REQUIRED' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF (OLD.public_action_key IS NOT NULL OR NEW.public_action_key IS NOT NULL)
    AND NEW.state IS DISTINCT FROM OLD.state
    AND NEW.endpoint_epoch <> OLD.endpoint_epoch + 1 THEN
    RAISE EXCEPTION 'APP_PUBLIC_ENDPOINT_EPOCH_REQUIRED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_public_endpoint_mapping_trigger ON app_public_endpoints;
CREATE TRIGGER app_public_endpoint_mapping_trigger BEFORE UPDATE ON app_public_endpoints
  FOR EACH ROW EXECUTE FUNCTION enforce_app_public_endpoint_mapping();

-- Existing Run transition machinery remains unchanged; only the two new
-- public origin pins are immutable once a Run has been inserted.
CREATE OR REPLACE FUNCTION enforce_app_run_public_identity() RETURNS trigger AS $$
BEGIN
  IF (NEW.origin_public_endpoint_id, NEW.origin_public_ingress_id) IS DISTINCT FROM
     (OLD.origin_public_endpoint_id, OLD.origin_public_ingress_id) THEN
    RAISE EXCEPTION 'APP_RUN_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_run_public_identity_trigger ON app_runs;
CREATE TRIGGER app_run_public_identity_trigger BEFORE UPDATE ON app_runs
  FOR EACH ROW EXECUTE FUNCTION enforce_app_run_public_identity();
