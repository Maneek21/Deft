-- Append to the retained preview96 lineage. Existing OAuth sessions and all
-- native Email rows are unchanged. A new reviewed session can nominate stable
-- runtime custody; its historical session never becomes current authority.
CREATE OR REPLACE FUNCTION deft_app_connection_reattachment_valid(r jsonb, current_scope jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s jsonb; source_scope jsonb; v jsonb; receipt jsonb; n numeric;
BEGIN
  IF r IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(r) IS DISTINCT FROM 'object'
    OR r-ARRAY['schema_version','source','transport_digest','review_expires_at','review','receipt'] <> '{}'::jsonb
    OR NOT r ?& ARRAY['schema_version','source','transport_digest','review_expires_at','review','receipt']
    OR r->>'schema_version' IS DISTINCT FROM 'deft.app_connection_reattachment.v1'
    OR NOT COALESCE(r->>'transport_digest' ~ '^sha256:[a-f0-9]{64}$',false)
    OR NOT COALESCE(r->>'review_expires_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T',false)
    OR NOT isfinite((r->>'review_expires_at')::timestamptz)
    OR NOT COALESCE(isfinite((current_scope->>'consent_expires_at')::timestamptz)
      AND (r->>'review_expires_at')::timestamptz <= (current_scope->>'consent_expires_at')::timestamptz,false) THEN RETURN false; END IF;
  s := r->'source'; v := r->'review'; receipt := r->'receipt';
  IF jsonb_typeof(s) IS DISTINCT FROM 'object'
    OR s-ARRAY['session_id','session_revision','scope','runtime_session_ref','account_ref'] <> '{}'::jsonb
    OR NOT s ?& ARRAY['session_id','session_revision','scope','runtime_session_ref','account_ref']
    OR NOT COALESCE(s->>'session_id' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',false)
    OR jsonb_typeof(s->'session_revision') IS DISTINCT FROM 'number'
    OR jsonb_typeof(s->'scope') IS DISTINCT FROM 'object'
    OR NOT COALESCE(s->>'runtime_session_ref' ~ '^[A-Za-z0-9_-]+$' AND char_length(s->>'runtime_session_ref') BETWEEN 1 AND 512,false)
    OR NOT COALESCE(s->>'account_ref' ~ '^[A-Za-z0-9_-]+$' AND char_length(s->>'account_ref') BETWEEN 1 AND 512,false) THEN RETURN false; END IF;
  n := (s->>'session_revision')::numeric;
  IF n <> trunc(n) OR n NOT BETWEEN 1 AND 2147483646 THEN RETURN false; END IF;
  source_scope := s->'scope';
  IF source_scope-ARRAY['org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','package_digest','grant_snapshot_digest','lifecycle_epoch','grant_epoch','target_key','resource_key','resource_binding_id','runtime_registration_id','operator_user_id','runtime_epoch','profile_digest','consent_expires_at'] <> '{}'::jsonb
    OR NOT source_scope ?& ARRAY['org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','package_digest','grant_snapshot_digest','lifecycle_epoch','grant_epoch','target_key','resource_key','resource_binding_id','runtime_registration_id','operator_user_id','runtime_epoch','profile_digest','consent_expires_at']
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','resource_binding_id','runtime_registration_id','operator_user_id']) k
      WHERE jsonb_typeof(source_scope->k) IS DISTINCT FROM 'string'
        OR NOT COALESCE(source_scope->>k ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',false))
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['package_digest','grant_snapshot_digest','profile_digest']) k
      WHERE jsonb_typeof(source_scope->k) IS DISTINCT FROM 'string'
        OR NOT COALESCE(source_scope->>k ~ '^sha256:[a-f0-9]{64}$',false))
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['target_key','resource_key']) k
      WHERE jsonb_typeof(source_scope->k) IS DISTINCT FROM 'string'
        OR NOT COALESCE(source_scope->>k ~ '^[a-z][a-z0-9_]{0,47}$',false)
        OR source_scope->>k IN ('constructor','prototype','__proto__'))
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['lifecycle_epoch','grant_epoch','runtime_epoch']) k
      WHERE jsonb_typeof(source_scope->k) IS DISTINCT FROM 'number'
        OR (source_scope->>k)::numeric NOT BETWEEN 0 AND 2147483647
        OR (source_scope->>k)::numeric <> trunc((source_scope->>k)::numeric))
    OR jsonb_typeof(source_scope->'consent_expires_at') IS DISTINCT FROM 'string'
    OR NOT COALESCE(source_scope->>'consent_expires_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T',false)
    OR NOT isfinite((source_scope->>'consent_expires_at')::timestamptz) THEN RETURN false; END IF;
  -- Reattachment preserves the owner, installation and exact reviewed custody
  -- domain. The new package/grant and connection consent remain independent.
  IF NOT (s->'scope' ?& ARRAY['org_id','owner_user_id','installation_id','target_key','resource_key','operator_user_id','profile_digest'])
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['org_id','owner_user_id','installation_id','target_key','resource_key','operator_user_id','profile_digest']) k
      WHERE s->'scope'->k IS DISTINCT FROM current_scope->k) THEN RETURN false; END IF;
  IF v <> 'null'::jsonb THEN
    IF jsonb_typeof(v) IS DISTINCT FROM 'object'
      OR v-ARRAY['digest','custody_generation','custody_digest','account'] <> '{}'::jsonb
      OR NOT v ?& ARRAY['digest','custody_generation','custody_digest','account']
      OR NOT COALESCE(v->>'digest' ~ '^sha256:[a-f0-9]{64}$',false)
      OR NOT COALESCE(v->>'custody_digest' ~ '^sha256:[a-f0-9]{64}$',false)
      OR jsonb_typeof(v->'custody_generation') IS DISTINCT FROM 'number'
      OR jsonb_typeof(v->'account') IS DISTINCT FROM 'object'
      OR (v->'account')-ARRAY['account_ref','label'] <> '{}'::jsonb
      OR NOT v->'account' ?& ARRAY['account_ref','label']
      OR v->'account'->'account_ref' IS DISTINCT FROM s->'account_ref'
      OR jsonb_typeof(v->'account'->'label') IS DISTINCT FROM 'string'
      OR char_length(v->'account'->>'label') NOT BETWEEN 1 AND 200
      OR v->'account'->>'label' ~ '[[:cntrl:]<>]' THEN RETURN false; END IF;
    n := (v->>'custody_generation')::numeric;
    IF n <> trunc(n) OR n NOT BETWEEN 1 AND 2147483646 THEN RETURN false; END IF;
  END IF;
  IF receipt <> 'null'::jsonb THEN
    IF v = 'null'::jsonb OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
      OR receipt-ARRAY['custody_generation','receipt_digest'] <> '{}'::jsonb
      OR NOT receipt ?& ARRAY['custody_generation','receipt_digest']
      OR jsonb_typeof(receipt->'custody_generation') IS DISTINCT FROM 'number'
      OR NOT COALESCE(receipt->>'receipt_digest' ~ '^sha256:[a-f0-9]{64}$',false) THEN RETURN false; END IF;
    n := (receipt->>'custody_generation')::numeric;
    IF n <> trunc(n) OR n NOT BETWEEN 1 AND 2147483646 OR n <> (v->>'custody_generation')::numeric+1 THEN RETURN false; END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN RETURN false;
END; $$;

ALTER TABLE app_connection_sessions DROP CONSTRAINT app_connection_sessions_record_identity;
ALTER TABLE app_connection_sessions ADD CONSTRAINT app_connection_sessions_record_identity CHECK ((
  jsonb_typeof(record)='object'
  AND record ?& ARRAY['session_id','revision','scope','profile','state','callback_state_hash','callback_consumed','callback_expires_at','runtime_session_ref','account','created_at','updated_at']
  AND record-ARRAY['session_id','revision','scope','profile','state','callback_state_hash','callback_consumed','callback_expires_at','runtime_session_ref','account','created_at','updated_at','action_consent','reattachment']='{}'::jsonb
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
    OR (record ? 'reattachment' AND record->>'state' IN ('reattach_reviewed','reattaching','reattach_checking')))
  AND deft_app_connection_reattachment_valid(record->'reattachment',record->'scope')
  AND (NOT record ? 'reattachment' OR record->>'state' NOT IN ('awaiting_callback','connecting'))
) IS TRUE);

CREATE OR REPLACE FUNCTION deft_app_connection_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
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
      OR NEW.record->'callback_state_hash' IS DISTINCT FROM OLD.record->'callback_state_hash'
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
