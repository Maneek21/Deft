-- Generic separately reviewed recurring record-write purpose. MIME and private
-- provider references remain exclusively in the independent runtime journal.
CREATE TABLE app_prepared_record_action_receipts (
 org_id text NOT NULL,run_id text NOT NULL,owner_user_id text NOT NULL,receipt jsonb NOT NULL,receipt_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 PRIMARY KEY(org_id,run_id),
 CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=8192 AND receipt_digest ~ '^sha256:[a-f0-9]{64}$' AND isfinite(expires_at) AND expires_at>created_at)
);
CREATE OR REPLACE FUNCTION deft_prepared_record_action_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'prepared record source receipt immutable';END IF;
 IF NOT EXISTS(SELECT 1 FROM app_runs r WHERE r.org_id=NEW.org_id AND r.id=NEW.run_id AND r.initiating_actor_type='human' AND r.initiating_actor_id=NEW.owner_user_id AND r.provider_kind='app_runtime' AND r.origin_kind='app'
  AND r.operation_name=NEW.receipt->>'action_key' AND r.input_fingerprint=NEW.receipt->>'run_input_fingerprint'
  AND r.origin_app_installation_id=NEW.receipt->'scope'->>'installation_id' AND r.origin_app_version_id=NEW.receipt->'scope'->>'app_version_id' AND r.origin_app_grant_snapshot_id=NEW.receipt->'scope'->>'grant_snapshot_id'
  AND NEW.expires_at<=r.result_expires_at) THEN RAISE EXCEPTION 'prepared record receipt requires exact reviewed Run';END IF;RETURN NEW;
END;$$;
CREATE TRIGGER prepared_record_action_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON app_prepared_record_action_receipts FOR EACH ROW EXECUTE FUNCTION deft_prepared_record_action_receipt_guard();
CREATE TABLE app_record_mirror_authorities (
 org_id text NOT NULL,owner_user_id text NOT NULL,receipt_id text NOT NULL,
 request_id text NOT NULL,review_web_session_id text NOT NULL,
 revision integer NOT NULL DEFAULT 1,state text NOT NULL DEFAULT 'enabled',
 store_key text NOT NULL,mirror_key text NOT NULL,account_ref text NOT NULL,
 installation_id text NOT NULL,app_version_id text NOT NULL,grant_snapshot_id text NOT NULL,
 runtime_registration_id text NOT NULL,resource_binding_id text NOT NULL,
 reviewed_authority jsonb NOT NULL,authority_digest text NOT NULL,policy_digest text NOT NULL,
 expires_at timestamptz NOT NULL,max_attempts_per_day integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,receipt_id),UNIQUE(org_id,owner_user_id,request_id),
 CHECK((receipt_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 AND request_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 AND account_ref ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 AND revision BETWEEN 1 AND 2147483646 AND state IN ('enabled','paused','revoked','expired')
 AND store_key ~ '^[a-z][a-z0-9_]{0,47}$' AND mirror_key ~ '^[a-z][a-z0-9_]{0,47}$'
 AND authority_digest ~ '^sha256:[a-f0-9]{64}$' AND policy_digest ~ '^sha256:[a-f0-9]{64}$'
 AND jsonb_typeof(reviewed_authority)='object' AND octet_length(reviewed_authority::text)<=65536
 AND isfinite(created_at) AND isfinite(updated_at) AND isfinite(expires_at)
 AND created_at<=updated_at AND created_at<expires_at AND expires_at<=created_at+interval '90 days'
 AND max_attempts_per_day BETWEEN 1 AND 1000) IS TRUE)
);
CREATE UNIQUE INDEX app_record_mirror_current ON app_record_mirror_authorities(org_id,owner_user_id,installation_id,store_key,mirror_key,account_ref) WHERE state='enabled';
CREATE TABLE app_record_mirror_runs (
 org_id text NOT NULL,receipt_id text NOT NULL,run_id text NOT NULL,request_id text NOT NULL,
 input_digest text NOT NULL,run_input_fingerprint text NOT NULL,input jsonb NOT NULL,record_id text NOT NULL,record_revision integer NOT NULL,
 snapshot_digest text NOT NULL,operation text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,run_id),UNIQUE(org_id,receipt_id,request_id),
 FOREIGN KEY(org_id,receipt_id) REFERENCES app_record_mirror_authorities(org_id,receipt_id),
 CHECK((request_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 AND run_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 AND record_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 AND record_revision BETWEEN 1 AND 2147483646 AND input_digest ~ '^sha256:[a-f0-9]{64}$'
 AND run_input_fingerprint ~ '^hmac-sha256:[a-f0-9]{64}$' AND jsonb_typeof(input)='object' AND octet_length(input::text)<=8192 AND snapshot_digest ~ '^sha256:[a-f0-9]{64}$' AND operation IN ('create','update','inspect','delete') AND isfinite(created_at)) IS TRUE)
);
CREATE INDEX app_record_mirror_budget ON app_record_mirror_runs(org_id,receipt_id,created_at);
CREATE OR REPLACE FUNCTION deft_app_record_mirror_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'mirror authority history retained';END IF;
 IF TG_TABLE_NAME='app_record_mirror_runs' THEN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'mirror operation identity immutable';END IF;RETURN NEW;
 END IF;
 IF TG_OP='INSERT' THEN IF NEW.state<>'enabled' OR NEW.revision<>1 THEN RAISE EXCEPTION 'mirror requires human reviewed enable';END IF;RETURN NEW;END IF;
 IF (to_jsonb(NEW)-ARRAY['revision','state','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','state','updated_at'])
 OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
 OR NOT(OLD.state='enabled' AND NEW.state IN ('paused','revoked','expired') OR OLD.state='paused' AND NEW.state IN ('revoked','expired'))
 THEN RAISE EXCEPTION 'mirror reviewed identity/expiry immutable';END IF;RETURN NEW;
