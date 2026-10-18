-- Additive protocol. Rollback keeps v3 rows inert; do not downgrade the constraint with v3 data present.
ALTER TABLE app_versions DROP CONSTRAINT IF EXISTS app_versions_protocol_supported_check;
ALTER TABLE app_versions ADD CONSTRAINT app_versions_protocol_supported_check CHECK (protocol_version IN ('0', '1', '2', '3'));

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

  IF installation.state = 'active' AND version_protocol IN ('1', '2', '3') THEN
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
        AND protocol_version IN ('1', '2', '3')
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
