-- One current private consent per owner, App and declared resource under the
-- exact reviewed grant. Revoked history is retained; a new grant never revives
-- its historical bindings. Host admission still checks all live ancestry.
CREATE UNIQUE INDEX IF NOT EXISTS app_resource_bindings_one_current_consent_unique
  ON app_resource_bindings (org_id, app_installation_id, grant_snapshot_id,
    owner_user_id, resource_key)
  WHERE state <> 'revoked';
