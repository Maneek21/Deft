-- Enable reviewed Protocol v1 grants without enabling App-origin execution.
-- Historical grant rows and App-version identities remain immutable; lifecycle
-- changes advance pointers/epochs and preserve their predecessors.

ALTER TABLE app_installations
  DROP CONSTRAINT IF EXISTS app_installations_grant_pointer_dormant_check;
ALTER TABLE app_installations
  DROP CONSTRAINT IF EXISTS app_installations_grant_pointer_shape_check;
ALTER TABLE app_installations
  ADD CONSTRAINT app_installations_grant_pointer_shape_check CHECK (
    (active_grant_snapshot_id IS NULL AND active_grant_snapshot_kind IS NULL)
    OR (active_grant_snapshot_id IS NOT NULL AND active_grant_snapshot_kind = 'effective')
  );

ALTER TABLE app_versions
  ADD COLUMN IF NOT EXISTS superseded_at timestamp;
ALTER TABLE app_versions
  DROP CONSTRAINT IF EXISTS app_versions_protocol_stage_gate_check;
ALTER TABLE app_versions
  DROP CONSTRAINT IF EXISTS app_versions_state_check;
ALTER TABLE app_versions
  DROP CONSTRAINT IF EXISTS app_versions_lifecycle_check;
ALTER TABLE app_versions
  ADD CONSTRAINT app_versions_state_check
    CHECK (state IN ('staged', 'active', 'superseded', 'failed'));
ALTER TABLE app_versions
  ADD CONSTRAINT app_versions_lifecycle_check CHECK (
    (state = 'staged' AND activated_at IS NULL AND failed_at IS NULL AND superseded_at IS NULL)
    OR (state = 'active' AND activated_at IS NOT NULL AND failed_at IS NULL AND superseded_at IS NULL)
    OR (state = 'superseded' AND activated_at IS NOT NULL AND failed_at IS NULL AND superseded_at IS NOT NULL)
    OR (state = 'failed' AND activated_at IS NULL AND failed_at IS NOT NULL AND superseded_at IS NULL)
  );
DROP INDEX IF EXISTS app_versions_one_staged_unique;
CREATE UNIQUE INDEX IF NOT EXISTS app_grant_snapshots_one_successor_unique
  ON app_grant_snapshots (org_id, app_installation_id, supersedes_snapshot_id)
  WHERE supersedes_snapshot_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS app_grant_snapshots_one_root_unique
  ON app_grant_snapshots (org_id, app_installation_id)
  WHERE snapshot_kind = 'effective' AND supersedes_snapshot_id IS NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_tool_overrides_org_connection_fk') THEN
    ALTER TABLE mcp_tool_overrides
      ADD CONSTRAINT mcp_tool_overrides_org_connection_fk
      FOREIGN KEY (org_id, mcp_connection_id)
      REFERENCES mcp_connections(org_id, id) ON DELETE CASCADE;
  END IF;
END $$;

DROP INDEX IF EXISTS app_module_bindings_owned_module_unique;
CREATE INDEX IF NOT EXISTS app_module_bindings_owner_idx
  ON app_module_bindings (org_id, module_installation_id, app_installation_id);

CREATE OR REPLACE FUNCTION enforce_app_module_binding_owner() RETURNS trigger AS $$
BEGIN
  -- Serialize owner establishment on the tenant-bound Module installation so
  -- concurrent App activations cannot both claim an unbound Module.
  PERFORM 1 FROM module_installations
   WHERE org_id = NEW.org_id AND id = NEW.module_installation_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'APP_MODULE_INSTALLATION_NOT_FOUND' USING ERRCODE = '23503';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app_module_bindings
     WHERE org_id = NEW.org_id
       AND module_installation_id = NEW.module_installation_id
       AND app_installation_id <> NEW.app_installation_id
       AND id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'APP_MODULE_OWNER_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_module_bindings_owner_trigger ON app_module_bindings;
CREATE TRIGGER app_module_bindings_owner_trigger
  BEFORE INSERT OR UPDATE ON app_module_bindings
  FOR EACH ROW EXECUTE FUNCTION enforce_app_module_binding_owner();

CREATE OR REPLACE FUNCTION enforce_app_module_binding_immutable() RETURNS trigger AS $$
BEGIN
  IF current_setting('deft.app_foundation_maintenance', true) = 'on' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'APP_MODULE_BINDING_APPEND_ONLY' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_module_bindings_immutable_trigger ON app_module_bindings;
CREATE TRIGGER app_module_bindings_immutable_trigger
  BEFORE UPDATE OR DELETE ON app_module_bindings
  FOR EACH ROW EXECUTE FUNCTION enforce_app_module_binding_immutable();

CREATE OR REPLACE FUNCTION enforce_app_version_identity() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 OR current_setting('deft.app_foundation_maintenance', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'APP_VERSION_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;

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
  IF NOT (
    (OLD.state = 'staged' AND NEW.state IN ('staged', 'active', 'failed'))
    OR (OLD.state = 'active' AND NEW.state IN ('active', 'superseded'))
    OR (OLD.state = 'superseded' AND NEW.state = 'superseded')
    OR (OLD.state = 'failed' AND NEW.state = 'failed')
  ) THEN
    RAISE EXCEPTION 'APP_VERSION_INVALID_TRANSITION' USING ERRCODE = '55000';
  END IF;
  IF (OLD.activated_at IS NOT NULL AND NEW.activated_at IS DISTINCT FROM OLD.activated_at)
    OR (OLD.failed_at IS NOT NULL AND NEW.failed_at IS DISTINCT FROM OLD.failed_at)
    OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at)
  THEN
    RAISE EXCEPTION 'APP_VERSION_LIFECYCLE_IMMUTABLE' USING ERRCODE = '55000';
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

  IF installation.state = 'active' AND version_protocol = '1' THEN
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