END;$$;
CREATE TRIGGER app_record_mirror_authority_history_guard BEFORE INSERT OR UPDATE OR DELETE ON app_record_mirror_authorities FOR EACH ROW EXECUTE FUNCTION deft_app_record_mirror_history_guard();
CREATE TRIGGER app_record_mirror_run_history_guard BEFORE INSERT OR UPDATE OR DELETE ON app_record_mirror_runs FOR EACH ROW EXECUTE FUNCTION deft_app_record_mirror_history_guard();
ALTER TABLE app_runs DROP CONSTRAINT app_runs_execution_release_shape_check;
ALTER TABLE app_runs ADD CONSTRAINT app_runs_execution_release_shape_check CHECK (
 (execution_release_kind IS NULL AND execution_released_at IS NULL) OR
 (execution_release_kind IS NOT NULL AND execution_released_at IS NOT NULL AND (
  (review_requirement='always' AND review_scope='per_invocation' AND execution_release_kind IN ('approved','record_mirror')) OR
  (review_requirement='always' AND review_scope='approved_automation_definition' AND execution_release_kind='approved_automation_definition') OR
  (review_requirement='policy' AND execution_release_kind IN ('policy_satisfied','approved')))));
CREATE OR REPLACE FUNCTION deft_app_record_mirror_release_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.execution_release_kind='record_mirror' AND (TG_OP='INSERT' OR OLD.execution_release_kind IS NULL) THEN
  IF NEW.provider_kind<>'app_runtime' OR NEW.origin_kind<>'app' OR NEW.initiating_actor_type<>'human'
   OR NOT EXISTS(SELECT 1 FROM app_record_mirror_runs m JOIN app_record_mirror_authorities a ON a.org_id=m.org_id AND a.receipt_id=m.receipt_id
    WHERE m.org_id=NEW.org_id AND m.run_id=NEW.id AND m.run_input_fingerprint=NEW.input_fingerprint
     AND a.reviewed_authority->'policy'->>'action_key'=NEW.operation_name
     AND a.reviewed_authority->'action_consents'->0->>'action_binding_id'=NEW.origin_runtime_binding_id
     AND a.owner_user_id=NEW.initiating_actor_id AND a.installation_id=NEW.origin_app_installation_id
     AND a.app_version_id=NEW.origin_app_version_id AND a.grant_snapshot_id=NEW.origin_app_grant_snapshot_id
     AND a.state='enabled' AND a.expires_at>clock_timestamp())
  THEN RAISE EXCEPTION 'record mirror requires exact durable reviewed receipt';END IF;
 END IF;RETURN NEW;
