-- Additive owner-private files and immutable action payload custody. No Email tables.
CREATE TABLE IF NOT EXISTS app_private_files (
  id text PRIMARY KEY, org_id text NOT NULL, owner_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  installation_id text NOT NULL, resource_target_key text NOT NULL, state_key text NOT NULL, record_id text NOT NULL,
  artifact_digest text NOT NULL, declaration_digest text NOT NULL,
  upload_operation_id text NOT NULL, upload_revision integer NOT NULL, content_digest text NOT NULL, byte_length integer NOT NULL,
  metadata_envelope jsonb, ciphertext bytea, key_version text, nonce_b64 text, auth_tag_b64 text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  detached_at timestamptz, purged_at timestamptz,
  CONSTRAINT app_private_files_org_owner_id_unique UNIQUE(org_id,owner_user_id,id),
  CONSTRAINT app_private_files_operation_unique UNIQUE(org_id,owner_user_id,installation_id,upload_operation_id),
  CONSTRAINT app_private_files_installation_fk FOREIGN KEY(org_id,installation_id) REFERENCES app_installations(org_id,id) ON DELETE RESTRICT,
  CONSTRAINT app_private_files_identity_check CHECK(resource_target_key ~ '^[a-z][a-z0-9_]{0,47}$' AND state_key ~ '^[a-z][a-z0-9_]{0,47}$'
    AND artifact_digest ~ '^sha256:[a-f0-9]{64}$' AND declaration_digest ~ '^sha256:[a-f0-9]{64}$'
    AND content_digest ~ '^[a-f0-9]{64}$' AND upload_revision BETWEEN 1 AND 2147483646 AND byte_length BETWEEN 1 AND 2097152),
  CONSTRAINT app_private_files_body_check CHECK((purged_at IS NULL AND ciphertext IS NOT NULL AND octet_length(ciphertext)=byte_length
    AND key_version IS NOT NULL AND nonce_b64 IS NOT NULL AND auth_tag_b64 IS NOT NULL AND nonce_b64 ~ '^[A-Za-z0-9+/]{16}$' AND auth_tag_b64 ~ '^[A-Za-z0-9+/]{22}==$'
    AND metadata_envelope IS NOT NULL AND jsonb_typeof(metadata_envelope)='object' AND octet_length(metadata_envelope::text)<=24576)
    OR (purged_at IS NOT NULL AND ciphertext IS NULL AND key_version IS NULL AND nonce_b64 IS NULL AND auth_tag_b64 IS NULL AND metadata_envelope IS NULL)),
  CONSTRAINT app_private_files_expiry_check CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days')
);
CREATE INDEX IF NOT EXISTS app_private_files_scope_idx ON app_private_files(org_id,owner_user_id,installation_id,state_key,record_id);
CREATE INDEX IF NOT EXISTS app_private_files_expiry_idx ON app_private_files(expires_at);

