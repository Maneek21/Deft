-- Dormant, explicit session-bound App-author disclosure consent. No backfill.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='app_experience_sessions'::regclass
   AND conname='app_experience_sessions_org_identity_unique') THEN
  ALTER TABLE app_experience_sessions ADD CONSTRAINT app_experience_sessions_org_identity_unique
   UNIQUE(org_id,id,user_id,web_session_id);
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS app_experience_resource_exposures (
 id text PRIMARY KEY, org_id text NOT NULL, experience_session_id text NOT NULL,
 owner_user_id text NOT NULL, web_session_id text NOT NULL,
 review_digest text NOT NULL, snapshot jsonb NOT NULL, payload_policy_version text NOT NULL,
 exposure_epoch integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL, revoked_at timestamptz,
 CONSTRAINT app_experience_resource_exposures_session_fk FOREIGN KEY
 (org_id,experience_session_id,owner_user_id,web_session_id)
 REFERENCES app_experience_sessions(org_id,id,user_id,web_session_id) ON DELETE CASCADE,
 CONSTRAINT app_experience_resource_exposures_org_id_unique UNIQUE(org_id,id),
 CONSTRAINT app_experience_resource_exposures_review_unique UNIQUE(org_id,experience_session_id,review_digest),
 CONSTRAINT app_experience_resource_exposures_digest_check CHECK(review_digest ~ '^sha256:[a-f0-9]{64}$'),
 CONSTRAINT app_experience_resource_exposures_policy_check CHECK(payload_policy_version='deft.experience_resource_payload.v1'),
 CONSTRAINT app_experience_resource_exposures_epoch_check CHECK(exposure_epoch>=0),
 CONSTRAINT app_experience_resource_exposures_expiry_check CHECK(expires_at>created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS app_experience_resource_exposures_current_unique
 ON app_experience_resource_exposures(org_id,experience_session_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS app_experience_resource_exposure_resources (
 org_id text NOT NULL, exposure_id text NOT NULL, resource_key text NOT NULL,
 resource_binding_id text NOT NULL, runtime_registration_id text NOT NULL,
 runtime_epoch integer NOT NULL, descriptor_digest text NOT NULL, resource_type text NOT NULL,
 allowed_operations jsonb NOT NULL, allowed_fields jsonb NOT NULL,
 PRIMARY KEY(org_id,exposure_id,resource_key),
 CONSTRAINT app_experience_resource_exposure_resources_parent_fk FOREIGN KEY(org_id,exposure_id)
 REFERENCES app_experience_resource_exposures(org_id,id) ON DELETE CASCADE,
 CONSTRAINT app_experience_resource_exposure_resources_binding_fk FOREIGN KEY(org_id,runtime_registration_id,resource_binding_id)
 REFERENCES app_resource_bindings(org_id,runtime_registration_id,id) ON DELETE RESTRICT,
 CONSTRAINT app_experience_resource_exposure_resources_epoch_check CHECK(runtime_epoch>0),
 CONSTRAINT app_experience_resource_exposure_resources_key_check CHECK(resource_key ~ '^[a-z][a-z0-9_]{0,47}$')
);
-- Audit has no session/exposure FK: pruning short-lived operational rows must
-- not delete accepted/revoked authority history. Contains safe pins only.
CREATE TABLE IF NOT EXISTS app_experience_resource_exposure_audit (
 id text PRIMARY KEY, org_id text NOT NULL, exposure_id text NOT NULL,
 experience_session_id text NOT NULL, owner_user_id text NOT NULL,
 review_digest text NOT NULL, event text NOT NULL, safe_snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT app_experience_resource_exposure_audit_event_unique UNIQUE(org_id,exposure_id,event),
 CONSTRAINT app_experience_resource_exposure_audit_event_check CHECK(event IN ('accepted','revoked'))
);
CREATE OR REPLACE FUNCTION deft_experience_exposure_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='app_experience_resource_exposures' THEN
  IF (to_jsonb(NEW)-'revoked_at'-'exposure_epoch') IS DISTINCT FROM
     (to_jsonb(OLD)-'revoked_at'-'exposure_epoch') OR
     NEW.exposure_epoch <> OLD.exposure_epoch + 1 OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
   RAISE EXCEPTION 'Experience exposure consent is immutable';
  END IF;
 ELSE
  RAISE EXCEPTION 'Experience exposure snapshot is immutable';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_experience_resource_exposures_immutable ON app_experience_resource_exposures;
CREATE TRIGGER app_experience_resource_exposures_immutable BEFORE UPDATE ON app_experience_resource_exposures
 FOR EACH ROW EXECUTE FUNCTION deft_experience_exposure_immutable();
DROP TRIGGER IF EXISTS app_experience_resource_exposure_resources_immutable ON app_experience_resource_exposure_resources;
CREATE TRIGGER app_experience_resource_exposure_resources_immutable BEFORE UPDATE ON app_experience_resource_exposure_resources
 FOR EACH ROW EXECUTE FUNCTION deft_experience_exposure_immutable();
DROP TRIGGER IF EXISTS app_experience_resource_exposure_audit_immutable ON app_experience_resource_exposure_audit;
CREATE TRIGGER app_experience_resource_exposure_audit_immutable BEFORE UPDATE OR DELETE ON app_experience_resource_exposure_audit
 FOR EACH ROW EXECUTE FUNCTION deft_experience_exposure_immutable();
