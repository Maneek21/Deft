-- Additive private-target selection. Existing custody/sessions remain primary.
ALTER TABLE app_resource_bindings ADD COLUMN IF NOT EXISTS target_key text NOT NULL DEFAULT 'primary';
ALTER TABLE app_runtime_bindings ADD COLUMN IF NOT EXISTS owner_resource_binding_id text;
ALTER TABLE app_experience_sessions ADD COLUMN IF NOT EXISTS resource_target_key text NOT NULL DEFAULT 'primary';
ALTER TABLE app_private_state_records ADD COLUMN IF NOT EXISTS resource_target_key text NOT NULL DEFAULT 'primary';
DROP INDEX IF EXISTS app_resource_bindings_one_current_consent_unique;
CREATE UNIQUE INDEX app_resource_bindings_one_current_consent_unique
 ON app_resource_bindings(org_id,app_installation_id,grant_snapshot_id,owner_user_id,resource_key,target_key)
 WHERE state<>'revoked';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='app_resource_bindings_target_key_check') THEN
  ALTER TABLE app_resource_bindings ADD CONSTRAINT app_resource_bindings_target_key_check
   CHECK(target_key ~ '^[a-z][a-z0-9_]{0,47}$');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='app_experience_sessions_target_key_check') THEN
  ALTER TABLE app_experience_sessions ADD CONSTRAINT app_experience_sessions_target_key_check
   CHECK(resource_target_key ~ '^[a-z][a-z0-9_]{0,47}$');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='app_runtime_bindings_owner_resource_fk') THEN
  ALTER TABLE app_runtime_bindings ADD CONSTRAINT app_runtime_bindings_owner_resource_fk
   FOREIGN KEY(org_id,owner_resource_binding_id) REFERENCES app_resource_bindings(org_id,id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='app_private_state_records_target_key_check') THEN
  ALTER TABLE app_private_state_records ADD CONSTRAINT app_private_state_records_target_key_check
   CHECK(resource_target_key ~ '^[a-z][a-z0-9_]{0,47}$');
 END IF;
END $$;
CREATE OR REPLACE FUNCTION deft_owner_target_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='app_resource_bindings' THEN
  IF NEW.target_key IS DISTINCT FROM OLD.target_key THEN
   RAISE EXCEPTION 'APP_RESOURCE_TARGET_IMMUTABLE' USING ERRCODE='55000';
  END IF;
 ELSIF TG_TABLE_NAME='app_runtime_bindings' THEN
  IF NEW.owner_resource_binding_id IS DISTINCT FROM OLD.owner_resource_binding_id THEN
   RAISE EXCEPTION 'APP_RUNTIME_TARGET_IMMUTABLE' USING ERRCODE='55000';
  END IF;
 ELSIF TG_TABLE_NAME IN ('app_experience_sessions','app_private_state_records') THEN
  IF NEW.resource_target_key IS DISTINCT FROM OLD.resource_target_key THEN
   RAISE EXCEPTION 'APP_EXPERIENCE_TARGET_IMMUTABLE' USING ERRCODE='55000';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_resource_target_immutable ON app_resource_bindings;
CREATE TRIGGER app_resource_target_immutable BEFORE UPDATE ON app_resource_bindings
 FOR EACH ROW EXECUTE FUNCTION deft_owner_target_immutable();
DROP TRIGGER IF EXISTS app_runtime_target_immutable ON app_runtime_bindings;
CREATE TRIGGER app_runtime_target_immutable BEFORE UPDATE ON app_runtime_bindings
 FOR EACH ROW EXECUTE FUNCTION deft_owner_target_immutable();
DROP TRIGGER IF EXISTS app_experience_target_immutable ON app_experience_sessions;
CREATE TRIGGER app_experience_target_immutable BEFORE UPDATE ON app_experience_sessions
 FOR EACH ROW EXECUTE FUNCTION deft_owner_target_immutable();
DROP TRIGGER IF EXISTS app_private_state_target_immutable ON app_private_state_records;
CREATE TRIGGER app_private_state_target_immutable BEFORE UPDATE ON app_private_state_records
 FOR EACH ROW EXECUTE FUNCTION deft_owner_target_immutable();
