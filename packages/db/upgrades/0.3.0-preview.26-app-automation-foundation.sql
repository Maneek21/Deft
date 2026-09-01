-- Add the dormant Track A automation definition/fire foundation.
-- This migration creates no scanner, queue job, worker route, or execution
-- consumer. Protocol v0/v1 bindings and their forbidden automation policy are
-- preserved; approved automation authority is a separate host-owned contract.

ALTER TABLE app_versions
  DROP CONSTRAINT IF EXISTS app_versions_protocol_supported_check;
ALTER TABLE app_versions
  ADD CONSTRAINT app_versions_protocol_supported_check
  CHECK (protocol_version IN ('0', '1', '2'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'app_action_bindings_automation_identity_unique'
  ) THEN
    ALTER TABLE app_action_bindings
      ADD CONSTRAINT app_action_bindings_automation_identity_unique
      UNIQUE (
        org_id, app_installation_id, app_version_id, grant_snapshot_id,
        action_key, id
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS app_automation_definitions (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  app_installation_id text NOT NULL,
  app_version_id text NOT NULL,
  app_manifest_digest text NOT NULL,
  app_package_digest text NOT NULL,
  grant_snapshot_id text NOT NULL,
  grant_snapshot_kind text NOT NULL DEFAULT 'effective',
  grant_snapshot_digest text NOT NULL,
  action_binding_id text NOT NULL,
  action_key text NOT NULL,
  interface_identity text NOT NULL,
  automation_request_key text NOT NULL,
  automation_request_digest text NOT NULL,
  installation_lifecycle_epoch integer NOT NULL,
  installation_grant_epoch integer NOT NULL,
  provider_kind text NOT NULL,
  mcp_connection_id text NOT NULL,
  provider_snapshot_id text NOT NULL,
  provider_snapshot_digest text NOT NULL,
  operation_name text NOT NULL,
  operation_schema_digest text NOT NULL,
  binding_digest text NOT NULL,
  connector_authorization_version integer NOT NULL,
  placement_resource_ref jsonb NOT NULL,
  placement_resource_revision text NOT NULL,
  placement_content_digest text NOT NULL,
  selected_resource_ref jsonb NOT NULL,
  selected_resource_revision text NOT NULL,
  selected_content_digest text NOT NULL,
  selected_relation_input_key text NOT NULL,
  selected_relation_key text NOT NULL,
  selected_relation_revision integer NOT NULL,
  schedule_kind text NOT NULL,
  local_time text NOT NULL,
  timezone text NOT NULL,
  misfire_policy text NOT NULL,
  catch_up_window_minutes integer NOT NULL DEFAULT 15,
  max_actions_per_fire integer NOT NULL DEFAULT 1,
  max_org_runs_per_utc_day integer NOT NULL DEFAULT 100,
  max_pending_org_fires integer NOT NULL DEFAULT 25,
  valid_from timestamp NOT NULL,
  valid_until timestamp NOT NULL,
  policy_version text NOT NULL,
  policy_digest text NOT NULL,
  authorization_vector jsonb NOT NULL,
  authorization_digest text NOT NULL,
  canonical_definition jsonb NOT NULL,
  definition_digest text NOT NULL,
  state text NOT NULL DEFAULT 'active',
  definition_epoch integer NOT NULL DEFAULT 1,
  created_by_user_id text NOT NULL,
  approved_by_user_id text NOT NULL,
  approver_authorization_version integer NOT NULL,
  approved_at timestamp NOT NULL,
  state_changed_at timestamp NOT NULL DEFAULT now(),
  revoked_at timestamp,
  expired_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_automation_definitions_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT app_automation_definitions_app_installation_fk
    FOREIGN KEY (org_id, app_installation_id)
    REFERENCES app_installations(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_automation_definitions_app_version_fk
    FOREIGN KEY (org_id, app_installation_id, app_version_id)
    REFERENCES app_versions(org_id, installation_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_automation_definitions_grant_snapshot_fk
    FOREIGN KEY (
      org_id, app_installation_id, app_version_id,
      grant_snapshot_id, grant_snapshot_kind
    ) REFERENCES app_grant_snapshots(
      org_id, app_installation_id, app_version_id, id, snapshot_kind
    ) ON DELETE RESTRICT,
  CONSTRAINT app_automation_definitions_action_binding_fk
    FOREIGN KEY (
      org_id, app_installation_id, app_version_id, grant_snapshot_id,
      action_key, action_binding_id
    ) REFERENCES app_action_bindings(
      org_id, app_installation_id, app_version_id, grant_snapshot_id,
      action_key, id
    ) ON DELETE RESTRICT,
  CONSTRAINT app_automation_definitions_key_check CHECK (
    action_key ~ '^[a-z][a-z0-9_]{0,47}$'
    AND automation_request_key ~ '^[a-z][a-z0-9_]{0,47}$'
    AND selected_relation_input_key ~ '^[a-z][a-z0-9_]{0,47}$'
    AND selected_relation_key ~ '^[a-z][a-z0-9_]{0,47}$'
    AND action_key !~ '^(deft|core|system)(_|$)'
    AND automation_request_key !~ '^(deft|core|system)(_|$)'
    AND selected_relation_input_key !~ '^(deft|core|system)(_|$)'
    AND selected_relation_key !~ '^(deft|core|system)(_|$)'
  ),
  CONSTRAINT app_automation_definitions_provider_check CHECK (provider_kind = 'mcp'),
  CONSTRAINT app_automation_definitions_grant_kind_check CHECK (grant_snapshot_kind = 'effective'),
  CONSTRAINT app_automation_definitions_schedule_check CHECK (
    schedule_kind = 'daily_local_time'
    AND local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND octet_length(timezone) BETWEEN 1 AND 128
    AND timezone !~ '[[:cntrl:]]'
    AND misfire_policy = 'catch_up_within_15m'
    AND catch_up_window_minutes = 15
  ),
  CONSTRAINT app_automation_definitions_budget_check CHECK (
    max_actions_per_fire = 1
    AND max_org_runs_per_utc_day BETWEEN 1 AND 100
    AND max_pending_org_fires BETWEEN 1 AND 25
  ),
  CONSTRAINT app_automation_definitions_validity_check CHECK (
    valid_from = approved_at
    AND valid_until > valid_from
    AND valid_until <= approved_at + interval '30 days'
  ),
  CONSTRAINT app_automation_definitions_epoch_check CHECK (definition_epoch >= 1),
  CONSTRAINT app_automation_definitions_state_check
    CHECK (state IN ('active', 'paused', 'revoked', 'expired')),
  CONSTRAINT app_automation_definitions_approval_shape_check CHECK (
    (
      state IN ('active', 'paused')
      AND definition_epoch >= 1
      AND revoked_at IS NULL
      AND expired_at IS NULL
    ) OR (
      state = 'revoked'
      AND definition_epoch >= 2
      AND revoked_at IS NOT NULL
      AND expired_at IS NULL
    ) OR (
      state = 'expired'
      AND definition_epoch >= 2
      AND revoked_at IS NULL
      AND expired_at IS NOT NULL
    )
  ),
  CONSTRAINT app_automation_definitions_digest_check CHECK (
    automation_request_digest ~ '^sha256:[a-f0-9]{64}$'
    AND app_manifest_digest ~ '^sha256:[a-f0-9]{64}$'
    AND app_package_digest ~ '^sha256:[a-f0-9]{64}$'
    AND grant_snapshot_digest ~ '^sha256:[a-f0-9]{64}$'
    AND operation_schema_digest ~ '^sha256:[a-f0-9]{64}$'
    AND binding_digest ~ '^sha256:[a-f0-9]{64}$'
    AND provider_snapshot_digest ~ '^sha256:[a-f0-9]{64}$'
    AND placement_content_digest ~ '^sha256:[a-f0-9]{64}$'
    AND selected_content_digest ~ '^sha256:[a-f0-9]{64}$'
    AND policy_digest ~ '^sha256:[a-f0-9]{64}$'
    AND authorization_digest ~ '^sha256:[a-f0-9]{64}$'
    AND definition_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  CONSTRAINT app_automation_definitions_resource_revision_check CHECK (
    octet_length(placement_resource_revision) BETWEEN 1 AND 128
    AND placement_resource_revision !~ '[[:cntrl:]]'
    AND octet_length(selected_resource_revision) BETWEEN 1 AND 128
    AND selected_resource_revision !~ '[[:cntrl:]]'
  ),
  CONSTRAINT app_automation_definitions_policy_check CHECK (
    policy_version = '1'
    AND connector_authorization_version >= 1
    AND approver_authorization_version >= 1
    AND installation_lifecycle_epoch >= 0
    AND installation_grant_epoch >= 1
    AND selected_relation_revision >= 0
  ),
  CONSTRAINT app_automation_definitions_json_check CHECK (
    jsonb_typeof(placement_resource_ref) = 'object'
    AND jsonb_typeof(selected_resource_ref) = 'object'
    AND jsonb_typeof(authorization_vector) = 'object'
    AND jsonb_typeof(canonical_definition) = 'object'
    AND placement_resource_ref->>'schema_version' = 'deft.resource_ref.v1'
    AND placement_resource_ref#>>'{provider,kind}' = 'module'
    AND selected_resource_ref->>'schema_version' = 'deft.resource_ref.v1'
    AND selected_resource_ref#>>'{provider,kind}' = 'module'
  ),
  CONSTRAINT app_automation_definitions_json_size_check CHECK (
    octet_length(placement_resource_ref::text) <= 4096
    AND octet_length(selected_resource_ref::text) <= 4096
    AND octet_length(authorization_vector::text) <= 65536
    AND octet_length(canonical_definition::text) <= 131072
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS app_automation_definitions_digest_unique
  ON app_automation_definitions(org_id, definition_digest);
CREATE INDEX IF NOT EXISTS app_automation_definitions_app_request_idx
  ON app_automation_definitions(
    org_id, app_installation_id, app_version_id, automation_request_key
  );
CREATE INDEX IF NOT EXISTS app_automation_definitions_eligibility_idx
  ON app_automation_definitions(org_id, state, valid_until);

CREATE TABLE IF NOT EXISTS app_automation_fires (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  definition_id text NOT NULL,
  definition_epoch integer NOT NULL,
  logical_local_date text NOT NULL,
  local_time text NOT NULL,
  timezone text NOT NULL,
  resolved_at_utc timestamp,
  fire_identity text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  claim_owner text,
  claim_token text,
  claimed_at timestamp,
  lease_expires_at timestamp,
  app_run_id text,
  terminal_reason text,
  terminal_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_automation_fires_org_definition_id_unique
    UNIQUE (org_id, definition_id, id),
  CONSTRAINT app_automation_fires_definition_fk
    FOREIGN KEY (org_id, definition_id)
    REFERENCES app_automation_definitions(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_automation_fires_epoch_check CHECK (definition_epoch >= 1),
  CONSTRAINT app_automation_fires_occurrence_check CHECK (
    logical_local_date ~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])$'
    AND local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND octet_length(timezone) BETWEEN 1 AND 128
    AND timezone !~ '[[:cntrl:]]'
  ),
  CONSTRAINT app_automation_fires_identity_check
    CHECK (fire_identity ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT app_automation_fires_attempt_check CHECK (attempt_count BETWEEN 0 AND 3),
  CONSTRAINT app_automation_fires_state_check
    CHECK (state IN ('pending', 'claimed', 'run_created', 'skipped', 'dead_letter')),
  CONSTRAINT app_automation_fires_resolution_check CHECK (
    (
      state = 'skipped' AND terminal_reason = 'dst_gap' AND resolved_at_utc IS NULL
    ) OR (
      (state <> 'skipped' OR terminal_reason IS DISTINCT FROM 'dst_gap')
      AND resolved_at_utc IS NOT NULL
    )
  ),
  CONSTRAINT app_automation_fires_claim_shape_check CHECK (
    (
      state = 'pending'
      AND claim_owner IS NULL AND claim_token IS NULL
      AND claimed_at IS NULL AND lease_expires_at IS NULL
      AND app_run_id IS NULL AND terminal_reason IS NULL AND terminal_at IS NULL
    ) OR (
      state = 'claimed'
      AND attempt_count BETWEEN 1 AND 3
      AND claim_owner IS NOT NULL AND claim_token IS NOT NULL
      AND claimed_at IS NOT NULL AND lease_expires_at > claimed_at
      AND app_run_id IS NULL AND terminal_reason IS NULL AND terminal_at IS NULL
    ) OR (
      state = 'run_created'
      AND attempt_count BETWEEN 1 AND 3
      AND app_run_id IS NOT NULL
      AND terminal_reason = 'run_created' AND terminal_at IS NOT NULL
    ) OR (
      state = 'skipped'
      AND app_run_id IS NULL
      AND terminal_reason IN ('dst_gap', 'misfire_skipped', 'definition_ineligible')
      AND terminal_at IS NOT NULL
    ) OR (
      state = 'dead_letter'
      AND attempt_count = 3 AND app_run_id IS NULL
      AND terminal_reason = 'attempts_exhausted' AND terminal_at IS NOT NULL
    )
  ),
  CONSTRAINT app_automation_fires_claim_text_check CHECK (
    (claim_owner IS NULL OR (
      octet_length(claim_owner) BETWEEN 1 AND 128 AND claim_owner !~ '[[:cntrl:]]'
    ))
    AND (claim_token IS NULL OR (
      octet_length(claim_token) BETWEEN 1 AND 128 AND claim_token !~ '[[:cntrl:]]'
    ))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS app_automation_fires_identity_unique
  ON app_automation_fires(org_id, fire_identity);
CREATE UNIQUE INDEX IF NOT EXISTS app_automation_fires_occurrence_unique
  ON app_automation_fires(
    org_id, definition_id, definition_epoch, logical_local_date, local_time, timezone
  );
CREATE UNIQUE INDEX IF NOT EXISTS app_automation_fires_definition_day_unique
  ON app_automation_fires(org_id, definition_id, logical_local_date);
CREATE UNIQUE INDEX IF NOT EXISTS app_automation_fires_one_active_unique
  ON app_automation_fires(org_id, definition_id)
  WHERE state IN ('pending', 'claimed');
CREATE INDEX IF NOT EXISTS app_automation_fires_claim_idx
  ON app_automation_fires(state, resolved_at_utc, lease_expires_at);
CREATE INDEX IF NOT EXISTS app_automation_fires_org_state_idx
  ON app_automation_fires(org_id, state, created_at);

ALTER TABLE app_runs
  ADD COLUMN IF NOT EXISTS origin_app_automation_definition_id text,
  ADD COLUMN IF NOT EXISTS origin_app_automation_fire_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_runs_automation_lineage_unique'
  ) THEN
    ALTER TABLE app_runs ADD CONSTRAINT app_runs_automation_lineage_unique
      UNIQUE (
        org_id, origin_app_automation_definition_id,
        origin_app_automation_fire_id, id
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_runs_automation_definition_fk'
  ) THEN
    ALTER TABLE app_runs ADD CONSTRAINT app_runs_automation_definition_fk
      FOREIGN KEY (org_id, origin_app_automation_definition_id)
      REFERENCES app_automation_definitions(org_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_runs_automation_fire_fk'
  ) THEN
    ALTER TABLE app_runs ADD CONSTRAINT app_runs_automation_fire_fk
      FOREIGN KEY (
        org_id, origin_app_automation_definition_id, origin_app_automation_fire_id
      ) REFERENCES app_automation_fires(org_id, definition_id, id)
      ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_automation_fires_app_run_fk'
  ) THEN
    ALTER TABLE app_automation_fires ADD CONSTRAINT app_automation_fires_app_run_fk
      FOREIGN KEY (org_id, definition_id, id, app_run_id)
      REFERENCES app_runs(
        org_id, origin_app_automation_definition_id,
        origin_app_automation_fire_id, id
      ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS app_runs_automation_lineage_idx
  ON app_runs(
    org_id, origin_app_automation_definition_id, origin_app_automation_fire_id
  );
CREATE UNIQUE INDEX IF NOT EXISTS app_runs_automation_fire_unique
  ON app_runs(
    org_id, origin_app_automation_definition_id, origin_app_automation_fire_id
  ) WHERE origin_app_automation_fire_id IS NOT NULL;

ALTER TABLE app_runs DROP CONSTRAINT IF EXISTS app_runs_app_origin_coherence_check;
ALTER TABLE app_runs ADD CONSTRAINT app_runs_app_origin_coherence_check CHECK (
  (
    origin_kind = 'app'
    AND origin_app_installation_id IS NOT NULL
    AND origin_app_version_id IS NOT NULL
    AND origin_app_binding_key IS NOT NULL
    AND origin_app_grant_snapshot_id IS NOT NULL
    AND risk_class = 'external_write'
    AND review_requirement = 'always'
    AND retry_class = 'idempotent_with_key'
    AND retention_class = 'standard'
    AND (
      (
        review_scope = 'per_invocation'
        AND origin_app_automation_definition_id IS NULL
        AND origin_app_automation_fire_id IS NULL
        AND initiating_actor_type <> 'automation'
        AND execution_actor_type <> 'automation'
      ) OR (
        review_scope = 'approved_automation_definition'
        AND origin_app_automation_definition_id IS NOT NULL
        AND origin_app_automation_fire_id IS NOT NULL
        AND initiating_actor_type = 'human'
        AND execution_actor_type = 'automation'
        AND execution_actor_id = origin_app_automation_definition_id
      )
    )
  ) OR (
    origin_kind <> 'app'
    AND origin_app_installation_id IS NULL
    AND origin_app_version_id IS NULL
    AND origin_app_binding_key IS NULL
    AND origin_app_grant_snapshot_id IS NULL
    AND origin_app_automation_definition_id IS NULL
    AND origin_app_automation_fire_id IS NULL
    AND initiating_actor_type <> 'automation'
    AND execution_actor_type <> 'automation'
  )
);

ALTER TABLE app_runs DROP CONSTRAINT IF EXISTS app_runs_execution_release_shape_check;
ALTER TABLE app_runs ADD CONSTRAINT app_runs_execution_release_shape_check CHECK (
  (execution_release_kind IS NULL AND execution_released_at IS NULL)
  OR (
    execution_release_kind IS NOT NULL
    AND execution_released_at IS NOT NULL
    AND (
      (
        review_requirement = 'always'
        AND review_scope = 'per_invocation'
        AND execution_release_kind = 'approved'
      ) OR (
        review_requirement = 'always'
        AND review_scope = 'approved_automation_definition'
        AND execution_release_kind = 'approved_automation_definition'
      ) OR (
        review_requirement = 'policy'
        AND execution_release_kind IN ('policy_satisfied', 'approved')
      )
    )
  )
);

-- Protocol v2 is connected and therefore participates in the unchanged grant
-- review lifecycle. Replace the two historical v1-only function bodies; their
-- trigger names remain unchanged.
CREATE OR REPLACE FUNCTION enforce_app_grant_snapshot_lineage() RETURNS trigger AS $$
BEGIN
  IF NEW.snapshot_kind = 'requested' THEN
    IF NOT EXISTS (
      SELECT 1 FROM app_versions
      WHERE org_id = NEW.org_id
        AND installation_id = NEW.app_installation_id
        AND id = NEW.app_version_id
        AND requested_grant_snapshot_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'APP_GRANT_REQUEST_POINTER_MISMATCH' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM app_versions
      WHERE org_id = NEW.org_id
        AND installation_id = NEW.app_installation_id
        AND id = NEW.app_version_id
        AND protocol_version IN ('1', '2')
    ) THEN
      RAISE EXCEPTION 'APP_GRANT_EFFECTIVE_PROTOCOL_UNSUPPORTED' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM app_grant_snapshots
      WHERE org_id = NEW.org_id
        AND app_installation_id = NEW.app_installation_id
        AND app_version_id = NEW.app_version_id
        AND id = NEW.requested_snapshot_id
        AND snapshot_kind = 'requested'
    ) THEN
      RAISE EXCEPTION 'APP_GRANT_REQUEST_LINEAGE_MISMATCH' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM org_members
      WHERE org_id = NEW.org_id
        AND user_id = NEW.reviewed_by_actor_id
        AND is_active = true
        AND role IN ('owner', 'admin')
    ) THEN
      RAISE EXCEPTION 'APP_GRANT_REVIEWER_NOT_AUTHORIZED' USING ERRCODE = '23514';
    END IF;
    IF NEW.supersedes_snapshot_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM app_grant_snapshots
      WHERE org_id = NEW.org_id
        AND app_installation_id = NEW.app_installation_id
        AND id = NEW.supersedes_snapshot_id
        AND snapshot_kind = 'effective'
    ) THEN
      RAISE EXCEPTION 'APP_GRANT_SUPERSEDES_LINEAGE_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION assert_app_installation_grant_coherence(
  checked_org_id text,
  checked_installation_id text
) RETURNS void AS $$
DECLARE
  installation app_installations%ROWTYPE;
  version_protocol text;
  version_state text;
BEGIN
  SELECT * INTO installation FROM app_installations
   WHERE org_id = checked_org_id AND id = checked_installation_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF installation.active_version_id IS NULL THEN
    IF installation.active_grant_snapshot_id IS NOT NULL
      OR installation.active_grant_snapshot_kind IS NOT NULL
    THEN
      RAISE EXCEPTION 'APP_GRANT_POINTER_WITHOUT_VERSION' USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;

  SELECT protocol_version, state INTO version_protocol, version_state
    FROM app_versions
   WHERE org_id = checked_org_id
     AND installation_id = checked_installation_id
     AND id = installation.active_version_id;
  IF NOT FOUND OR version_state <> 'active' THEN
    RAISE EXCEPTION 'APP_ACTIVE_VERSION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF installation.state = 'active' AND version_protocol IN ('1', '2') THEN
    IF installation.active_grant_snapshot_id IS NULL
      OR installation.active_grant_snapshot_kind <> 'effective'
    THEN
      RAISE EXCEPTION 'APP_EFFECTIVE_GRANT_REQUIRED' USING ERRCODE = '23514';
    END IF;
  ELSIF installation.active_grant_snapshot_id IS NOT NULL
    OR installation.active_grant_snapshot_kind IS NOT NULL
  THEN
    RAISE EXCEPTION 'APP_EFFECTIVE_GRANT_NOT_ALLOWED' USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_app_automation_definition() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1
      OR current_setting('deft.app_automation_maintenance', true) = 'on'
    THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'APP_AUTOMATION_DEFINITION_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (
      to_jsonb(NEW) - ARRAY[
        'state', 'definition_epoch', 'state_changed_at', 'revoked_at',
        'expired_at', 'updated_at'
      ]::text[]
    ) IS DISTINCT FROM (
      to_jsonb(OLD) - ARRAY[
        'state', 'definition_epoch', 'state_changed_at', 'revoked_at',
        'expired_at', 'updated_at'
      ]::text[]
    ) THEN
      RAISE EXCEPTION 'APP_AUTOMATION_DEFINITION_IMMUTABLE_FIELD' USING ERRCODE = '55000';
    END IF;

    IF NEW.definition_epoch <> OLD.definition_epoch + 1 OR NOT (
      (OLD.state = 'active' AND NEW.state IN ('paused', 'revoked', 'expired'))
      OR (OLD.state = 'paused' AND NEW.state IN ('active', 'revoked', 'expired'))
    ) THEN
      RAISE EXCEPTION 'APP_AUTOMATION_DEFINITION_INVALID_TRANSITION' USING ERRCODE = '55000';
    END IF;
    IF NEW.state_changed_at < OLD.state_changed_at
      OR (NEW.state = 'revoked' AND NEW.revoked_at IS DISTINCT FROM NEW.state_changed_at)
      OR (NEW.state = 'expired' AND NEW.expired_at IS DISTINCT FROM NEW.state_changed_at)
      OR (NEW.state IN ('active', 'paused') AND (
        NEW.revoked_at IS NOT NULL OR NEW.expired_at IS NOT NULL
      ))
    THEN
      RAISE EXCEPTION 'APP_AUTOMATION_DEFINITION_INVALID_TRANSITION' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.created_by_user_id <> NEW.approved_by_user_id THEN
    RAISE EXCEPTION 'APP_AUTOMATION_APPROVER_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM org_members
     WHERE org_id = NEW.org_id
       AND user_id = NEW.approved_by_user_id
       AND is_active = true
       AND role IN ('owner', 'admin')
       AND app_run_authorization_version = NEW.approver_authorization_version
  ) THEN
    RAISE EXCEPTION 'APP_AUTOMATION_APPROVER_NOT_AUTHORIZED' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app_installations
     WHERE org_id = NEW.org_id
       AND id = NEW.app_installation_id
       AND state = 'active'
       AND active_version_id = NEW.app_version_id
       AND active_grant_snapshot_id = NEW.grant_snapshot_id
       AND active_grant_snapshot_kind = 'effective'
       AND lifecycle_epoch = NEW.installation_lifecycle_epoch
       AND grant_epoch = NEW.installation_grant_epoch
  ) THEN
    RAISE EXCEPTION 'APP_AUTOMATION_INSTALLATION_LINEAGE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app_versions version,
      LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(version.manifest->'automation_requests') = 'array'
          THEN version.manifest->'automation_requests' ELSE '[]'::jsonb END
      ) request
     WHERE version.org_id = NEW.org_id
       AND version.installation_id = NEW.app_installation_id
       AND version.id = NEW.app_version_id
       AND version.protocol_version = '2'
       AND version.state = 'active'
       AND version.manifest_digest = NEW.app_manifest_digest
       AND version.package_digest = NEW.app_package_digest
       AND request->>'key' = NEW.automation_request_key
       AND request->>'action_key' = NEW.action_key
       AND request#>>'{trigger,kind}' = 'daily_local_time'
  ) THEN
    RAISE EXCEPTION 'APP_AUTOMATION_REQUEST_LINEAGE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app_versions version,
      LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(version.manifest->'actions') = 'array'
          THEN version.manifest->'actions' ELSE '[]'::jsonb END
      ) action
     WHERE version.org_id = NEW.org_id
       AND version.installation_id = NEW.app_installation_id
       AND version.id = NEW.app_version_id
       AND action->>'key' = NEW.action_key
       AND (
         SELECT count(*) FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(action->'input_bindings') = 'array'
             THEN action->'input_bindings' ELSE '[]'::jsonb END
         ) input_binding
         WHERE input_binding->'source'->>'kind' = 'selected_relation_field'
       ) = 1
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(action->'input_bindings') = 'array'
             THEN action->'input_bindings' ELSE '[]'::jsonb END
         ) input_binding
         WHERE input_binding->'source'->>'kind' = 'selected_relation_field'
           AND input_binding->>'input_key' = NEW.selected_relation_input_key
           AND input_binding#>>'{source,relation_field_key}' = NEW.selected_relation_key
       )
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(action->'input_bindings') = 'array'
             THEN action->'input_bindings' ELSE '[]'::jsonb END
         ) input_binding
         WHERE input_binding->'source'->>'kind' = 'user_input'
       )
  ) THEN
    RAISE EXCEPTION 'APP_AUTOMATION_ACTION_INPUT_LINEAGE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app_grant_snapshots
     WHERE org_id = NEW.org_id
       AND app_installation_id = NEW.app_installation_id
       AND app_version_id = NEW.app_version_id
       AND id = NEW.grant_snapshot_id
       AND snapshot_kind = 'effective'
       AND snapshot_digest = NEW.grant_snapshot_digest
  ) THEN
    RAISE EXCEPTION 'APP_AUTOMATION_GRANT_LINEAGE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app_action_bindings
     WHERE org_id = NEW.org_id
       AND app_installation_id = NEW.app_installation_id
       AND app_version_id = NEW.app_version_id
       AND grant_snapshot_id = NEW.grant_snapshot_id
       AND grant_snapshot_kind = 'effective'
       AND action_key = NEW.action_key
       AND id = NEW.action_binding_id
       AND interface_identity = NEW.interface_identity
       AND provider_kind = NEW.provider_kind
       AND mcp_connection_id = NEW.mcp_connection_id
       AND provider_snapshot_id = NEW.provider_snapshot_id
       AND operation_name = NEW.operation_name
       AND operation_schema_digest = NEW.operation_schema_digest
       AND binding_digest = NEW.binding_digest
       AND connector_authorization_version = NEW.connector_authorization_version
       AND risk_class = 'external_write'
       AND review_requirement = 'always'
       AND review_scope = 'per_invocation'
       AND egress_class = 'email'
       AND retry_class = 'idempotent_with_key'
       AND retention_class = 'standard'
       AND automation_eligibility = 'forbidden'
       AND provider_idempotency_key_required = true
  ) THEN
    RAISE EXCEPTION 'APP_AUTOMATION_BINDING_LINEAGE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF NEW.interface_identity <> (
    'deft.private.v1:' || lower(NEW.org_id) || ':' ||
    lower(NEW.app_installation_id) || ':sandbox_email_send:v1'
  ) THEN
    RAISE EXCEPTION 'APP_AUTOMATION_INTERFACE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM capability_provider_snapshots
     WHERE org_id = NEW.org_id
       AND provider_kind = NEW.provider_kind
       AND provider_instance_id = NEW.mcp_connection_id
       AND id = NEW.provider_snapshot_id
       AND snapshot_digest = NEW.provider_snapshot_digest
  ) THEN
    RAISE EXCEPTION 'APP_AUTOMATION_PROVIDER_LINEAGE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM resource_relation_sets relation_set
      JOIN resource_relation_edges edge
        ON edge.org_id = relation_set.org_id
       AND edge.relation_set_id = relation_set.id
       AND edge.is_deleted = false
     WHERE relation_set.org_id = NEW.org_id
       AND relation_set.source_provider_kind = NEW.placement_resource_ref#>>'{provider,kind}'
       AND relation_set.source_provider_instance_id = NEW.placement_resource_ref#>>'{provider,provider_instance_id}'
       AND relation_set.source_resource_type = NEW.placement_resource_ref->>'resource_type'
       AND relation_set.source_resource_id = NEW.placement_resource_ref->>'resource_id'
       AND relation_set.relation_key = NEW.selected_relation_key
       AND relation_set.revision = NEW.selected_relation_revision
       AND edge.target_provider_kind = NEW.selected_resource_ref#>>'{provider,kind}'
       AND edge.target_provider_instance_id = NEW.selected_resource_ref#>>'{provider,provider_instance_id}'
       AND edge.target_resource_type = NEW.selected_resource_ref->>'resource_type'
       AND edge.target_resource_id = NEW.selected_resource_ref->>'resource_id'
  ) THEN
    RAISE EXCEPTION 'APP_AUTOMATION_RELATION_LINEAGE_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_automation_definitions_guard_trigger
  ON app_automation_definitions;
