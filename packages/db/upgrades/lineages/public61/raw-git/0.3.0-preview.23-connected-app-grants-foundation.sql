-- Additive connected-App authority substrate. Protocol v1 staging may persist
-- an immutable requested snapshot, but effective grants and App-origin Runs
-- remain database-denied until a later reviewed lifecycle migration.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'capability_provider_snapshots_org_provider_id_unique') THEN
    ALTER TABLE capability_provider_snapshots
      ADD CONSTRAINT capability_provider_snapshots_org_provider_id_unique
      UNIQUE (org_id, provider_kind, provider_instance_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_connections_org_id_id_unique') THEN
    ALTER TABLE mcp_connections
      ADD CONSTRAINT mcp_connections_org_id_id_unique UNIQUE (org_id, id);
  END IF;
END $$;

ALTER TABLE app_installations
  ADD COLUMN IF NOT EXISTS active_grant_snapshot_id text,
  ADD COLUMN IF NOT EXISTS active_grant_snapshot_kind text,
  ADD COLUMN IF NOT EXISTS grant_epoch integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_installations_org_id_app_id_unique') THEN
    ALTER TABLE app_installations ADD CONSTRAINT app_installations_org_id_app_id_unique
      UNIQUE (org_id, id, app_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_installations_grant_epoch_nonnegative_check') THEN
    ALTER TABLE app_installations ADD CONSTRAINT app_installations_grant_epoch_nonnegative_check
      CHECK (grant_epoch >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_installations_grant_pointer_dormant_check') THEN
    ALTER TABLE app_installations ADD CONSTRAINT app_installations_grant_pointer_dormant_check
      CHECK (active_grant_snapshot_id IS NULL AND active_grant_snapshot_kind IS NULL);
  END IF;
END $$;

ALTER TABLE app_versions
  ADD COLUMN IF NOT EXISTS requested_grant_snapshot_id text;

ALTER TABLE app_versions DROP CONSTRAINT IF EXISTS app_versions_protocol_v0_check;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_versions_org_installation_identity_unique') THEN
    ALTER TABLE app_versions ADD CONSTRAINT app_versions_org_installation_identity_unique
      UNIQUE (org_id, installation_id, id, version, manifest_digest, package_digest);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_versions_protocol_supported_check') THEN
    ALTER TABLE app_versions ADD CONSTRAINT app_versions_protocol_supported_check
      CHECK (protocol_version IN ('0', '1'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_versions_protocol_stage_gate_check') THEN
    ALTER TABLE app_versions ADD CONSTRAINT app_versions_protocol_stage_gate_check
      CHECK (protocol_version = '0' OR state = 'staged');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_versions_connected_request_check') THEN
    ALTER TABLE app_versions ADD CONSTRAINT app_versions_connected_request_check
      CHECK (protocol_version = '0' OR requested_grant_snapshot_id IS NOT NULL);
  END IF;
END $$;

ALTER TABLE app_runs
  ADD COLUMN IF NOT EXISTS origin_app_installation_id text,
  ADD COLUMN IF NOT EXISTS origin_app_version_id text,
  ADD COLUMN IF NOT EXISTS origin_app_binding_key text,
  ADD COLUMN IF NOT EXISTS origin_app_grant_snapshot_id text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_runs_app_identity_dormant_check') THEN
    ALTER TABLE app_runs ADD CONSTRAINT app_runs_app_identity_dormant_check CHECK (
      (
        origin_kind = 'app'
        AND origin_app_installation_id IS NOT NULL
        AND origin_app_version_id IS NOT NULL
        AND origin_app_binding_key IS NOT NULL
        AND origin_app_grant_snapshot_id IS NOT NULL
      ) OR (
        origin_kind <> 'app'
        AND origin_app_installation_id IS NULL
        AND origin_app_version_id IS NULL
        AND origin_app_binding_key IS NULL
        AND origin_app_grant_snapshot_id IS NULL
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_runs_app_binding_key_check') THEN
    ALTER TABLE app_runs ADD CONSTRAINT app_runs_app_binding_key_check CHECK (
      origin_app_binding_key IS NULL OR (
        origin_app_binding_key ~ '^[a-z][a-z0-9_]{0,47}$'
        AND origin_app_binding_key !~ '^(deft|core|system)(_|$)'
      )
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS app_grant_snapshots (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  app_installation_id text NOT NULL,
  app_version_id text NOT NULL,
  app_id text NOT NULL,
  app_version text NOT NULL,
  manifest_digest text NOT NULL,
  package_digest text NOT NULL,
  snapshot_kind text NOT NULL,
  snapshot_version text NOT NULL,
  requested_snapshot_id text,
  supersedes_snapshot_id text,
  resource_rights jsonb NOT NULL,
  classification jsonb NOT NULL,
  canonical_snapshot jsonb NOT NULL,
  snapshot_digest text NOT NULL,
  reviewed_by_actor_type text,
  reviewed_by_actor_id text,
  reviewed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_grant_snapshots_app_installation_fk
    FOREIGN KEY (org_id, app_installation_id, app_id)
    REFERENCES app_installations(org_id, id, app_id) ON DELETE RESTRICT,
  CONSTRAINT app_grant_snapshots_app_version_fk
    FOREIGN KEY (
      org_id, app_installation_id, app_version_id,
      app_version, manifest_digest, package_digest
    ) REFERENCES app_versions(
      org_id, installation_id, id, version, manifest_digest, package_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT app_grant_snapshots_org_installation_id_unique
    UNIQUE (org_id, app_installation_id, id),
  CONSTRAINT app_grant_snapshots_org_version_id_unique
    UNIQUE (org_id, app_installation_id, app_version_id, id),
  CONSTRAINT app_grant_snapshots_org_version_kind_id_unique
    UNIQUE (org_id, app_installation_id, app_version_id, id, snapshot_kind),
  CONSTRAINT app_grant_snapshots_requested_snapshot_fk
    FOREIGN KEY (org_id, app_installation_id, app_version_id, requested_snapshot_id)
    REFERENCES app_grant_snapshots(org_id, app_installation_id, app_version_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT app_grant_snapshots_supersedes_snapshot_fk
    FOREIGN KEY (org_id, app_installation_id, supersedes_snapshot_id)
    REFERENCES app_grant_snapshots(org_id, app_installation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT app_grant_snapshots_kind_check CHECK (snapshot_kind IN ('requested', 'effective')),
  CONSTRAINT app_grant_snapshots_version_check CHECK (snapshot_version = 'deft.app_grant_snapshot.v1'),
  CONSTRAINT app_grant_snapshots_app_id_check CHECK (
    app_id ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$'
  ),
  CONSTRAINT app_grant_snapshots_digest_check CHECK (
    manifest_digest ~ '^sha256:[a-f0-9]{64}$'
    AND package_digest ~ '^sha256:[a-f0-9]{64}$'
    AND snapshot_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  CONSTRAINT app_grant_snapshots_json_check CHECK (
    jsonb_typeof(resource_rights) = 'array'
    AND jsonb_typeof(classification) = 'object'
    AND jsonb_typeof(canonical_snapshot) = 'object'
  ),
  CONSTRAINT app_grant_snapshots_json_size_check CHECK (
    octet_length(resource_rights::text) <= 65536
    AND octet_length(classification::text) <= 32768
    AND octet_length(canonical_snapshot::text) <= 262144
  ),
  CONSTRAINT app_grant_snapshots_review_shape_check CHECK (
    (
      snapshot_kind = 'requested'
      AND requested_snapshot_id IS NULL
      AND supersedes_snapshot_id IS NULL
      AND reviewed_by_actor_type IS NULL
      AND reviewed_by_actor_id IS NULL
      AND reviewed_at IS NULL
    ) OR (
      snapshot_kind = 'effective'
      AND requested_snapshot_id IS NOT NULL
      AND reviewed_by_actor_type = 'human'
      AND reviewed_by_actor_id IS NOT NULL
      AND reviewed_at IS NOT NULL
    )
  ),
  CONSTRAINT app_grant_snapshots_supersedes_self_check CHECK (
    supersedes_snapshot_id IS NULL OR supersedes_snapshot_id <> id
  )
);

ALTER TABLE app_grant_snapshots
  DROP CONSTRAINT IF EXISTS app_grant_snapshots_supersedes_self_check;
ALTER TABLE app_grant_snapshots
  ADD CONSTRAINT app_grant_snapshots_supersedes_self_check CHECK (
    supersedes_snapshot_id IS NULL OR supersedes_snapshot_id <> id
  );

CREATE UNIQUE INDEX IF NOT EXISTS app_grant_snapshots_one_requested_unique
  ON app_grant_snapshots(org_id, app_version_id) WHERE snapshot_kind = 'requested';
CREATE INDEX IF NOT EXISTS app_grant_snapshots_app_version_idx
  ON app_grant_snapshots(org_id, app_installation_id, app_version_id, created_at);

CREATE TABLE IF NOT EXISTS app_dependency_locks (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  app_installation_id text NOT NULL,
  app_version_id text NOT NULL,
  grant_snapshot_id text NOT NULL,
  grant_snapshot_kind text NOT NULL DEFAULT 'effective',
  dependency_key text NOT NULL,
  required_app_id text NOT NULL,
  required_version text NOT NULL,
  dependency_installation_id text NOT NULL,
  dependency_version_id text NOT NULL,
  dependency_manifest_digest text NOT NULL,
  dependency_package_digest text NOT NULL,
  dependency_lifecycle_epoch integer NOT NULL,
  ownership text NOT NULL,
  canonical_lock jsonb NOT NULL,
  lock_digest text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_dependency_locks_app_version_fk
    FOREIGN KEY (org_id, app_installation_id, app_version_id)
    REFERENCES app_versions(org_id, installation_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_dependency_locks_grant_snapshot_fk
    FOREIGN KEY (
      org_id, app_installation_id, app_version_id,
      grant_snapshot_id, grant_snapshot_kind
    ) REFERENCES app_grant_snapshots(
      org_id, app_installation_id, app_version_id, id, snapshot_kind
    ) ON DELETE RESTRICT,
  CONSTRAINT app_dependency_locks_dependency_app_fk
    FOREIGN KEY (org_id, dependency_installation_id, required_app_id)
    REFERENCES app_installations(org_id, id, app_id) ON DELETE RESTRICT,
  CONSTRAINT app_dependency_locks_dependency_version_fk
    FOREIGN KEY (
      org_id, dependency_installation_id, dependency_version_id,
      required_version, dependency_manifest_digest, dependency_package_digest
    ) REFERENCES app_versions(
      org_id, installation_id, id, version, manifest_digest, package_digest
    ) ON DELETE RESTRICT,
  CONSTRAINT app_dependency_locks_key_check CHECK (
    dependency_key ~ '^[a-z][a-z0-9_]{0,47}$'
    AND dependency_key !~ '^(deft|core|system)(_|$)'
  ),
  CONSTRAINT app_dependency_locks_app_id_check CHECK (
    required_app_id ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$'
  ),
  CONSTRAINT app_dependency_locks_self_check CHECK (dependency_installation_id <> app_installation_id),
  CONSTRAINT app_dependency_locks_epoch_check CHECK (dependency_lifecycle_epoch >= 0),
  CONSTRAINT app_dependency_locks_ownership_check CHECK (
    ownership = 'preexisting'
  ),
  CONSTRAINT app_dependency_locks_grant_kind_check CHECK (grant_snapshot_kind = 'effective'),
  CONSTRAINT app_dependency_locks_digest_check CHECK (
    dependency_manifest_digest ~ '^sha256:[a-f0-9]{64}$'
    AND dependency_package_digest ~ '^sha256:[a-f0-9]{64}$'
    AND lock_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  CONSTRAINT app_dependency_locks_json_check CHECK (
    jsonb_typeof(canonical_lock) = 'object'
    AND octet_length(canonical_lock::text) <= 65536
  )
);

ALTER TABLE app_dependency_locks
  DROP CONSTRAINT IF EXISTS app_dependency_locks_ownership_check;
ALTER TABLE app_dependency_locks
  ADD CONSTRAINT app_dependency_locks_ownership_check CHECK (ownership = 'preexisting');

CREATE UNIQUE INDEX IF NOT EXISTS app_dependency_locks_grant_key_unique
  ON app_dependency_locks(org_id, grant_snapshot_id, dependency_key);
CREATE UNIQUE INDEX IF NOT EXISTS app_dependency_locks_grant_installation_unique
  ON app_dependency_locks(org_id, grant_snapshot_id, dependency_installation_id);
CREATE INDEX IF NOT EXISTS app_dependency_locks_dependency_idx
  ON app_dependency_locks(org_id, dependency_installation_id, dependency_version_id);

CREATE TABLE IF NOT EXISTS app_action_bindings (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  app_installation_id text NOT NULL,
  app_version_id text NOT NULL,
  grant_snapshot_id text NOT NULL,
  grant_snapshot_kind text NOT NULL DEFAULT 'effective',
  action_key text NOT NULL,
  capability_requirement_key text NOT NULL,
  connector_requirement_key text NOT NULL,
  interface_identity text NOT NULL,
  provider_kind text NOT NULL,
  mcp_connection_id text NOT NULL,
  provider_snapshot_id text NOT NULL,
  operation_name text NOT NULL,
  operation_schema_digest text NOT NULL,
  connector_authorization_version integer NOT NULL,
  risk_class text NOT NULL,
  review_requirement text NOT NULL,
  review_scope text NOT NULL,
  egress_class text NOT NULL,
  retry_class text NOT NULL,
  retention_class text NOT NULL,
  automation_eligibility text NOT NULL,
  provider_idempotency_key_required boolean NOT NULL,
  canonical_binding jsonb NOT NULL,
  binding_digest text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_action_bindings_app_version_fk
    FOREIGN KEY (org_id, app_installation_id, app_version_id)
    REFERENCES app_versions(org_id, installation_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_action_bindings_grant_snapshot_fk
    FOREIGN KEY (
      org_id, app_installation_id, app_version_id,
      grant_snapshot_id, grant_snapshot_kind
    ) REFERENCES app_grant_snapshots(
      org_id, app_installation_id, app_version_id, id, snapshot_kind
    ) ON DELETE RESTRICT,
  CONSTRAINT app_action_bindings_mcp_connection_fk
    FOREIGN KEY (org_id, mcp_connection_id)
    REFERENCES mcp_connections(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_action_bindings_provider_snapshot_fk
    FOREIGN KEY (org_id, provider_kind, mcp_connection_id, provider_snapshot_id)
    REFERENCES capability_provider_snapshots(org_id, provider_kind, provider_instance_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT app_action_bindings_grant_action_unique
    UNIQUE (org_id, grant_snapshot_id, action_key),
  CONSTRAINT app_action_bindings_run_identity_unique
    UNIQUE (
      org_id, app_installation_id, app_version_id, grant_snapshot_id,
      action_key, provider_kind, mcp_connection_id, operation_name, provider_snapshot_id
    ),
  CONSTRAINT app_action_bindings_key_check CHECK (
    action_key ~ '^[a-z][a-z0-9_]{0,47}$'
    AND capability_requirement_key ~ '^[a-z][a-z0-9_]{0,47}$'
    AND connector_requirement_key ~ '^[a-z][a-z0-9_]{0,47}$'
    AND action_key !~ '^(deft|core|system)(_|$)'
    AND capability_requirement_key !~ '^(deft|core|system)(_|$)'
    AND connector_requirement_key !~ '^(deft|core|system)(_|$)'
  ),
  CONSTRAINT app_action_bindings_interface_check CHECK (
    interface_identity =
      'deft.private.v1:' || lower(org_id) || ':' || lower(app_installation_id) ||
      ':sandbox_email_send:v1'
  ),
  CONSTRAINT app_action_bindings_provider_check CHECK (provider_kind = 'mcp'),
  CONSTRAINT app_action_bindings_grant_kind_check CHECK (grant_snapshot_kind = 'effective'),
  CONSTRAINT app_action_bindings_policy_check CHECK (
    risk_class = 'external_write'
    AND review_requirement = 'always'
    AND review_scope = 'per_invocation'
    AND egress_class = 'email'
    AND retry_class = 'idempotent_with_key'
    AND retention_class = 'standard'
    AND automation_eligibility = 'forbidden'
    AND provider_idempotency_key_required = true
    AND connector_authorization_version >= 1
  ),
  CONSTRAINT app_action_bindings_operation_check CHECK (
    octet_length(operation_name) BETWEEN 1 AND 512
    AND operation_name !~ '[[:cntrl:]]'
  ),
  CONSTRAINT app_action_bindings_digest_check CHECK (
    operation_schema_digest ~ '^sha256:[a-f0-9]{64}$'
    AND binding_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  CONSTRAINT app_action_bindings_json_check CHECK (
    jsonb_typeof(canonical_binding) = 'object'
    AND octet_length(canonical_binding::text) <= 65536
  )
);

ALTER TABLE app_action_bindings DROP CONSTRAINT IF EXISTS app_action_bindings_interface_check;
ALTER TABLE app_action_bindings ADD CONSTRAINT app_action_bindings_interface_check CHECK (
  interface_identity =
    'deft.private.v1:' || lower(org_id) || ':' || lower(app_installation_id) ||
    ':sandbox_email_send:v1'
);

CREATE INDEX IF NOT EXISTS app_action_bindings_provider_idx
  ON app_action_bindings(org_id, mcp_connection_id, provider_snapshot_id);

-- Cyclic pointers are deliberately deferred so a version and its requested
-- snapshot can be inserted atomically without a temporary mutable pointer.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_versions_requested_grant_snapshot_fk') THEN
    ALTER TABLE app_versions ADD CONSTRAINT app_versions_requested_grant_snapshot_fk
      FOREIGN KEY (org_id, installation_id, id, requested_grant_snapshot_id)
      REFERENCES app_grant_snapshots(org_id, app_installation_id, app_version_id, id)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_installations_active_grant_snapshot_fk') THEN
    ALTER TABLE app_installations ADD CONSTRAINT app_installations_active_grant_snapshot_fk
      FOREIGN KEY (org_id, id, active_version_id, active_grant_snapshot_id, active_grant_snapshot_kind)
      REFERENCES app_grant_snapshots(org_id, app_installation_id, app_version_id, id, snapshot_kind)
      ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_runs_app_version_fk') THEN
    ALTER TABLE app_runs ADD CONSTRAINT app_runs_app_version_fk
      FOREIGN KEY (org_id, origin_app_installation_id, origin_app_version_id)
      REFERENCES app_versions(org_id, installation_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_runs_app_grant_snapshot_fk') THEN
    ALTER TABLE app_runs ADD CONSTRAINT app_runs_app_grant_snapshot_fk
      FOREIGN KEY (
        org_id, origin_app_installation_id, origin_app_version_id,
        origin_app_grant_snapshot_id
      ) REFERENCES app_grant_snapshots(org_id, app_installation_id, app_version_id, id)
      ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_runs_app_action_binding_fk') THEN
    ALTER TABLE app_runs ADD CONSTRAINT app_runs_app_action_binding_fk
      FOREIGN KEY (
        org_id, origin_app_installation_id, origin_app_version_id,
        origin_app_grant_snapshot_id, origin_app_binding_key, provider_kind,
        provider_instance_id, operation_name, provider_snapshot_id
      ) REFERENCES app_action_bindings(
        org_id, app_installation_id, app_version_id, grant_snapshot_id,
        action_key, provider_kind, mcp_connection_id, operation_name, provider_snapshot_id
      ) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_app_foundation_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (
    pg_trigger_depth() > 1
    OR current_setting('deft.app_foundation_maintenance', true) = 'on'
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'APP_FOUNDATION_APPEND_ONLY' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

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
        AND protocol_version = '1'
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
    -- Validate the reviewer at insertion time without coupling immutable audit
    -- history to later org-member deletion.
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

CREATE OR REPLACE FUNCTION enforce_app_version_identity() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 OR current_setting('deft.app_foundation_maintenance', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'APP_VERSION_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF (
    NEW.org_id, NEW.installation_id, NEW.id, NEW.version, NEW.protocol_version,
    NEW.manifest, NEW.manifest_digest, NEW.package_digest, NEW.package,
    NEW.requested_grant_snapshot_id, NEW.provenance, NEW.staged_at,
    NEW.created_by_actor_type, NEW.created_by_actor_id, NEW.created_at
  ) IS DISTINCT FROM (
    OLD.org_id, OLD.installation_id, OLD.id, OLD.version, OLD.protocol_version,
    OLD.manifest, OLD.manifest_digest, OLD.package_digest, OLD.package,
    OLD.requested_grant_snapshot_id, OLD.provenance, OLD.staged_at,
    OLD.created_by_actor_type, OLD.created_by_actor_id, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'APP_VERSION_IMMUTABLE_FIELD' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
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
      NEW.origin_app_installation_id, NEW.origin_app_version_id,
      NEW.origin_app_binding_key, NEW.origin_app_grant_snapshot_id,
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

DROP TRIGGER IF EXISTS app_grant_snapshots_lineage_trigger ON app_grant_snapshots;
CREATE CONSTRAINT TRIGGER app_grant_snapshots_lineage_trigger
  AFTER INSERT ON app_grant_snapshots
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_app_grant_snapshot_lineage();

DROP TRIGGER IF EXISTS app_grant_snapshots_append_only_trigger ON app_grant_snapshots;
CREATE TRIGGER app_grant_snapshots_append_only_trigger
  BEFORE UPDATE OR DELETE ON app_grant_snapshots
  FOR EACH ROW EXECUTE FUNCTION enforce_app_foundation_append_only();

DROP TRIGGER IF EXISTS app_dependency_locks_append_only_trigger ON app_dependency_locks;
CREATE TRIGGER app_dependency_locks_append_only_trigger
  BEFORE UPDATE OR DELETE ON app_dependency_locks
  FOR EACH ROW EXECUTE FUNCTION enforce_app_foundation_append_only();

DROP TRIGGER IF EXISTS app_action_bindings_append_only_trigger ON app_action_bindings;
CREATE TRIGGER app_action_bindings_append_only_trigger
  BEFORE UPDATE OR DELETE ON app_action_bindings
  FOR EACH ROW EXECUTE FUNCTION enforce_app_foundation_append_only();

DROP TRIGGER IF EXISTS app_versions_identity_trigger ON app_versions;
CREATE TRIGGER app_versions_identity_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON app_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_app_version_identity();
