-- Append-only candidate on the receipt-matched preview93 lineage. No Email
-- account/history/credential data is changed by this dormant generic table.
CREATE TABLE IF NOT EXISTS app_connection_sessions (
  org_id text NOT NULL,
  owner_user_id text NOT NULL,
  session_id text NOT NULL,
  web_session_id text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  revision integer NOT NULL CHECK (revision >= 0),
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, owner_user_id, session_id),
  CONSTRAINT app_connection_sessions_owner_fk FOREIGN KEY (org_id, owner_user_id) REFERENCES org_members (org_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT app_connection_sessions_web_session_fk FOREIGN KEY (web_session_id) REFERENCES web_sessions (id) ON DELETE RESTRICT,
  CONSTRAINT app_connection_sessions_record_bound CHECK (octet_length(record::text) <= 16384),
  CONSTRAINT app_connection_sessions_record_identity CHECK ((
    jsonb_typeof(record) = 'object' AND record ?& ARRAY['session_id','revision','scope','profile','state','callback_state_hash','callback_consumed','callback_expires_at','runtime_session_ref','account','created_at','updated_at']
    AND record-ARRAY['session_id','revision','scope','profile','state','callback_state_hash','callback_consumed','callback_expires_at','runtime_session_ref','account','created_at','updated_at']='{}'::jsonb
    AND jsonb_typeof(record->'scope')='object' AND jsonb_typeof(record->'profile')='object'
    AND record->'scope' ?& ARRAY['org_id','owner_user_id'] AND record->>'session_id' = session_id
    AND (record->>'revision')::integer = revision
    AND record->'scope'->>'org_id' = org_id
    AND record->'scope'->>'owner_user_id' = owner_user_id
    AND record->>'callback_state_hash' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(record->'callback_consumed') = 'boolean'
    AND record->>'state' IN ('starting','awaiting_callback','connecting','checking','disconnecting','connected','not_connected','disconnected','indeterminate')
  ) IS TRUE)
);
-- Fresh Drizzle push can already have created this table; install these
-- cross-table/JSON checks explicitly as well as in the CREATE path.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='app_connection_sessions'::regclass AND conname='app_connection_sessions_owner_fk') THEN
    ALTER TABLE app_connection_sessions ADD CONSTRAINT app_connection_sessions_owner_fk
      FOREIGN KEY (org_id, owner_user_id) REFERENCES org_members (org_id, user_id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='app_connection_sessions'::regclass AND conname='app_connection_sessions_web_session_fk') THEN
    ALTER TABLE app_connection_sessions ADD CONSTRAINT app_connection_sessions_web_session_fk
      FOREIGN KEY (web_session_id) REFERENCES web_sessions (id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='app_connection_sessions'::regclass AND conname='app_connection_sessions_record_identity') THEN
    ALTER TABLE app_connection_sessions ADD
    CONSTRAINT app_connection_sessions_record_identity CHECK ((
    jsonb_typeof(record) = 'object' AND record ?& ARRAY['session_id','revision','scope','profile','state','callback_state_hash','callback_consumed','callback_expires_at','runtime_session_ref','account','created_at','updated_at']
    AND record-ARRAY['session_id','revision','scope','profile','state','callback_state_hash','callback_consumed','callback_expires_at','runtime_session_ref','account','created_at','updated_at']='{}'::jsonb
    AND jsonb_typeof(record->'scope')='object' AND jsonb_typeof(record->'profile')='object'
    AND record->'scope' ?& ARRAY['org_id','owner_user_id'] AND record->>'session_id' = session_id
    AND (record->>'revision')::integer = revision
    AND record->'scope'->>'org_id' = org_id
    AND record->'scope'->>'owner_user_id' = owner_user_id
    AND record->>'callback_state_hash' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(record->'callback_consumed') = 'boolean'
    AND record->>'state' IN ('starting','awaiting_callback','connecting','checking','disconnecting','connected','not_connected','disconnected','indeterminate')
  ) IS TRUE);
  END IF;
END; $$;

CREATE INDEX IF NOT EXISTS app_connection_sessions_owner_idx
  ON app_connection_sessions (org_id, owner_user_id, updated_at);

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
DROP TRIGGER IF EXISTS app_connection_sessions_guard ON app_connection_sessions;
CREATE TRIGGER app_connection_sessions_guard BEFORE INSERT OR UPDATE ON app_connection_sessions
  FOR EACH ROW EXECUTE FUNCTION deft_app_connection_session_guard();

