-- Additive117: explicit abandoned UNKNOWN exchange; frozen116 and all legacy guards untouched.

-- Strict additive credential repair on verified head115. Existing115 helper definitions remain unchanged.
CREATE OR REPLACE FUNCTION public.deft_app_connection_credential_repair_valid(u jsonb,s jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v jsonb; f jsonb; h jsonb; c jsonb; n numeric; legacy jsonb; k text;
BEGIN
 IF jsonb_typeof(u) IS DISTINCT FROM 'object' OR u->>'schema_version' IS DISTINCT FROM 'deft.app_connection_credential_repair.v1'
 OR NOT u ?& ARRAY['schema_version','source','transport_digest','review_expires_at','historical_attempts','publication_continuity_digest','begin_consumed','reservation_closed','review','receipt']
 OR u-ARRAY['schema_version','source','transport_digest','review_expires_at','historical_attempts','publication_continuity_digest','begin_consumed','reservation_closed','review','receipt','closure']<>'{}'::jsonb
 OR u->'source'->'scope' IS DISTINCT FROM s OR u->'publication_continuity_digest' IS DISTINCT FROM 'null'::jsonb
 OR jsonb_typeof(u->'begin_consumed') IS DISTINCT FROM 'boolean' OR jsonb_typeof(u->'reservation_closed') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(u->'historical_attempts') IS DISTINCT FROM 'array' OR jsonb_array_length(u->'historical_attempts')>64 THEN RETURN false; END IF;
 FOR h IN SELECT value FROM jsonb_array_elements(u->'historical_attempts') LOOP
  IF jsonb_typeof(h) IS DISTINCT FROM 'object' OR NOT h ?& ARRAY['run_id','attempt_id','attempt_digest'] OR h-ARRAY['run_id','attempt_id','attempt_digest']<>'{}'::jsonb
  OR NOT COALESCE(h->>'run_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
  OR NOT COALESCE(h->>'attempt_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
  OR NOT COALESCE(h->>'attempt_digest' ~ '^sha256:[a-f0-9]{64}$',false) THEN RETURN false; END IF;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_array_elements(u->'historical_attempts'))<>(SELECT count(DISTINCT entry->>'attempt_id') FROM jsonb_array_elements(u->'historical_attempts') entry) THEN RETURN false; END IF;
 v:=u->'review';
 legacy:=(u-ARRAY['begin_consumed','reservation_closed','historical_attempts','publication_continuity_digest','closure'])||jsonb_build_object('schema_version','deft.app_connection_reattachment.v1');
 IF v<>'null'::jsonb THEN
  IF jsonb_typeof(v) IS DISTINCT FROM 'object' OR NOT v ?& ARRAY['account','custody_generation','custody_digest','digest','fence'] OR v-ARRAY['account','custody_generation','custody_digest','digest','fence']<>'{}'::jsonb THEN RETURN false; END IF;
  f:=v->'fence';
  IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR NOT f ?& ARRAY['reservation_id','repair_session_id','source_session_id','source_revision','account_ref','resource_binding_id','old_custody_generation','planned_custody_generation','identity_digest','fence_digest','historical_attempts','publication_continuity_digest']
  OR f-ARRAY['reservation_id','repair_session_id','source_session_id','source_revision','account_ref','resource_binding_id','old_custody_generation','planned_custody_generation','identity_digest','fence_digest','historical_attempts','publication_continuity_digest']<>'{}'::jsonb
  OR f->'source_session_id' IS DISTINCT FROM u->'source'->'session_id' OR f->'source_revision' IS DISTINCT FROM u->'source'->'session_revision'
  OR f->'account_ref' IS DISTINCT FROM u->'source'->'account_ref' OR f->'resource_binding_id' IS DISTINCT FROM s->'resource_binding_id'
  OR f->'old_custody_generation' IS DISTINCT FROM v->'custody_generation' OR f->'historical_attempts' IS DISTINCT FROM u->'historical_attempts' THEN RETURN false; END IF;
  IF jsonb_typeof(f->'planned_custody_generation') IS DISTINCT FROM 'number' OR jsonb_typeof(f->'old_custody_generation') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  FOREACH k IN ARRAY ARRAY['reservation_id','repair_session_id'] LOOP IF NOT COALESCE(f->>k ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) THEN RETURN false; END IF; END LOOP;
  FOREACH k IN ARRAY ARRAY['identity_digest','fence_digest','publication_continuity_digest'] LOOP IF NOT COALESCE(f->>k ~ '^sha256:[a-f0-9]{64}$',false) THEN RETURN false; END IF; END LOOP;
  n:=(f->>'planned_custody_generation')::numeric; IF n<>trunc(n) OR n IS DISTINCT FROM (v->>'custody_generation')::numeric+1 OR n NOT BETWEEN 1 AND 2147483646 THEN RETURN false; END IF;
  legacy:=legacy||jsonb_build_object('review',v-'fence');
 END IF;
 IF NOT COALESCE(public.deft_app_connection_reattachment_valid(legacy,s),false) THEN RETURN false; END IF;
 IF u->'begin_consumed'='true'::jsonb AND v='null'::jsonb OR u->'receipt'<>'null'::jsonb AND u->'begin_consumed'<>'true'::jsonb THEN RETURN false; END IF;
 IF u ? 'closure' THEN
  c:=u->'closure';
  IF c->>'reason'='intent_cancelled' THEN
   IF v<>'null'::jsonb OR u->'receipt'<>'null'::jsonb OR u->'begin_consumed'<>'false'::jsonb
    OR jsonb_typeof(c) IS DISTINCT FROM 'object' OR NOT c ?& ARRAY['reason','custody_generation','receipt_digest','intent_fence']
    OR c-ARRAY['reason','custody_generation','receipt_digest','intent_fence']<>'{}'::jsonb OR jsonb_typeof(c->'custody_generation') IS DISTINCT FROM 'number'
    OR NOT COALESCE(c->>'receipt_digest' ~ '^sha256:[a-f0-9]{64}$',false) THEN RETURN false; END IF;
   f:=c->'intent_fence';
   IF jsonb_typeof(f) IS DISTINCT FROM 'object' OR NOT f ?& ARRAY['reservation_id','repair_session_id','source_session_id','source_revision','account_ref','resource_binding_id','old_custody_generation','planned_custody_generation','identity_digest','fence_digest','historical_attempts','publication_continuity_digest']
    OR f-ARRAY['reservation_id','repair_session_id','source_session_id','source_revision','account_ref','resource_binding_id','old_custody_generation','planned_custody_generation','identity_digest','fence_digest','historical_attempts','publication_continuity_digest']<>'{}'::jsonb
    OR f->'source_session_id' IS DISTINCT FROM u->'source'->'session_id' OR f->'source_revision' IS DISTINCT FROM u->'source'->'session_revision'
    OR f->'account_ref' IS DISTINCT FROM u->'source'->'account_ref' OR f->'resource_binding_id' IS DISTINCT FROM s->'resource_binding_id'
    OR f->'historical_attempts' IS DISTINCT FROM u->'historical_attempts' OR f->'old_custody_generation' IS DISTINCT FROM c->'custody_generation'
    OR jsonb_typeof(f->'planned_custody_generation') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
   FOREACH k IN ARRAY ARRAY['reservation_id','repair_session_id'] LOOP IF NOT COALESCE(f->>k ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) THEN RETURN false; END IF; END LOOP;
   FOREACH k IN ARRAY ARRAY['identity_digest','fence_digest','publication_continuity_digest'] LOOP IF NOT COALESCE(f->>k ~ '^sha256:[a-f0-9]{64}$',false) THEN RETURN false; END IF; END LOOP;
   n:=(c->>'custody_generation')::numeric; IF n<>trunc(n) OR n NOT BETWEEN 1 AND 2147483645 OR (f->>'planned_custody_generation')::numeric IS DISTINCT FROM n+1 THEN RETURN false; END IF;
  ELSE
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR NOT c ?& ARRAY['reason','custody_generation','receipt_digest'] OR c-ARRAY['reason','custody_generation','receipt_digest']<>'{}'::jsonb
  OR jsonb_typeof(c->'reason') IS DISTINCT FROM 'string' OR jsonb_typeof(c->'custody_generation') IS DISTINCT FROM 'number'
  OR c->>'reason' NOT IN ('prepared_cancelled','callback_expired','provider_denied','exchange_abandoned') OR NOT COALESCE(c->>'receipt_digest' ~ '^sha256:[a-f0-9]{64}$',false)
  OR v='null'::jsonb OR u->'receipt'<>'null'::jsonb THEN RETURN false; END IF;
  n:=(c->>'custody_generation')::numeric; IF n<>trunc(n) OR n NOT BETWEEN 1 AND 2147483646
  OR n IS DISTINCT FROM ((v->>'custody_generation')::numeric+(CASE WHEN c->>'reason'='prepared_cancelled' THEN 0 ELSE 1 END))
  OR (c->>'reason'='prepared_cancelled') IS DISTINCT FROM (u->'begin_consumed'='false'::jsonb) THEN RETURN false; END IF;
  END IF;
 END IF;
 IF u->'reservation_closed'='true'::jsonb AND u->'receipt'='null'::jsonb AND NOT u ? 'closure' THEN RETURN false; END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false; END; $$;

CREATE OR REPLACE FUNCTION public.deft_app_connection_credential_repair_record_valid(r jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE u jsonb:=r->'credential_repair'; s text:=r->>'state'; p jsonb:=r->'profile'; n numeric; k text;
BEGIN
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR NOT r ?& ARRAY['session_id','revision','scope','profile','state','callback_state_hash','callback_consumed','callback_expires_at','runtime_session_ref','account','created_at','updated_at','action_consents','credential_repair']
 OR r-ARRAY['session_id','revision','scope','profile','state','callback_state_hash','callback_consumed','callback_expires_at','runtime_session_ref','account','created_at','updated_at','action_consents','credential_repair']<>'{}'::jsonb
 OR jsonb_typeof(r->'scope') IS DISTINCT FROM 'object' OR jsonb_typeof(r->'profile') IS DISTINCT FROM 'object'
 OR jsonb_typeof(r->'session_id') IS DISTINCT FROM 'string' OR NOT COALESCE(r->>'session_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
 OR jsonb_typeof(r->'revision') IS DISTINCT FROM 'number' OR jsonb_typeof(r->'state') IS DISTINCT FROM 'string'
 OR NOT COALESCE(public.deft_app_connection_form_scope_valid(r->'scope'),false)
 OR NOT COALESCE(public.deft_app_connection_credential_repair_valid(u,r->'scope'),false)
 OR NOT COALESCE(public.deft_app_connection_actions_v2_valid(r->'action_consents',r->'scope'),false)
 OR NOT COALESCE(r->>'callback_state_hash' ~ '^[a-f0-9]{64}$',false) OR jsonb_typeof(r->'callback_consumed') IS DISTINCT FROM 'boolean'
 OR NOT isfinite((r->>'callback_expires_at')::timestamptz) OR (r->>'callback_expires_at')::timestamptz>(r->'scope'->>'consent_expires_at')::timestamptz
 OR NOT isfinite((r->>'created_at')::timestamptz) OR NOT isfinite((r->>'updated_at')::timestamptz) OR (r->>'updated_at')::timestamptz<(r->>'created_at')::timestamptz
 OR u->'source'->>'session_id'=r->>'session_id' OR u->'review'->'fence'->>'repair_session_id' IS DISTINCT FROM (CASE WHEN u->'review'='null'::jsonb THEN NULL ELSE r->>'session_id' END) THEN RETURN false; END IF;
 n:=(r->>'revision')::numeric; IF n<>trunc(n) OR n NOT BETWEEN 0 AND 2147483647 THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['created_at','updated_at','callback_expires_at'] LOOP IF jsonb_typeof(r->k) IS DISTINCT FROM 'string' THEN RETURN false; END IF; END LOOP;
 IF NOT p ?& ARRAY['schema_version','key','provider_id','operator_user_id','runtime_requirement_key','resource_key','action_keys','authorization_origin','credential_custody','executable']
 OR p-ARRAY['schema_version','key','provider_id','operator_user_id','runtime_requirement_key','resource_key','action_keys','authorization_origin','credential_custody','executable']<>'{}'::jsonb
 OR p->>'schema_version' IS DISTINCT FROM 'deft.app_connection_profile.v1' OR p->>'credential_custody' IS DISTINCT FROM 'runtime' OR p->'executable' IS DISTINCT FROM 'false'::jsonb
 OR p->'operator_user_id' IS DISTINCT FROM r->'scope'->'operator_user_id' OR p->'resource_key' IS DISTINCT FROM r->'scope'->'resource_key'
 OR jsonb_typeof(p->'authorization_origin') IS DISTINCT FROM 'string' OR NOT COALESCE(p->>'authorization_origin' ~ '^https://[^/?#@]+$',false) OR length(p->>'authorization_origin')>512
 OR jsonb_typeof(p->'action_keys') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'action_keys')>16 THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['key','provider_id','runtime_requirement_key','resource_key'] LOOP IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR NOT COALESCE(p->>k ~ '^[a-z][a-z0-9_]{0,47}$',false) OR p->>k IN ('constructor','prototype','__proto__') THEN RETURN false; END IF; END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'action_keys') a WHERE jsonb_typeof(a) IS DISTINCT FROM 'string' OR NOT COALESCE(a#>>'{}' ~ '^[a-z][a-z0-9_]{0,47}$',false) OR a#>>'{}' IN ('constructor','prototype','__proto__')) THEN RETURN false; END IF;
 IF u ? 'closure' THEN
  IF u->'closure'->>'reason'='intent_cancelled' THEN RETURN COALESCE(r->'account'='null'::jsonb AND r->'runtime_session_ref'='null'::jsonb
   AND r->'callback_consumed'='false'::jsonb AND s IN ('not_connected','repair_checking','indeterminate')
   AND u->'closure'->'intent_fence'->>'repair_session_id'=r->>'session_id',false); END IF;
  RETURN COALESCE(r->'account'='null'::jsonb AND s IN ('not_connected','repair_checking','indeterminate') AND
   CASE u->'closure'->>'reason' WHEN 'prepared_cancelled' THEN r->'callback_consumed'='false'::jsonb
    WHEN 'callback_expired' THEN r->'callback_consumed'='false'::jsonb AND (r->>'callback_expires_at')::timestamptz<=(r->>'updated_at')::timestamptz
    WHEN 'exchange_abandoned' THEN r->'callback_consumed'='true'::jsonb AND r->'runtime_session_ref'<>'null'::jsonb AND (u->>'review_expires_at')::timestamptz<=(r->>'updated_at')::timestamptz
    WHEN 'provider_denied' THEN r->'callback_consumed'='true'::jsonb ELSE false END,false);
 END IF;
 IF u->'receipt'<>'null'::jsonb THEN RETURN COALESCE(r->'callback_consumed'='true'::jsonb AND (r->'account'='null'::jsonb OR r->'account'=u->'review'->'account')
  AND (s<>'connected' OR r->'account'=u->'review'->'account')
  AND r->'runtime_session_ref'<>'null'::jsonb AND s IN ('connected','repair_checking','checking','disconnecting','disconnected','indeterminate'),false); END IF;
 IF r->'account'<>'null'::jsonb THEN RETURN false; END IF;
 IF s='repair_reviewed' THEN RETURN COALESCE(u->'review'<>'null'::jsonb AND u->'begin_consumed'='false'::jsonb AND r->'callback_consumed'='false'::jsonb,false); END IF;
 IF s='repair_starting' THEN RETURN COALESCE(u->'begin_consumed'='true'::jsonb AND r->'callback_consumed'='false'::jsonb,false); END IF;
 IF s='awaiting_callback' THEN RETURN COALESCE(u->'begin_consumed'='true'::jsonb AND r->'runtime_session_ref'<>'null'::jsonb AND r->'callback_consumed'='false'::jsonb,false); END IF;
 IF s='connecting' THEN RETURN COALESCE(u->'begin_consumed'='true'::jsonb AND r->'callback_consumed'='true'::jsonb,false); END IF;
 RETURN COALESCE(s IN ('starting','repair_checking','indeterminate','not_connected'),false);
EXCEPTION WHEN OTHERS THEN RETURN false; END; $$;


-- Existing116 guard, only explicit abandonment real-clock admission added.
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
