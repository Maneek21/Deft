-- Additive, independent runtime-owned credential form metadata. No provider
-- credentials are representable here. OAuth v1/v2 tables/triggers are unchanged.
CREATE OR REPLACE FUNCTION deft_app_connection_form_scope_valid(s jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; n numeric;
BEGIN
 IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR NOT s ?& ARRAY['org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','package_digest','grant_snapshot_digest','lifecycle_epoch','grant_epoch','target_key','resource_key','resource_binding_id','runtime_registration_id','operator_user_id','runtime_epoch','profile_digest','consent_expires_at']
 OR s-ARRAY['org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','package_digest','grant_snapshot_digest','lifecycle_epoch','grant_epoch','target_key','resource_key','resource_binding_id','runtime_registration_id','operator_user_id','runtime_epoch','profile_digest','consent_expires_at']<>'{}'::jsonb THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','resource_binding_id','runtime_registration_id','operator_user_id'] LOOP
  IF jsonb_typeof(s->k) IS DISTINCT FROM 'string' OR NOT COALESCE(s->>k ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) THEN RETURN false; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['package_digest','grant_snapshot_digest','profile_digest'] LOOP
  IF jsonb_typeof(s->k) IS DISTINCT FROM 'string' OR NOT COALESCE(s->>k ~ '^sha256:[a-f0-9]{64}$',false) THEN RETURN false; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['target_key','resource_key'] LOOP
  IF jsonb_typeof(s->k) IS DISTINCT FROM 'string' OR NOT COALESCE(s->>k ~ '^[a-z][a-z0-9_]{0,47}$',false) OR s->>k IN ('constructor','prototype','__proto__') THEN RETURN false; END IF;
 END LOOP;
 FOREACH k IN ARRAY ARRAY['lifecycle_epoch','grant_epoch','runtime_epoch'] LOOP
  IF jsonb_typeof(s->k) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  n:=(s->>k)::numeric; IF n<>trunc(n) OR n NOT BETWEEN 0 AND 2147483647 THEN RETURN false; END IF;
 END LOOP;
 RETURN jsonb_typeof(s->'consent_expires_at')='string' AND isfinite((s->>'consent_expires_at')::timestamptz);
EXCEPTION WHEN OTHERS THEN RETURN false;
END; $$;
CREATE OR REPLACE FUNCTION deft_app_connection_form_record_valid(r jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s jsonb; receipt jsonb; account jsonb; source jsonb; k text; n numeric;
BEGIN
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR octet_length(r::text)>16384
 OR NOT r ?& ARRAY['schema_version','session_id','revision','scope','action_consents','source','transport_digest','authorization_origin','state','runtime_session_ref','begin_consumed','input_consumed','input_expires_at','account','receipt','created_at','updated_at']
 OR r-ARRAY['schema_version','session_id','revision','scope','action_consents','source','transport_digest','authorization_origin','state','runtime_session_ref','begin_consumed','input_consumed','input_expires_at','account','receipt','created_at','updated_at']<>'{}'::jsonb
 OR r->>'schema_version' IS DISTINCT FROM 'deft.app_connection_form_record.v1' THEN RETURN false; END IF;
 s:=r->'scope'; IF NOT COALESCE(deft_app_connection_form_scope_valid(s),false) OR NOT COALESCE(deft_app_connection_actions_v2_valid(r->'action_consents',s),false) THEN RETURN false; END IF;
 IF jsonb_typeof(r->'session_id') IS DISTINCT FROM 'string' OR NOT COALESCE(r->>'session_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
 OR jsonb_typeof(r->'revision') IS DISTINCT FROM 'number' OR jsonb_typeof(r->'begin_consumed') IS DISTINCT FROM 'boolean' OR jsonb_typeof(r->'input_consumed') IS DISTINCT FROM 'boolean'
 OR NOT COALESCE(r->>'transport_digest' ~ '^sha256:[a-f0-9]{64}$',false) OR NOT COALESCE(r->>'authorization_origin' ~ '^https://[a-z0-9.-]+$',false)
 OR length(r->>'authorization_origin')>512 OR jsonb_typeof(r->'state') IS DISTINCT FROM 'string' OR r->>'state' NOT IN ('starting','awaiting_input','checking','disconnecting','connected','not_connected','disconnected','indeterminate') THEN RETURN false; END IF;
 n:=(r->>'revision')::numeric; IF n<>trunc(n) OR n NOT BETWEEN 1 AND 2147483646 THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['created_at','updated_at','input_expires_at'] LOOP
  IF jsonb_typeof(r->k) IS DISTINCT FROM 'string' OR NOT isfinite((r->>k)::timestamptz) THEN RETURN false; END IF;
 END LOOP;
 IF (r->>'input_expires_at')::timestamptz>(r->>'created_at')::timestamptz+interval '5 minutes' OR (r->>'input_expires_at')::timestamptz>(s->>'consent_expires_at')::timestamptz OR (r->>'updated_at')::timestamptz<(r->>'created_at')::timestamptz THEN RETURN false; END IF;
 IF r->'runtime_session_ref'<>'null'::jsonb AND (jsonb_typeof(r->'runtime_session_ref') IS DISTINCT FROM 'string' OR length(r->>'runtime_session_ref') NOT BETWEEN 1 AND 512 OR NOT COALESCE(r->>'runtime_session_ref' ~ '^[A-Za-z0-9_-]+$',false)) THEN RETURN false; END IF;
 source:=r->'source'; IF source<>'null'::jsonb THEN
  IF jsonb_typeof(source) IS DISTINCT FROM 'object' OR NOT source ?& ARRAY['session_id','session_revision','scope','runtime_session_ref','account_ref'] OR source-ARRAY['session_id','session_revision','scope','runtime_session_ref','account_ref']<>'{}'::jsonb
  OR NOT COALESCE(deft_app_connection_form_scope_valid(source->'scope'),false) OR source->>'session_id'=r->>'session_id'
  OR NOT COALESCE(source->>'session_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
  OR NOT COALESCE(source->>'account_ref' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
  OR length(source->>'runtime_session_ref') NOT BETWEEN 1 AND 512 OR NOT COALESCE(source->>'runtime_session_ref' ~ '^[A-Za-z0-9_-]+$',false) OR jsonb_typeof(source->'session_revision') IS DISTINCT FROM 'number'
  OR source->'scope'->>'org_id' IS DISTINCT FROM s->>'org_id' OR source->'scope'->>'owner_user_id' IS DISTINCT FROM s->>'owner_user_id'
  OR source->'scope'->>'installation_id' IS DISTINCT FROM s->>'installation_id' OR source->'scope'->>'target_key' IS DISTINCT FROM s->>'target_key'
  OR source->'scope'->>'operator_user_id' IS DISTINCT FROM s->>'operator_user_id' THEN RETURN false; END IF;
  n:=(source->>'session_revision')::numeric; IF n<>trunc(n) OR n NOT BETWEEN 1 AND 2147483646 THEN RETURN false; END IF;
 END IF;
 account:=r->'account'; IF account<>'null'::jsonb THEN
  IF jsonb_typeof(account) IS DISTINCT FROM 'object' OR NOT account ?& ARRAY['account_ref','label','address','capabilities','identity_assurance'] OR account-ARRAY['account_ref','label','address','capabilities','identity_assurance']<>'{}'::jsonb
  OR NOT COALESCE(account->>'account_ref' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
  OR jsonb_typeof(account->'label') IS DISTINCT FROM 'string' OR length(account->>'label') NOT BETWEEN 1 AND 200 OR account->>'label' ~ '[[:cntrl:]<>]'
  OR jsonb_typeof(account->'address') IS DISTINCT FROM 'string' OR length(account->>'address') NOT BETWEEN 1 AND 320 OR account->>'address' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  OR account->>'identity_assurance' IS DISTINCT FROM 'owner_declared_authenticated' OR jsonb_typeof(account->'capabilities') IS DISTINCT FROM 'array' OR jsonb_array_length(account->'capabilities')>16
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(account->'capabilities') c WHERE jsonb_typeof(c) IS DISTINCT FROM 'string' OR c#>>'{}' !~ '^[a-z][a-z0-9_]{0,47}$')
  OR source<>'null'::jsonb AND account->>'account_ref' IS DISTINCT FROM source->>'account_ref' THEN RETURN false; END IF;
 END IF;
 receipt:=r->'receipt'; IF receipt<>'null'::jsonb THEN
  IF jsonb_typeof(receipt) IS DISTINCT FROM 'object' OR NOT receipt ?& ARRAY['schema_version','account_ref','custody_generation','principal_digest','custody_digest','scope_digest','committed_at','digest'] OR receipt-ARRAY['schema_version','account_ref','custody_generation','principal_digest','custody_digest','scope_digest','committed_at','digest']<>'{}'::jsonb
  OR receipt->>'schema_version' IS DISTINCT FROM 'deft.app_connection_form_receipt.v1' OR account='null'::jsonb OR receipt->>'account_ref' IS DISTINCT FROM account->>'account_ref'
  OR r->'input_consumed' IS DISTINCT FROM 'true'::jsonb OR r->'begin_consumed' IS DISTINCT FROM 'true'::jsonb OR jsonb_typeof(receipt->'custody_generation') IS DISTINCT FROM 'number'
  OR jsonb_typeof(receipt->'committed_at') IS DISTINCT FROM 'string' OR NOT isfinite((receipt->>'committed_at')::timestamptz) THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['principal_digest','custody_digest','scope_digest','digest'] LOOP IF jsonb_typeof(receipt->k) IS DISTINCT FROM 'string' OR NOT COALESCE(receipt->>k ~ '^sha256:[a-f0-9]{64}$',false) THEN RETURN false; END IF; END LOOP;
  n:=(receipt->>'custody_generation')::numeric; IF n<>trunc(n) OR n NOT BETWEEN 1 AND 2147483646 THEN RETURN false; END IF;
 END IF;
 IF r->>'state'='connected' AND (account='null'::jsonb OR receipt='null'::jsonb OR r->'runtime_session_ref'='null'::jsonb) THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END; $$;
CREATE TABLE IF NOT EXISTS app_connection_forms (
 org_id text NOT NULL,owner_user_id text NOT NULL,session_id text NOT NULL,
 web_session_id text NOT NULL,access_expires_at timestamptz NOT NULL,
 revision integer NOT NULL,record jsonb NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 PRIMARY KEY(org_id,owner_user_id,session_id),
 CONSTRAINT app_connection_forms_carrier_fk FOREIGN KEY(org_id,owner_user_id,session_id) REFERENCES app_connection_sessions(org_id,owner_user_id,session_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CONSTRAINT app_connection_forms_owner_fk FOREIGN KEY(org_id,owner_user_id) REFERENCES org_members(org_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT app_connection_forms_web_session_fk FOREIGN KEY(web_session_id) REFERENCES web_sessions(id) ON DELETE RESTRICT,
 CONSTRAINT app_connection_forms_identity CHECK ((deft_app_connection_form_record_valid(record)
  AND record->>'session_id'=session_id AND (record->>'revision')::integer=revision
  AND record->'scope'->>'org_id'=org_id AND record->'scope'->>'owner_user_id'=owner_user_id
  AND (record->>'created_at')::timestamptz=created_at AND (record->>'updated_at')::timestamptz=updated_at
  AND isfinite(access_expires_at)) IS TRUE)
);
-- Drizzle fresh-push creates the table before extras. Install the same closed
-- identities and deferred compatibility FK without replacing existing guards.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_connection_forms'::regclass AND conname='app_connection_forms_carrier_fk') THEN
  ALTER TABLE app_connection_forms ADD CONSTRAINT app_connection_forms_carrier_fk FOREIGN KEY(org_id,owner_user_id,session_id) REFERENCES app_connection_sessions(org_id,owner_user_id,session_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_connection_forms'::regclass AND conname='app_connection_forms_owner_fk') THEN
  ALTER TABLE app_connection_forms ADD CONSTRAINT app_connection_forms_owner_fk FOREIGN KEY(org_id,owner_user_id) REFERENCES org_members(org_id,user_id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_connection_forms'::regclass AND conname='app_connection_forms_web_session_fk') THEN
  ALTER TABLE app_connection_forms ADD CONSTRAINT app_connection_forms_web_session_fk FOREIGN KEY(web_session_id) REFERENCES web_sessions(id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_connection_forms'::regclass AND conname='app_connection_forms_identity') THEN
  ALTER TABLE app_connection_forms ADD CONSTRAINT app_connection_forms_identity CHECK ((deft_app_connection_form_record_valid(record)
   AND record->>'session_id'=session_id AND (record->>'revision')::integer=revision
   AND record->'scope'->>'org_id'=org_id AND record->'scope'->>'owner_user_id'=owner_user_id
   AND (record->>'created_at')::timestamptz=created_at AND (record->>'updated_at')::timestamptz=updated_at
   AND isfinite(access_expires_at)) IS TRUE);
 END IF;
END; $$;
CREATE INDEX IF NOT EXISTS app_connection_forms_current_target ON app_connection_forms(org_id,owner_user_id,(record->'scope'->>'installation_id'),(record->'scope'->>'target_key'));
CREATE OR REPLACE FUNCTION deft_app_connection_form_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'APP_CONNECTION_FORM_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.record->>'state'<>'starting' OR NEW.record->'begin_consumed'<>'false'::jsonb OR NEW.record->'input_consumed'<>'false'::jsonb OR NEW.record->'account'<>'null'::jsonb OR NEW.record->'receipt'<>'null'::jsonb OR NEW.record->'runtime_session_ref'<>'null'::jsonb THEN RAISE EXCEPTION 'APP_CONNECTION_FORM_INITIAL_STATE' USING ERRCODE='23514'; END IF; RETURN NEW;
 END IF;
 IF NEW.org_id<>OLD.org_id OR NEW.owner_user_id<>OLD.owner_user_id OR NEW.session_id<>OLD.session_id OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'APP_CONNECTION_FORM_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM app_connection_forms child WHERE child.org_id=OLD.org_id AND child.owner_user_id=OLD.owner_user_id
  AND child.record->'source'->>'session_id'=OLD.session_id AND child.record->'begin_consumed'='true'::jsonb
  AND NOT(child.record->>'state'='not_connected' AND child.record->'input_consumed'='false'::jsonb)) THEN
  RAISE EXCEPTION 'APP_CONNECTION_FORM_SOURCE_RESERVED' USING ERRCODE='23514'; END IF;
 FOREACH k IN ARRAY ARRAY['schema_version','session_id','scope','action_consents','source','transport_digest','authorization_origin','input_expires_at','created_at'] LOOP IF NEW.record->k IS DISTINCT FROM OLD.record->k THEN RAISE EXCEPTION 'APP_CONNECTION_FORM_IMMUTABLE' USING ERRCODE='23514'; END IF; END LOOP;
 IF OLD.record->'begin_consumed'='true'::jsonb AND NEW.record->'begin_consumed'<>'true'::jsonb OR OLD.record->'input_consumed'='true'::jsonb AND NEW.record->'input_consumed'<>'true'::jsonb
 OR OLD.record->'receipt'<>'null'::jsonb AND NEW.record->'receipt' IS DISTINCT FROM OLD.record->'receipt'
 OR OLD.record->'account'<>'null'::jsonb AND NEW.record->'account' IS DISTINCT FROM OLD.record->'account'
 OR OLD.record->'runtime_session_ref'<>'null'::jsonb AND NEW.record->'runtime_session_ref' IS DISTINCT FROM OLD.record->'runtime_session_ref' THEN RAISE EXCEPTION 'APP_CONNECTION_FORM_CUSTODY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NOT ((OLD.record->>'state'='starting' AND NEW.record->>'state' IN ('starting','awaiting_input','not_connected','indeterminate'))
 OR (OLD.record->>'state'='awaiting_input' AND NEW.record->>'state' IN ('checking','disconnecting','indeterminate'))
 OR (OLD.record->>'state' IN ('connected','indeterminate') AND NEW.record->>'state' IN ('checking','disconnecting','indeterminate'))
 OR (OLD.record->>'state'='checking' AND NEW.record->>'state' IN ('awaiting_input','connected','not_connected','disconnected','indeterminate'))
 OR (OLD.record->>'state'='disconnecting' AND NEW.record->>'state' IN ('connected','disconnected','indeterminate'))) THEN
  RAISE EXCEPTION 'APP_CONNECTION_FORM_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS app_connection_form_immutable ON app_connection_forms;
CREATE TRIGGER app_connection_form_immutable BEFORE INSERT OR UPDATE OR DELETE ON app_connection_forms FOR EACH ROW EXECUTE FUNCTION deft_app_connection_form_immutable();

-- Validate the final committed row, not the transient INSERT event snapshot.
-- This allows the historical revision0 admission to be consumed at revision1
-- in one transaction without exposing an OAuth-ready form carrier.
CREATE OR REPLACE FUNCTION deft_app_connection_form_pair_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f app_connection_forms%ROWTYPE; c app_connection_sessions%ROWTYPE; source app_connection_forms%ROWTYPE; projected_state text;
BEGIN
 SELECT * INTO f FROM app_connection_forms WHERE org_id=NEW.org_id AND owner_user_id=NEW.owner_user_id AND session_id=NEW.session_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT * INTO c FROM app_connection_sessions WHERE org_id=f.org_id AND owner_user_id=f.owner_user_id AND session_id=f.session_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'APP_CONNECTION_FORM_SPLIT_STATE' USING ERRCODE='23514'; END IF;
 projected_state:=CASE WHEN f.record->>'state'='awaiting_input' THEN 'awaiting_callback' ELSE f.record->>'state' END;
 IF (c.revision=f.revision AND c.web_session_id=f.web_session_id AND c.access_expires_at=f.access_expires_at
  AND c.record->'scope'=f.record->'scope' AND c.record->'action_consents'=f.record->'action_consents'
  AND c.record->>'state'=projected_state AND c.record->'callback_consumed'='true'::jsonb
  AND c.record->'runtime_session_ref'=f.record->'runtime_session_ref'
  AND c.record->>'callback_expires_at'=f.record->>'input_expires_at'
  AND c.record->>'created_at'=f.record->>'created_at' AND c.record->>'updated_at'=f.record->>'updated_at'
  AND c.created_at=f.created_at AND c.updated_at=f.updated_at
  AND c.record->'profile'->>'authorization_origin'=f.record->>'authorization_origin'
  AND NOT c.record ?| ARRAY['action_consent','reattachment','upgrade']
  AND c.record->'account'=CASE WHEN f.record->'account'='null'::jsonb THEN 'null'::jsonb ELSE jsonb_build_object('account_ref',f.record->'account'->'account_ref','label',f.record->'account'->'label') END) IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'APP_CONNECTION_FORM_SPLIT_STATE' USING ERRCODE='23514'; END IF;
 IF f.record->'source'<>'null'::jsonb THEN
  SELECT * INTO source FROM app_connection_forms WHERE org_id=f.org_id AND owner_user_id=f.owner_user_id AND session_id=f.record->'source'->>'session_id';
  IF NOT FOUND OR (source.record->>'state'='connected' AND source.revision=(f.record->'source'->>'session_revision')::integer
   AND source.record->'scope'=f.record->'source'->'scope' AND source.record->'runtime_session_ref'=f.record->'source'->'runtime_session_ref'
   AND source.record->'account'->'account_ref'=f.record->'source'->'account_ref' AND source.record->'receipt'<>'null'::jsonb) IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'APP_CONNECTION_FORM_SOURCE_STALE' USING ERRCODE='23514'; END IF;
  IF f.record->'receipt'<>'null'::jsonb AND ((f.record->'receipt'->>'custody_generation')::integer=(source.record->'receipt'->>'custody_generation')::integer+1
   AND f.record->'receipt'->'principal_digest'=source.record->'receipt'->'principal_digest') IS DISTINCT FROM true THEN
   RAISE EXCEPTION 'APP_CONNECTION_FORM_GENERATION_INVALID' USING ERRCODE='23514'; END IF;
 ELSIF f.record->'receipt'<>'null'::jsonb AND (f.record->'receipt'->>'custody_generation')::integer<>1 THEN
  RAISE EXCEPTION 'APP_CONNECTION_FORM_GENERATION_INVALID' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS app_connection_form_pair_guard ON app_connection_forms;
CREATE CONSTRAINT TRIGGER app_connection_form_pair_guard AFTER INSERT OR UPDATE ON app_connection_forms DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION deft_app_connection_form_pair_guard();
DROP TRIGGER IF EXISTS app_connection_form_carrier_pair_guard ON app_connection_sessions;
CREATE CONSTRAINT TRIGGER app_connection_form_carrier_pair_guard AFTER INSERT OR UPDATE ON app_connection_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION deft_app_connection_form_pair_guard();