CREATE TABLE IF NOT EXISTS app_action_payloads (
  id text PRIMARY KEY, org_id text NOT NULL, owner_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  installation_id text NOT NULL, app_version_id text NOT NULL, grant_snapshot_id text NOT NULL,
  resource_target_key text NOT NULL, state_key text NOT NULL, draft_id text NOT NULL, draft_revision integer NOT NULL,
  artifact_digest text NOT NULL, declaration_digest text NOT NULL, runtime_binding_id text NOT NULL, action_key text NOT NULL,
  action_contract_digest text NOT NULL, input_digest text NOT NULL, snapshot_digest text NOT NULL, bytes_digest text NOT NULL, byte_length integer NOT NULL,
  metadata_envelope jsonb, ciphertext bytea, key_version text, nonce_b64 text, auth_tag_b64 text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, purged_at timestamptz,
  CONSTRAINT app_action_payloads_org_owner_id_unique UNIQUE(org_id,owner_user_id,id),
  CONSTRAINT app_action_payloads_exact_reference_unique UNIQUE(org_id,owner_user_id,id,snapshot_digest),
  CONSTRAINT app_action_payloads_equivalent_unique UNIQUE(org_id,owner_user_id,installation_id,snapshot_digest),
  CONSTRAINT app_action_payloads_installation_fk FOREIGN KEY(org_id,installation_id) REFERENCES app_installations(org_id,id) ON DELETE RESTRICT,
  CONSTRAINT app_action_payloads_identity_check CHECK(resource_target_key ~ '^[a-z][a-z0-9_]{0,47}$' AND state_key ~ '^[a-z][a-z0-9_]{0,47}$'
    AND action_key ~ '^[a-z][a-z0-9_]{0,47}$' AND draft_revision BETWEEN 1 AND 2147483646
    AND artifact_digest ~ '^sha256:[a-f0-9]{64}$' AND declaration_digest ~ '^sha256:[a-f0-9]{64}$'
    AND action_contract_digest ~ '^sha256:[a-f0-9]{64}$' AND input_digest ~ '^sha256:[a-f0-9]{64}$'
    AND snapshot_digest ~ '^[a-f0-9]{64}$' AND bytes_digest ~ '^[a-f0-9]{64}$' AND byte_length BETWEEN 1 AND 8388608),
  CONSTRAINT app_action_payloads_body_check CHECK((purged_at IS NULL AND ciphertext IS NOT NULL AND octet_length(ciphertext)=byte_length
    AND key_version IS NOT NULL AND nonce_b64 IS NOT NULL AND auth_tag_b64 IS NOT NULL AND nonce_b64 ~ '^[A-Za-z0-9+/]{16}$' AND auth_tag_b64 ~ '^[A-Za-z0-9+/]{22}==$'
    AND metadata_envelope IS NOT NULL AND jsonb_typeof(metadata_envelope)='object' AND octet_length(metadata_envelope::text)<=98304)
    OR (purged_at IS NOT NULL AND ciphertext IS NULL AND key_version IS NULL AND nonce_b64 IS NULL AND auth_tag_b64 IS NULL AND metadata_envelope IS NULL)),
  CONSTRAINT app_action_payloads_expiry_check CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days')
);
CREATE INDEX IF NOT EXISTS app_action_payloads_scope_idx ON app_action_payloads(org_id,owner_user_id,installation_id,state_key);
CREATE INDEX IF NOT EXISTS app_action_payloads_expiry_idx ON app_action_payloads(expires_at);

CREATE TABLE IF NOT EXISTS app_action_payload_files (
  org_id text NOT NULL, owner_user_id text NOT NULL, snapshot_id text NOT NULL, file_id text NOT NULL, position integer NOT NULL,
  CONSTRAINT app_action_payload_files_pkey PRIMARY KEY(org_id,snapshot_id,file_id),
  CONSTRAINT app_action_payload_files_position_unique UNIQUE(org_id,snapshot_id,position),
  CONSTRAINT app_action_payload_files_payload_fk FOREIGN KEY(org_id,owner_user_id,snapshot_id) REFERENCES app_action_payloads(org_id,owner_user_id,id) ON DELETE RESTRICT,
  CONSTRAINT app_action_payload_files_file_fk FOREIGN KEY(org_id,owner_user_id,file_id) REFERENCES app_private_files(org_id,owner_user_id,id) ON DELETE RESTRICT,
  CONSTRAINT app_action_payload_files_position_check CHECK(position BETWEEN 0 AND 7)
);
ALTER TABLE app_run_human_authorizations ADD COLUMN IF NOT EXISTS snapshot_id text;
ALTER TABLE app_run_human_authorizations ADD COLUMN IF NOT EXISTS snapshot_digest text;
ALTER TABLE app_run_human_authorizations DROP CONSTRAINT IF EXISTS app_run_human_authorizations_payload_check;
ALTER TABLE app_run_human_authorizations ADD CONSTRAINT app_run_human_authorizations_payload_check CHECK(
  (snapshot_id IS NULL AND snapshot_digest IS NULL) OR (snapshot_id IS NOT NULL AND snapshot_digest IS NOT NULL AND snapshot_digest ~ '^[a-f0-9]{64}$'));
ALTER TABLE app_run_human_authorizations DROP CONSTRAINT IF EXISTS app_run_human_authorizations_payload_fk;
ALTER TABLE app_run_human_authorizations ADD CONSTRAINT app_run_human_authorizations_payload_fk
  FOREIGN KEY(org_id,owner_user_id,snapshot_id,snapshot_digest) REFERENCES app_action_payloads(org_id,owner_user_id,id,snapshot_digest) ON DELETE RESTRICT;