CREATE TRIGGER app_automation_definitions_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON app_automation_definitions
  FOR EACH ROW EXECUTE FUNCTION enforce_app_automation_definition();

CREATE OR REPLACE FUNCTION enforce_app_automation_fire() RETURNS trigger AS $$
DECLARE
  definition app_automation_definitions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1
      OR current_setting('deft.app_automation_maintenance', true) = 'on'
    THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'APP_AUTOMATION_FIRE_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO definition
    FROM app_automation_definitions
   WHERE org_id = NEW.org_id AND id = NEW.definition_id
   FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'APP_AUTOMATION_DEFINITION_NOT_FOUND' USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF definition.state <> 'active'
      OR definition.definition_epoch <> NEW.definition_epoch
      OR definition.local_time <> NEW.local_time
      OR definition.timezone <> NEW.timezone
      OR (
        NEW.resolved_at_utc IS NOT NULL
        AND (
          NEW.resolved_at_utc < definition.valid_from
          OR NEW.resolved_at_utc >= definition.valid_until
        )
      )
    THEN
      RAISE EXCEPTION 'APP_AUTOMATION_FIRE_DEFINITION_MISMATCH' USING ERRCODE = '23514';
    END IF;
    PERFORM pg_advisory_xact_lock(
      hashtextextended('deft.app_automation.pending_budget:' || NEW.org_id, 0)
    );
    IF (
      SELECT count(*) FROM app_automation_fires
       WHERE org_id = NEW.org_id AND state IN ('pending', 'claimed')
    ) >= LEAST(definition.max_pending_org_fires, 25) THEN
      RAISE EXCEPTION 'APP_AUTOMATION_PENDING_BUDGET_EXCEEDED' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF (
    to_jsonb(NEW) - ARRAY[
      'state', 'attempt_count', 'claim_owner', 'claim_token', 'claimed_at',
      'lease_expires_at', 'app_run_id', 'terminal_reason', 'terminal_at', 'updated_at'
    ]::text[]
  ) IS DISTINCT FROM (
    to_jsonb(OLD) - ARRAY[
      'state', 'attempt_count', 'claim_owner', 'claim_token', 'claimed_at',
      'lease_expires_at', 'app_run_id', 'terminal_reason', 'terminal_at', 'updated_at'
    ]::text[]
  ) THEN
    RAISE EXCEPTION 'APP_AUTOMATION_FIRE_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;
  IF OLD.app_run_id IS NOT NULL AND NEW.app_run_id IS DISTINCT FROM OLD.app_run_id THEN
    RAISE EXCEPTION 'APP_AUTOMATION_FIRE_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;
  IF OLD.state IN ('run_created', 'skipped', 'dead_letter') THEN
    RAISE EXCEPTION 'APP_AUTOMATION_FIRE_INVALID_TRANSITION' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.state = 'pending' AND NEW.state IN ('claimed', 'skipped'))
    OR (OLD.state = 'claimed' AND NEW.state IN ('claimed', 'pending', 'run_created', 'dead_letter', 'skipped'))
  ) THEN
    RAISE EXCEPTION 'APP_AUTOMATION_FIRE_INVALID_TRANSITION' USING ERRCODE = '55000';
  END IF;
  IF (OLD.state = 'pending' AND NEW.state = 'claimed'
      AND NEW.attempt_count <> OLD.attempt_count + 1)
    OR (NOT (OLD.state = 'pending' AND NEW.state = 'claimed')
      AND NEW.attempt_count <> OLD.attempt_count)
  THEN
    RAISE EXCEPTION 'APP_AUTOMATION_FIRE_ATTEMPT_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF NEW.state = 'claimed' AND (
    definition.state <> 'active'
    OR definition.definition_epoch <> NEW.definition_epoch
    OR NEW.claimed_at < definition.valid_from
    OR NEW.claimed_at >= definition.valid_until
    OR NOT EXISTS (
      SELECT 1 FROM org_members
       WHERE org_id = definition.org_id
         AND user_id = definition.approved_by_user_id
         AND is_active = true
         AND role IN ('owner', 'admin')
         AND app_run_authorization_version = definition.approver_authorization_version
    )
  ) THEN
    RAISE EXCEPTION 'APP_AUTOMATION_FIRE_DEFINITION_INELIGIBLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_automation_fires_guard_trigger ON app_automation_fires;
