-- Generic independently operated App data authorization/journal. App content
-- and provider credentials remain outside the host database.
CREATE TABLE IF NOT EXISTS app_data_consents (
 org_id text NOT NULL,owner_user_id text NOT NULL,consent_id text NOT NULL,
 connection_session_id text NOT NULL,store_key text NOT NULL,state text NOT NULL,
 consent_digest text NOT NULL,snapshot jsonb NOT NULL,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 PRIMARY KEY(org_id,owner_user_id,consent_id),
 CONSTRAINT app_data_consents_state_check CHECK(state IN ('proposed','active','revoked')),
 CONSTRAINT app_data_consents_snapshot_bound CHECK(octet_length(snapshot::text)<=16384)
);
CREATE INDEX IF NOT EXISTS app_data_consents_target_idx ON app_data_consents(org_id,owner_user_id,connection_session_id,store_key,state);
CREATE TABLE IF NOT EXISTS app_data_invocations (
 org_id text NOT NULL,owner_user_id text NOT NULL,request_id text NOT NULL,connection_session_id text NOT NULL,
 operation text NOT NULL,input_digest text NOT NULL,state text NOT NULL,revision integer NOT NULL,
 web_session_id text NOT NULL,access_expires_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 context jsonb NOT NULL,result jsonb,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 PRIMARY KEY(org_id,owner_user_id,request_id),
 CONSTRAINT app_data_invocations_state_check CHECK(state IN ('inflight','completed','indeterminate')),
 CONSTRAINT app_data_invocations_revision_check CHECK(revision>=0),
 CONSTRAINT app_data_invocations_context_bound CHECK(octet_length(context::text)<=16384 AND (result IS NULL OR octet_length(result::text)<=16384))
);
CREATE INDEX IF NOT EXISTS app_data_invocations_owner_idx ON app_data_invocations(org_id,owner_user_id,connection_session_id,created_at);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_data_consents'::regclass AND conname='app_data_consents_connection_fk') THEN
  ALTER TABLE app_data_consents ADD CONSTRAINT app_data_consents_connection_fk FOREIGN KEY(org_id,owner_user_id,connection_session_id)
   REFERENCES app_connection_sessions(org_id,owner_user_id,session_id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_data_invocations'::regclass AND conname='app_data_invocations_connection_fk') THEN
  ALTER TABLE app_data_invocations ADD CONSTRAINT app_data_invocations_connection_fk FOREIGN KEY(org_id,owner_user_id,connection_session_id)
   REFERENCES app_connection_sessions(org_id,owner_user_id,session_id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_data_invocations'::regclass AND conname='app_data_invocations_sid_fk') THEN
  ALTER TABLE app_data_invocations ADD CONSTRAINT app_data_invocations_sid_fk FOREIGN KEY(web_session_id) REFERENCES web_sessions(id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_data_consents'::regclass AND conname='app_data_consents_identity_check') THEN
  ALTER TABLE app_data_consents ADD CONSTRAINT app_data_consents_identity_check CHECK((
   jsonb_typeof(snapshot)='object' AND snapshot->>'schema_version'='deft.app_data_consent.v1'
   AND snapshot->>'consent_id'=consent_id AND snapshot->'scope'->>'org_id'=org_id
   AND snapshot->'scope'->>'owner_user_id'=owner_user_id AND snapshot->'connection'->>'session_id'=connection_session_id
   AND snapshot->'store'->>'key'=store_key AND snapshot->>'purpose'='human_record_write'
   AND consent_digest ~ '^sha256:[a-f0-9]{64}$'
   AND jsonb_typeof(snapshot->'scope')='object' AND jsonb_typeof(snapshot->'connection')='object' AND jsonb_typeof(snapshot->'store')='object'
   AND (snapshot-'schema_version'-'consent_id'-'scope'-'connection'-'store'-'data_policy_digest'-'purpose'-'expires_at')='{}'::jsonb
   AND snapshot ?& ARRAY['schema_version','consent_id','scope','connection','store','data_policy_digest','purpose','expires_at']
   AND snapshot->>'data_policy_digest' ~ '^sha256:[a-f0-9]{64}$'
   AND snapshot->'connection' ?& ARRAY['session_id','session_revision','runtime_session_ref','account_ref']
   AND (snapshot->'connection')-ARRAY['session_id','session_revision','runtime_session_ref','account_ref']='{}'::jsonb
   AND snapshot->'connection'->>'runtime_session_ref' ~ '^[A-Za-z0-9_-]{1,512}$'
   AND snapshot->'connection'->>'account_ref' ~ '^[A-Za-z0-9_-]{1,512}$'
   AND (snapshot->'connection'->>'session_revision')::numeric BETWEEN 1 AND 2147483646
   AND isfinite(expires_at) AND isfinite(created_at) AND isfinite(updated_at)
   AND (snapshot->>'expires_at')::timestamptz=expires_at
   AND expires_at<=(snapshot->'scope'->>'consent_expires_at')::timestamptz
  ) IS TRUE);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_data_invocations'::regclass AND conname='app_data_invocations_identity_check') THEN
  ALTER TABLE app_data_invocations ADD CONSTRAINT app_data_invocations_identity_check CHECK((
   jsonb_typeof(context)='object' AND context->>'schema_version'='deft.app_data_authority.v1'
   AND context->>'request_id'=request_id AND context->>'operation'=operation AND context->>'input_digest'=input_digest
   AND context->'scope'->>'org_id'=org_id AND context->'scope'->>'owner_user_id'=owner_user_id
   AND context->'connection'->>'session_id'=connection_session_id AND input_digest ~ '^sha256:[a-f0-9]{64}$'
   AND jsonb_typeof(context->'scope')='object' AND jsonb_typeof(context->'connection')='object' AND jsonb_typeof(context->'authority')='object'
   AND (context-'schema_version'-'request_id'-'scope'-'connection'-'authority'-'operation'-'input_digest'-'expires_at')='{}'::jsonb
   AND context ?& ARRAY['schema_version','request_id','scope','connection','authority','operation','input_digest','expires_at']
   AND context->'connection' ?& ARRAY['session_id','session_revision','runtime_session_ref','account_ref']
   AND (context->'connection')-ARRAY['session_id','session_revision','runtime_session_ref','account_ref']='{}'::jsonb
   AND context->'authority' ?& ARRAY['consent_id','consent_digest','data_policy_digest']
   AND (context->'authority')-ARRAY['consent_id','consent_digest','data_policy_digest']='{}'::jsonb
   AND context->'authority'->>'data_policy_digest' ~ '^sha256:[a-f0-9]{64}$'
   AND ((context->'authority'->'consent_id'='null'::jsonb AND context->'authority'->'consent_digest'='null'::jsonb)
     OR (jsonb_typeof(context->'authority'->'consent_id')='string' AND context->'authority'->>'consent_digest' ~ '^sha256:[a-f0-9]{64}$'))
   AND context->'connection'->>'runtime_session_ref' ~ '^[A-Za-z0-9_-]{1,512}$'
   AND context->'connection'->>'account_ref' ~ '^[A-Za-z0-9_-]{1,512}$'
   AND (context->'connection'->>'session_revision')::numeric BETWEEN 1 AND 2147483646
   AND isfinite(expires_at) AND isfinite(access_expires_at) AND isfinite(created_at) AND isfinite(updated_at)
   AND (context->>'expires_at')::timestamptz=expires_at AND expires_at<=access_expires_at
   AND expires_at<=(context->'scope'->>'consent_expires_at')::timestamptz
  ) IS TRUE);
 END IF;
END $$;
CREATE OR REPLACE FUNCTION guard_app_data_consent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'proposed' THEN RAISE EXCEPTION 'App data consent must be reviewed first'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app_connection_sessions c WHERE c.org_id=NEW.org_id AND c.owner_user_id=NEW.owner_user_id AND c.session_id=NEW.connection_session_id
    AND c.record->>'state'='connected' AND c.record->'scope'=NEW.snapshot->'scope'
    AND c.record->>'runtime_session_ref'=NEW.snapshot->'connection'->>'runtime_session_ref'
    AND c.record->'account'->>'account_ref'=NEW.snapshot->'connection'->>'account_ref'
    AND c.revision=(NEW.snapshot->'connection'->>'session_revision')::integer) THEN
   RAISE EXCEPTION 'App data consent connection authority mismatch'; END IF;
 ELSE
  IF ROW(NEW.org_id,NEW.owner_user_id,NEW.consent_id,NEW.connection_session_id,NEW.store_key,NEW.consent_digest,NEW.snapshot,NEW.expires_at,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.org_id,OLD.owner_user_id,OLD.consent_id,OLD.connection_session_id,OLD.store_key,OLD.consent_digest,OLD.snapshot,OLD.expires_at,OLD.created_at)
   OR NOT (NEW.state=OLD.state OR OLD.state='proposed' AND NEW.state IN ('active','revoked') OR OLD.state='active' AND NEW.state='revoked') THEN
   RAISE EXCEPTION 'App data consent identity is immutable';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_data_consent_guard ON app_data_consents;
CREATE TRIGGER app_data_consent_guard BEFORE INSERT OR UPDATE ON app_data_consents FOR EACH ROW EXECUTE FUNCTION guard_app_data_consent();
CREATE OR REPLACE FUNCTION guard_app_data_invocation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM web_sessions WHERE id=NEW.web_session_id AND org_id=NEW.org_id AND user_id=NEW.owner_user_id) THEN
  RAISE EXCEPTION 'App data invocation web identity mismatch';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'inflight' OR NEW.revision<>0 OR NEW.result IS NOT NULL THEN RAISE EXCEPTION 'App data invocation must start inflight'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app_connection_sessions c WHERE c.org_id=NEW.org_id AND c.owner_user_id=NEW.owner_user_id AND c.session_id=NEW.connection_session_id
    AND c.record->>'state'='connected' AND c.record->'scope'=NEW.context->'scope'
    AND c.record->>'runtime_session_ref'=NEW.context->'connection'->>'runtime_session_ref'
    AND c.record->'account'->>'account_ref'=NEW.context->'connection'->>'account_ref'
    AND c.revision=(NEW.context->'connection'->>'session_revision')::integer) THEN
   RAISE EXCEPTION 'App data invocation connection authority mismatch'; END IF;
 ELSE
  IF ROW(NEW.org_id,NEW.owner_user_id,NEW.request_id,NEW.connection_session_id,NEW.operation,NEW.input_digest,NEW.context,
   NEW.web_session_id,NEW.access_expires_at,NEW.expires_at,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.org_id,OLD.owner_user_id,OLD.request_id,OLD.connection_session_id,OLD.operation,OLD.input_digest,OLD.context,
   OLD.web_session_id,OLD.access_expires_at,OLD.expires_at,OLD.created_at)
   OR OLD.state<>'inflight' OR NEW.state NOT IN ('completed','indeterminate') OR NEW.revision<>OLD.revision+1 THEN
   RAISE EXCEPTION 'App data invocation identity is immutable';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_data_invocation_guard ON app_data_invocations;
