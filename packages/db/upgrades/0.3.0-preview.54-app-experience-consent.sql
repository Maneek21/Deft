-- Durable exact human permission; existing short-lived consent is not backfilled.
CREATE TABLE IF NOT EXISTS app_experience_consent_grants (
 id text PRIMARY KEY, org_id text NOT NULL, owner_user_id text NOT NULL,
 app_installation_id text NOT NULL, app_version_id text NOT NULL, experience_key text NOT NULL,
 scope_digest text NOT NULL, snapshot jsonb NOT NULL, epoch integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
 CONSTRAINT app_experience_consent_grants_org_identity UNIQUE(org_id,id,owner_user_id),
 CONSTRAINT app_experience_consent_grants_owner_fk FOREIGN KEY(org_id,owner_user_id) REFERENCES org_members(org_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT app_experience_consent_grants_version_fk FOREIGN KEY(org_id,app_installation_id,app_version_id) REFERENCES app_versions(org_id,installation_id,id) ON DELETE RESTRICT,
 CONSTRAINT app_experience_consent_grants_digest_check CHECK(scope_digest ~ '^sha256:[a-f0-9]{64}$'),
 CONSTRAINT app_experience_consent_grants_epoch_check CHECK(epoch>=0)
);
CREATE UNIQUE INDEX IF NOT EXISTS app_experience_consent_grants_current_unique
 ON app_experience_consent_grants(org_id,owner_user_id,app_installation_id,experience_key,scope_digest) WHERE revoked_at IS NULL;
ALTER TABLE app_experience_sessions ADD COLUMN IF NOT EXISTS consent_grant_id text;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='app_experience_sessions_consent_fk') THEN
  ALTER TABLE app_experience_sessions ADD CONSTRAINT app_experience_sessions_consent_fk
   FOREIGN KEY(org_id,consent_grant_id,user_id) REFERENCES app_experience_consent_grants(org_id,id,owner_user_id) ON DELETE RESTRICT;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION deft_experience_consent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Experience consent history is retained'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'revoked_at'-'epoch') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'epoch')
   OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.epoch<>OLD.epoch+1 THEN
   RAISE EXCEPTION 'Experience consent is immutable except explicit revocation';
  END IF;
 ELSE
  IF NEW.epoch<>0 OR NEW.revoked_at IS NOT NULL OR jsonb_typeof(NEW.snapshot) IS DISTINCT FROM 'object'
   OR NEW.snapshot->>'schema_version' IS DISTINCT FROM 'deft.experience_consent.v1'
   OR NEW.snapshot->>'org_id' IS DISTINCT FROM NEW.org_id
   OR NEW.snapshot->>'owner_user_id' IS DISTINCT FROM NEW.owner_user_id
   OR NEW.snapshot->>'installation_id' IS DISTINCT FROM NEW.app_installation_id
   OR NEW.snapshot->>'app_version_id' IS DISTINCT FROM NEW.app_version_id
   OR NEW.snapshot->>'experience_key' IS DISTINCT FROM NEW.experience_key
   OR NEW.snapshot ?| ARRAY['web_session_id','experience_session_id','prepared_at','review_expires_at','web_access_expires_at','expires_at']
   OR jsonb_typeof(NEW.snapshot->'resources') IS DISTINCT FROM 'array'
   OR octet_length(NEW.snapshot::text)>24576 THEN
   RAISE EXCEPTION 'Experience consent scope is invalid';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_experience_consent_grants_guard ON app_experience_consent_grants;
CREATE TRIGGER app_experience_consent_grants_guard BEFORE INSERT OR UPDATE OR DELETE ON app_experience_consent_grants
 FOR EACH ROW EXECUTE FUNCTION deft_experience_consent_guard();
CREATE OR REPLACE FUNCTION deft_experience_consent_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE grant_row app_experience_consent_grants%ROWTYPE;
BEGIN
 IF NEW.consent_grant_id IS NULL THEN
  IF TG_OP='UPDATE' AND OLD.consent_grant_id IS NOT NULL THEN RAISE EXCEPTION 'Consent cannot be silently detached'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND OLD.consent_grant_id IS NOT NULL AND OLD.consent_grant_id<>NEW.consent_grant_id THEN
  RAISE EXCEPTION 'Consent cannot be silently rebound';
 END IF;
 SELECT * INTO grant_row FROM app_experience_consent_grants WHERE org_id=NEW.org_id AND id=NEW.consent_grant_id AND owner_user_id=NEW.user_id;
 IF NOT FOUND OR grant_row.app_installation_id<>NEW.app_installation_id OR grant_row.app_version_id<>NEW.app_version_id
  OR grant_row.experience_key<>NEW.experience_key OR grant_row.snapshot->>'artifact_digest' IS DISTINCT FROM NEW.artifact_digest
  OR grant_row.snapshot->>'grant_snapshot_id' IS DISTINCT FROM NEW.grant_snapshot_id
  OR grant_row.snapshot->>'lifecycle_epoch' IS DISTINCT FROM NEW.lifecycle_epoch::text
  OR grant_row.snapshot->>'grant_epoch' IS DISTINCT FROM NEW.grant_epoch::text THEN RAISE EXCEPTION 'Consent session lineage is invalid'; END IF;
 -- Revocation may still retire a lease, but never extend one or attach it anew.
 IF grant_row.revoked_at IS NOT NULL THEN
  IF TG_OP='INSERT' THEN RAISE EXCEPTION 'Revoked consent cannot renew a lease'; END IF;
  IF OLD.consent_grant_id IS NULL OR NEW.expires_at>OLD.expires_at THEN RAISE EXCEPTION 'Revoked consent cannot renew a lease'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_experience_sessions_consent_guard ON app_experience_sessions;
