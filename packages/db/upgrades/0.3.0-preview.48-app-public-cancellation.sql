-- Additive explicit owner selection. Historical grants are ancestry only.
ALTER TABLE app_native_bindings ADD COLUMN IF NOT EXISTS historical_create_policy jsonb;
CREATE OR REPLACE FUNCTION valid_app_native_historical_create_policy(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; identity text; identities text[] := ARRAY[]::text[];
BEGIN
  IF value IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(value)<>'object' OR octet_length(value::text)>8192
    OR value->>'schema_version' IS DISTINCT FROM 'deft.app_native_historical_create_policy.v1'
    OR value-ARRAY['schema_version','creates']<>'{}'::jsonb
    OR jsonb_typeof(value->'creates') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(value->'creates') NOT BETWEEN 1 AND 16 THEN RETURN false; END IF;
  FOR item IN SELECT jsonb_array_elements(value->'creates') LOOP
    IF jsonb_typeof(item)<>'object' OR item-ARRAY['app_version_id','package_digest','grant_snapshot_id','grant_snapshot_digest']<>'{}'::jsonb
      OR NOT COALESCE(item->>'app_version_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
      OR NOT COALESCE(item->>'grant_snapshot_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
      OR NOT COALESCE(item->>'package_digest' ~ '^sha256:[a-f0-9]{64}$',false)
      OR NOT COALESCE(item->>'grant_snapshot_digest' ~ '^sha256:[a-f0-9]{64}$',false) THEN RETURN false; END IF;
    identity := (item->>'app_version_id')||':'||(item->>'grant_snapshot_id');
    IF identity=ANY(identities) THEN RETURN false; END IF;
    identities := array_append(identities,identity);
  END LOOP;
  RETURN true;
END $$;
ALTER TABLE app_native_bindings DROP CONSTRAINT IF EXISTS app_native_bindings_historical_create_check;
ALTER TABLE app_native_bindings ADD CONSTRAINT app_native_bindings_historical_create_check CHECK (
  historical_create_policy IS NULL OR (operation_name='calendar.events.cancel.v1' AND valid_app_native_historical_create_policy(historical_create_policy))
);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_native_bindings'::regclass AND conname='app_native_bindings_public_cancel_owner_unique') THEN
    ALTER TABLE app_native_bindings ADD CONSTRAINT app_native_bindings_public_cancel_owner_unique UNIQUE(org_id,app_installation_id,id,owner_user_id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_public_cancellations'::regclass AND conname='app_public_cancellations_selection_identity_unique') THEN
    ALTER TABLE app_public_cancellations ADD CONSTRAINT app_public_cancellations_selection_identity_unique UNIQUE(org_id,app_installation_id,id,original_run_id);
  END IF;
END $$;
ALTER TABLE app_public_cancellations DROP CONSTRAINT IF EXISTS app_public_cancellations_state_check;
ALTER TABLE app_public_cancellations ADD CONSTRAINT app_public_cancellations_state_check CHECK (
  state IN ('released_before_effect','withdrawal_requested','cancellation_unavailable','cancel_run_pending','cancelled','cancel_failed','unknown_outcome')
  AND ((state IN ('withdrawal_requested','cancel_run_pending','unknown_outcome') AND settled_at IS NULL)
    OR (state NOT IN ('withdrawal_requested','cancel_run_pending','unknown_outcome') AND settled_at IS NOT NULL AND settled_at>=accepted_at))
);
CREATE TABLE IF NOT EXISTS app_public_cancellation_selections (
  id text PRIMARY KEY,org_id text NOT NULL,cancellation_id text NOT NULL,app_installation_id text NOT NULL,
  original_run_id text NOT NULL,owner_user_id text NOT NULL,native_binding_id text NOT NULL,
  consent_digest text NOT NULL,selection_digest text NOT NULL,historical_create_pin jsonb NOT NULL,
  input_digest text NOT NULL,original_output_digest text NOT NULL,cancel_run_id text,created_at timestamp NOT NULL,
  CONSTRAINT app_public_cancellation_selections_request_fk FOREIGN KEY(org_id,app_installation_id,cancellation_id,original_run_id)
    REFERENCES app_public_cancellations(org_id,app_installation_id,id,original_run_id) ON DELETE RESTRICT,
  CONSTRAINT app_public_cancellation_selections_binding_fk FOREIGN KEY(org_id,app_installation_id,native_binding_id,owner_user_id)
    REFERENCES app_native_bindings(org_id,app_installation_id,id,owner_user_id) ON DELETE RESTRICT,
  CONSTRAINT app_public_cancellation_selections_run_fk FOREIGN KEY(org_id,cancel_run_id) REFERENCES app_runs(org_id,id) ON DELETE RESTRICT,
  CONSTRAINT app_public_cancellation_selections_request_unique UNIQUE(org_id,cancellation_id),
  CONSTRAINT app_public_cancellation_selections_run_unique UNIQUE(org_id,cancel_run_id),
  CONSTRAINT app_public_cancellation_selections_digests_check CHECK(consent_digest ~ '^sha256:[a-f0-9]{64}$'
    AND selection_digest ~ '^sha256:[a-f0-9]{64}$' AND input_digest ~ '^sha256:[a-f0-9]{64}$' AND original_output_digest ~ '^sha256:[a-f0-9]{64}$')
);
ALTER TABLE app_public_cancellation_selections DROP CONSTRAINT IF EXISTS app_public_cancellation_selections_pin_check;
ALTER TABLE app_public_cancellation_selections ADD CONSTRAINT app_public_cancellation_selections_pin_check CHECK (
  valid_app_native_historical_create_policy(jsonb_build_object('schema_version','deft.app_native_historical_create_policy.v1','creates',jsonb_build_array(historical_create_pin)))
);
CREATE OR REPLACE FUNCTION enforce_app_public_cancellation_selection_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'APP_PUBLIC_CANCELLATION_SELECTION_RETAINED' USING ERRCODE='55000'; END IF;
  IF (to_jsonb(NEW)-'cancel_run_id') IS DISTINCT FROM (to_jsonb(OLD)-'cancel_run_id')
    OR (OLD.cancel_run_id IS NOT NULL AND NEW.cancel_run_id IS DISTINCT FROM OLD.cancel_run_id) THEN
    RAISE EXCEPTION 'APP_PUBLIC_CANCELLATION_SELECTION_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_public_cancellation_selection_immutable ON app_public_cancellation_selections;
CREATE TRIGGER app_public_cancellation_selection_immutable BEFORE UPDATE OR DELETE ON app_public_cancellation_selections
  FOR EACH ROW EXECUTE FUNCTION enforce_app_public_cancellation_selection_immutable();
CREATE OR REPLACE FUNCTION enforce_app_public_cancellation_selection_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM app_public_cancellation_selections WHERE org_id=NEW.org_id AND id=NEW.id AND cancel_run_id IS NULL) THEN
    RAISE EXCEPTION 'APP_PUBLIC_CANCELLATION_SELECTION_INCOMPLETE' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS app_public_cancellation_selection_complete ON app_public_cancellation_selections;
CREATE CONSTRAINT TRIGGER app_public_cancellation_selection_complete AFTER INSERT OR UPDATE ON app_public_cancellation_selections
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_app_public_cancellation_selection_complete();