CREATE TRIGGER app_automation_fires_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON app_automation_fires
  FOR EACH ROW EXECUTE FUNCTION enforce_app_automation_fire();

-- The new automation lineage is part of immutable Run identity. This replaces
-- the latest function body without changing the established trigger name.
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
      NEW.origin_app_installation_id, NEW.origin_app_version_id,
      NEW.origin_app_binding_key, NEW.origin_app_grant_snapshot_id,
      NEW.origin_app_automation_definition_id, NEW.origin_app_automation_fire_id,
      NEW.risk_class, NEW.review_requirement, NEW.review_scope, NEW.retry_class,
      NEW.retention_class, NEW.idempotency_key_version, NEW.idempotency_fingerprint,
      NEW.input_fingerprint_key_version, NEW.input_fingerprint, NEW.authorization_snapshot,
      NEW.safe_preview, NEW.root_run_id, NEW.parent_run_id, NEW.depth,
      NEW.input_expires_at, NEW.result_expires_at, NEW.idempotency_expires_at, NEW.attempt_limit)
    IS DISTINCT FROM
     (OLD.org_id, OLD.contract_version, OLD.origin_kind, OLD.initiating_actor_type, OLD.initiating_actor_id,
      OLD.execution_actor_type, OLD.execution_actor_id, OLD.provider_kind,
      OLD.provider_instance_id, OLD.operation_name, OLD.provider_snapshot_id,
      OLD.origin_app_installation_id, OLD.origin_app_version_id,
      OLD.origin_app_binding_key, OLD.origin_app_grant_snapshot_id,
      OLD.origin_app_automation_definition_id, OLD.origin_app_automation_fire_id,
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

-- Automation is a closed non-admin principal in this slice. It cannot create
-- a child Run, even if every other ancestry ceiling would otherwise match.
CREATE OR REPLACE FUNCTION enforce_app_run_ancestry_insert() RETURNS trigger AS $$
DECLARE
  parent_row app_runs%ROWTYPE;
  root_row app_runs%ROWTYPE;
BEGIN
  IF NEW.depth = 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.execution_actor_type = 'automation'
    OR NEW.origin_app_automation_definition_id IS NOT NULL
    OR NEW.origin_app_automation_fire_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'APP_AUTOMATION_RECURSION_FORBIDDEN' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO parent_row
    FROM app_runs
    WHERE org_id = NEW.org_id AND id = NEW.parent_run_id
    FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'APP_RUN_ANCESTRY_INVALID' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO root_row
    FROM app_runs
    WHERE org_id = NEW.org_id AND id = NEW.root_run_id
    FOR KEY SHARE;
  IF NOT FOUND OR root_row.depth <> 0 OR root_row.root_run_id <> root_row.id THEN
    RAISE EXCEPTION 'APP_RUN_ANCESTRY_INVALID' USING ERRCODE = '55000';
  END IF;

  IF parent_row.state NOT IN ('running', 'waiting_external')
    OR NEW.depth <> parent_row.depth + 1
    OR NEW.root_run_id <> parent_row.root_run_id
    OR NEW.id = NEW.parent_run_id
    OR NEW.id = NEW.root_run_id
  THEN
    RAISE EXCEPTION 'APP_RUN_ANCESTRY_INVALID' USING ERRCODE = '55000';
  END IF;

  IF (NEW.initiating_actor_type, NEW.initiating_actor_id,
      NEW.execution_actor_type, NEW.execution_actor_id, NEW.origin_kind)
    IS DISTINCT FROM
     (parent_row.initiating_actor_type, parent_row.initiating_actor_id,
      parent_row.execution_actor_type, parent_row.execution_actor_id, parent_row.origin_kind)
  THEN
    RAISE EXCEPTION 'APP_RUN_AUTHORIZATION_CEILING' USING ERRCODE = '55000';
  END IF;

  IF jsonb_typeof(NEW.authorization_snapshot->'authority_refs') <> 'array'
    OR jsonb_typeof(parent_row.authorization_snapshot->'authority_refs') <> 'array'
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW.authorization_snapshot->'authority_refs') child_ref
      WHERE child_ref->>'authority_kind' IN (
        'membership', 'token_scope', 'employee_health', 'employee_budget'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(parent_row.authorization_snapshot->'authority_refs') parent_ref
        WHERE parent_ref->>'authority_kind' = child_ref->>'authority_kind'
          AND parent_ref->>'authority_id' = child_ref->>'authority_id'
          AND parent_ref->>'version' = child_ref->>'version'
      )
    )
  THEN
    RAISE EXCEPTION 'APP_RUN_AUTHORIZATION_CEILING' USING ERRCODE = '55000';
  END IF;

  IF (CASE NEW.risk_class
       WHEN 'read' THEN 0 WHEN 'internal_write' THEN 1 WHEN 'external_write' THEN 2
       WHEN 'destructive' THEN 3 WHEN 'privileged' THEN 4 ELSE 99 END)
     > (CASE parent_row.risk_class
       WHEN 'read' THEN 0 WHEN 'internal_write' THEN 1 WHEN 'external_write' THEN 2
       WHEN 'destructive' THEN 3 WHEN 'privileged' THEN 4 ELSE -1 END)
    OR (parent_row.review_requirement = 'always' AND NEW.review_requirement <> 'always')
    OR NEW.review_scope <> parent_row.review_scope
    OR (CASE NEW.retry_class
       WHEN 'unsafe_or_unknown' THEN 0 WHEN 'idempotent_with_key' THEN 1
       WHEN 'safe' THEN 2 ELSE 99 END)
       > (CASE parent_row.retry_class
       WHEN 'unsafe_or_unknown' THEN 0 WHEN 'idempotent_with_key' THEN 1
       WHEN 'safe' THEN 2 ELSE -1 END)
    OR (CASE NEW.retention_class
       WHEN 'ephemeral' THEN 0 WHEN 'standard' THEN 1 WHEN 'extended' THEN 2 ELSE 99 END
       > (CASE parent_row.retention_class
       WHEN 'ephemeral' THEN 0 WHEN 'standard' THEN 1 WHEN 'extended' THEN 2 ELSE -1 END))
    OR NEW.input_expires_at > parent_row.input_expires_at
    OR NEW.result_expires_at > parent_row.result_expires_at
    OR NEW.idempotency_expires_at > parent_row.idempotency_expires_at
    OR NEW.attempt_limit > parent_row.attempt_limit
  THEN
    RAISE EXCEPTION 'APP_RUN_POLICY_CEILING' USING ERRCODE = '55000';
  END IF;

  IF (NEW.budget_reserved_count, NEW.budget_limit_at_reservation)
    IS DISTINCT FROM
     (root_row.budget_reserved_count, root_row.budget_limit_at_reservation)
    OR date_trunc('milliseconds', NEW.budget_reserved_at)
      IS DISTINCT FROM date_trunc('milliseconds', root_row.budget_reserved_at)
    OR (
      NEW.execution_actor_type = 'agent_employee'
      AND root_row.budget_reserved_at IS NULL
    )
  THEN
    RAISE EXCEPTION 'APP_RUN_BUDGET_CONTINUITY' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_app_automation_run_lineage() RETURNS trigger AS $$