CREATE TRIGGER app_data_invocation_guard BEFORE INSERT OR UPDATE ON app_data_invocations FOR EACH ROW EXECUTE FUNCTION guard_app_data_invocation();

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
        AND policy-ARRAY['schema_version','key','resource_key','runtime_requirement_key','max_record_bytes','max_files','max_file_bytes','max_total_file_bytes','resource_content']='{}'::jsonb
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

-- Optional separately consented OAuth action scope; absence preserves Read-only.
ALTER TABLE app_connection_sessions DROP CONSTRAINT IF EXISTS app_connection_sessions_record_identity;
ALTER TABLE app_connection_sessions ADD   CONSTRAINT app_connection_sessions_record_identity CHECK ((
    jsonb_typeof(record) = 'object' AND record ?& ARRAY['session_id','revision','scope','profile','state','callback_state_hash','callback_consumed','callback_expires_at','runtime_session_ref','account','created_at','updated_at']
    AND record-ARRAY['action_consent','session_id','revision','scope','profile','state','callback_state_hash','callback_consumed','callback_expires_at','runtime_session_ref','account','created_at','updated_at']='{}'::jsonb
    AND jsonb_typeof(record->'scope')='object' AND jsonb_typeof(record->'profile')='object'
    AND record->'scope' ?& ARRAY['org_id','owner_user_id'] AND record->>'session_id' = session_id
    AND (record->>'revision')::integer = revision
    AND record->'scope'->>'org_id' = org_id
    AND record->'scope'->>'owner_user_id' = owner_user_id
    AND record->>'callback_state_hash' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(record->'callback_consumed') = 'boolean'
    AND record->>'state' IN ('starting','awaiting_callback','connecting','checking','disconnecting','connected','not_connected','disconnected','indeterminate')
    AND (NOT(record ? 'action_consent') OR (
      jsonb_typeof(record->'action_consent')='object'
      AND record->'action_consent' ?& ARRAY['action_binding_id','action_key','authority_epoch','consent_id','consent_digest','expires_at']
      AND (record->'action_consent')-ARRAY['action_binding_id','action_key','authority_epoch','consent_id','consent_digest','expires_at']='{}'::jsonb
      AND record->'action_consent'->>'action_binding_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      AND record->'action_consent'->>'consent_id'=record->'action_consent'->>'action_binding_id'
      AND record->'action_consent'->>'action_key' ~ '^[a-z][a-z0-9_]{0,47}$'
      AND jsonb_typeof(record->'action_consent'->'authority_epoch')='number'
      AND (record->'action_consent'->>'authority_epoch')::numeric BETWEEN 0 AND 2147483647
      AND (record->'action_consent'->>'authority_epoch')::numeric=trunc((record->'action_consent'->>'authority_epoch')::numeric)
      AND record->'action_consent'->>'consent_digest' ~ '^sha256:[a-f0-9]{64}$'
      AND jsonb_typeof(record->'action_consent'->'expires_at')='string'
      AND isfinite((record->'action_consent'->>'expires_at')::timestamptz)
      AND (record->'action_consent'->>'expires_at')::timestamptz<=(record->'scope'->>'consent_expires_at')::timestamptz
    ))
  ) IS TRUE);
