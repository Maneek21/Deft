-- Additive v5 staging/review authority. Retain old rows; downgrade is not safe after v5 state.
ALTER TABLE app_versions DROP CONSTRAINT IF EXISTS app_versions_protocol_supported_check;
ALTER TABLE app_versions ADD CONSTRAINT app_versions_protocol_supported_check CHECK (protocol_version IN ('0', '1', '2', '3', '4', '5'));

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

  IF installation.state = 'active' AND version_protocol IN ('1', '2', '3', '4', '5') THEN
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

-- A v5 effective snapshot is only a reviewed App declaration. It must pin
-- the exact stored App/requested ancestry and cannot masquerade as consent.
-- Older effective snapshots keep their historical shape and bytes.
CREATE OR REPLACE FUNCTION enforce_app_v5_effective_grant_shape() RETURNS trigger AS $$
DECLARE
  version_row app_versions%ROWTYPE;
  installation_row app_installations%ROWTYPE;
  requested_row app_grant_snapshots%ROWTYPE;
  descriptor jsonb;
  snapshot_json jsonb;
  declared_descriptors jsonb;
BEGIN
  IF NEW.snapshot_kind <> 'effective' THEN RETURN NEW; END IF;
  SELECT * INTO version_row FROM app_versions WHERE org_id = NEW.org_id
    AND installation_id = NEW.app_installation_id AND id = NEW.app_version_id;
  IF NOT FOUND OR version_row.protocol_version <> '5' THEN RETURN NEW; END IF;
  SELECT * INTO installation_row FROM app_installations WHERE org_id = NEW.org_id
    AND id = NEW.app_installation_id;
  SELECT * INTO requested_row FROM app_grant_snapshots WHERE org_id = NEW.org_id
    AND app_installation_id = NEW.app_installation_id AND app_version_id = NEW.app_version_id
    AND id = NEW.requested_snapshot_id AND snapshot_kind = 'requested';
  IF installation_row.id IS NULL OR requested_row.id IS NULL THEN
    RAISE EXCEPTION 'APP_V5_GRANT_ANCESTRY_MISSING' USING ERRCODE = '23514';
  END IF;
  snapshot_json := NEW.canonical_snapshot;
  IF NOT (snapshot_json ?& ARRAY['schema','lineage_key','package_digest','manifest_digest',
      'runtime_actions','sync_descriptors','modules','experiences','public_actions',
      'organization_id','app_installation_id','app_version_id','requested_snapshot_id',
      'requested_snapshot_digest','classification','review_digest'])
    OR snapshot_json - ARRAY['schema','lineage_key','package_digest','manifest_digest',
      'runtime_actions','sync_descriptors','modules','experiences','public_actions',
      'organization_id','app_installation_id','app_version_id','requested_snapshot_id',
      'requested_snapshot_digest','classification','review_digest'] <> '{}'::jsonb
    OR snapshot_json->>'schema' IS DISTINCT FROM 'deft.app_runtime_grant.v2'
    OR snapshot_json->>'lineage_key' IS DISTINCT FROM installation_row.lineage_key
    OR snapshot_json->>'package_digest' IS DISTINCT FROM version_row.package_digest
    OR snapshot_json->>'manifest_digest' IS DISTINCT FROM version_row.manifest_digest
    OR snapshot_json->>'organization_id' IS DISTINCT FROM NEW.org_id
    OR snapshot_json->>'app_installation_id' IS DISTINCT FROM NEW.app_installation_id
    OR snapshot_json->>'app_version_id' IS DISTINCT FROM NEW.app_version_id
    OR snapshot_json->>'requested_snapshot_id' IS DISTINCT FROM NEW.requested_snapshot_id
    OR snapshot_json->>'requested_snapshot_digest' IS DISTINCT FROM requested_row.snapshot_digest
    OR NOT COALESCE((snapshot_json->>'review_digest' ~ '^sha256:[a-f0-9]{64}$'), false)
    OR NEW.resource_rights <> '[]'::jsonb
    OR NEW.classification <> '{"authority_state":"effective","executable":false,"provider_access":false,"runtime_binding_review_required":true,"resource_binding_consent_required":true}'::jsonb
    OR snapshot_json->'classification' IS DISTINCT FROM NEW.classification THEN
    RAISE EXCEPTION 'APP_V5_GRANT_SHAPE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(snapshot_json->'runtime_actions') IS DISTINCT FROM 'array'
    OR jsonb_typeof(snapshot_json->'sync_descriptors') IS DISTINCT FROM 'array'
    OR jsonb_typeof(snapshot_json->'modules') IS DISTINCT FROM 'array'
    OR jsonb_typeof(snapshot_json->'experiences') IS DISTINCT FROM 'array'
    OR jsonb_typeof(snapshot_json->'public_actions') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'APP_V5_GRANT_ARRAY_INVALID' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(snapshot_json->'sync_descriptors') NOT BETWEEN 1 AND 8
    OR jsonb_array_length(snapshot_json->'runtime_actions') > 16
    OR jsonb_array_length(snapshot_json->'modules') > 15
    OR jsonb_array_length(snapshot_json->'experiences') > 1
    OR jsonb_array_length(snapshot_json->'public_actions') > 8 THEN
    RAISE EXCEPTION 'APP_V5_GRANT_LIMIT_INVALID' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(jsonb_agg(item.value - 'descriptor_digest' ORDER BY item.ordinality), '[]'::jsonb)
    INTO declared_descriptors FROM jsonb_array_elements(snapshot_json->'sync_descriptors')
      WITH ORDINALITY AS item(value, ordinality);
  IF declared_descriptors IS DISTINCT FROM version_row.manifest->'sync_descriptors'
    OR snapshot_json->'modules' IS DISTINCT FROM version_row.manifest->'modules'
    OR snapshot_json->'experiences' IS DISTINCT FROM version_row.manifest->'experiences'
    OR snapshot_json->'public_actions' IS DISTINCT FROM version_row.manifest->'public_actions'
    OR jsonb_array_length(snapshot_json->'runtime_actions')
      IS DISTINCT FROM jsonb_array_length(version_row.manifest->'runtime_actions') THEN
    RAISE EXCEPTION 'APP_V5_GRANT_DECLARATION_MISMATCH' USING ERRCODE = '23514';
  END IF;
  FOR descriptor IN SELECT value FROM jsonb_array_elements(snapshot_json->'sync_descriptors') LOOP
    IF jsonb_typeof(descriptor) IS DISTINCT FROM 'object'
      OR NOT (descriptor ?& ARRAY['schema_version','key','runtime_requirement_key',
        'resource_type','requested_visibility','record_schema','label_field','descriptor_digest'])
      OR descriptor - ARRAY['schema_version','key','runtime_requirement_key',
        'resource_type','requested_visibility','record_schema','label_field','descriptor_digest'] <> '{}'::jsonb
      OR descriptor->>'schema_version' IS DISTINCT FROM 'deft.app_sync_descriptor.v1'
      OR descriptor->>'requested_visibility' IS DISTINCT FROM 'user_private'
      OR NOT COALESCE((descriptor->>'descriptor_digest' ~ '^sha256:[a-f0-9]{64}$'), false)
      OR jsonb_typeof(descriptor->'record_schema') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'APP_V5_GRANT_DESCRIPTOR_INVALID' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_grant_snapshots_v5_shape_trigger ON app_grant_snapshots;
CREATE CONSTRAINT TRIGGER app_grant_snapshots_v5_shape_trigger
  AFTER INSERT ON app_grant_snapshots DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_app_v5_effective_grant_shape();

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
        AND protocol_version IN ('1', '2', '3', '4', '5')
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