-- Preserve preview60 grant/admission rules while admitting closed reviewed external profiles.
CREATE OR REPLACE FUNCTION enforce_app_owner_connection_admission() RETURNS trigger AS $$
DECLARE limit_key text; limit_max integer; val numeric;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'APP_OWNER_CONNECTION_APPEND_ONLY' USING ERRCODE='55000'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.org_id,NEW.app_installation_id,NEW.app_version_id,NEW.grant_snapshot_id,NEW.operator_user_id,
      NEW.policy_key,NEW.review_digest,NEW.snapshot,NEW.reviewed_by_user_id,NEW.reviewed_at,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.app_installation_id,OLD.app_version_id,OLD.grant_snapshot_id,OLD.operator_user_id,
      OLD.policy_key,OLD.review_digest,OLD.snapshot,OLD.reviewed_by_user_id,OLD.reviewed_at,OLD.created_at)
    OR NOT ((OLD.state='active' AND NEW.state='revoked' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
      OR (OLD.state=NEW.state AND OLD.revoked_at IS NOT DISTINCT FROM NEW.revoked_at)) THEN
   RAISE EXCEPTION 'APP_OWNER_CONNECTION_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.state<>'active' OR NEW.revoked_at IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM org_members m JOIN users u ON u.id=m.user_id WHERE m.org_id=NEW.org_id
    AND m.user_id=NEW.reviewed_by_user_id AND m.is_active AND m.role IN ('owner','admin') AND u.kind='human' AND NOT u.is_agent)
  OR NEW.snapshot-ARRAY['schema_version','org_id','installation_id','app_version_id','grant_snapshot_id','package_digest',
    'grant_snapshot_digest','lifecycle_epoch','grant_epoch','operator_user_id','policy','policy_digest','resource_descriptor_digest','actions','limits','connection_profile','connection_profile_digest','connection_transport_digest']<>'{}'::jsonb
  OR NOT (NEW.snapshot ?& ARRAY['schema_version','org_id','installation_id','app_version_id','grant_snapshot_id','package_digest',
    'grant_snapshot_digest','lifecycle_epoch','grant_epoch','operator_user_id','policy','policy_digest','resource_descriptor_digest','actions','limits'])
  OR NOT COALESCE(NEW.snapshot->>'policy_digest' ~ '^sha256:[a-f0-9]{64}$',false)
  OR jsonb_typeof(NEW.snapshot->'limits') IS DISTINCT FROM 'object'
  OR (NEW.snapshot->'limits')-ARRAY['max_records_per_page','max_page_bytes','max_retained_records','max_retained_bytes','min_interval_seconds']<>'{}'::jsonb
  OR NOT (NEW.snapshot->'limits' ?& ARRAY['max_records_per_page','max_page_bytes','max_retained_records','max_retained_bytes','min_interval_seconds']) THEN
  RAISE EXCEPTION 'APP_OWNER_CONNECTION_REVIEW_INVALID' USING ERRCODE='55000'; END IF;
 FOR limit_key,limit_max IN VALUES ('max_records_per_page',100),('max_page_bytes',524288),('max_retained_records',100000),
   ('max_retained_bytes',1073741824),('min_interval_seconds',86400) LOOP
  IF jsonb_typeof(NEW.snapshot->'limits'->limit_key) IS DISTINCT FROM 'number' THEN
   RAISE EXCEPTION 'APP_OWNER_CONNECTION_LIMIT_INVALID' USING ERRCODE='55000'; END IF;
  val := (NEW.snapshot->'limits'->>limit_key)::numeric;
  IF val<>trunc(val) OR val NOT BETWEEN (CASE WHEN limit_key='min_interval_seconds' THEN 60 ELSE 1 END) AND limit_max THEN
   RAISE EXCEPTION 'APP_OWNER_CONNECTION_LIMIT_INVALID' USING ERRCODE='55000'; END IF;
 END LOOP;
 IF (NEW.snapshot ? 'connection_profile') <> (NEW.snapshot ? 'connection_profile_digest')
   OR (NEW.snapshot ? 'connection_profile') <> (NEW.snapshot ? 'connection_transport_digest')
   OR (NEW.snapshot->'policy' ? 'provider_profile_key') <> (NEW.snapshot ? 'connection_profile') THEN
   RAISE EXCEPTION 'APP_OWNER_CONNECTION_PROFILE_INVALID' USING ERRCODE='23514';
 END IF;
 IF NEW.snapshot ? 'connection_profile' THEN
   IF NOT COALESCE(jsonb_typeof(NEW.snapshot->'connection_profile')='object'
     AND (NEW.snapshot->'connection_profile') ?& ARRAY['schema_version','key','provider_id','operator_user_id','runtime_requirement_key','resource_key','action_keys','authorization_origin','credential_custody','executable']
     AND (NEW.snapshot->'connection_profile')-ARRAY['schema_version','key','provider_id','operator_user_id','runtime_requirement_key','resource_key','action_keys','authorization_origin','credential_custody','executable']='{}'::jsonb
     AND NEW.snapshot->'connection_profile'->>'schema_version'='deft.app_connection_profile.v1'
     AND NEW.snapshot->'connection_profile'->>'key'=NEW.snapshot->'policy'->>'provider_profile_key'
     AND NEW.snapshot->'connection_profile'->>'operator_user_id'=NEW.operator_user_id
     AND NEW.snapshot->'connection_profile'->>'runtime_requirement_key'=NEW.snapshot->'policy'->>'runtime_requirement_key'
     AND NEW.snapshot->'connection_profile'->>'resource_key'=NEW.snapshot->'policy'->>'resource_key'
     AND NEW.snapshot->'connection_profile'->'action_keys'=NEW.snapshot->'policy'->'action_keys'
     AND NEW.snapshot->'connection_profile'->>'provider_id' ~ '^[a-z][a-z0-9_]{0,47}$'
     AND NEW.snapshot->'connection_profile'->>'authorization_origin' ~ '^https://[^/@?#[:space:]]+(:[0-9]+)?$'
     AND NEW.snapshot->'connection_profile'->>'credential_custody'='runtime'
     AND NEW.snapshot->'connection_profile'->'executable'='false'::jsonb
     AND NEW.snapshot->>'connection_profile_digest' ~ '^sha256:[a-f0-9]{64}$'
     AND NEW.snapshot->>'connection_transport_digest' ~ '^sha256:[a-f0-9]{64}$',false) THEN
     RAISE EXCEPTION 'APP_OWNER_CONNECTION_PROFILE_INVALID' USING ERRCODE='23514';
   END IF;
 END IF;
 -- Check before insert against current deployment rows (the row is not visible yet).
 IF NOT EXISTS(SELECT 1 FROM app_installations i JOIN app_versions v ON v.org_id=i.org_id AND v.installation_id=i.id AND v.id=NEW.app_version_id
   JOIN app_grant_snapshots g ON g.org_id=i.org_id AND g.app_installation_id=i.id AND g.app_version_id=v.id AND g.id=NEW.grant_snapshot_id
   WHERE i.org_id=NEW.org_id AND i.id=NEW.app_installation_id AND i.state='active' AND v.state='active' AND v.protocol_version='7'
   AND g.snapshot_kind='effective' AND i.active_version_id=v.id AND i.active_grant_snapshot_id=g.id
   AND NEW.snapshot->>'org_id'=NEW.org_id AND NEW.snapshot->>'installation_id'=i.id
   AND NEW.snapshot->>'app_version_id'=v.id AND NEW.snapshot->>'grant_snapshot_id'=g.id
   AND NEW.snapshot->>'operator_user_id'=NEW.operator_user_id AND NEW.snapshot->>'package_digest'=v.package_digest
   AND NEW.snapshot->>'grant_snapshot_digest'=g.snapshot_digest
   AND NEW.snapshot->>'lifecycle_epoch'=i.lifecycle_epoch::text AND NEW.snapshot->>'grant_epoch'=i.grant_epoch::text
   AND NEW.snapshot->>'schema_version'='deft.owner_connection_admission.v1'
   AND app_owner_connection_member(NEW.org_id,NEW.operator_user_id)
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.manifest->'owner_connections') p WHERE p->>'key'=NEW.policy_key AND p=NEW.snapshot->'policy')
   AND v.manifest->'owner_connections'=g.canonical_snapshot->'owner_connections'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(g.canonical_snapshot->'sync_descriptors') d
     WHERE d->>'key'=NEW.snapshot->'policy'->>'resource_key' AND d->>'requested_visibility'='user_private'
       AND d->>'descriptor_digest'=NEW.snapshot->>'resource_descriptor_digest')
   AND NEW.snapshot->'actions'=COALESCE((SELECT jsonb_agg(jsonb_build_object('action_key',d->'action_key','contract_digest',d->'contract_digest') ORDER BY d->>'action_key')
     FROM jsonb_array_elements(g.canonical_snapshot->'runtime_actions') d WHERE NEW.snapshot->'policy'->'action_keys' ? (d->>'action_key')),'[]'::jsonb)) THEN
   RAISE EXCEPTION 'APP_OWNER_CONNECTION_REVIEW_INVALID' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;

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
  IF NOT(snapshot_json ?& ARRAY['schema','lineage_key','package_digest','manifest_digest','sync_descriptors','modules','runtime_actions','native_actions','public_actions','experiences','host_policy','organization_id','app_installation_id','app_version_id','requested_snapshot_id','requested_snapshot_digest','classification','review_digest']) OR snapshot_json-ARRAY['owner_connections','private_state','schema','lineage_key','package_digest','manifest_digest','sync_descriptors','modules','runtime_actions','native_actions','public_actions','experiences','host_policy','organization_id','app_installation_id','app_version_id','requested_snapshot_id','requested_snapshot_digest','classification','review_digest']<>'{}'::jsonb
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
