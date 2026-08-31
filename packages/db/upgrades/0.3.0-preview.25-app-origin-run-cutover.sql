-- Permit the first reviewed connected-App action to persist governed Runs.
-- Runtime rollout remains controlled by the disabled-by-default API feature
-- gate; this migration only replaces the database's blanket deny with exact,
-- immutable App ancestry and the frozen sandbox-email policy shape.

ALTER TABLE app_runs
  DROP CONSTRAINT IF EXISTS app_runs_app_origin_disabled_check;
ALTER TABLE app_runs
  DROP CONSTRAINT IF EXISTS app_runs_app_identity_dormant_check;
ALTER TABLE app_runs
  DROP CONSTRAINT IF EXISTS app_runs_app_origin_coherence_check;
ALTER TABLE app_runs
  ADD CONSTRAINT app_runs_app_origin_coherence_check CHECK (
    (
      origin_kind = 'app'
      AND origin_app_installation_id IS NOT NULL
      AND origin_app_version_id IS NOT NULL
      AND origin_app_binding_key IS NOT NULL
      AND origin_app_grant_snapshot_id IS NOT NULL
      AND risk_class = 'external_write'
      AND review_requirement = 'always'
      AND review_scope = 'per_invocation'
      AND retry_class = 'idempotent_with_key'
      AND retention_class = 'standard'
    ) OR (
      origin_kind <> 'app'
      AND origin_app_installation_id IS NULL
      AND origin_app_version_id IS NULL
      AND origin_app_binding_key IS NULL
      AND origin_app_grant_snapshot_id IS NULL
    )
  );

-- App Runs pin immutable historical ancestry. They deliberately do not point
-- at the installation's mutable active-version/grant columns: upgrades and
-- revocation must remain able to advance those pointers while receipts retain
-- the exact authority used by an earlier Run.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_runs_app_installation_fk') THEN
    ALTER TABLE app_runs ADD CONSTRAINT app_runs_app_installation_fk
      FOREIGN KEY (org_id, origin_app_installation_id)
      REFERENCES app_installations(org_id, id) ON DELETE RESTRICT;
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

-- The action-binding FK above is also the effective-grant proof: every binding
-- is constrained to grant_snapshot_kind = 'effective' and has its own exact
-- composite FK to that effective grant snapshot.