END;$$;
CREATE TRIGGER app_record_mirror_release_guard BEFORE INSERT OR UPDATE ON app_runs FOR EACH ROW EXECUTE FUNCTION deft_app_record_mirror_release_guard();

CREATE OR REPLACE FUNCTION deft_app_record_mirrors_valid(actions jsonb,snapshot_json jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb;previous_key text;name text;minimum numeric;ceiling numeric;
BEGIN
 IF jsonb_typeof(actions) IS DISTINCT FROM 'array' OR jsonb_array_length(actions) NOT BETWEEN 1 AND 4 THEN RETURN false;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(actions) LOOP
  IF NOT COALESCE(jsonb_typeof(item)='object' AND item ?& ARRAY['schema_version','key','action_key','max_authority_seconds','max_attempts_per_day','max_mime_bytes','operations','cleanup'] AND item-ARRAY['schema_version','key','action_key','max_authority_seconds','max_attempts_per_day','max_mime_bytes','operations','cleanup','cleanup_action_keys']='{}'::jsonb
   AND item->>'schema_version'='deft.app_record_mirror.v1' AND item->>'key' ~ '^[a-z][a-z0-9_]{0,47}$' AND item->>'key' NOT IN ('constructor','prototype','__proto__') AND item->>'action_key' ~ '^[a-z][a-z0-9_]{0,47}$' AND item->>'action_key' NOT IN ('constructor','prototype','__proto__')
   AND (previous_key IS NULL OR previous_key COLLATE "C"<(item->>'key') COLLATE "C") AND item->'operations'='["create","update","inspect","delete"]'::jsonb AND item->>'cleanup'='matching_accepted_submission'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'runtime_actions') a WHERE a->>'action_key'=item->>'action_key'),false) THEN RETURN false;END IF;
  IF item ? 'cleanup_action_keys' AND (jsonb_typeof(item->'cleanup_action_keys') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'cleanup_action_keys') NOT BETWEEN 1 AND 4 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(item->'cleanup_action_keys') k WHERE k !~ '^[a-z][a-z0-9_]{0,47}$' OR k=item->>'action_key' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'runtime_actions') a WHERE a->>'action_key'=k)) OR (SELECT count(DISTINCT k) FROM jsonb_array_elements_text(item->'cleanup_action_keys') k)<>jsonb_array_length(item->'cleanup_action_keys') OR item->'cleanup_action_keys'<>(SELECT jsonb_agg(k ORDER BY k COLLATE "C") FROM jsonb_array_elements_text(item->'cleanup_action_keys') k)) THEN RETURN false;END IF;
  FOR name,minimum,ceiling IN VALUES ('max_authority_seconds',60,7776000),('max_attempts_per_day',1,1000),('max_mime_bytes',1,36700160) LOOP
   IF jsonb_typeof(item->name) IS DISTINCT FROM 'number' OR (item->>name)::numeric NOT BETWEEN minimum AND ceiling OR (item->>name)::numeric<>trunc((item->>name)::numeric) THEN RETURN false;END IF;
  END LOOP;previous_key:=item->>'key';
 END LOOP;
 IF (SELECT count(DISTINCT value->>'action_key') FROM jsonb_array_elements(actions))<>jsonb_array_length(actions) THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;END;$$;
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
  change_descriptor jsonb;
  previous_change_key text;
  local_job_descriptor jsonb;
  previous_local_job_key text;
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
  IF NOT(snapshot_json ?& ARRAY['schema','lineage_key','package_digest','manifest_digest','sync_descriptors','modules','runtime_actions','native_actions','public_actions','experiences','host_policy','organization_id','app_installation_id','app_version_id','requested_snapshot_id','requested_snapshot_digest','classification','review_digest']) OR snapshot_json-ARRAY['record_stores','owner_connections','private_state','schema','lineage_key','package_digest','manifest_digest','sync_descriptors','modules','runtime_actions','native_actions','public_actions','experiences','host_policy','organization_id','app_installation_id','app_version_id','requested_snapshot_id','requested_snapshot_digest','classification','review_digest']<>'{}'::jsonb
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
  -- Separately reviewed app-owned stores preserve every existing private-state budget.
  IF snapshot_json ? 'record_stores' OR version_row.manifest ? 'record_stores' THEN
    IF snapshot_json->>'schema' IS DISTINCT FROM 'deft.app_blob_grant.v2'
      OR snapshot_json->'record_stores' IS DISTINCT FROM version_row.manifest->'record_stores'
      OR jsonb_typeof(snapshot_json->'record_stores') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
    IF jsonb_array_length(snapshot_json->'record_stores') NOT BETWEEN 1 AND 16 THEN
      RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
    previous_action_key:=NULL;
    FOR policy IN SELECT value FROM jsonb_array_elements(snapshot_json->'record_stores') LOOP
      IF NOT COALESCE(jsonb_typeof(policy)='object'
        AND policy ?& ARRAY['schema_version','key','resource_key','runtime_requirement_key','max_record_bytes','max_files','max_file_bytes','max_total_file_bytes']
        AND policy-ARRAY['schema_version','key','resource_key','runtime_requirement_key','max_record_bytes','max_files','max_file_bytes','max_total_file_bytes','resource_content','record_changes','local_job_operations','future_record_actions','record_mirrors']='{}'::jsonb
        AND policy->>'schema_version'='deft.app_record_store.v1'
        AND policy->>'key' ~ '^[a-z][a-z0-9_]{0,47}$'
        AND policy->>'key' NOT IN ('constructor','prototype','__proto__')
        AND policy->>'resource_key' ~ '^[a-z][a-z0-9_]{0,47}$'
        AND policy->>'runtime_requirement_key' ~ '^[a-z][a-z0-9_]{0,47}$',false) THEN
        RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
      FOR policy_key,policy_max IN VALUES ('max_record_bytes',491520),('max_files',32),('max_file_bytes',26214400),('max_total_file_bytes',26214400) LOOP
        IF jsonb_typeof(policy->policy_key) IS DISTINCT FROM 'number' THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
        IF (policy->>policy_key)::numeric NOT BETWEEN (CASE WHEN policy_key='max_files' THEN 0 ELSE 1 END) AND policy_max
          OR (policy->>policy_key)::numeric<>trunc((policy->>policy_key)::numeric) THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
      END LOOP;
      IF (policy->>'max_file_bytes')::numeric>(policy->>'max_total_file_bytes')::numeric
        OR previous_action_key IS NOT NULL AND previous_action_key COLLATE "C">=(policy->>'key') COLLATE "C"
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'sync_descriptors') d WHERE d->>'key'=policy->>'resource_key'
          AND d->>'runtime_requirement_key'=policy->>'runtime_requirement_key' AND d->>'requested_visibility'='user_private')
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'owner_connections') p WHERE p->>'resource_key'=policy->>'resource_key'
          AND p->>'runtime_requirement_key'=policy->>'runtime_requirement_key' AND p ? 'provider_profile_key') THEN
        RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
      IF policy ? 'record_mirrors' AND NOT deft_app_record_mirrors_valid(policy->'record_mirrors',snapshot_json) THEN RAISE EXCEPTION 'APP_V7_RECORD_MIRROR_INVALID' USING ERRCODE='23514';END IF;
      IF policy ? 'future_record_actions' AND NOT deft_app_future_record_actions_valid(policy->'future_record_actions',snapshot_json) THEN RAISE EXCEPTION 'APP_V7_FUTURE_RECORD_ACTION_INVALID' USING ERRCODE='23514';END IF;
      IF policy ? 'local_job_operations' THEN
        IF jsonb_typeof(policy->'local_job_operations') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514';END IF;
        IF jsonb_array_length(policy->'local_job_operations') NOT BETWEEN 1 AND 8 THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514';END IF;
        previous_local_job_key:=NULL;
        FOR local_job_descriptor IN SELECT value FROM jsonb_array_elements(policy->'local_job_operations') LOOP
          IF NOT COALESCE(jsonb_typeof(local_job_descriptor)='object'
            AND local_job_descriptor ?& ARRAY['key','local_only'] AND local_job_descriptor-ARRAY['key','local_only']='{}'::jsonb
            AND local_job_descriptor->>'key' ~ '^[a-z][a-z0-9_]{0,47}$' AND local_job_descriptor->>'key' NOT IN ('constructor','prototype','__proto__')
            AND local_job_descriptor->'local_only'='true'::jsonb,false)
            OR previous_local_job_key IS NOT NULL AND previous_local_job_key COLLATE "C">=(local_job_descriptor->>'key') COLLATE "C" THEN
            RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514';END IF;
          previous_local_job_key:=local_job_descriptor->>'key';
        END LOOP;
      END IF;
      IF policy ? 'record_changes' THEN
        IF jsonb_typeof(policy->'record_changes') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
        IF jsonb_array_length(policy->'record_changes') NOT BETWEEN 1 AND 8 THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
        previous_change_key:=NULL;
        FOR change_descriptor IN SELECT value FROM jsonb_array_elements(policy->'record_changes') LOOP
          IF NOT COALESCE(jsonb_typeof(change_descriptor)='object'
            AND change_descriptor ?& ARRAY['key','source_store_key']
            AND change_descriptor-ARRAY['key','source_store_key']='{}'::jsonb
            AND change_descriptor->>'key' ~ '^[a-z][a-z0-9_]{0,47}$'
            AND change_descriptor->>'key' NOT IN ('constructor','prototype','__proto__')
            AND change_descriptor->>'source_store_key' ~ '^[a-z][a-z0-9_]{0,47}$'
            AND change_descriptor->>'source_store_key' NOT IN ('constructor','prototype','__proto__')
            AND change_descriptor->>'source_store_key'<>policy->>'key',false)
            OR previous_change_key IS NOT NULL AND previous_change_key COLLATE "C">=(change_descriptor->>'key') COLLATE "C"
            OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'record_stores') source_store
              WHERE source_store->>'key'=change_descriptor->>'source_store_key'
                AND source_store->>'resource_key'=policy->>'resource_key'
                AND source_store->>'runtime_requirement_key'=policy->>'runtime_requirement_key') THEN
            RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
          previous_change_key:=change_descriptor->>'key';
        END LOOP;
      END IF;
      IF policy ? 'resource_content' THEN
        payload_policy:=policy->'resource_content';
        IF NOT COALESCE(jsonb_typeof(payload_policy)='object' AND payload_policy ?& ARRAY['max_presentation_bytes','max_source_bytes','max_file_bytes','max_image_bytes']
          AND payload_policy-ARRAY['max_presentation_bytes','max_source_bytes','max_file_bytes','max_image_bytes']='{}'::jsonb,false) THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
        FOR policy_key,policy_max IN VALUES ('max_presentation_bytes',262144),('max_source_bytes',36700160),('max_file_bytes',26214400),('max_image_bytes',2097152) LOOP
          IF jsonb_typeof(payload_policy->policy_key) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
          IF (payload_policy->>policy_key)::numeric NOT BETWEEN 1 AND policy_max OR (payload_policy->>policy_key)::numeric<>trunc((payload_policy->>policy_key)::numeric) THEN
            RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
        END LOOP;
      END IF;
      previous_action_key:=policy->>'key';
    END LOOP;
  END IF;
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

  -- Optional member ownership is independently reviewed and cannot widen a
  -- resource or action declaration. Absence preserves historical grants.
  IF snapshot_json ? 'owner_connections' OR version_row.manifest ? 'owner_connections' THEN
    IF snapshot_json->>'schema' IS DISTINCT FROM 'deft.app_blob_grant.v2'
      OR snapshot_json->'owner_connections' IS DISTINCT FROM version_row.manifest->'owner_connections'
      OR jsonb_typeof(snapshot_json->'owner_connections') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'APP_V7_OWNER_CONNECTION_POLICY_INVALID' USING ERRCODE='23514'; END IF;
    IF jsonb_array_length(snapshot_json->'owner_connections') NOT BETWEEN 1 AND 16 THEN
      RAISE EXCEPTION 'APP_V7_OWNER_CONNECTION_POLICY_INVALID' USING ERRCODE='23514'; END IF;
    previous_action_key:=NULL;
    FOR policy IN SELECT value FROM jsonb_array_elements(snapshot_json->'owner_connections') LOOP
      IF jsonb_typeof(policy) IS DISTINCT FROM 'object'
        OR NOT(policy ?& ARRAY['key','resource_key','action_keys','max_consent_seconds'])
        OR policy-ARRAY['key','resource_key','action_keys','max_consent_seconds','provider_profile_key','runtime_requirement_key']<>'{}'::jsonb
        OR jsonb_typeof(policy->'key') IS DISTINCT FROM 'string'
        OR jsonb_typeof(policy->'resource_key') IS DISTINCT FROM 'string'
        OR NOT COALESCE(policy->>'key' ~ '^[a-z][a-z0-9_]{0,47}$',false)
        OR NOT COALESCE(policy->>'resource_key' ~ '^[a-z][a-z0-9_]{0,47}$',false)
        OR policy->>'key' IN ('constructor','prototype','__proto__')
        OR jsonb_typeof(policy->'action_keys') IS DISTINCT FROM 'array'
        OR jsonb_typeof(policy->'max_consent_seconds') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'APP_V7_OWNER_CONNECTION_POLICY_INVALID' USING ERRCODE='23514'; END IF;
      IF (policy->>'max_consent_seconds')::numeric NOT BETWEEN 1 AND 7776000
        OR (policy->>'max_consent_seconds')::numeric<>trunc((policy->>'max_consent_seconds')::numeric)
        OR jsonb_array_length(policy->'action_keys')>16
        OR (previous_action_key IS NOT NULL AND previous_action_key COLLATE "C">=(policy->>'key') COLLATE "C")
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'sync_descriptors') d
          WHERE d->>'key'=policy->>'resource_key' AND d->>'requested_visibility'='user_private') THEN
        RAISE EXCEPTION 'APP_V7_OWNER_CONNECTION_POLICY_INVALID' USING ERRCODE='23514'; END IF;
      IF (policy ? 'provider_profile_key') <> (policy ? 'runtime_requirement_key')
        OR (policy ? 'provider_profile_key' AND NOT COALESCE(
          jsonb_typeof(policy->'provider_profile_key') = 'string'
          AND jsonb_typeof(policy->'runtime_requirement_key') = 'string'
          AND policy->>'provider_profile_key' ~ '^[a-z][a-z0-9_]{0,47}$'
          AND policy->>'runtime_requirement_key' ~ '^[a-z][a-z0-9_]{0,47}$'
          AND policy->>'provider_profile_key' NOT IN ('constructor','prototype','__proto__')
          AND policy->>'runtime_requirement_key' NOT IN ('constructor','prototype','__proto__')
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'sync_descriptors') d
            WHERE d->>'key'=policy->>'resource_key' AND d->>'runtime_requirement_key'=policy->>'runtime_requirement_key')
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(version_row.manifest->'runtime_requirements') r
            WHERE r->>'key'=policy->>'runtime_requirement_key' AND r->>'protocol_version'='deft.app_runtime_channel.v3'),false)) THEN
        RAISE EXCEPTION 'APP_V7_OWNER_CONNECTION_PROFILE_INVALID' USING ERRCODE='23514';
      END IF;
      previous_action_key:=policy->>'key';
      policy_key:=NULL;
      FOR descriptor IN SELECT value FROM jsonb_array_elements(policy->'action_keys') LOOP
        IF jsonb_typeof(descriptor) IS DISTINCT FROM 'string'
          OR NOT COALESCE(descriptor#>>'{}' ~ '^[a-z][a-z0-9_]{0,47}$',false)
          OR (policy_key IS NOT NULL AND policy_key COLLATE "C">=(descriptor#>>'{}') COLLATE "C")
          OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'runtime_actions') d WHERE d->>'action_key'=descriptor#>>'{}') THEN
          RAISE EXCEPTION 'APP_V7_OWNER_CONNECTION_POLICY_INVALID' USING ERRCODE='23514'; END IF;
        policy_key:=descriptor#>>'{}';
      END LOOP;
    END LOOP;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