-- The prior effective-grant guard is reproduced below with separately reviewed
-- private file and action payload policies; existing absent policies stay absent.

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
  payload_policy jsonb;
  previous_action_key text;
  seen_payload_actions text[] := ARRAY[]::text[];
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
  IF NOT(snapshot_json ?& ARRAY['schema','lineage_key','package_digest','manifest_digest','sync_descriptors','modules','runtime_actions','native_actions','public_actions','experiences','host_policy','organization_id','app_installation_id','app_version_id','requested_snapshot_id','requested_snapshot_digest','classification','review_digest']) OR snapshot_json-ARRAY['private_state','schema','lineage_key','package_digest','manifest_digest','sync_descriptors','modules','runtime_actions','native_actions','public_actions','experiences','host_policy','organization_id','app_installation_id','app_version_id','requested_snapshot_id','requested_snapshot_digest','classification','review_digest']<>'{}'::jsonb
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
    IF jsonb_array_length(policy->'allowed_media_types') NOT BETWEEN 1 AND 8
      OR NOT(policy->'allowed_media_types'<@'["text/plain","text/csv","application/json","image/png","image/jpeg","image/gif","image/webp","application/pdf"]'::jsonb)
      OR jsonb_array_length(policy->'allowed_media_types')<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(policy->'allowed_media_types')) THEN
      RAISE EXCEPTION 'APP_V7_GRANT_ATTACHMENT_POLICY_INVALID' USING ERRCODE='23514'; END IF;
  END LOOP;
  -- Optional state is separately reviewed and exactly binds the signed manifest.
  IF snapshot_json ? 'private_state' OR version_row.manifest ? 'private_state' THEN
    IF snapshot_json->>'schema' IS DISTINCT FROM 'deft.app_blob_grant.v2'
      OR snapshot_json->'private_state' IS DISTINCT FROM version_row.manifest->'private_state'
      OR jsonb_typeof(snapshot_json->'private_state') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
    IF jsonb_array_length(snapshot_json->'private_state') NOT BETWEEN 1 AND 16 THEN
      RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
    FOR descriptor IN SELECT value FROM jsonb_array_elements(snapshot_json->'private_state') LOOP
      IF jsonb_typeof(descriptor) IS DISTINCT FROM 'object'
        OR NOT(descriptor ?& ARRAY['key','label','schema','max_record_bytes','max_records','max_total_bytes','retention_days'])
        OR descriptor-ARRAY['key','label','schema','max_record_bytes','max_records','max_total_bytes','retention_days','files','action_payloads']<>'{}'::jsonb
        OR NOT COALESCE(descriptor->>'key' ~ '^[a-z][a-z0-9_]{0,47}$',false)
        OR jsonb_typeof(descriptor->'label') IS DISTINCT FROM 'string'
        OR length(descriptor->>'label') NOT BETWEEN 1 AND 128
        OR jsonb_typeof(descriptor->'schema') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
      FOR policy_key,policy_max IN VALUES ('max_record_bytes',16384),('max_records',32),('max_total_bytes',131072),('retention_days',30) LOOP
        IF jsonb_typeof(descriptor->policy_key) IS DISTINCT FROM 'number' THEN
          RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
        IF (descriptor->>policy_key)::numeric NOT BETWEEN 1 AND policy_max
          OR (descriptor->>policy_key)::numeric<>trunc((descriptor->>policy_key)::numeric) THEN
          RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
      END LOOP;
      IF descriptor ? 'files' THEN
        policy := descriptor->'files';
        IF jsonb_typeof(policy) IS DISTINCT FROM 'object'
          OR NOT(policy ?& ARRAY['max_file_bytes','max_files_per_record','max_total_bytes_per_record','allowed_media_types'])
          OR policy-ARRAY['max_file_bytes','max_files_per_record','max_total_bytes_per_record','allowed_media_types']<>'{}'::jsonb THEN
          RAISE EXCEPTION 'APP_V7_PRIVATE_FILE_POLICY_INVALID' USING ERRCODE='23514'; END IF;
        FOR policy_key,policy_max IN VALUES ('max_file_bytes',2097152),('max_files_per_record',8),('max_total_bytes_per_record',8388608) LOOP
          IF jsonb_typeof(policy->policy_key) IS DISTINCT FROM 'number' THEN
            RAISE EXCEPTION 'APP_V7_PRIVATE_FILE_POLICY_INVALID' USING ERRCODE='23514'; END IF;
          IF (policy->>policy_key)::numeric NOT BETWEEN 1 AND policy_max
            OR (policy->>policy_key)::numeric<>trunc((policy->>policy_key)::numeric) THEN
            RAISE EXCEPTION 'APP_V7_PRIVATE_FILE_POLICY_INVALID' USING ERRCODE='23514'; END IF;
        END LOOP;
        IF (policy->>'max_file_bytes')::numeric>(policy->>'max_total_bytes_per_record')::numeric
          OR jsonb_typeof(policy->'allowed_media_types') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'APP_V7_PRIVATE_FILE_POLICY_INVALID' USING ERRCODE='23514'; END IF;
        IF jsonb_array_length(policy->'allowed_media_types') NOT BETWEEN 1 AND 8
          OR NOT(policy->'allowed_media_types'<@'["text/plain","text/csv","application/json","image/png","image/jpeg","image/gif","image/webp","application/pdf"]'::jsonb)
          OR jsonb_array_length(policy->'allowed_media_types')<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(policy->'allowed_media_types')) THEN
          RAISE EXCEPTION 'APP_V7_PRIVATE_FILE_POLICY_INVALID' USING ERRCODE='23514'; END IF;
      END IF;
      IF descriptor ? 'action_payloads' THEN
        IF jsonb_typeof(descriptor->'action_payloads') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'APP_V7_ACTION_PAYLOAD_POLICY_INVALID' USING ERRCODE='23514'; END IF;
        IF jsonb_array_length(descriptor->'action_payloads') NOT BETWEEN 1 AND 16 THEN
          RAISE EXCEPTION 'APP_V7_ACTION_PAYLOAD_POLICY_INVALID' USING ERRCODE='23514'; END IF;
        previous_action_key := NULL;
        FOR payload_policy IN SELECT value FROM jsonb_array_elements(descriptor->'action_payloads') LOOP
          IF jsonb_typeof(payload_policy) IS DISTINCT FROM 'object'
            OR NOT(payload_policy ?& ARRAY['action_key','max_payload_bytes'])
            OR payload_policy-ARRAY['action_key','max_payload_bytes']<>'{}'::jsonb
            OR NOT COALESCE(payload_policy->>'action_key' ~ '^[a-z][a-z0-9_]{0,47}$',false)
            OR payload_policy->>'action_key' IN ('constructor','prototype','__proto__')
            OR payload_policy->>'action_key' ~ '^(deft|core|system)(_|$)'
            OR jsonb_typeof(payload_policy->'max_payload_bytes') IS DISTINCT FROM 'number' THEN
            RAISE EXCEPTION 'APP_V7_ACTION_PAYLOAD_POLICY_INVALID' USING ERRCODE='23514'; END IF;
          IF (payload_policy->>'max_payload_bytes')::numeric NOT BETWEEN 1 AND 8388608
            OR (payload_policy->>'max_payload_bytes')::numeric<>trunc((payload_policy->>'max_payload_bytes')::numeric)
            OR (previous_action_key IS NOT NULL AND previous_action_key COLLATE "C">=(payload_policy->>'action_key') COLLATE "C")
            OR payload_policy->>'action_key'=ANY(seen_payload_actions)
            OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(version_row.manifest->'runtime_actions') action WHERE action->>'key'=payload_policy->>'action_key') THEN
            RAISE EXCEPTION 'APP_V7_ACTION_PAYLOAD_POLICY_INVALID' USING ERRCODE='23514'; END IF;
          previous_action_key := payload_policy->>'action_key';
          seen_payload_actions := array_append(seen_payload_actions,previous_action_key);
        END LOOP;
      END IF;
      IF (descriptor->>'max_record_bytes')::numeric>(descriptor->>'max_total_bytes')::numeric THEN
        RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
    END LOOP;
    IF (SELECT count(DISTINCT value->>'key') FROM jsonb_array_elements(snapshot_json->'private_state'))<>jsonb_array_length(snapshot_json->'private_state') THEN
      RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