CREATE OR REPLACE FUNCTION deft_app_connection_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 0 OR NEW.record->>'state' <> 'starting'
      OR NEW.record->'callback_consumed' <> 'false'::jsonb THEN
      RAISE EXCEPTION 'invalid connection session admission';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM web_sessions WHERE id = NEW.web_session_id
      AND org_id = NEW.org_id AND user_id = NEW.owner_user_id) THEN
      RAISE EXCEPTION 'connection session web identity mismatch';
    END IF;
  ELSE
    IF NEW.org_id <> OLD.org_id OR NEW.owner_user_id <> OLD.owner_user_id
      OR NEW.session_id <> OLD.session_id OR NEW.created_at <> OLD.created_at
      OR NEW.revision <> OLD.revision + 1
      OR NEW.record->'scope' IS DISTINCT FROM OLD.record->'scope'
      OR NEW.record->'profile' IS DISTINCT FROM OLD.record->'profile'
      OR NEW.record->'action_consent' IS DISTINCT FROM OLD.record->'action_consent'
      OR NEW.record->'callback_state_hash' IS DISTINCT FROM OLD.record->'callback_state_hash'
      OR NEW.record->'callback_expires_at' IS DISTINCT FROM OLD.record->'callback_expires_at'
      OR (OLD.record->'callback_consumed' = 'true'::jsonb AND NEW.record->'callback_consumed' <> 'true'::jsonb) THEN
      RAISE EXCEPTION 'connection session immutable authority or CAS mismatch';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM web_sessions WHERE id = NEW.web_session_id
    AND org_id = NEW.org_id AND user_id = NEW.owner_user_id) THEN
    RAISE EXCEPTION 'connection session web identity mismatch';
  END IF;
  RETURN NEW;
END;
$$;
