-- Separate protocol7 blob-grant.v2 composition; v1 and accepted0–6 remain
-- unchanged. No retained grants/bindings/sessions are rewritten or promoted.
CREATE OR REPLACE FUNCTION enforce_app_v7_effective_grant_shape() RETURNS trigger AS $$
DECLARE
  version_row app_versions%ROWTYPE;
  installation_row app_installations%ROWTYPE;
  requested_row app_grant_snapshots%ROWTYPE;
  snapshot_json jsonb;
  descriptor jsonb;
  declared_descriptors jsonb;
  policy jsonb;
  policy_key text;
  policy_max numeric;
BEGIN
  IF NEW.snapshot_kind <> 'effective' THEN RETURN NEW; END IF;
  SELECT * INTO version_row FROM app_versions WHERE org_id=NEW.org_id
    AND installation_id=NEW.app_installation_id AND id=NEW.app_version_id;
  IF NOT FOUND OR version_row.protocol_version<>'7' THEN RETURN NEW; END IF;
  SELECT * INTO installation_row FROM app_installations WHERE org_id=NEW.org_id AND id=NEW.app_installation_id;
  SELECT * INTO requested_row FROM app_grant_snapshots WHERE org_id=NEW.org_id
    AND app_installation_id=NEW.app_installation_id AND app_version_id=NEW.app_version_id
    AND id=NEW.requested_snapshot_id AND snapshot_kind='requested';
  IF installation_row.id IS NULL OR requested_row.id IS NULL THEN
    RAISE EXCEPTION 'APP_V7_GRANT_ANCESTRY_MISSING' USING ERRCODE='23514'; END IF;
  snapshot_json:=NEW.canonical_snapshot;
  IF NOT(snapshot_json ?& ARRAY['schema','lineage_key','package_digest','manifest_digest','sync_descriptors','modules','runtime_actions','native_actions','public_actions','experiences','host_policy','organization_id','app_installation_id','app_version_id','requested_snapshot_id','requested_snapshot_digest','classification','review_digest']) OR snapshot_json-ARRAY['schema','lineage_key','package_digest','manifest_digest','sync_descriptors','modules','runtime_actions','native_actions','public_actions','experiences','host_policy','organization_id','app_installation_id','app_version_id','requested_snapshot_id','requested_snapshot_digest','classification','review_digest']<>'{}'::jsonb
    OR snapshot_json->>'schema' IS NULL OR snapshot_json->>'schema' NOT IN ('deft.app_blob_grant.v1','deft.app_blob_grant.v2')
    OR snapshot_json->>'lineage_key' IS DISTINCT FROM installation_row.lineage_key
    OR snapshot_json->>'package_digest' IS DISTINCT FROM version_row.package_digest
    OR snapshot_json->>'manifest_digest' IS DISTINCT FROM version_row.manifest_digest
    OR snapshot_json->>'organization_id' IS DISTINCT FROM NEW.org_id
    OR snapshot_json->>'app_installation_id' IS DISTINCT FROM NEW.app_installation_id
    OR snapshot_json->>'app_version_id' IS DISTINCT FROM NEW.app_version_id
    OR snapshot_json->>'requested_snapshot_id' IS DISTINCT FROM NEW.requested_snapshot_id
    OR snapshot_json->>'requested_snapshot_digest' IS DISTINCT FROM requested_row.snapshot_digest
    OR NOT COALESCE(snapshot_json->>'review_digest' ~ '^sha256:[a-f0-9]{64}$',false)
    OR NEW.resource_rights<>'[]'::jsonb
    OR NEW.classification<>'{"authority_state":"effective","executable":false,"provider_access":false,"runtime_binding_review_required":true,"resource_binding_consent_required":true,"attachment_policy_review_required":true}'::jsonb
    OR snapshot_json->'classification' IS DISTINCT FROM NEW.classification
    OR snapshot_json->'host_policy' IS DISTINCT FROM '{"encrypted_custody":true,"current_parent_required":true,"provider_url_fetch":false,"irrecoverable_host_purge":true,"owner_only":true,"stage_ceiling_seconds":3600}'::jsonb THEN
    RAISE EXCEPTION 'APP_V7_GRANT_SHAPE_INVALID' USING ERRCODE='23514'; END IF;
  IF jsonb_typeof(snapshot_json->'sync_descriptors') IS DISTINCT FROM 'array'
    OR jsonb_typeof(snapshot_json->'modules') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'APP_V7_GRANT_ARRAY_INVALID' USING ERRCODE='23514'; END IF;
  IF jsonb_array_length(snapshot_json->'sync_descriptors') NOT BETWEEN 1 AND 8
    OR jsonb_array_length(snapshot_json->'modules')>15
    OR snapshot_json->'modules' IS DISTINCT FROM version_row.manifest->'modules'
    OR snapshot_json->'native_actions' IS DISTINCT FROM '[]'::jsonb
    OR snapshot_json->'public_actions' IS DISTINCT FROM '[]'::jsonb
    OR version_row.manifest->'native_actions' IS DISTINCT FROM '[]'::jsonb
    OR version_row.manifest->'public_actions' IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'APP_V7_GRANT_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
  IF snapshot_json->>'schema'='deft.app_blob_grant.v1' THEN
    -- Preserve the exact v1 empty-plane requirement; no existing grant widens.
    IF snapshot_json->'runtime_actions' IS DISTINCT FROM '[]'::jsonb
      OR snapshot_json->'experiences' IS DISTINCT FROM '[]'::jsonb
      OR version_row.manifest->'runtime_actions' IS DISTINCT FROM '[]'::jsonb
      OR version_row.manifest->'experiences' IS DISTINCT FROM '[]'::jsonb
      OR version_row.manifest->'private_capabilities' IS DISTINCT FROM '[]'::jsonb THEN
      RAISE EXCEPTION 'APP_V7_GRANT_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
  ELSE
    -- Only the separately reviewed composition shape admits Runtime and
    -- verified Experience declarations; native and public stay empty above.
    IF jsonb_typeof(snapshot_json->'runtime_actions') IS DISTINCT FROM 'array'
      OR jsonb_typeof(version_row.manifest->'runtime_actions') IS DISTINCT FROM 'array'
      OR jsonb_typeof(version_row.manifest->'private_capabilities') IS DISTINCT FROM 'array'
      OR jsonb_typeof(version_row.manifest->'runtime_requirements') IS DISTINCT FROM 'array'
      OR jsonb_typeof(version_row.manifest->'experiences') IS DISTINCT FROM 'array'
      OR snapshot_json->'experiences' IS DISTINCT FROM version_row.manifest->'experiences' THEN
      RAISE EXCEPTION 'APP_V7_COMPOSITION_ARRAY_INVALID' USING ERRCODE='23514'; END IF;
    IF jsonb_array_length(snapshot_json->'runtime_actions')<>jsonb_array_length(version_row.manifest->'runtime_actions') THEN
      RAISE EXCEPTION 'APP_V7_COMPOSITION_ACTION_MISMATCH' USING ERRCODE='23514'; END IF;
    FOR descriptor IN SELECT value FROM jsonb_array_elements(snapshot_json->'runtime_actions') LOOP
      IF jsonb_typeof(descriptor) IS DISTINCT FROM 'object'
        OR NOT(descriptor ?& ARRAY['action_key','runtime_requirement_key','interface','operation_name','input_schema','output_schema','contract_digest','host_policy'])
        OR descriptor-ARRAY['action_key','runtime_requirement_key','interface','operation_name','input_schema','output_schema','contract_digest','host_policy']<>'{}'::jsonb
        OR NOT COALESCE(descriptor->>'contract_digest' ~ '^sha256:[a-f0-9]{64}$',false)
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(version_row.manifest->'runtime_actions') action
          JOIN jsonb_array_elements(version_row.manifest->'private_capabilities') capability
            ON capability->>'key'=action->>'capability_key'
          JOIN jsonb_array_elements(version_row.manifest->'runtime_requirements') requirement
            ON requirement->>'key'=action->>'runtime_requirement_key'
          WHERE requirement->>'protocol_version'='deft.app_runtime_channel.v1'
            AND capability->>'version'='1'
            AND jsonb_typeof(capability->'input_schema')='object'
            AND jsonb_typeof(capability->'output_schema')='object'
            AND descriptor-'contract_digest'=jsonb_build_object(
              'action_key',action->'key','runtime_requirement_key',action->'runtime_requirement_key',
              'interface',jsonb_build_object('namespace','app_lineage','key',capability->'key','version',capability->'version'),
              'operation_name',action->'key','input_schema',capability->'input_schema','output_schema',capability->'output_schema',
              'host_policy','{"risk_class":"external_write","review_requirement":"always","review_scope":"per_invocation","retry_class":"unsafe_or_unknown","retention_class":"standard"}'::jsonb)) THEN
        RAISE EXCEPTION 'APP_V7_COMPOSITION_ACTION_MISMATCH' USING ERRCODE='23514'; END IF;
    END LOOP;
    IF (SELECT count(DISTINCT value->>'action_key') FROM jsonb_array_elements(snapshot_json->'runtime_actions'))<>jsonb_array_length(snapshot_json->'runtime_actions') THEN
      RAISE EXCEPTION 'APP_V7_COMPOSITION_ACTION_MISMATCH' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT COALESCE(jsonb_agg(item.value-'descriptor_digest' ORDER BY item.ordinality),'[]'::jsonb)
    INTO declared_descriptors FROM jsonb_array_elements(snapshot_json->'sync_descriptors') WITH ORDINALITY AS item(value,ordinality);
  IF declared_descriptors IS DISTINCT FROM version_row.manifest->'sync_descriptors' THEN
    RAISE EXCEPTION 'APP_V7_GRANT_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
  FOR descriptor IN SELECT value FROM jsonb_array_elements(snapshot_json->'sync_descriptors') LOOP
    IF jsonb_typeof(descriptor) IS DISTINCT FROM 'object'
      OR NOT(descriptor ?& ARRAY['schema_version','key','runtime_requirement_key','resource_type','requested_visibility','record_schema','label_field','attachments','descriptor_digest'])
      OR descriptor-ARRAY['schema_version','key','runtime_requirement_key','resource_type','requested_visibility','record_schema','label_field','attachments','descriptor_digest']<>'{}'::jsonb
      OR descriptor->>'schema_version' IS DISTINCT FROM 'deft.app_sync_descriptor.v2'
      OR descriptor->>'requested_visibility' IS DISTINCT FROM 'user_private'
      OR NOT COALESCE(descriptor->>'descriptor_digest' ~ '^sha256:[a-f0-9]{64}$',false)
      OR jsonb_typeof(descriptor->'record_schema') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'APP_V7_GRANT_DESCRIPTOR_INVALID' USING ERRCODE='23514'; END IF;
    policy:=descriptor->'attachments';
    IF jsonb_typeof(policy) IS DISTINCT FROM 'object'
      OR NOT(policy ?& ARRAY['max_attachment_bytes','max_attachments_per_record','max_attachments_per_run','max_attachment_bytes_per_run','retention_days','allowed_media_types'])
      OR policy-ARRAY['max_attachment_bytes','max_attachments_per_record','max_attachments_per_run','max_attachment_bytes_per_run','retention_days','allowed_media_types']<>'{}'::jsonb THEN
      RAISE EXCEPTION 'APP_V7_GRANT_ATTACHMENT_POLICY_INVALID' USING ERRCODE='23514'; END IF;
    FOR policy_key,policy_max IN VALUES ('max_attachment_bytes',2097152),('max_attachments_per_record',8),
      ('max_attachments_per_run',32),('max_attachment_bytes_per_run',8388608),('retention_days',30) LOOP
      IF jsonb_typeof(policy->policy_key) IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'APP_V7_GRANT_ATTACHMENT_POLICY_INVALID' USING ERRCODE='23514'; END IF;
      IF (policy->>policy_key)::numeric NOT BETWEEN 1 AND policy_max
        OR (policy->>policy_key)::numeric<>trunc((policy->>policy_key)::numeric) THEN
        RAISE EXCEPTION 'APP_V7_GRANT_ATTACHMENT_POLICY_INVALID' USING ERRCODE='23514'; END IF;
    END LOOP;
    IF jsonb_typeof(policy->'allowed_media_types') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'APP_V7_GRANT_ATTACHMENT_POLICY_INVALID' USING ERRCODE='23514'; END IF;
    IF jsonb_array_length(policy->'allowed_media_types') NOT BETWEEN 1 AND 7
      OR NOT(policy->'allowed_media_types'<@'["text/plain","text/csv","application/json","image/png","image/jpeg","image/gif","image/webp"]'::jsonb)
      OR jsonb_array_length(policy->'allowed_media_types')<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(policy->'allowed_media_types')) THEN
      RAISE EXCEPTION 'APP_V7_GRANT_ATTACHMENT_POLICY_INVALID' USING ERRCODE='23514'; END IF;
  END LOOP;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_v7_effective_grant_shape_trigger ON app_grant_snapshots;
CREATE TRIGGER app_v7_effective_grant_shape_trigger BEFORE INSERT ON app_grant_snapshots
  FOR EACH ROW EXECUTE FUNCTION enforce_app_v7_effective_grant_shape();