CREATE OR REPLACE FUNCTION enforce_app_installation_grant_coherence() RETURNS trigger AS $$
BEGIN
  PERFORM assert_app_installation_grant_coherence(NEW.org_id, NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_app_installation_epoch_cas() RETURNS trigger AS $$
DECLARE
  lifecycle_changed boolean;
  grant_changed boolean;
BEGIN
  lifecycle_changed := (NEW.state, NEW.active_version_id, NEW.disabled_at)
    IS DISTINCT FROM (OLD.state, OLD.active_version_id, OLD.disabled_at);
  grant_changed := (NEW.active_grant_snapshot_id, NEW.active_grant_snapshot_kind)
    IS DISTINCT FROM (OLD.active_grant_snapshot_id, OLD.active_grant_snapshot_kind);
  IF (lifecycle_changed AND NEW.lifecycle_epoch <> OLD.lifecycle_epoch + 1)
    OR (NOT lifecycle_changed AND NEW.lifecycle_epoch <> OLD.lifecycle_epoch)
  THEN
    RAISE EXCEPTION 'APP_LIFECYCLE_EPOCH_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF (grant_changed AND NEW.grant_epoch <> OLD.grant_epoch + 1)
    OR (NOT grant_changed AND NEW.grant_epoch <> OLD.grant_epoch)
  THEN
    RAISE EXCEPTION 'APP_GRANT_EPOCH_MISMATCH' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_installations_epoch_cas_trigger ON app_installations;
CREATE TRIGGER app_installations_epoch_cas_trigger
  BEFORE UPDATE ON app_installations
  FOR EACH ROW EXECUTE FUNCTION enforce_app_installation_epoch_cas();

CREATE OR REPLACE FUNCTION enforce_app_version_grant_coherence() RETURNS trigger AS $$
BEGIN
  PERFORM assert_app_installation_grant_coherence(NEW.org_id, NEW.installation_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_installations_grant_coherence_trigger ON app_installations;
CREATE CONSTRAINT TRIGGER app_installations_grant_coherence_trigger
  AFTER INSERT OR UPDATE ON app_installations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_app_installation_grant_coherence();

DROP TRIGGER IF EXISTS app_versions_grant_coherence_trigger ON app_versions;
CREATE CONSTRAINT TRIGGER app_versions_grant_coherence_trigger
  AFTER INSERT OR UPDATE ON app_versions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_app_version_grant_coherence();

-- Override creation/deletion is authorization drift too. Propagate it to the
-- connector version so review and live authorization share one monotonic CAS.
CREATE OR REPLACE FUNCTION bump_mcp_connection_app_run_authorization_version() RETURNS trigger AS $$
BEGIN
  IF (NEW.slug, NEW.server_url, NEW.transport, NEW.stdio_command, NEW.stdio_args,
      NEW.auth_type, NEW.auth_config_encrypted, NEW.is_active,
      NEW.default_trust_tier, NEW.enabled_tools)
    IS DISTINCT FROM
     (OLD.slug, OLD.server_url, OLD.transport, OLD.stdio_command, OLD.stdio_args,
      OLD.auth_type, OLD.auth_config_encrypted, OLD.is_active,
      OLD.default_trust_tier, OLD.enabled_tools)
  THEN
    NEW.app_run_authorization_version := OLD.app_run_authorization_version + 1;
  ELSIF NEW.app_run_authorization_version = OLD.app_run_authorization_version + 1 THEN
    NULL;
  ELSE
    NEW.app_run_authorization_version := OLD.app_run_authorization_version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION propagate_mcp_override_authorization_version() RETURNS trigger AS $$
DECLARE
  prior_connection_id text;
  next_connection_id text;
BEGIN
  IF TG_OP = 'UPDATE' AND
    (NEW.mcp_connection_id, NEW.tool_name, NEW.trust_tier_override, NEW.is_disabled)
      IS NOT DISTINCT FROM
    (OLD.mcp_connection_id, OLD.tool_name, OLD.trust_tier_override, OLD.is_disabled)
  THEN
    RETURN NULL;
  END IF;
  prior_connection_id := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.mcp_connection_id END;
  next_connection_id := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.mcp_connection_id END;
  UPDATE mcp_connections
     SET app_run_authorization_version = app_run_authorization_version + 1
   WHERE id IN (prior_connection_id, next_connection_id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mcp_tool_overrides_parent_authorization_trigger ON mcp_tool_overrides;
CREATE TRIGGER mcp_tool_overrides_parent_authorization_trigger
  AFTER INSERT OR UPDATE OR DELETE ON mcp_tool_overrides
  FOR EACH ROW EXECUTE FUNCTION propagate_mcp_override_authorization_version();
