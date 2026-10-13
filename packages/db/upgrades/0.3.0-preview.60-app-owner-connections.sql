-- Explicit, separately reviewed per-owner admission. Existing null registrations
-- keep their manager-only semantics; no historical registration is upgraded.
CREATE TABLE IF NOT EXISTS app_owner_connection_admissions (
 id text PRIMARY KEY, org_id text NOT NULL, app_installation_id text NOT NULL,
 app_version_id text NOT NULL, grant_snapshot_id text NOT NULL, operator_user_id text NOT NULL,
 policy_key text NOT NULL, review_digest text NOT NULL, snapshot jsonb NOT NULL,
 reviewed_by_user_id text NOT NULL, reviewed_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'active', revoked_at timestamptz,
 created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
 CONSTRAINT app_owner_connection_admissions_version_fk FOREIGN KEY (org_id,app_installation_id,app_version_id)
   REFERENCES app_versions(org_id,installation_id,id) ON DELETE RESTRICT,
 CONSTRAINT app_owner_connection_admissions_grant_fk FOREIGN KEY (org_id,app_installation_id,app_version_id,grant_snapshot_id)
   REFERENCES app_grant_snapshots(org_id,app_installation_id,app_version_id,id) ON DELETE RESTRICT,
 CONSTRAINT app_owner_connection_admissions_operator_fk FOREIGN KEY (org_id,operator_user_id)
   REFERENCES org_members(org_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT app_owner_connection_admissions_reviewer_fk FOREIGN KEY (org_id,reviewed_by_user_id)
   REFERENCES org_members(org_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT app_owner_connection_admissions_exact_unique UNIQUE
   (org_id,app_installation_id,app_version_id,grant_snapshot_id,operator_user_id,id,review_digest),
 CONSTRAINT app_owner_connection_admissions_identity_check CHECK
   (policy_key ~ '^[a-z][a-z0-9_]{0,47}$' AND review_digest ~ '^sha256:[a-f0-9]{64}$'),
 CONSTRAINT app_owner_connection_admissions_snapshot_check CHECK
   (jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=32768),
 CONSTRAINT app_owner_connection_admissions_state_check CHECK
   ((state='active' AND revoked_at IS NULL) OR (state='revoked' AND revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS app_owner_connection_admissions_current_unique
 ON app_owner_connection_admissions(org_id,app_installation_id,grant_snapshot_id,policy_key) WHERE state='active';
ALTER TABLE app_runtime_registrations ADD COLUMN IF NOT EXISTS owner_connection_admission_id text;
ALTER TABLE app_runtime_registrations ADD COLUMN IF NOT EXISTS owner_connection_admission_digest text;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='app_runtime_registrations_owner_admission_fk') THEN
  ALTER TABLE app_runtime_registrations ADD CONSTRAINT app_runtime_registrations_owner_admission_fk FOREIGN KEY
   (org_id,app_installation_id,app_version_id,grant_snapshot_id,operator_user_id,owner_connection_admission_id,owner_connection_admission_digest)
   REFERENCES app_owner_connection_admissions
   (org_id,app_installation_id,app_version_id,grant_snapshot_id,operator_user_id,id,review_digest) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='app_runtime_registrations_owner_admission_check') THEN
  ALTER TABLE app_runtime_registrations ADD CONSTRAINT app_runtime_registrations_owner_admission_check CHECK
   ((owner_connection_admission_id IS NULL AND owner_connection_admission_digest IS NULL)
    OR (owner_connection_admission_id IS NOT NULL AND owner_connection_admission_digest IS NOT NULL
       AND owner_connection_admission_digest ~ '^sha256:[a-f0-9]{64}$'));
 END IF;
END $$;

-- Host role eligibility is fixed, never supplied by an author policy.
CREATE OR REPLACE FUNCTION app_owner_connection_member(org_key text,user_key text) RETURNS boolean AS $$
 SELECT EXISTS(SELECT 1 FROM org_members m JOIN users u ON u.id=m.user_id
  WHERE m.org_id=org_key AND m.user_id=user_key AND m.is_active
    AND m.role IN ('owner','admin','member') AND u.kind='human' AND NOT u.is_agent);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_owner_connection_admission_current(org_key text,admission_key text,digest_key text) RETURNS boolean AS $$
 SELECT EXISTS(SELECT 1 FROM app_owner_connection_admissions a
 JOIN app_installations i ON i.org_id=a.org_id AND i.id=a.app_installation_id
 JOIN app_versions v ON v.org_id=a.org_id AND v.installation_id=i.id AND v.id=a.app_version_id
 JOIN app_grant_snapshots g ON g.org_id=a.org_id AND g.app_installation_id=i.id AND g.app_version_id=v.id AND g.id=a.grant_snapshot_id
 WHERE a.org_id=org_key AND a.id=admission_key AND a.review_digest=digest_key AND a.state='active' AND a.revoked_at IS NULL
 AND i.state='active' AND v.state='active' AND v.protocol_version='7' AND g.snapshot_kind='effective'
 AND i.active_version_id=v.id AND i.active_grant_snapshot_id=g.id
 AND a.snapshot->>'schema_version'='deft.owner_connection_admission.v1'
 AND a.snapshot->>'org_id'=a.org_id AND a.snapshot->>'installation_id'=i.id
 AND a.snapshot->>'app_version_id'=v.id AND a.snapshot->>'grant_snapshot_id'=g.id
 AND a.snapshot->>'operator_user_id'=a.operator_user_id AND a.snapshot->>'package_digest'=v.package_digest
 AND a.snapshot->>'grant_snapshot_digest'=g.snapshot_digest
 AND a.snapshot->>'lifecycle_epoch'=i.lifecycle_epoch::text AND a.snapshot->>'grant_epoch'=i.grant_epoch::text
 AND app_owner_connection_member(a.org_id,a.operator_user_id)
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.manifest->'owner_connections') p
   WHERE p->>'key'=a.policy_key AND p=a.snapshot->'policy')
 AND v.manifest->'owner_connections'=g.canonical_snapshot->'owner_connections'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(g.canonical_snapshot->'sync_descriptors') d
   WHERE d->>'key'=a.snapshot->'policy'->>'resource_key' AND d->>'requested_visibility'='user_private'
     AND d->>'descriptor_digest'=a.snapshot->>'resource_descriptor_digest')
 AND a.snapshot->'actions'=COALESCE((SELECT jsonb_agg(jsonb_build_object('action_key',d->'action_key','contract_digest',d->'contract_digest') ORDER BY d->>'action_key')
   FROM jsonb_array_elements(g.canonical_snapshot->'runtime_actions') d
   WHERE a.snapshot->'policy'->'action_keys' ? (d->>'action_key')),'[]'::jsonb));