CREATE TRIGGER app_experience_sessions_consent_guard BEFORE INSERT OR UPDATE ON app_experience_sessions
 FOR EACH ROW EXECUTE FUNCTION deft_experience_consent_session_guard();
CREATE TABLE IF NOT EXISTS app_runtime_agent_policies (
 org_id text NOT NULL, owner_user_id text NOT NULL, runtime_binding_id text NOT NULL,
 mode text NOT NULL DEFAULT 'deny', revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT app_runtime_agent_policies_pkey PRIMARY KEY(org_id,owner_user_id,runtime_binding_id),
 CONSTRAINT app_runtime_agent_policies_owner_fk FOREIGN KEY(org_id,owner_user_id) REFERENCES org_members(org_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT app_runtime_agent_policies_binding_fk FOREIGN KEY(org_id,runtime_binding_id) REFERENCES app_runtime_bindings(org_id,id) ON DELETE RESTRICT,
 CONSTRAINT app_runtime_agent_policies_mode_check CHECK(mode IN ('deny','require_approval')),
 CONSTRAINT app_runtime_agent_policies_revision_check CHECK(revision>0)
);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='app_experience_resource_exposures_owner_identity') THEN
  ALTER TABLE app_experience_resource_exposures ADD CONSTRAINT app_experience_resource_exposures_owner_identity UNIQUE(org_id,id,owner_user_id);
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS app_run_human_authorizations (
 org_id text NOT NULL, run_id text NOT NULL, owner_user_id text NOT NULL,
 consent_grant_id text, consent_epoch integer, exposure_id text, exposure_epoch integer,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT app_run_human_authorizations_pkey PRIMARY KEY(org_id,run_id),
 CONSTRAINT app_run_human_authorizations_run_fk FOREIGN KEY(org_id,run_id) REFERENCES app_runs(org_id,id) ON DELETE RESTRICT,
 CONSTRAINT app_run_human_authorizations_consent_fk FOREIGN KEY(org_id,consent_grant_id,owner_user_id) REFERENCES app_experience_consent_grants(org_id,id,owner_user_id) ON DELETE RESTRICT,
 CONSTRAINT app_run_human_authorizations_exposure_fk FOREIGN KEY(org_id,exposure_id,owner_user_id) REFERENCES app_experience_resource_exposures(org_id,id,owner_user_id) ON DELETE RESTRICT,
 CONSTRAINT app_run_human_authorizations_identity_check CHECK(
  (consent_grant_id IS NOT NULL AND consent_epoch IS NOT NULL AND consent_epoch>=0 AND exposure_id IS NULL AND exposure_epoch IS NULL)
  OR (consent_grant_id IS NULL AND consent_epoch IS NULL AND exposure_id IS NOT NULL AND exposure_epoch IS NOT NULL AND exposure_epoch>=0))
);
CREATE OR REPLACE FUNCTION deft_run_human_authorization_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_row app_runs%ROWTYPE; grant_row app_experience_consent_grants%ROWTYPE; exposure_row app_experience_resource_exposures%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Human Run authorization is immutable'; END IF;
 SELECT * INTO run_row FROM app_runs WHERE org_id=NEW.org_id AND id=NEW.run_id;
 IF NOT FOUND OR run_row.initiating_actor_type<>'human' OR run_row.initiating_actor_id<>NEW.owner_user_id
  OR run_row.provider_kind<>'app_runtime' OR run_row.origin_kind<>'app' THEN RAISE EXCEPTION 'Human Run identity is invalid'; END IF;
 IF NEW.consent_grant_id IS NOT NULL THEN
  SELECT * INTO grant_row FROM app_experience_consent_grants WHERE org_id=NEW.org_id AND id=NEW.consent_grant_id AND owner_user_id=NEW.owner_user_id;
  IF NOT FOUND OR grant_row.revoked_at IS NOT NULL OR grant_row.epoch<>NEW.consent_epoch
   OR grant_row.app_installation_id IS DISTINCT FROM run_row.origin_app_installation_id
   OR grant_row.app_version_id IS DISTINCT FROM run_row.origin_app_version_id THEN RAISE EXCEPTION 'Human Run consent is invalid'; END IF;
 ELSE
  SELECT * INTO exposure_row FROM app_experience_resource_exposures WHERE org_id=NEW.org_id AND id=NEW.exposure_id AND owner_user_id=NEW.owner_user_id;
  IF NOT FOUND OR exposure_row.revoked_at IS NOT NULL OR exposure_row.exposure_epoch<>NEW.exposure_epoch OR exposure_row.expires_at<=now()
   OR exposure_row.snapshot->>'installation_id' IS DISTINCT FROM run_row.origin_app_installation_id
   OR exposure_row.snapshot->>'app_version_id' IS DISTINCT FROM run_row.origin_app_version_id THEN RAISE EXCEPTION 'Human Run exposure is invalid'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_run_human_authorizations_guard ON app_run_human_authorizations;
CREATE TRIGGER app_run_human_authorizations_guard BEFORE INSERT OR UPDATE OR DELETE ON app_run_human_authorizations
 FOR EACH ROW EXECUTE FUNCTION deft_run_human_authorization_guard();
