-- Append-only connection v2 and explicit stable-account OAuth upgrade.
-- Existing v1 and reattachment records remain immutable and unchanged.
CREATE OR REPLACE FUNCTION deft_app_connection_actions_v2_valid(actions jsonb, scope jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE c jsonb; previous_key text := ''; ids text[] := '{}'; n numeric;
BEGIN
  IF jsonb_typeof(actions) IS DISTINCT FROM 'array' OR jsonb_array_length(actions)>8 THEN RETURN false; END IF;
  FOR c IN SELECT value FROM jsonb_array_elements(actions) LOOP
    IF jsonb_typeof(c) IS DISTINCT FROM 'object'
      OR c-ARRAY['action_binding_id','action_key','authority_epoch','consent_id','consent_digest','expires_at']<>'{}'::jsonb
      OR NOT c ?& ARRAY['action_binding_id','action_key','authority_epoch','consent_id','consent_digest','expires_at']
      OR NOT COALESCE(c->>'action_binding_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
      OR c->>'consent_id' IS DISTINCT FROM c->>'action_binding_id'
      OR NOT COALESCE(c->>'action_key' ~ '^[a-z][a-z0-9_]{0,47}$',false)
      OR c->>'action_key' IN ('constructor','prototype','__proto__')
      OR (c->>'action_key') COLLATE "C" <= previous_key COLLATE "C"
      OR c->>'action_binding_id'=ANY(ids)
      OR jsonb_typeof(c->'authority_epoch') IS DISTINCT FROM 'number'
      OR NOT COALESCE(c->>'consent_digest' ~ '^sha256:[a-f0-9]{64}$',false)
      OR jsonb_typeof(c->'expires_at') IS DISTINCT FROM 'string'
      OR NOT isfinite((c->>'expires_at')::timestamptz)
      OR NOT COALESCE((c->>'expires_at')::timestamptz <= (scope->>'consent_expires_at')::timestamptz,false) THEN RETURN false; END IF;
    n:=(c->>'authority_epoch')::numeric; IF n<>trunc(n) OR n NOT BETWEEN 0 AND 2147483647 THEN RETURN false; END IF;
    previous_key:=c->>'action_key'; ids:=array_append(ids,c->>'action_binding_id');
  END LOOP; RETURN true;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN RETURN false;
END; $$;
CREATE OR REPLACE FUNCTION deft_app_connection_upgrade_valid(r jsonb,current_scope jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF r IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r->>'schema_version' IS DISTINCT FROM 'deft.app_connection_upgrade.v1'
    OR jsonb_typeof(r->'begin_consumed') IS DISTINCT FROM 'boolean'
    OR r-ARRAY['schema_version','source','transport_digest','review_expires_at','begin_consumed','review','receipt']<>'{}'::jsonb
    OR NOT r ?& ARRAY['schema_version','source','transport_digest','review_expires_at','begin_consumed','review','receipt']
    OR (r->'begin_consumed'='true'::jsonb AND r->'review'='null'::jsonb)
    OR (r->'receipt'<>'null'::jsonb AND r->'begin_consumed'<>'true'::jsonb) THEN RETURN false; END IF;
  -- A fresh reviewed profile may request added capability. Every other custody
  -- domain key stays equal; actual provider/client identity is runtime verified.
  RETURN deft_app_connection_reattachment_valid(
    (r-'begin_consumed')||jsonb_build_object('schema_version','deft.app_connection_reattachment.v1'),
    current_scope||jsonb_build_object('profile_digest',r->'source'->'scope'->'profile_digest'));
END; $$;
CREATE OR REPLACE FUNCTION deft_app_connection_upgrade_record_valid(r jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE u jsonb:=r->'upgrade'; s text:=r->>'state';
BEGIN
  IF (u->'receipt'<>'null'::jsonb) THEN
    RETURN COALESCE(r->'callback_consumed'='true'::jsonb AND (r->'account'='null'::jsonb OR r->'account'=u->'review'->'account')
      AND r->'runtime_session_ref'<>'null'::jsonb AND s IN ('connected','checking','disconnecting','disconnected','indeterminate'),false);
  END IF;
  IF r->'account'<>'null'::jsonb THEN RETURN false; END IF;
  IF s='upgrade_reviewed' THEN RETURN COALESCE(u->'review'<>'null'::jsonb AND u->'begin_consumed'='false'::jsonb AND r->'callback_consumed'='false'::jsonb,false); END IF;
  IF s='upgrade_starting' THEN RETURN COALESCE(u->'begin_consumed'='true'::jsonb AND r->'callback_consumed'='false'::jsonb,false); END IF;
  IF s='awaiting_callback' THEN RETURN COALESCE(u->'begin_consumed'='true'::jsonb AND r->'runtime_session_ref'<>'null'::jsonb AND r->'callback_consumed'='false'::jsonb,false); END IF;
  IF s='connecting' THEN RETURN COALESCE(u->'begin_consumed'='true'::jsonb AND r->'callback_consumed'='true'::jsonb,false); END IF;
  RETURN s IN ('starting','upgrade_checking','indeterminate','not_connected');
END; $$;
ALTER TABLE app_connection_sessions DROP CONSTRAINT app_connection_sessions_record_identity;
ALTER TABLE app_connection_sessions ADD CONSTRAINT app_connection_sessions_record_identity CHECK ((
  jsonb_typeof(record)='object'
  AND record ?& ARRAY['session_id','revision','scope','profile','state','callback_state_hash','callback_consumed','callback_expires_at','runtime_session_ref','account','created_at','updated_at']
  AND record-ARRAY['session_id','revision','scope','profile','state','callback_state_hash','callback_consumed','callback_expires_at','runtime_session_ref','account','created_at','updated_at','action_consent','reattachment','action_consents','upgrade']='{}'::jsonb
  AND jsonb_typeof(record->'scope')='object' AND jsonb_typeof(record->'profile')='object'
  AND record->'scope' ?& ARRAY['org_id','owner_user_id'] AND record->>'session_id'=session_id
  AND (record->>'revision')::integer=revision
  AND record->'scope'->>'org_id'=org_id AND record->'scope'->>'owner_user_id'=owner_user_id
  AND record->>'callback_state_hash' ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(record->'callback_consumed')='boolean'
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
  AND (record->>'state' IN ('starting','awaiting_callback','connecting','checking','disconnecting','connected','not_connected','disconnected','indeterminate')
    OR (record ? 'reattachment' AND record->>'state' IN ('reattach_reviewed','reattaching','reattach_checking'))
    OR (record ? 'upgrade' AND record->>'state' IN ('upgrade_reviewed','upgrade_starting','upgrade_checking')))
  AND (NOT record ? 'action_consents' OR (NOT record ? 'action_consent' AND deft_app_connection_actions_v2_valid(record->'action_consents',record->'scope')))
  AND (NOT record ? 'upgrade' OR (NOT record ? 'reattachment' AND record ? 'action_consents' AND deft_app_connection_upgrade_valid(record->'upgrade',record->'scope')))
  AND deft_app_connection_reattachment_valid(record->'reattachment',record->'scope')
  AND (NOT record ? 'reattachment' OR record->>'state' NOT IN ('awaiting_callback','connecting'))
) IS TRUE);

CREATE OR REPLACE FUNCTION deft_app_connection_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.record ? 'upgrade' THEN
    IF NOT deft_app_connection_upgrade_record_valid(NEW.record) THEN RAISE EXCEPTION 'invalid connection upgrade state'; END IF;
  END IF;
  IF TG_OP='INSERT' THEN
    IF (NEW.record ? 'upgrade' AND ((NEW.record->'upgrade'->'begin_consumed') IS DISTINCT FROM 'false'::jsonb OR (NEW.record->'upgrade'->'review') IS DISTINCT FROM 'null'::jsonb OR (NEW.record->'upgrade'->'receipt') IS DISTINCT FROM 'null'::jsonb)) THEN RAISE EXCEPTION 'invalid upgrade admission'; END IF;
    IF NEW.revision<>0 OR NEW.record->>'state'<>'starting' OR NEW.record->'callback_consumed'<>'false'::jsonb
      OR (NEW.record ? 'reattachment' AND
        (NEW.record->'reattachment'->'review' IS DISTINCT FROM 'null'::jsonb
          OR NEW.record->'reattachment'->'receipt' IS DISTINCT FROM 'null'::jsonb)) THEN
      RAISE EXCEPTION 'invalid connection session admission';
    END IF;
  ELSE
    IF NEW.org_id<>OLD.org_id OR NEW.owner_user_id<>OLD.owner_user_id
      OR NEW.session_id<>OLD.session_id OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1
      OR NEW.record->'scope' IS DISTINCT FROM OLD.record->'scope'
      OR NEW.record->'profile' IS DISTINCT FROM OLD.record->'profile'
      OR NEW.record->'action_consent' IS DISTINCT FROM OLD.record->'action_consent'
      OR NEW.record->'action_consents' IS DISTINCT FROM OLD.record->'action_consents'
      OR (NEW.record ? 'upgrade') IS DISTINCT FROM (OLD.record ? 'upgrade')
      OR ((NEW.record->'upgrade')-ARRAY['review','receipt','begin_consumed']) IS DISTINCT FROM ((OLD.record->'upgrade')-ARRAY['review','receipt','begin_consumed'])
      OR (OLD.record->'upgrade'->'review'<>'null'::jsonb AND NEW.record->'upgrade'->'review' IS DISTINCT FROM OLD.record->'upgrade'->'review')
      OR (OLD.record->'upgrade'->'receipt'<>'null'::jsonb AND NEW.record->'upgrade'->'receipt' IS DISTINCT FROM OLD.record->'upgrade'->'receipt')
      OR (OLD.record->'upgrade'->'begin_consumed'='true'::jsonb AND NEW.record->'upgrade'->'begin_consumed' IS DISTINCT FROM 'true'::jsonb)
      OR (OLD.record->'upgrade'->'begin_consumed'='false'::jsonb AND NEW.record->'upgrade'->'begin_consumed'='true'::jsonb AND (OLD.record->>'state'<>'upgrade_reviewed' OR NEW.record->>'state'<>'upgrade_starting' OR OLD.record->'upgrade'->'review'='null'::jsonb))
      OR (NEW.record->'callback_state_hash' IS DISTINCT FROM OLD.record->'callback_state_hash' AND NOT COALESCE(OLD.record->'upgrade'->'begin_consumed'='false'::jsonb AND NEW.record->'upgrade'->'begin_consumed'='true'::jsonb AND OLD.record->>'state'='upgrade_reviewed' AND NEW.record->>'state'='upgrade_starting',false))
      OR NEW.record->'callback_expires_at' IS DISTINCT FROM OLD.record->'callback_expires_at'
      OR (OLD.record->'callback_consumed'='true'::jsonb AND NEW.record->'callback_consumed'<>'true'::jsonb)
      OR (NEW.record ? 'reattachment') IS DISTINCT FROM (OLD.record ? 'reattachment')
      OR ((NEW.record->'reattachment')-ARRAY['review','receipt']) IS DISTINCT FROM ((OLD.record->'reattachment')-ARRAY['review','receipt'])
      OR (OLD.record->'reattachment'->'review'<>'null'::jsonb AND NEW.record->'reattachment'->'review' IS DISTINCT FROM OLD.record->'reattachment'->'review')
      OR (OLD.record->'reattachment'->'receipt'<>'null'::jsonb AND NEW.record->'reattachment'->'receipt' IS DISTINCT FROM OLD.record->'reattachment'->'receipt') THEN
      RAISE EXCEPTION 'connection session immutable authority or CAS mismatch';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM web_sessions WHERE id=NEW.web_session_id AND org_id=NEW.org_id AND user_id=NEW.owner_user_id) THEN
    RAISE EXCEPTION 'connection session web identity mismatch';
  END IF;
  RETURN NEW;
END; $$;