$$ LANGUAGE sql STABLE;

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
    'grant_snapshot_digest','lifecycle_epoch','grant_epoch','operator_user_id','policy','policy_digest','resource_descriptor_digest','actions','limits']<>'{}'::jsonb
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
DROP TRIGGER IF EXISTS app_owner_connection_admission_guard_trigger ON app_owner_connection_admissions;
CREATE TRIGGER app_owner_connection_admission_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON app_owner_connection_admissions
 FOR EACH ROW EXECUTE FUNCTION enforce_app_owner_connection_admission();

CREATE OR REPLACE FUNCTION enforce_app_runtime_registration() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APP_RUNTIME_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.org_id, NEW.app_installation_id, NEW.app_version_id, NEW.grant_snapshot_id,
        NEW.grant_snapshot_kind, NEW.operator_user_id, NEW.contract_version,
        NEW.owner_connection_admission_id, NEW.owner_connection_admission_digest, NEW.created_at) IS DISTINCT FROM
       (OLD.org_id, OLD.app_installation_id, OLD.app_version_id, OLD.grant_snapshot_id,
        OLD.grant_snapshot_kind, OLD.operator_user_id, OLD.contract_version,
        OLD.owner_connection_admission_id, OLD.owner_connection_admission_digest, OLD.created_at)
    THEN RAISE EXCEPTION 'APP_RUNTIME_IMMUTABLE_FIELD' USING ERRCODE = '55000'; END IF;
    IF (NEW.reviewed_by_user_id, NEW.reviewed_at) IS DISTINCT FROM
       (OLD.reviewed_by_user_id, OLD.reviewed_at)
       AND NOT (OLD.state = 'disabled' AND NEW.state = 'active'
         AND OLD.reviewed_by_user_id IS NULL AND OLD.reviewed_at IS NULL
         AND NEW.reviewed_by_user_id IS NOT NULL AND NEW.reviewed_at IS NOT NULL)
    THEN RAISE EXCEPTION 'APP_RUNTIME_IMMUTABLE_FIELD' USING ERRCODE = '55000'; END IF;
    IF NOT ((OLD.state = 'disabled' AND NEW.state = 'active'
             AND NEW.runtime_epoch = OLD.runtime_epoch + 1)
         OR (OLD.state = 'active' AND NEW.state = 'revoked'
             AND NEW.runtime_epoch = OLD.runtime_epoch + 1)
         OR (OLD.state = NEW.state AND NEW.runtime_epoch = OLD.runtime_epoch)) THEN
      RAISE EXCEPTION 'APP_RUNTIME_ILLEGAL_TRANSITION' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW.state = 'active' THEN
    IF NEW.owner_connection_admission_id IS NULL THEN
      IF NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=NEW.org_id AND user_id=NEW.reviewed_by_user_id
        AND is_active AND role IN ('owner','admin')) THEN
        RAISE EXCEPTION 'APP_RUNTIME_REVIEW_INVALID' USING ERRCODE='55000'; END IF;
    ELSIF NOT app_owner_connection_admission_current(NEW.org_id,NEW.owner_connection_admission_id,NEW.owner_connection_admission_digest)
      OR NOT app_owner_connection_member(NEW.org_id,NEW.reviewed_by_user_id)
      OR NEW.contract_version NOT IN ('deft.app_runtime_channel.v1','deft.app_runtime_channel.v3') THEN
      RAISE EXCEPTION 'APP_OWNER_CONNECTION_REVIEW_INVALID' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_app_runtime_binding() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APP_RUNTIME_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.org_id, NEW.app_installation_id, NEW.app_version_id, NEW.grant_snapshot_id,
        NEW.runtime_registration_id, NEW.action_key, NEW.interface_identity,
        NEW.provider_kind, NEW.provider_instance_id, NEW.provider_snapshot_id,
        NEW.operation_name, NEW.risk_class, NEW.review_requirement,
        NEW.retry_class, NEW.retention_class, NEW.created_at) IS DISTINCT FROM
       (OLD.org_id, OLD.app_installation_id, OLD.app_version_id, OLD.grant_snapshot_id,
        OLD.runtime_registration_id, OLD.action_key, OLD.interface_identity,
        OLD.provider_kind, OLD.provider_instance_id, OLD.provider_snapshot_id,
        OLD.operation_name, OLD.risk_class, OLD.review_requirement,
        OLD.retry_class, OLD.retention_class, OLD.created_at)
    THEN RAISE EXCEPTION 'APP_RUNTIME_IMMUTABLE_FIELD' USING ERRCODE = '55000'; END IF;
    IF (NEW.reviewed_by_user_id, NEW.reviewed_at) IS DISTINCT FROM
       (OLD.reviewed_by_user_id, OLD.reviewed_at)
       AND NOT (OLD.state = 'disabled' AND NEW.state = 'active'
         AND OLD.reviewed_by_user_id IS NULL AND OLD.reviewed_at IS NULL
         AND NEW.reviewed_by_user_id IS NOT NULL AND NEW.reviewed_at IS NOT NULL)
    THEN RAISE EXCEPTION 'APP_RUNTIME_IMMUTABLE_FIELD' USING ERRCODE = '55000'; END IF;
    IF NOT ((OLD.state = 'disabled' AND NEW.state = 'active')
         OR (OLD.state = 'active' AND NEW.state = 'revoked')
         OR OLD.state = NEW.state) THEN
      RAISE EXCEPTION 'APP_RUNTIME_ILLEGAL_TRANSITION' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW.state = 'active' THEN
    IF EXISTS(SELECT 1 FROM app_runtime_registrations r WHERE r.org_id=NEW.org_id AND r.id=NEW.runtime_registration_id
      AND r.owner_connection_admission_id IS NOT NULL) THEN
      IF NOT EXISTS(SELECT 1 FROM app_runtime_registrations r
        JOIN app_owner_connection_admissions a ON a.org_id=r.org_id AND a.id=r.owner_connection_admission_id AND a.review_digest=r.owner_connection_admission_digest
        JOIN app_resource_bindings b ON b.org_id=r.org_id AND b.id=NEW.owner_resource_binding_id
        JOIN app_runtime_registrations rr ON rr.org_id=b.org_id AND rr.id=b.runtime_registration_id
        WHERE r.org_id=NEW.org_id AND r.id=NEW.runtime_registration_id AND r.state='active'
        AND app_owner_connection_admission_current(r.org_id,a.id,a.review_digest)
        AND app_owner_connection_member(r.org_id,NEW.reviewed_by_user_id)
        AND NEW.reviewed_by_user_id=r.reviewed_by_user_id AND b.owner_user_id=r.reviewed_by_user_id
        AND b.state='active' AND b.consent_expires_at>clock_timestamp() AND b.resource_key=a.snapshot->'policy'->>'resource_key'
        AND b.app_installation_id=r.app_installation_id AND b.app_version_id=r.app_version_id AND b.grant_snapshot_id=r.grant_snapshot_id
        AND rr.owner_connection_admission_id=a.id AND rr.owner_connection_admission_digest=a.review_digest AND rr.operator_user_id=r.operator_user_id
        AND a.snapshot->'policy'->'action_keys' ? NEW.action_key) THEN
        RAISE EXCEPTION 'APP_OWNER_CONNECTION_ACTION_INVALID' USING ERRCODE='55000'; END IF;
    ELSIF NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=NEW.org_id AND user_id=NEW.reviewed_by_user_id
      AND is_active AND role IN ('owner','admin')) THEN
      RAISE EXCEPTION 'APP_RUNTIME_REVIEW_INVALID' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- The original binding state/identity guards still run. This supplements only
