-- Explicit reviewed background observation over the retained resource-sync lane.
-- No existing consent, Run, connection, custody or historical row is changed.
CREATE OR REPLACE FUNCTION deft_resource_observation_scope_valid(s jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 RETURN COALESCE(jsonb_typeof(s)='object'
  AND s ?& ARRAY['org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','package_digest','grant_snapshot_digest','lifecycle_epoch','grant_epoch','target_key','resource_key','resource_binding_id','runtime_registration_id','operator_user_id','runtime_epoch','profile_digest','consent_expires_at']
  AND s-ARRAY['org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','package_digest','grant_snapshot_digest','lifecycle_epoch','grant_epoch','target_key','resource_key','resource_binding_id','runtime_registration_id','operator_user_id','runtime_epoch','profile_digest','consent_expires_at']='{}'::jsonb
  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','resource_binding_id','runtime_registration_id','operator_user_id']) k
   WHERE jsonb_typeof(s->k) IS DISTINCT FROM 'string' OR NOT COALESCE(s->>k ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',false))
  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['package_digest','grant_snapshot_digest','profile_digest']) k
   WHERE jsonb_typeof(s->k) IS DISTINCT FROM 'string' OR NOT COALESCE(s->>k ~ '^sha256:[a-f0-9]{64}$',false))
  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['target_key','resource_key']) k
   WHERE jsonb_typeof(s->k) IS DISTINCT FROM 'string' OR NOT COALESCE(s->>k ~ '^[a-z][a-z0-9_]{0,47}$',false) OR s->>k IN ('constructor','prototype','__proto__'))
  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['lifecycle_epoch','grant_epoch','runtime_epoch']) k
   WHERE jsonb_typeof(s->k) IS DISTINCT FROM 'number' OR (s->>k)::numeric NOT BETWEEN 0 AND 2147483647 OR (s->>k)::numeric<>trunc((s->>k)::numeric))
  AND jsonb_typeof(s->'consent_expires_at')='string' AND isfinite((s->>'consent_expires_at')::timestamptz),false);
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN RETURN false;
END;$$;
CREATE TABLE IF NOT EXISTS app_resource_observation_consents (
 org_id text NOT NULL,owner_user_id text NOT NULL,consent_id text NOT NULL,
 resource_binding_id text NOT NULL,connection_session_id text NOT NULL,
 state text NOT NULL,
 consent_digest text NOT NULL,snapshot jsonb NOT NULL,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 PRIMARY KEY(org_id,consent_id)
);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_resource_observation_consents'::regclass AND conname='app_resource_observation_state') THEN
  ALTER TABLE app_resource_observation_consents ADD CONSTRAINT app_resource_observation_state CHECK(state IN ('proposed','active','revoked'));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_resource_observation_consents'::regclass AND conname='app_resource_observation_bound') THEN
  ALTER TABLE app_resource_observation_consents ADD CONSTRAINT app_resource_observation_bound CHECK(octet_length(snapshot::text)<=16384);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_resource_observation_consents'::regclass AND conname='app_resource_observation_digest') THEN
  ALTER TABLE app_resource_observation_consents ADD CONSTRAINT app_resource_observation_digest CHECK(consent_digest ~ '^sha256:[a-f0-9]{64}$');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_resource_observation_consents'::regclass AND conname='app_resource_observation_identity') THEN
  ALTER TABLE app_resource_observation_consents ADD CONSTRAINT app_resource_observation_identity CHECK((jsonb_typeof(snapshot)='object'
  AND snapshot ?& ARRAY['schema_version','consent_id','scope','connection','resource_policy_digest','interval_seconds','expires_at']
  AND snapshot-ARRAY['schema_version','consent_id','scope','connection','resource_policy_digest','interval_seconds','expires_at']='{}'::jsonb
  AND snapshot->>'schema_version'='deft.app_resource_observation_consent.v1'
  AND snapshot->>'consent_id'=consent_id
  AND consent_id ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
  AND deft_resource_observation_scope_valid(snapshot->'scope')
  AND snapshot->'scope'->>'org_id'=org_id AND snapshot->'scope'->>'owner_user_id'=owner_user_id
  AND snapshot->'scope'->>'resource_binding_id'=resource_binding_id
  AND snapshot->>'resource_policy_digest' ~ '^sha256:[a-f0-9]{64}$'
  AND jsonb_typeof(snapshot->'interval_seconds')='number'
  AND (snapshot->>'interval_seconds')::numeric BETWEEN 60 AND 86400
  AND (snapshot->>'interval_seconds')::numeric=trunc((snapshot->>'interval_seconds')::numeric)
  AND jsonb_typeof(snapshot->'connection')='object'
  AND snapshot->'connection' ?& ARRAY['session_id','runtime_session_ref','account_ref','expected_custody_generation','receipt_digest']
  AND (snapshot->'connection')-ARRAY['session_id','runtime_session_ref','account_ref','expected_custody_generation','receipt_digest']='{}'::jsonb
  AND snapshot->'connection'->>'session_id'=connection_session_id
  AND snapshot->'connection'->>'runtime_session_ref' ~ '^[A-Za-z0-9_-]+$' AND length(snapshot->'connection'->>'runtime_session_ref') BETWEEN 1 AND 512
  AND snapshot->'connection'->>'account_ref' ~ '^[A-Za-z0-9_-]+$' AND length(snapshot->'connection'->>'account_ref') BETWEEN 1 AND 512
  AND ((snapshot->'connection'->'expected_custody_generation'='null'::jsonb AND snapshot->'connection'->'receipt_digest'='null'::jsonb)
   OR (jsonb_typeof(snapshot->'connection'->'expected_custody_generation')='number'
    AND (snapshot->'connection'->>'expected_custody_generation')::numeric BETWEEN 1 AND 2147483646
    AND (snapshot->'connection'->>'expected_custody_generation')::numeric=trunc((snapshot->'connection'->>'expected_custody_generation')::numeric)
    AND snapshot->'connection'->>'receipt_digest' ~ '^sha256:[a-f0-9]{64}$'))
  AND isfinite(expires_at) AND (snapshot->>'expires_at')::timestamptz=expires_at
  AND isfinite(created_at) AND isfinite(updated_at) AND expires_at>created_at AND updated_at>=created_at
 ) IS TRUE);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_resource_observation_consents'::regclass AND conname='app_resource_observation_owner_fk') THEN
  ALTER TABLE app_resource_observation_consents ADD CONSTRAINT app_resource_observation_owner_fk FOREIGN KEY(org_id,owner_user_id) REFERENCES org_members(org_id,user_id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_resource_observation_consents'::regclass AND conname='app_resource_observation_binding_fk') THEN
  ALTER TABLE app_resource_observation_consents ADD CONSTRAINT app_resource_observation_binding_fk FOREIGN KEY(org_id,resource_binding_id) REFERENCES app_resource_bindings(org_id,id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_resource_observation_consents'::regclass AND conname='app_resource_observation_connection_fk') THEN
  ALTER TABLE app_resource_observation_consents ADD CONSTRAINT app_resource_observation_connection_fk FOREIGN KEY(org_id,owner_user_id,connection_session_id) REFERENCES app_connection_sessions(org_id,owner_user_id,session_id) ON DELETE RESTRICT;
 END IF;
END;$$;
CREATE INDEX IF NOT EXISTS app_resource_observation_active_idx ON app_resource_observation_consents(org_id,resource_binding_id,state);
CREATE UNIQUE INDEX IF NOT EXISTS app_resource_observation_one_active ON app_resource_observation_consents(org_id,resource_binding_id) WHERE state='active';

CREATE OR REPLACE FUNCTION deft_resource_observation_consent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope jsonb; record jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'observation consent history retained';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['state','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','updated_at'])
   OR OLD.state='revoked' AND NEW.state<>'revoked'
   OR OLD.state='active' AND NEW.state NOT IN ('active','revoked')
   OR NEW.updated_at<OLD.updated_at THEN RAISE EXCEPTION 'observation consent immutable identity';END IF;
 ELSE
  IF NEW.state<>'proposed' THEN RAISE EXCEPTION 'observation review required';END IF;
 END IF;
 IF TG_OP='UPDATE' AND NEW.state='revoked' THEN RETURN NEW;END IF;
 scope:=NEW.snapshot->'scope';
 SELECT s.record INTO record FROM app_connection_sessions s WHERE s.org_id=NEW.org_id AND s.owner_user_id=NEW.owner_user_id AND s.session_id=NEW.connection_session_id;
 IF record IS NULL OR record->>'state' IS DISTINCT FROM 'connected' OR scope IS DISTINCT FROM record->'scope'
  OR NEW.snapshot->'connection'->'runtime_session_ref' IS DISTINCT FROM record->'runtime_session_ref'
  OR NEW.snapshot->'connection'->'account_ref' IS DISTINCT FROM record->'account'->'account_ref'
  OR NEW.snapshot->'connection'->'expected_custody_generation' IS DISTINCT FROM COALESCE(record->'reattachment'->'receipt'->'custody_generation','null'::jsonb)
  OR NEW.snapshot->'connection'->'receipt_digest' IS DISTINCT FROM COALESCE(record->'reattachment'->'receipt'->'receipt_digest','null'::jsonb)
  OR NOT COALESCE(isfinite((scope->>'consent_expires_at')::timestamptz) AND NEW.expires_at<=(scope->>'consent_expires_at')::timestamptz,false)
  THEN RAISE EXCEPTION 'observation connection pins mismatch';END IF;
 RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS app_resource_observation_consent_guard ON app_resource_observation_consents;
CREATE TRIGGER app_resource_observation_consent_guard BEFORE INSERT OR UPDATE OR DELETE ON app_resource_observation_consents FOR EACH ROW EXECUTE FUNCTION deft_resource_observation_consent_guard();

CREATE TABLE IF NOT EXISTS app_resource_observation_runs (
 org_id text NOT NULL,run_id text NOT NULL,consent_id text NOT NULL,consent_digest text NOT NULL,
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 PRIMARY KEY(org_id,run_id)
);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_resource_observation_runs'::regclass AND conname='app_resource_observation_run_fk') THEN
  ALTER TABLE app_resource_observation_runs ADD CONSTRAINT app_resource_observation_run_fk FOREIGN KEY(org_id,run_id) REFERENCES app_runs(org_id,id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_resource_observation_runs'::regclass AND conname='app_resource_observation_run_consent_fk') THEN
  ALTER TABLE app_resource_observation_runs ADD CONSTRAINT app_resource_observation_run_consent_fk FOREIGN KEY(org_id,consent_id) REFERENCES app_resource_observation_consents(org_id,consent_id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_resource_observation_runs'::regclass AND conname='app_resource_observation_run_digest') THEN
  ALTER TABLE app_resource_observation_runs ADD CONSTRAINT app_resource_observation_run_digest CHECK(consent_digest ~ '^sha256:[a-f0-9]{64}$');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_resource_observation_runs'::regclass AND conname='app_resource_observation_run_dates') THEN
  ALTER TABLE app_resource_observation_runs ADD CONSTRAINT app_resource_observation_run_dates CHECK(isfinite(created_at) AND isfinite(updated_at) AND updated_at>=created_at);
 END IF;
END;$$;
CREATE OR REPLACE FUNCTION deft_resource_observation_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r app_runs%ROWTYPE;c app_resource_observation_consents%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'observation Run link immutable';END IF;
 SELECT * INTO r FROM app_runs WHERE org_id=NEW.org_id AND id=NEW.run_id;
 SELECT * INTO c FROM app_resource_observation_consents WHERE org_id=NEW.org_id AND consent_id=NEW.consent_id;
 IF r.id IS NULL OR c.consent_id IS NULL OR c.state<>'active' OR c.consent_digest<>NEW.consent_digest
  OR r.origin_kind<>'app' OR r.provider_kind<>'app_runtime' OR r.review_scope<>'reviewed_resource_sync'
  OR r.origin_runtime_binding_id IS NOT NULL OR r.origin_resource_binding_id IS DISTINCT FROM c.resource_binding_id
  OR r.origin_app_installation_id IS DISTINCT FROM c.snapshot->'scope'->>'installation_id'
  OR r.origin_app_version_id IS DISTINCT FROM c.snapshot->'scope'->>'app_version_id'
  OR r.origin_app_grant_snapshot_id IS DISTINCT FROM c.snapshot->'scope'->>'grant_snapshot_id'
  OR r.initiating_actor_type<>'system' OR r.execution_actor_type<>'system'
  OR r.initiating_actor_id IS DISTINCT FROM c.resource_binding_id OR r.execution_actor_id IS DISTINCT FROM c.resource_binding_id
  OR r.state<>'pending' OR r.execution_released_at IS NULL
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.authorization_snapshot->'authority_refs') ref WHERE ref->>'authority_kind'='policy'
    AND ref->>'authority_id'=c.consent_id AND ref->>'version'=c.consent_digest)
  THEN RAISE EXCEPTION 'observation Run authority mismatch';END IF;
 RETURN NEW;
END;$$;
DROP TRIGGER IF EXISTS app_resource_observation_run_guard ON app_resource_observation_runs;
CREATE TRIGGER app_resource_observation_run_guard BEFORE INSERT OR UPDATE OR DELETE ON app_resource_observation_runs FOR EACH ROW EXECUTE FUNCTION deft_resource_observation_run_guard();
