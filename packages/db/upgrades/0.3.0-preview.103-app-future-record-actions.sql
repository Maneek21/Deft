-- Dedicated human-reviewed future effect authority. No message body, MIME,
-- credentials, provider draft ID or upload URL belongs in this journal.
CREATE TABLE IF NOT EXISTS app_future_record_action_releases (
 org_id text NOT NULL,release_id text NOT NULL,owner_user_id text NOT NULL,
 request_id text NOT NULL,run_id text NOT NULL,review_web_session_id text NOT NULL,
 revision integer NOT NULL DEFAULT 1,state text NOT NULL DEFAULT 'pending_local_commit',
 reviewed_authority jsonb NOT NULL,authority_digest text NOT NULL,
 prepared jsonb NOT NULL,prepared_digest text NOT NULL,input_digest text NOT NULL,
 not_before timestamptz NOT NULL,undo_until timestamptz NOT NULL,
 dispatch_expires_at timestamptz NOT NULL,authority_expires_at timestamptz NOT NULL,
 dispatch_attempt_id text,dispatch_started_at timestamptz,dispatch_lifetime_expires_at timestamptz,
 pause_reason text,cancel_request_id text,cancelled_at timestamptz,
 local_state text NOT NULL DEFAULT 'pending',freeze_request_id text NOT NULL,restore_request_id text NOT NULL,local_receipt jsonb,
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 PRIMARY KEY(org_id,release_id),UNIQUE(org_id,owner_user_id,request_id),UNIQUE(org_id,run_id),
 FOREIGN KEY(org_id,run_id) REFERENCES app_runs(org_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(org_id,owner_user_id) REFERENCES org_members(org_id,user_id) ON DELETE RESTRICT,
 FOREIGN KEY(review_web_session_id) REFERENCES web_sessions(id) ON DELETE RESTRICT,
 CHECK((release_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' AND request_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 AND revision BETWEEN 1 AND 2147483646 AND state IN ('pending_local_commit','queued','paused','dispatching','accepted','unknown','cancelled','expired')
 AND freeze_request_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' AND restore_request_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' AND freeze_request_id<>restore_request_id
 AND local_state IN ('pending','committed','restore_pending','restored','conflict') AND (local_receipt IS NULL OR jsonb_typeof(local_receipt)='object' AND octet_length(local_receipt::text)<=4096)
 AND (state NOT IN ('queued','dispatching','accepted','unknown') OR local_state='committed')
 AND authority_digest ~ '^sha256:[a-f0-9]{64}$' AND prepared_digest ~ '^sha256:[a-f0-9]{64}$' AND input_digest ~ '^sha256:[a-f0-9]{64}$'
 AND jsonb_typeof(reviewed_authority)='object' AND octet_length(reviewed_authority::text)<=32768
 AND jsonb_typeof(prepared)='object' AND octet_length(prepared::text)<=32768
 AND isfinite(not_before) AND isfinite(undo_until) AND isfinite(dispatch_expires_at) AND isfinite(authority_expires_at)
 AND isfinite(created_at) AND isfinite(updated_at) AND updated_at>=created_at
 AND undo_until>=created_at AND not_before>=undo_until AND dispatch_expires_at>not_before AND dispatch_expires_at<=authority_expires_at
 AND (pause_reason IS NULL OR state='paused' AND pause_reason IN ('authority_changed','missed_time','runtime_unavailable','local_conflict'))
 AND ((dispatch_attempt_id IS NULL AND dispatch_started_at IS NULL AND dispatch_lifetime_expires_at IS NULL)
 OR (dispatch_attempt_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' AND isfinite(dispatch_started_at) AND isfinite(dispatch_lifetime_expires_at)
 AND dispatch_started_at>=not_before AND dispatch_lifetime_expires_at>dispatch_started_at
 AND dispatch_lifetime_expires_at<=LEAST(dispatch_expires_at,dispatch_started_at+interval '5 minutes')))
 AND (state NOT IN ('dispatching','accepted','unknown') OR dispatch_attempt_id IS NOT NULL)
 AND ((cancelled_at IS NULL AND cancel_request_id IS NULL AND state<>'cancelled')
 OR (state='cancelled' AND isfinite(cancelled_at) AND cancel_request_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' AND dispatch_attempt_id IS NULL))) IS TRUE)
);
CREATE INDEX IF NOT EXISTS app_future_record_action_due ON app_future_record_action_releases(org_id,not_before) WHERE state='queued';
CREATE OR REPLACE FUNCTION deft_app_future_record_action_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'future effect history retained';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'pending_local_commit' OR NEW.revision<>1 OR NEW.dispatch_attempt_id IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN RAISE EXCEPTION 'future effect requires reviewed enqueue';END IF;
  RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['revision','state','dispatch_attempt_id','dispatch_started_at','dispatch_lifetime_expires_at','pause_reason','cancel_request_id','cancelled_at','updated_at','local_state','local_receipt'])
 IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','state','dispatch_attempt_id','dispatch_started_at','dispatch_lifetime_expires_at','pause_reason','cancel_request_id','cancelled_at','updated_at','local_state','local_receipt'])
 OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
 OR NOT(OLD.state='pending_local_commit' AND NEW.state IN ('queued','paused','cancelled','expired')
 OR OLD.state='cancelled' AND NEW.state='cancelled' AND OLD.local_state='restore_pending' AND NEW.local_state IN ('restored','conflict')
 OR OLD.state='queued' AND NEW.state IN ('paused','dispatching','cancelled','expired')
 OR OLD.state='paused' AND NEW.state IN ('cancelled','expired')
 OR OLD.state='expired' AND NEW.state='cancelled' AND OLD.dispatch_attempt_id IS NULL
 OR OLD.state='dispatching' AND NEW.state IN ('accepted','unknown'))
 OR (OLD.dispatch_attempt_id IS NOT NULL AND (NEW.dispatch_attempt_id IS DISTINCT FROM OLD.dispatch_attempt_id
 OR NEW.dispatch_started_at IS DISTINCT FROM OLD.dispatch_started_at OR NEW.dispatch_lifetime_expires_at IS DISTINCT FROM OLD.dispatch_lifetime_expires_at))
 THEN RAISE EXCEPTION 'future effect identity/state immutable';END IF;
 RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS app_future_record_action_history_guard ON app_future_record_action_releases;
CREATE TRIGGER app_future_record_action_history_guard BEFORE INSERT OR UPDATE OR DELETE ON app_future_record_action_releases FOR EACH ROW EXECUTE FUNCTION deft_app_future_record_action_history_guard();

CREATE OR REPLACE FUNCTION deft_app_future_record_actions_valid(actions jsonb,snapshot_json jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE action jsonb; previous_key text; name text; ceiling numeric;
BEGIN
 IF jsonb_typeof(actions) IS DISTINCT FROM 'array' OR jsonb_array_length(actions) NOT BETWEEN 1 AND 8 THEN RETURN false;END IF;
 FOR action IN SELECT value FROM jsonb_array_elements(actions) LOOP
  IF NOT COALESCE(jsonb_typeof(action)='object' AND action ?& ARRAY['schema_version','action_key','max_undo_delay_seconds','max_schedule_horizon_seconds','max_dispatch_lifetime_seconds','missed_policies']
   AND action-ARRAY['schema_version','action_key','max_undo_delay_seconds','max_schedule_horizon_seconds','max_dispatch_lifetime_seconds','missed_policies']='{}'::jsonb
   AND action->>'schema_version'='deft.app_future_record_action.v1' AND action->>'action_key' ~ '^[a-z][a-z0-9_]{0,47}$'
   AND action->>'action_key' NOT IN ('constructor','prototype','__proto__')
   AND (previous_key IS NULL OR previous_key COLLATE "C"<(action->>'action_key') COLLATE "C")
   AND jsonb_typeof(action->'missed_policies')='array',false) THEN RETURN false;END IF;
  IF jsonb_array_length(action->'missed_policies') NOT BETWEEN 1 AND 2
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(action->'missed_policies') value WHERE value NOT IN ('"send_when_available"'::jsonb,'"pause_if_late"'::jsonb))
   OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(action->'missed_policies'))<>jsonb_array_length(action->'missed_policies')
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'runtime_actions') value WHERE value->>'action_key'=action->>'action_key') THEN RETURN false;END IF;
  FOR name,ceiling IN VALUES ('max_undo_delay_seconds',120),('max_schedule_horizon_seconds',63244800),('max_dispatch_lifetime_seconds',300) LOOP
   IF jsonb_typeof(action->name) IS DISTINCT FROM 'number' OR (action->>name)::numeric NOT BETWEEN (CASE WHEN name='max_dispatch_lifetime_seconds' THEN 1 ELSE 0 END) AND ceiling OR (action->>name)::numeric<>trunc((action->>name)::numeric) THEN RETURN false;END IF;
  END LOOP;
  previous_key:=action->>'action_key';
 END LOOP;RETURN true;
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
        AND policy-ARRAY['schema_version','key','resource_key','runtime_requirement_key','max_record_bytes','max_files','max_file_bytes','max_total_file_bytes','resource_content','record_changes','local_job_operations','future_record_actions']='{}'::jsonb
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