-- explicitly admitted registrations, including disabled candidate inserts.
CREATE OR REPLACE FUNCTION enforce_app_owner_connection_resource() RETURNS trigger AS $$
DECLARE r app_runtime_registrations%ROWTYPE; a app_owner_connection_admissions%ROWTYPE;
BEGIN
 SELECT * INTO r FROM app_runtime_registrations WHERE org_id=NEW.org_id AND id=NEW.runtime_registration_id;
 IF r.owner_connection_admission_id IS NULL OR NEW.state='revoked' THEN RETURN NEW; END IF;
 SELECT * INTO a FROM app_owner_connection_admissions WHERE org_id=r.org_id AND id=r.owner_connection_admission_id;
 IF NOT app_owner_connection_admission_current(r.org_id,a.id,r.owner_connection_admission_digest)
   OR NOT app_owner_connection_member(NEW.org_id,NEW.owner_user_id)
   OR NEW.registration_contract_version<>'deft.app_runtime_channel.v3'
   OR NEW.resource_key IS DISTINCT FROM a.snapshot->'policy'->>'resource_key'
   OR NEW.descriptor_digest IS DISTINCT FROM a.snapshot->>'resource_descriptor_digest'
   OR NEW.max_records_per_page>(a.snapshot->'limits'->>'max_records_per_page')::integer
   OR NEW.max_page_bytes>(a.snapshot->'limits'->>'max_page_bytes')::integer
   OR NEW.max_retained_records>(a.snapshot->'limits'->>'max_retained_records')::integer
   OR NEW.max_retained_bytes>(a.snapshot->'limits'->>'max_retained_bytes')::integer
   OR NEW.min_interval_seconds<(a.snapshot->'limits'->>'min_interval_seconds')::integer
   OR (NEW.state='active' AND (r.reviewed_by_user_id IS DISTINCT FROM NEW.owner_user_id
      OR NEW.reviewed_by_user_id IS DISTINCT FROM NEW.owner_user_id
      OR NEW.consent_expires_at IS NULL OR NEW.consent_expires_at<=clock_timestamp()
      OR NEW.consent_expires_at>NEW.reviewed_at+((a.snapshot->'policy'->>'max_consent_seconds')::integer * interval '1 second'))) THEN
   RAISE EXCEPTION 'APP_OWNER_CONNECTION_RESOURCE_INVALID' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_owner_connection_resource_guard_trigger ON app_resource_bindings;
CREATE TRIGGER app_owner_connection_resource_guard_trigger BEFORE INSERT OR UPDATE ON app_resource_bindings
 FOR EACH ROW EXECUTE FUNCTION enforce_app_owner_connection_resource();

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
        OR policy-ARRAY['key','resource_key','action_keys','max_consent_seconds']<>'{}'::jsonb
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