DECLARE
  definition app_automation_definitions%ROWTYPE;
  fire app_automation_fires%ROWTYPE;
BEGIN
  IF NEW.origin_app_automation_definition_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO definition
    FROM app_automation_definitions
   WHERE org_id = NEW.org_id
     AND id = NEW.origin_app_automation_definition_id
   FOR KEY SHARE;
  SELECT * INTO fire
    FROM app_automation_fires
   WHERE org_id = NEW.org_id
     AND definition_id = NEW.origin_app_automation_definition_id
     AND id = NEW.origin_app_automation_fire_id
   FOR UPDATE;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'deft.app_automation.run_budget:' || NEW.org_id || ':' ||
    to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
    0
  ));

  IF definition.id IS NULL
    OR fire.id IS NULL
    OR definition.state <> 'active'
    OR definition.definition_epoch <> fire.definition_epoch
    OR now() < definition.valid_from
    OR now() >= definition.valid_until
    OR NEW.depth <> 0
    OR NEW.initiating_actor_type <> 'human'
    OR NEW.initiating_actor_id <> definition.approved_by_user_id
    OR NEW.execution_actor_type <> 'automation'
    OR NEW.execution_actor_id <> definition.id
    OR NEW.origin_app_installation_id <> definition.app_installation_id
    OR NEW.origin_app_version_id <> definition.app_version_id
    OR NEW.origin_app_grant_snapshot_id <> definition.grant_snapshot_id
    OR NEW.origin_app_binding_key <> definition.action_key
    OR NEW.provider_kind <> definition.provider_kind
    OR NEW.provider_instance_id <> definition.mcp_connection_id
    OR NEW.provider_snapshot_id <> definition.provider_snapshot_id
    OR NEW.operation_name <> definition.operation_name
    OR NEW.review_requirement <> 'always'
    OR NEW.review_scope <> 'approved_automation_definition'
    OR NEW.execution_release_kind <> 'approved_automation_definition'
    OR NEW.execution_released_at IS NULL
    OR fire.state <> 'claimed'
    OR fire.app_run_id IS NOT NULL
    OR (
      SELECT count(*) FROM app_runs
       WHERE org_id = NEW.org_id
         AND origin_app_automation_definition_id IS NOT NULL
         AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
         AND created_at < date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day'
    ) >= LEAST(definition.max_org_runs_per_utc_day, 100)
    OR NOT EXISTS (
      SELECT 1 FROM org_members
       WHERE org_id = definition.org_id
         AND user_id = definition.approved_by_user_id
         AND is_active = true
         AND role IN ('owner', 'admin')
         AND app_run_authorization_version = definition.approver_authorization_version
    )
  THEN
    RAISE EXCEPTION 'APP_AUTOMATION_RUN_LINEAGE_MISMATCH' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_runs_automation_lineage_trigger ON app_runs;
CREATE TRIGGER app_runs_automation_lineage_trigger
  BEFORE INSERT ON app_runs
  FOR EACH ROW EXECUTE FUNCTION enforce_app_automation_run_lineage();
