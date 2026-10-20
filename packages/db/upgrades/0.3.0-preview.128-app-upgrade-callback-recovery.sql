-- Close only Runtime-proven untouched expired upgrades; preserve callback history.
-- No historical data or deadlines are rewritten.
CREATE OR REPLACE FUNCTION deft_app_connection_upgrade_record_valid(r jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE u jsonb:=r->'upgrade'; s text:=r->>'state';
BEGIN
  IF u ? 'closure' THEN
    RETURN COALESCE(s='not_connected' AND r->'account'='null'::jsonb
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
CREATE OR REPLACE FUNCTION public.deft_app_connection_session_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN

  IF NEW.record ? 'credential_repair' OR (TG_OP='UPDATE' AND OLD.record ? 'credential_repair') THEN
    IF NOT NEW.record ? 'credential_repair' OR NOT COALESCE(public.deft_app_connection_credential_repair_record_valid(NEW.record),false) THEN RAISE EXCEPTION 'invalid credential repair state'; END IF;
    IF EXISTS(SELECT 1 FROM public.app_connection_sessions repair WHERE repair.org_id=NEW.org_id AND repair.session_id<>NEW.session_id
      AND repair.record->'credential_repair'->'source'->'scope'->>'resource_binding_id'=NEW.record->'scope'->>'resource_binding_id'
      AND (repair.record->'credential_repair'->'reservation_closed'='false'::jsonb OR repair.record->'credential_repair'->'receipt'<>'null'::jsonb AND repair.record->'credential_repair'->'source'->>'session_id'=NEW.session_id))
    THEN RAISE EXCEPTION 'credential repair reserves source'; END IF;
    IF TG_OP='INSERT' THEN
      IF NEW.revision<>0 OR NEW.record->>'state'<>'starting' OR NEW.record->'callback_consumed'<>'false'::jsonb OR NEW.record->'account'<>'null'::jsonb
      OR NEW.record->'credential_repair'->'begin_consumed'<>'false'::jsonb OR NEW.record->'credential_repair'->'reservation_closed'<>'false'::jsonb
      OR NEW.record->'credential_repair'->'review'<>'null'::jsonb OR NEW.record->'credential_repair'->'receipt'<>'null'::jsonb OR NEW.record->'credential_repair' ? 'closure' THEN RAISE EXCEPTION 'invalid credential repair admission'; END IF;
    ELSE
      IF NOT OLD.record ? 'credential_repair' OR NEW.org_id<>OLD.org_id OR NEW.owner_user_id<>OLD.owner_user_id OR NEW.session_id<>OLD.session_id
      OR NEW.created_at<>OLD.created_at OR NEW.revision<>OLD.revision+1 OR NEW.record->'created_at' IS DISTINCT FROM OLD.record->'created_at'
      OR NEW.record->'scope' IS DISTINCT FROM OLD.record->'scope' OR NEW.record->'profile' IS DISTINCT FROM OLD.record->'profile' OR NEW.record->'action_consents' IS DISTINCT FROM OLD.record->'action_consents'
      OR ((NEW.record->'credential_repair')-ARRAY['review','receipt','begin_consumed','closure','reservation_closed']) IS DISTINCT FROM ((OLD.record->'credential_repair')-ARRAY['review','receipt','begin_consumed','closure','reservation_closed'])
      OR OLD.record->'credential_repair'->'review'<>'null'::jsonb AND NEW.record->'credential_repair'->'review' IS DISTINCT FROM OLD.record->'credential_repair'->'review'
      OR OLD.record->'credential_repair'->'receipt'<>'null'::jsonb AND NEW.record->'credential_repair'->'receipt' IS DISTINCT FROM OLD.record->'credential_repair'->'receipt'
      OR OLD.record->'credential_repair' ? 'closure' AND NEW.record->'credential_repair'->'closure' IS DISTINCT FROM OLD.record->'credential_repair'->'closure'
      OR OLD.record->'credential_repair'->'begin_consumed'='true'::jsonb AND NEW.record->'credential_repair'->'begin_consumed'<>'true'::jsonb
      OR OLD.record->'credential_repair'->'reservation_closed'='true'::jsonb AND NEW.record->'credential_repair'->'reservation_closed'<>'true'::jsonb
      OR NEW.record->'callback_expires_at' IS DISTINCT FROM OLD.record->'callback_expires_at' OR OLD.record->'callback_consumed'='true'::jsonb AND NEW.record->'callback_consumed'<>'true'::jsonb
      OR OLD.record->'credential_repair'->'begin_consumed'='false'::jsonb AND NEW.record->'credential_repair'->'begin_consumed'='true'::jsonb AND (OLD.record->>'state'<>'repair_reviewed' OR NEW.record->>'state'<>'repair_starting')
      OR NEW.record->'callback_state_hash' IS DISTINCT FROM OLD.record->'callback_state_hash' AND NOT (OLD.record->>'state'='repair_reviewed' AND NEW.record->>'state'='repair_starting' AND OLD.record->'credential_repair'->'begin_consumed'='false'::jsonb AND NEW.record->'credential_repair'->'begin_consumed'='true'::jsonb)
      OR OLD.record->'runtime_session_ref'<>'null'::jsonb AND NEW.record->'runtime_session_ref' IS DISTINCT FROM OLD.record->'runtime_session_ref'
      OR OLD.record->'runtime_session_ref'='null'::jsonb AND NEW.record->'runtime_session_ref'<>'null'::jsonb AND (NEW.record->>'state'<>'awaiting_callback' OR NEW.record->'credential_repair'->'begin_consumed'<>'true'::jsonb)
      OR NEW.record->'credential_repair'->'closure'->>'reason'='exchange_abandoned' AND NOT OLD.record->'credential_repair' ? 'closure' AND (OLD.record->'credential_repair'->>'review_expires_at')::timestamptz>clock_timestamp()
      OR NEW.record->'credential_repair'->'closure'->>'reason'='callback_expired' AND NOT OLD.record->'credential_repair' ? 'closure' AND (OLD.record->>'callback_expires_at')::timestamptz>clock_timestamp()
      THEN RAISE EXCEPTION 'credential repair immutable authority or CAS mismatch'; END IF;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.web_sessions WHERE id=NEW.web_session_id AND org_id=NEW.org_id AND user_id=NEW.owner_user_id) THEN RAISE EXCEPTION 'credential repair web identity mismatch'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.app_connection_sessions source WHERE source.org_id=NEW.org_id AND source.owner_user_id=NEW.owner_user_id
     AND source.session_id=NEW.record->'credential_repair'->'source'->>'session_id' AND source.revision=(NEW.record->'credential_repair'->'source'->>'session_revision')::integer
     AND source.record->>'state'='connected' AND source.record->'scope'=NEW.record->'scope' AND source.record->'profile'=NEW.record->'profile'
     AND source.record->'action_consents'=NEW.record->'action_consents' AND source.record->'runtime_session_ref'=NEW.record->'credential_repair'->'source'->'runtime_session_ref'
     AND source.record->'account'->'account_ref'=NEW.record->'credential_repair'->'source'->'account_ref') THEN RAISE EXCEPTION 'credential repair source identity mismatch'; END IF;
    RETURN NEW;
  END IF;
  IF EXISTS(SELECT 1 FROM public.app_connection_sessions repair WHERE repair.org_id=NEW.org_id AND repair.session_id<>NEW.session_id
    AND repair.record->'credential_repair'->'source'->'scope'->'resource_binding_id'=NEW.record->'scope'->'resource_binding_id'
    AND (repair.record->'credential_repair'->'reservation_closed'='false'::jsonb OR repair.record->'credential_repair'->'receipt'<>'null'::jsonb AND repair.record->'credential_repair'->'source'->>'session_id'=NEW.session_id))
  THEN RAISE EXCEPTION 'credential repair reserves source'; END IF;
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
        OLD.record->>'state'<>'upgrade_checking' OR NEW.record->'callback_consumed' IS DISTINCT FROM OLD.record->'callback_consumed'
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
