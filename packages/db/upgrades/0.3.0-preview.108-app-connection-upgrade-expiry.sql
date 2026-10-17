-- Add an immutable proof of expired, callback-unconsumed upgrade closure.
-- No historical rows, successful receipts, account custody, or deadlines change.
CREATE OR REPLACE FUNCTION deft_app_connection_upgrade_valid(r jsonb,current_scope jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE c jsonb:=r->'closure'; n numeric;
BEGIN
  IF r IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r->>'schema_version' IS DISTINCT FROM 'deft.app_connection_upgrade.v1'
    OR jsonb_typeof(r->'begin_consumed') IS DISTINCT FROM 'boolean'
    OR r-ARRAY['schema_version','source','transport_digest','review_expires_at','begin_consumed','review','receipt','closure']<>'{}'::jsonb
    OR NOT r ?& ARRAY['schema_version','source','transport_digest','review_expires_at','begin_consumed','review','receipt']
    OR (r->'begin_consumed'='true'::jsonb AND r->'review'='null'::jsonb)
    OR (r->'receipt'<>'null'::jsonb AND r->'begin_consumed'<>'true'::jsonb) THEN RETURN false; END IF;
  IF r ? 'closure' THEN
    IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR NOT c ?& ARRAY['reason','custody_generation','receipt_digest']
      OR c-ARRAY['reason','custody_generation','receipt_digest']<>'{}'::jsonb
      OR c->>'reason' IS DISTINCT FROM 'callback_expired'
      OR jsonb_typeof(c->'custody_generation') IS DISTINCT FROM 'number'
      OR jsonb_typeof(c->'receipt_digest') IS DISTINCT FROM 'string'
      OR NOT COALESCE(c->>'receipt_digest' ~ '^sha256:[a-f0-9]{64}$',false)
      OR r->'begin_consumed' IS DISTINCT FROM 'true'::jsonb OR r->'review'='null'::jsonb
      OR r->'receipt' IS DISTINCT FROM 'null'::jsonb THEN RETURN false; END IF;
    n:=(c->>'custody_generation')::numeric;
    IF n<>trunc(n) OR n NOT BETWEEN 1 AND 2147483646
      OR n IS DISTINCT FROM (r->'review'->>'custody_generation')::numeric+1 THEN RETURN false; END IF;
  END IF;
  -- A fresh reviewed profile may request added capability. Every other custody
  -- domain key stays equal; actual provider/client identity is runtime verified.
  RETURN deft_app_connection_reattachment_valid(
    (r-ARRAY['begin_consumed','closure'])||jsonb_build_object('schema_version','deft.app_connection_reattachment.v1'),
    current_scope||jsonb_build_object('profile_digest',r->'source'->'scope'->'profile_digest'));
END; $$;
CREATE OR REPLACE FUNCTION deft_app_connection_upgrade_record_valid(r jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE u jsonb:=r->'upgrade'; s text:=r->>'state';
BEGIN
  IF u ? 'closure' THEN
    RETURN COALESCE(s='not_connected' AND r->'callback_consumed'='false'::jsonb AND r->'account'='null'::jsonb
      AND (u->>'review_expires_at')::timestamptz<=(r->>'updated_at')::timestamptz
      AND (r->>'callback_expires_at')::timestamptz<=(r->>'updated_at')::timestamptz,false);
  END IF;
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
      OR ((NEW.record->'upgrade')-ARRAY['review','receipt','begin_consumed','closure']) IS DISTINCT FROM ((OLD.record->'upgrade')-ARRAY['review','receipt','begin_consumed','closure'])
      OR (OLD.record->'upgrade'->'review'<>'null'::jsonb AND NEW.record->'upgrade'->'review' IS DISTINCT FROM OLD.record->'upgrade'->'review')
      OR (OLD.record->'upgrade'->'receipt'<>'null'::jsonb AND NEW.record->'upgrade'->'receipt' IS DISTINCT FROM OLD.record->'upgrade'->'receipt')
      OR (OLD.record->'upgrade' ? 'closure' AND NEW.record->'upgrade'->'closure' IS DISTINCT FROM OLD.record->'upgrade'->'closure')
      OR (NEW.record->'upgrade' ? 'closure' AND NOT OLD.record->'upgrade' ? 'closure' AND (
        OLD.record->>'state'<>'upgrade_checking' OR OLD.record->'callback_consumed'<>'false'::jsonb
        OR OLD.record->'upgrade'->'begin_consumed'<>'true'::jsonb OR OLD.record->'upgrade'->'receipt'<>'null'::jsonb
        OR NEW.record->'runtime_session_ref' IS DISTINCT FROM OLD.record->'runtime_session_ref'
        OR (OLD.record->'upgrade'->>'review_expires_at')::timestamptz>clock_timestamp()
        OR (OLD.record->>'callback_expires_at')::timestamptz>clock_timestamp()))
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
