-- Explicit persistent consent is opt-in; SQL NULL alone never conveys authority.
-- Infinity is an internal comparison value only, never a stored consent/session deadline.
CREATE OR REPLACE FUNCTION deft_app_consent_valid(s jsonb, expiry_key text DEFAULT 'consent_expires_at') RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR NOT s ? expiry_key THEN RETURN false; END IF;
 IF s ? 'consent_lifetime' THEN
  RETURN s->'consent_lifetime'='"until_revoked"'::jsonb AND s->expiry_key='null'::jsonb;
 END IF;
 RETURN COALESCE(jsonb_typeof(s->expiry_key)='string' AND isfinite((s->>expiry_key)::timestamptz),false);
EXCEPTION WHEN OTHERS THEN RETURN false; END; $$;
CREATE OR REPLACE FUNCTION deft_app_consent_deadline(s jsonb, expiry_key text DEFAULT 'consent_expires_at') RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF NOT deft_app_consent_valid(s,expiry_key) THEN RAISE EXCEPTION 'APP_CONSENT_LIFETIME_INVALID' USING ERRCODE='23514'; END IF;
 IF s ? 'consent_lifetime' THEN RETURN 'infinity'::timestamptz; END IF;
 RETURN (s->>expiry_key)::timestamptz;
END; $$;
CREATE OR REPLACE FUNCTION deft_app_consent_snapshot_valid(s jsonb, expiry timestamptz, created timestamptz) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF NOT deft_app_consent_valid(s,'expires_at') OR NOT deft_app_consent_valid(s->'scope') OR NOT isfinite(created) THEN RETURN false; END IF;
 IF s ? 'consent_lifetime' THEN
  RETURN COALESCE(expiry IS NULL AND s->'scope'->'consent_lifetime'='"until_revoked"'::jsonb
   AND jsonb_typeof(s->'review_expires_at')='string' AND isfinite((s->>'review_expires_at')::timestamptz)
   AND (s->>'review_expires_at')::timestamptz>created AND (s->>'review_expires_at')::timestamptz<=created+interval '5 minutes',false);
 END IF;
 RETURN NOT s ? 'review_expires_at' AND expiry IS NOT NULL AND isfinite(expiry)
  AND expiry=(s->>'expires_at')::timestamptz AND expiry<=deft_app_consent_deadline(s->'scope');
EXCEPTION WHEN OTHERS THEN RETURN false; END; $$;
ALTER TABLE app_resource_bindings ADD COLUMN IF NOT EXISTS consent_lifetime text;
ALTER TABLE app_runtime_sessions ADD COLUMN IF NOT EXISTS renewal_lifetime text;
ALTER TABLE app_data_consents ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE app_resource_observation_consents ALTER COLUMN expires_at DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.deft_app_connection_form_scope_valid(s jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE k text; n numeric;
BEGIN
 IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR NOT s ?& ARRAY['org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','package_digest','grant_snapshot_digest','lifecycle_epoch','grant_epoch','target_key','resource_key','resource_binding_id','runtime_registration_id','operator_user_id','runtime_epoch','profile_digest','consent_expires_at']
 OR s-ARRAY['consent_lifetime','org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','package_digest','grant_snapshot_digest','lifecycle_epoch','grant_epoch','target_key','resource_key','resource_binding_id','runtime_registration_id','operator_user_id','runtime_epoch','profile_digest','consent_expires_at']<>'{}'::jsonb THEN RETURN false; END IF;
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
 RETURN deft_app_consent_valid(s);
EXCEPTION WHEN OTHERS THEN RETURN false;
END; $function$;

CREATE OR REPLACE FUNCTION public.deft_resource_observation_scope_valid(s jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
BEGIN
 RETURN COALESCE(jsonb_typeof(s)='object'
  AND s ?& ARRAY['org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','package_digest','grant_snapshot_digest','lifecycle_epoch','grant_epoch','target_key','resource_key','resource_binding_id','runtime_registration_id','operator_user_id','runtime_epoch','profile_digest','consent_expires_at']
  AND s-ARRAY['consent_lifetime','org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','package_digest','grant_snapshot_digest','lifecycle_epoch','grant_epoch','target_key','resource_key','resource_binding_id','runtime_registration_id','operator_user_id','runtime_epoch','profile_digest','consent_expires_at']='{}'::jsonb
  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','resource_binding_id','runtime_registration_id','operator_user_id']) k
   WHERE jsonb_typeof(s->k) IS DISTINCT FROM 'string' OR NOT COALESCE(s->>k ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$',false))
  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['package_digest','grant_snapshot_digest','profile_digest']) k
   WHERE jsonb_typeof(s->k) IS DISTINCT FROM 'string' OR NOT COALESCE(s->>k ~ '^sha256:[a-f0-9]{64}$',false))
  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['target_key','resource_key']) k
   WHERE jsonb_typeof(s->k) IS DISTINCT FROM 'string' OR NOT COALESCE(s->>k ~ '^[a-z][a-z0-9_]{0,47}$',false) OR s->>k IN ('constructor','prototype','__proto__'))
  AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['lifecycle_epoch','grant_epoch','runtime_epoch']) k
   WHERE jsonb_typeof(s->k) IS DISTINCT FROM 'number' OR (s->>k)::numeric NOT BETWEEN 0 AND 2147483647 OR (s->>k)::numeric<>trunc((s->>k)::numeric))
  AND deft_app_consent_valid(s),false);
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN RETURN false;
END;$function$;

CREATE OR REPLACE FUNCTION public.deft_app_connection_actions_v2_valid(actions jsonb, scope jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE c jsonb; previous_key text := ''; ids text[] := '{}'; n numeric;
BEGIN
  IF jsonb_typeof(actions) IS DISTINCT FROM 'array' OR jsonb_array_length(actions)>8 THEN RETURN false; END IF;
  FOR c IN SELECT value FROM jsonb_array_elements(actions) LOOP
    IF jsonb_typeof(c) IS DISTINCT FROM 'object'
      OR c-ARRAY['consent_lifetime','action_binding_id','action_key','authority_epoch','consent_id','consent_digest','expires_at']<>'{}'::jsonb
      OR NOT c ?& ARRAY['action_binding_id','action_key','authority_epoch','consent_id','consent_digest','expires_at']
      OR NOT COALESCE(c->>'action_binding_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
      OR c->>'consent_id' IS DISTINCT FROM c->>'action_binding_id'
      OR NOT COALESCE(c->>'action_key' ~ '^[a-z][a-z0-9_]{0,47}$',false)
      OR c->>'action_key' IN ('constructor','prototype','__proto__')
      OR (c->>'action_key') COLLATE "C" <= previous_key COLLATE "C"
      OR c->>'action_binding_id'=ANY(ids)
      OR jsonb_typeof(c->'authority_epoch') IS DISTINCT FROM 'number'
      OR NOT COALESCE(c->>'consent_digest' ~ '^sha256:[a-f0-9]{64}$',false)
      OR NOT deft_app_consent_valid(c,'expires_at')
      OR NOT COALESCE(deft_app_consent_deadline(c,'expires_at') <= deft_app_consent_deadline(scope),false) THEN RETURN false; END IF;
    n:=(c->>'authority_epoch')::numeric; IF n<>trunc(n) OR n NOT BETWEEN 0 AND 2147483647 THEN RETURN false; END IF;
    previous_key:=c->>'action_key'; ids:=array_append(ids,c->>'action_binding_id');
  END LOOP; RETURN true;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow THEN RETURN false;
END; $function$;

CREATE OR REPLACE FUNCTION public.deft_app_connection_reattachment_valid(r jsonb, current_scope jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
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
    OR NOT COALESCE(deft_app_consent_valid(current_scope)
      AND (r->>'review_expires_at')::timestamptz <= deft_app_consent_deadline(current_scope),false) THEN RETURN false; END IF;
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
  IF source_scope-ARRAY['consent_lifetime','org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','package_digest','grant_snapshot_digest','lifecycle_epoch','grant_epoch','target_key','resource_key','resource_binding_id','runtime_registration_id','operator_user_id','runtime_epoch','profile_digest','consent_expires_at'] <> '{}'::jsonb
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
    OR NOT deft_app_consent_valid(source_scope)
    OR (NOT source_scope ? 'consent_lifetime' AND NOT COALESCE(source_scope->>'consent_expires_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T',false)) THEN RETURN false; END IF;
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
END; $function$;

CREATE OR REPLACE FUNCTION public.deft_app_connection_form_record_valid(r jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE s jsonb; receipt jsonb; account jsonb; source jsonb; k text; n numeric;
BEGIN
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR octet_length(r::text)>16384
 OR NOT r ?& ARRAY['schema_version','session_id','revision','scope','action_consents','source','transport_digest','authorization_origin','state','runtime_session_ref','begin_consumed','input_consumed','input_expires_at','account','receipt','created_at','updated_at']
 OR r-ARRAY['schema_version','session_id','revision','scope','action_consents','source','transport_digest','authorization_origin','state','runtime_session_ref','begin_consumed','input_consumed','input_expires_at','account','receipt','created_at','updated_at']<>'{}'::jsonb
 OR r->>'schema_version' IS DISTINCT FROM 'deft.app_connection_form_record.v1' THEN RETURN false; END IF;
 s:=r->'scope'; IF NOT COALESCE(public.deft_app_connection_form_scope_valid(s),false) OR NOT COALESCE(public.deft_app_connection_actions_v2_valid(r->'action_consents',s),false) THEN RETURN false; END IF;
 IF jsonb_typeof(r->'session_id') IS DISTINCT FROM 'string' OR NOT COALESCE(r->>'session_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
 OR jsonb_typeof(r->'revision') IS DISTINCT FROM 'number' OR jsonb_typeof(r->'begin_consumed') IS DISTINCT FROM 'boolean' OR jsonb_typeof(r->'input_consumed') IS DISTINCT FROM 'boolean'
 OR NOT COALESCE(r->>'transport_digest' ~ '^sha256:[a-f0-9]{64}$',false) OR NOT COALESCE(r->>'authorization_origin' ~ '^https://[a-z0-9.-]+$',false)
 OR length(r->>'authorization_origin')>512 OR jsonb_typeof(r->'state') IS DISTINCT FROM 'string' OR r->>'state' NOT IN ('starting','awaiting_input','checking','disconnecting','connected','not_connected','disconnected','indeterminate') THEN RETURN false; END IF;
 n:=(r->>'revision')::numeric; IF n<>trunc(n) OR n NOT BETWEEN 1 AND 2147483646 THEN RETURN false; END IF;
 FOREACH k IN ARRAY ARRAY['created_at','updated_at','input_expires_at'] LOOP
  IF jsonb_typeof(r->k) IS DISTINCT FROM 'string' OR NOT isfinite((r->>k)::timestamptz) THEN RETURN false; END IF;
 END LOOP;
 IF (r->>'input_expires_at')::timestamptz>(r->>'created_at')::timestamptz+interval '5 minutes' OR (r->>'input_expires_at')::timestamptz>deft_app_consent_deadline(s) OR (r->>'updated_at')::timestamptz<(r->>'created_at')::timestamptz THEN RETURN false; END IF;
 IF r->'runtime_session_ref'<>'null'::jsonb AND (jsonb_typeof(r->'runtime_session_ref') IS DISTINCT FROM 'string' OR length(r->>'runtime_session_ref') NOT BETWEEN 1 AND 512 OR NOT COALESCE(r->>'runtime_session_ref' ~ '^[A-Za-z0-9_-]+$',false)) THEN RETURN false; END IF;
 source:=r->'source'; IF source<>'null'::jsonb THEN
  IF jsonb_typeof(source) IS DISTINCT FROM 'object' OR NOT source ?& ARRAY['session_id','session_revision','scope','runtime_session_ref','account_ref'] OR source-ARRAY['session_id','session_revision','scope','runtime_session_ref','account_ref']<>'{}'::jsonb
  OR NOT COALESCE(public.deft_app_connection_form_scope_valid(source->'scope'),false) OR source->>'session_id'=r->>'session_id'
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
END; $function$;

CREATE OR REPLACE FUNCTION public.deft_app_connection_credential_repair_record_valid(r jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
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
 OR NOT isfinite((r->>'callback_expires_at')::timestamptz) OR (r->>'callback_expires_at')::timestamptz>deft_app_consent_deadline(r->'scope')
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
EXCEPTION WHEN OTHERS THEN RETURN false; END; $function$;

CREATE OR REPLACE FUNCTION public.deft_app_consent_continuation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE s app_connection_sessions%ROWTYPE; k text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NOT deft_app_consent_continuation_valid(NEW.record) OR NEW.record->>'session_id'<>NEW.session_id
  OR NEW.record->'scope'->>'org_id'<>NEW.org_id OR NEW.record->'scope'->>'owner_user_id'<>NEW.owner_user_id
  OR NEW.record->'scope'->>'resource_binding_id'<>NEW.resource_binding_id OR NEW.record->'source'->>'session_id'<>NEW.source_session_id
  OR (NEW.record->>'revision')::integer<>NEW.revision OR (NEW.record->>'created_at')::timestamptz<>NEW.created_at
  OR (NEW.record->>'updated_at')::timestamptz<>NEW.updated_at OR NOT isfinite(NEW.access_expires_at)
  OR NEW.authority_operation NOT IN ('prepare','activate','status') OR NOT isfinite(NEW.authority_expires_at)
  OR NEW.authority_expires_at>NEW.access_expires_at OR NEW.authority_expires_at>deft_app_consent_deadline(NEW.record->'scope')
  OR (NEW.authority_operation<>'status' AND NEW.authority_expires_at>(NEW.record->>'review_expires_at')::timestamptz)
  OR NOT EXISTS(SELECT 1 FROM web_sessions w WHERE w.id=NEW.web_session_id AND w.org_id=NEW.org_id AND w.user_id=NEW.owner_user_id) THEN
  RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_INVALID' USING ERRCODE='23514'; END IF;
 SELECT * INTO s FROM app_connection_sessions WHERE org_id=NEW.org_id AND owner_user_id=NEW.owner_user_id AND session_id=NEW.source_session_id FOR SHARE;
 IF s.session_id IS NULL OR s.record->>'state'<>'connected' OR s.revision<>(NEW.record->'source'->>'session_revision')::integer
  OR s.record->'scope' IS DISTINCT FROM NEW.record->'source'->'scope' OR s.record->'profile' IS DISTINCT FROM NEW.record->'profile'
  OR s.record->'action_consents' IS DISTINCT FROM NEW.record->'source'->'action_consents'
  OR s.record->'runtime_session_ref' IS DISTINCT FROM NEW.record->'source'->'runtime_session_ref'
  OR s.record->'account'->'account_ref' IS DISTINCT FROM NEW.record->'source'->'account_ref' THEN
  RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_SOURCE_STALE' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>0 OR NEW.record->>'state'<>'preparing' OR NEW.record->'activation_started'<>'false'::jsonb OR NEW.record->'review'<>'null'::jsonb OR NEW.record->'result'<>'null'::jsonb THEN RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_INITIAL_STATE' USING ERRCODE='23514'; END IF;
 ELSE
  IF (NEW.org_id,NEW.owner_user_id,NEW.session_id,NEW.source_session_id,NEW.resource_binding_id,NEW.created_at) IS DISTINCT FROM
    (OLD.org_id,OLD.owner_user_id,OLD.session_id,OLD.source_session_id,OLD.resource_binding_id,OLD.created_at) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_CAS' USING ERRCODE='23514'; END IF;
  IF (NEW.web_session_id,NEW.access_expires_at,NEW.authority_operation,NEW.authority_expires_at) IS DISTINCT FROM (OLD.web_session_id,OLD.access_expires_at,OLD.authority_operation,OLD.authority_expires_at) AND
    (OLD.record->>'state' IN ('connected','not_connected','committing') OR NEW.access_expires_at<=clock_timestamp()
     OR NOT EXISTS(SELECT 1 FROM web_sessions w WHERE w.id=NEW.web_session_id AND w.org_id=NEW.org_id AND w.user_id=NEW.owner_user_id AND w.revoked_at IS NULL AND w.expires_at>clock_timestamp())) THEN
    RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_WEB_AUTHORITY_INVALID' USING ERRCODE='23514'; END IF;
  FOREACH k IN ARRAY ARRAY['session_id','scope','profile','source','action_consents','transport_digest','review_expires_at','reviewed_at','binding_before','attachment_consent_digest','created_at'] LOOP
   IF NEW.record->k IS DISTINCT FROM OLD.record->k THEN RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_PINS_IMMUTABLE' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF OLD.record->'review'<>'null'::jsonb AND NEW.record->'review' IS DISTINCT FROM OLD.record->'review'
   OR OLD.record->'result'<>'null'::jsonb AND NEW.record->'result' IS DISTINCT FROM OLD.record->'result'
   OR OLD.record->'activation_started'='true'::jsonb AND NEW.record->'activation_started'<>'true'::jsonb
   OR OLD.record->'activation_started'='false'::jsonb AND NEW.record->'activation_started'='true'::jsonb AND NOT(OLD.record->>'state'='reviewed' AND NEW.record->>'state'='activating' AND (OLD.record->>'review_expires_at')::timestamptz>clock_timestamp())
   OR NOT ((OLD.record->>'state'=NEW.record->>'state' AND OLD.record->>'state' IN ('preparing','reviewed','activating','indeterminate'))
     OR (OLD.record->>'state' IN ('preparing','indeterminate') AND NEW.record->>'state' IN ('reviewed','indeterminate','committing','not_connected'))
     OR (OLD.record->>'state'='reviewed' AND NEW.record->>'state' IN ('activating','reviewed','indeterminate','not_connected'))
     OR (OLD.record->>'state'='activating' AND NEW.record->>'state' IN ('committing','indeterminate'))
     OR (OLD.record->>'state'='committing' AND NEW.record->>'state'='connected')) THEN
    RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.deft_app_consent_continuation_valid(r jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE s jsonb:=r->'source'; a jsonb; b jsonb; n integer;
BEGIN
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r-ARRAY['session_id','revision','state','activation_started','scope','profile','source','action_consents','transport_digest','review_expires_at','reviewed_at','binding_before','attachment_consent_digest','review','result','created_at','updated_at']<>'{}'::jsonb
  OR NOT r ?& ARRAY['session_id','revision','state','activation_started','scope','profile','source','action_consents','transport_digest','review_expires_at','reviewed_at','binding_before','attachment_consent_digest','review','result','created_at','updated_at']
  OR NOT COALESCE(r->>'session_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
  OR r->>'session_id'=s->>'session_id' OR jsonb_typeof(r->'revision') IS DISTINCT FROM 'number'
  OR (r->>'revision')::numeric<>trunc((r->>'revision')::numeric) OR (r->>'revision')::numeric NOT BETWEEN 0 AND 2147483647
  OR r->>'state' NOT IN ('preparing','reviewed','activating','indeterminate','committing','connected','not_connected')
  OR jsonb_typeof(r->'activation_started') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(r->'binding_before') IS DISTINCT FROM 'object'
  OR jsonb_typeof(r->'profile') IS DISTINCT FROM 'object'
  OR NOT COALESCE(r->>'attachment_consent_digest' ~ '^sha256:[a-f0-9]{64}$',false)
  OR s-ARRAY['session_id','session_revision','scope','runtime_session_ref','account_ref','action_consents']<>'{}'::jsonb
  OR NOT s ?& ARRAY['session_id','session_revision','scope','runtime_session_ref','account_ref','action_consents']
  OR ((r->'scope')-ARRAY['consent_expires_at','consent_lifetime']) IS DISTINCT FROM ((s->'scope')-ARRAY['consent_expires_at','consent_lifetime'])
  OR NOT COALESCE(deft_app_consent_deadline(r->'scope')>deft_app_consent_deadline(s->'scope'),false)
  OR NOT deft_app_connection_reattachment_valid(jsonb_build_object('schema_version','deft.app_connection_reattachment.v1','source',s-'action_consents','transport_digest',r->'transport_digest','review_expires_at',r->'review_expires_at','review',r->'review','receipt',null),r->'scope')
  OR NOT deft_app_connection_actions_v2_valid(s->'action_consents',s->'scope')
  OR NOT deft_app_connection_actions_v2_valid(r->'action_consents',r->'scope')
  OR jsonb_array_length(r->'action_consents')<>jsonb_array_length(s->'action_consents')
  OR NOT COALESCE((r->>'reviewed_at')::timestamptz=(r->>'created_at')::timestamptz
    AND (r->>'review_expires_at')::timestamptz>(r->>'reviewed_at')::timestamptz
    AND (r->>'review_expires_at')::timestamptz<=(r->>'reviewed_at')::timestamptz+interval '120 seconds'
    AND (r->>'updated_at')::timestamptz>=(r->>'created_at')::timestamptz,false) THEN RETURN false; END IF;
 FOR n IN 0..jsonb_array_length(r->'action_consents')-1 LOOP
  a:=r->'action_consents'->n;b:=s->'action_consents'->n;
  IF (a-ARRAY['consent_digest','expires_at','consent_lifetime']) IS DISTINCT FROM (b-ARRAY['consent_digest','expires_at','consent_lifetime'])
    OR deft_app_consent_deadline(a,'expires_at')<=deft_app_consent_deadline(b,'expires_at')
    OR deft_app_consent_deadline(a,'expires_at')<(r->>'review_expires_at')::timestamptz THEN RETURN false; END IF;
 END LOOP;
 IF r->>'state' IN ('reviewed','activating','committing','connected') AND r->'review'='null'::jsonb THEN RETURN false; END IF;
 IF r->>'state' IN ('activating','committing','connected') AND r->'activation_started'<>'true'::jsonb THEN RETURN false; END IF;
 IF r->>'state'='not_connected' AND r->'activation_started'<>'false'::jsonb THEN RETURN false; END IF;
 IF r->'result'<>'null'::jsonb THEN
  IF jsonb_typeof(r->'result') IS DISTINCT FROM 'object' OR r->'result'->>'state'<>'connected'
   OR (r->'result')-ARRAY['schema_version','session_id','state','account','runtime_session_ref','custody_generation','receipt_digest']<>'{}'::jsonb
   OR NOT (r->'result') ?& ARRAY['schema_version','session_id','state','account','runtime_session_ref','custody_generation','receipt_digest']
   OR r->'result'->>'schema_version'<>'deft.app_connection_consent_continuation_runtime.v1'
   OR r->'result'->'session_id' IS DISTINCT FROM r->'session_id'
   OR r->'result'->'account' IS DISTINCT FROM r->'review'->'account'
   OR r->'result'->'custody_generation' IS DISTINCT FROM r->'review'->'custody_generation'
   OR NOT COALESCE(r->'result'->>'receipt_digest' ~ '^sha256:[a-f0-9]{64}$',false)
   OR NOT COALESCE(r->'result'->>'runtime_session_ref' ~ '^[A-Za-z0-9_-]+$' AND char_length(r->'result'->>'runtime_session_ref') BETWEEN 1 AND 512,false)
   OR r->'result'->'runtime_session_ref'=s->'runtime_session_ref' THEN RETURN false; END IF;
 END IF;
 RETURN r->>'state' NOT IN ('committing','connected') OR r->'result'<>'null'::jsonb;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN RETURN false;
END; $function$;

CREATE OR REPLACE FUNCTION public.app_owner_resource_consent_continuation_allowed(previous app_resource_bindings, amended app_resource_bindings)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE j app_connection_consent_continuations%ROWTYPE;
BEGIN
 IF previous.state<>'active' OR amended.state<>'active' OR previous.consent_expires_at IS NULL
  OR deft_app_consent_deadline(jsonb_strip_nulls(to_jsonb(amended)) || jsonb_build_object('consent_expires_at',amended.consent_expires_at))<=deft_app_consent_deadline(jsonb_strip_nulls(to_jsonb(previous)) || jsonb_build_object('consent_expires_at',previous.consent_expires_at)) OR deft_app_consent_deadline(jsonb_strip_nulls(to_jsonb(amended)) || jsonb_build_object('consent_expires_at',amended.consent_expires_at))<=clock_timestamp()
  OR amended.reviewed_at<=previous.reviewed_at OR amended.reviewed_at>clock_timestamp()
  OR amended.reviewed_by_user_id IS DISTINCT FROM amended.owner_user_id
  OR (to_jsonb(previous)-ARRAY['consent_lifetime','consent_expires_at','reviewed_at','attachment_consent_digest','updated_at']) IS DISTINCT FROM (to_jsonb(amended)-ARRAY['consent_lifetime','consent_expires_at','reviewed_at','attachment_consent_digest','updated_at']) THEN RETURN false; END IF;
 SELECT * INTO j FROM app_connection_consent_continuations WHERE org_id=previous.org_id AND owner_user_id=previous.owner_user_id AND resource_binding_id=previous.id
   AND record->>'state'='committing' AND record->'activation_started'='true'::jsonb AND record->'result'->>'state'='connected' FOR SHARE;
 IF j.session_id IS NULL OR j.record->'binding_before' IS DISTINCT FROM to_jsonb(previous)
  OR (j.record->'scope'->>'consent_expires_at')::timestamptz IS DISTINCT FROM amended.consent_expires_at
  OR j.record->'scope'->>'consent_lifetime' IS DISTINCT FROM amended.consent_lifetime
  OR (j.record->>'reviewed_at')::timestamptz IS DISTINCT FROM amended.reviewed_at
  OR j.record->>'attachment_consent_digest' IS DISTINCT FROM amended.attachment_consent_digest
  OR NOT app_owner_connection_member(previous.org_id,previous.owner_user_id)
  OR NOT EXISTS(SELECT 1 FROM web_sessions w WHERE w.id=j.web_session_id AND w.org_id=j.org_id AND w.user_id=j.owner_user_id AND w.revoked_at IS NULL AND w.expires_at>clock_timestamp() AND j.access_expires_at>clock_timestamp())
  OR EXISTS(SELECT 1 FROM app_run_attempts a JOIN app_runs r ON r.org_id=a.org_id AND r.id=a.run_id LEFT JOIN app_runtime_bindings b ON b.org_id=r.org_id AND b.id=r.origin_runtime_binding_id
    WHERE r.org_id=previous.org_id AND (r.origin_resource_binding_id=previous.id OR b.owner_resource_binding_id=previous.id) AND a.state IN ('claimed','provider_call_started')) THEN RETURN false; END IF;
 RETURN true;
END; $function$;

CREATE OR REPLACE FUNCTION public.deft_app_consent_continuation_pair_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE j app_connection_consent_continuations%ROWTYPE; c app_connection_sessions%ROWTYPE; b app_resource_bindings%ROWTYPE;
BEGIN
 SELECT * INTO j FROM app_connection_consent_continuations WHERE org_id=NEW.org_id AND owner_user_id=NEW.owner_user_id AND session_id=NEW.session_id;
 IF j.session_id IS NULL THEN RETURN NEW; END IF;
 IF j.record->>'state'='committing' THEN RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_SPLIT_STATE' USING ERRCODE='23514'; END IF;
 IF j.record->>'state'<>'connected' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='app_connection_sessions' AND NEW.revision>1 THEN RETURN NEW; END IF;
 SELECT * INTO c FROM app_connection_sessions WHERE org_id=j.org_id AND owner_user_id=j.owner_user_id AND session_id=j.session_id;
 SELECT * INTO b FROM app_resource_bindings WHERE org_id=j.org_id AND id=j.resource_binding_id;
 IF c.session_id IS NULL OR b.id IS NULL OR c.record->'scope' IS DISTINCT FROM j.record->'scope' OR c.record->'profile' IS DISTINCT FROM j.record->'profile'
  OR c.record->'action_consents' IS DISTINCT FROM j.record->'action_consents' OR c.record->'account' IS DISTINCT FROM j.record->'result'->'account'
  OR c.record->'runtime_session_ref' IS DISTINCT FROM j.record->'result'->'runtime_session_ref' OR c.record->'callback_consumed'<>'true'::jsonb
  OR c.record ?| ARRAY['action_consent','reattachment','upgrade'] OR c.web_session_id<>j.web_session_id OR c.access_expires_at<>j.access_expires_at
  OR b.consent_lifetime IS DISTINCT FROM j.record->'scope'->>'consent_lifetime'
  OR b.consent_expires_at IS DISTINCT FROM (j.record->'scope'->>'consent_expires_at')::timestamptz
  OR b.reviewed_at IS DISTINCT FROM (j.record->>'reviewed_at')::timestamptz OR b.attachment_consent_digest IS DISTINCT FROM j.record->>'attachment_consent_digest'
  OR (to_jsonb(b)-ARRAY['consent_lifetime','consent_expires_at','reviewed_at','attachment_consent_digest','updated_at']) IS DISTINCT FROM ((j.record->'binding_before')-ARRAY['consent_lifetime','consent_expires_at','reviewed_at','attachment_consent_digest','updated_at']) THEN
  RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_SPLIT_STATE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.enforce_app_resource_binding()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APP_RESOURCE_BINDING_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'disabled' OR NEW.reviewed_by_user_id IS NOT NULL
      OR NEW.reviewed_at IS NOT NULL OR NEW.consent_expires_at IS NOT NULL OR NEW.consent_lifetime IS NOT NULL THEN
      RAISE EXCEPTION 'APP_RESOURCE_BINDING_REVIEW_REQUIRED' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.max_records_per_page IS DISTINCT FROM OLD.max_records_per_page
      AND NOT app_owner_resource_page_amendment_allowed(OLD, NEW) THEN
      RAISE EXCEPTION 'APP_RESOURCE_BINDING_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF (NEW.id, NEW.org_id, NEW.app_installation_id, NEW.app_version_id, NEW.grant_snapshot_id,
        NEW.grant_snapshot_kind, NEW.runtime_registration_id, NEW.registration_contract_version,
        NEW.provider_kind, NEW.provider_instance_id, NEW.provider_snapshot_id,
        NEW.resource_key, NEW.resource_family, NEW.operation_name, NEW.interface_identity,
        NEW.reviewed_descriptor, NEW.descriptor_digest, NEW.owner_user_id, NEW.owner_scope,
        NEW.risk_class, NEW.review_requirement, NEW.review_scope, NEW.retry_class,
        NEW.retention_class, NEW.max_page_bytes,
        NEW.max_retained_records, NEW.max_retained_bytes, NEW.min_interval_seconds,
        NEW.created_at) IS DISTINCT FROM
       (OLD.id, OLD.org_id, OLD.app_installation_id, OLD.app_version_id, OLD.grant_snapshot_id,
        OLD.grant_snapshot_kind, OLD.runtime_registration_id, OLD.registration_contract_version,
        OLD.provider_kind, OLD.provider_instance_id, OLD.provider_snapshot_id,
        OLD.resource_key, OLD.resource_family, OLD.operation_name, OLD.interface_identity,
        OLD.reviewed_descriptor, OLD.descriptor_digest, OLD.owner_user_id, OLD.owner_scope,
        OLD.risk_class, OLD.review_requirement, OLD.review_scope, OLD.retry_class,
        OLD.retention_class, OLD.max_page_bytes,
        OLD.max_retained_records, OLD.max_retained_bytes, OLD.min_interval_seconds,
        OLD.created_at) THEN
      RAISE EXCEPTION 'APP_RESOURCE_BINDING_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF OLD.state = 'disabled' AND NEW.state = 'active' THEN
      IF OLD.reviewed_by_user_id IS NOT NULL OR OLD.reviewed_at IS NOT NULL
        OR OLD.consent_expires_at IS NOT NULL OR NEW.reviewed_by_user_id <> NEW.owner_user_id
        OR NEW.reviewed_at IS NULL OR NEW.consent_expires_at IS NULL OR NEW.consent_lifetime IS NOT NULL OR OLD.consent_lifetime IS NOT NULL
        OR NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = NEW.org_id
          AND user_id = NEW.owner_user_id AND is_active) THEN
        RAISE EXCEPTION 'APP_RESOURCE_BINDING_REVIEW_INVALID' USING ERRCODE = '55000';
      END IF;
    ELSIF OLD.state = 'active' AND NEW.state = 'revoked' THEN
      IF (NEW.reviewed_by_user_id, NEW.reviewed_at, NEW.consent_expires_at, NEW.consent_lifetime)
        IS DISTINCT FROM (OLD.reviewed_by_user_id, OLD.reviewed_at, OLD.consent_expires_at, OLD.consent_lifetime) THEN
        RAISE EXCEPTION 'APP_RESOURCE_BINDING_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
    ELSIF NEW.state = OLD.state THEN
      IF (NEW.reviewed_by_user_id, NEW.reviewed_at, NEW.consent_expires_at, NEW.consent_lifetime)
        IS DISTINCT FROM (OLD.reviewed_by_user_id, OLD.reviewed_at, OLD.consent_expires_at, OLD.consent_lifetime)
        AND NOT app_owner_resource_consent_continuation_allowed(OLD,NEW) THEN
        RAISE EXCEPTION 'APP_RESOURCE_BINDING_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
    ELSE
      RAISE EXCEPTION 'APP_RESOURCE_BINDING_ILLEGAL_TRANSITION' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.enforce_app_owner_connection_resource()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE r app_runtime_registrations%ROWTYPE; a app_owner_connection_admissions%ROWTYPE;
BEGIN
 SELECT * INTO r FROM app_runtime_registrations WHERE org_id=NEW.org_id AND id=NEW.runtime_registration_id;
 IF r.owner_connection_admission_id IS NULL OR NEW.state='revoked' THEN RETURN NEW; END IF;
 SELECT * INTO a FROM app_owner_connection_admissions WHERE org_id=r.org_id AND id=r.owner_connection_admission_id;
 IF NOT app_owner_connection_admission_current(r.org_id,a.id,r.owner_connection_admission_digest)
   OR NOT app_owner_connection_member(NEW.org_id,NEW.owner_user_id)
   OR NEW.registration_contract_version<>'deft.app_runtime_channel.v3'
   OR NEW.resource_key IS DISTINCT FROM a.snapshot->'policy'->>'resource_key'
   OR NEW.descriptor_digest IS DISTINCT FROM a.snapshot->>'resource_descriptor_digest'
   OR NEW.max_records_per_page>(a.snapshot->'limits'->>'max_records_per_page')::integer
   OR NEW.max_page_bytes>(a.snapshot->'limits'->>'max_page_bytes')::integer
   OR NEW.max_retained_records>(a.snapshot->'limits'->>'max_retained_records')::integer
   OR NEW.max_retained_bytes>(a.snapshot->'limits'->>'max_retained_bytes')::integer
   OR NEW.min_interval_seconds<(a.snapshot->'limits'->>'min_interval_seconds')::integer
   OR (NEW.state='active' AND (r.reviewed_by_user_id IS DISTINCT FROM NEW.owner_user_id
      OR NEW.reviewed_by_user_id IS DISTINCT FROM NEW.owner_user_id
      OR NOT COALESCE((NEW.consent_lifetime IS NULL AND NEW.consent_expires_at IS NOT NULL AND isfinite(NEW.consent_expires_at)
       AND NEW.consent_expires_at>clock_timestamp() AND NEW.consent_expires_at<=NEW.reviewed_at+((a.snapshot->'policy'->>'max_consent_seconds')::integer * interval '1 second'))
       OR (NEW.consent_lifetime='until_revoked' AND NEW.consent_expires_at IS NULL AND a.snapshot->'policy'->'allow_until_revoked'='true'::jsonb),false))) THEN
   RAISE EXCEPTION 'APP_OWNER_CONNECTION_RESOURCE_INVALID' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.enforce_app_runtime_binding()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APP_RUNTIME_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.org_id, NEW.app_installation_id, NEW.app_version_id, NEW.grant_snapshot_id,
        NEW.runtime_registration_id, NEW.action_key, NEW.interface_identity,
        NEW.provider_kind, NEW.provider_instance_id, NEW.provider_snapshot_id,
        NEW.operation_name, NEW.risk_class, NEW.review_requirement,
        NEW.retry_class, NEW.retention_class, NEW.created_at) IS DISTINCT FROM
       (OLD.org_id, OLD.app_installation_id, OLD.app_version_id, OLD.grant_snapshot_id,
        OLD.runtime_registration_id, OLD.action_key, OLD.interface_identity,
        OLD.provider_kind, OLD.provider_instance_id, OLD.provider_snapshot_id,
        OLD.operation_name, OLD.risk_class, OLD.review_requirement,
        OLD.retry_class, OLD.retention_class, OLD.created_at)
    THEN RAISE EXCEPTION 'APP_RUNTIME_IMMUTABLE_FIELD' USING ERRCODE = '55000'; END IF;
    IF (NEW.reviewed_by_user_id, NEW.reviewed_at) IS DISTINCT FROM
       (OLD.reviewed_by_user_id, OLD.reviewed_at)
       AND NOT (OLD.state = 'disabled' AND NEW.state = 'active'
         AND OLD.reviewed_by_user_id IS NULL AND OLD.reviewed_at IS NULL
         AND NEW.reviewed_by_user_id IS NOT NULL AND NEW.reviewed_at IS NOT NULL)
    THEN RAISE EXCEPTION 'APP_RUNTIME_IMMUTABLE_FIELD' USING ERRCODE = '55000'; END IF;
    IF NOT ((OLD.state = 'disabled' AND NEW.state = 'active')
         OR (OLD.state = 'active' AND NEW.state = 'revoked')
         OR OLD.state = NEW.state) THEN
      RAISE EXCEPTION 'APP_RUNTIME_ILLEGAL_TRANSITION' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW.state = 'active' THEN
    IF EXISTS(SELECT 1 FROM app_runtime_registrations r WHERE r.org_id=NEW.org_id AND r.id=NEW.runtime_registration_id
      AND r.owner_connection_admission_id IS NOT NULL) THEN
      IF NOT EXISTS(SELECT 1 FROM app_runtime_registrations r
        JOIN app_owner_connection_admissions a ON a.org_id=r.org_id AND a.id=r.owner_connection_admission_id AND a.review_digest=r.owner_connection_admission_digest
        JOIN app_resource_bindings b ON b.org_id=r.org_id AND b.id=NEW.owner_resource_binding_id
        JOIN app_runtime_registrations rr ON rr.org_id=b.org_id AND rr.id=b.runtime_registration_id
        WHERE r.org_id=NEW.org_id AND r.id=NEW.runtime_registration_id AND r.state='active'
        AND app_owner_connection_admission_current(r.org_id,a.id,a.review_digest)
        AND app_owner_connection_member(r.org_id,NEW.reviewed_by_user_id)
        AND NEW.reviewed_by_user_id=r.reviewed_by_user_id AND b.owner_user_id=r.reviewed_by_user_id
        AND b.state='active' AND ((b.consent_lifetime IS NULL AND b.consent_expires_at>clock_timestamp()) OR (b.consent_lifetime='until_revoked' AND b.consent_expires_at IS NULL AND a.snapshot->'policy'->'allow_until_revoked'='true'::jsonb)) AND b.resource_key=a.snapshot->'policy'->>'resource_key'
        AND b.app_installation_id=r.app_installation_id AND b.app_version_id=r.app_version_id AND b.grant_snapshot_id=r.grant_snapshot_id
        AND rr.owner_connection_admission_id=a.id AND rr.owner_connection_admission_digest=a.review_digest AND rr.operator_user_id=r.operator_user_id
        AND a.snapshot->'policy'->'action_keys' ? NEW.action_key) THEN
        RAISE EXCEPTION 'APP_OWNER_CONNECTION_ACTION_INVALID' USING ERRCODE='55000'; END IF;
    ELSIF NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=NEW.org_id AND user_id=NEW.reviewed_by_user_id
      AND is_active AND role IN ('owner','admin')) THEN
      RAISE EXCEPTION 'APP_RUNTIME_REVIEW_INVALID' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.app_owner_resource_page_amendment_allowed(previous app_resource_bindings, amended app_resource_bindings)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE r app_runtime_registrations%ROWTYPE; a app_owner_connection_admissions%ROWTYPE;
BEGIN
  IF previous.state<>'active' OR amended.state<>'active'
    OR previous.registration_contract_version<>'deft.app_runtime_channel.v3'
    OR amended.max_records_per_page=previous.max_records_per_page
    OR amended.attachment_consent_digest IS NOT DISTINCT FROM previous.attachment_consent_digest
    OR amended.attachment_policy IS DISTINCT FROM previous.attachment_policy
    OR amended.consent_expires_at IS DISTINCT FROM previous.consent_expires_at
    OR NOT deft_app_consent_valid(jsonb_strip_nulls(to_jsonb(amended)) || jsonb_build_object('consent_expires_at',amended.consent_expires_at)) OR deft_app_consent_deadline(jsonb_strip_nulls(to_jsonb(amended)) || jsonb_build_object('consent_expires_at',amended.consent_expires_at))<=clock_timestamp()
    OR amended.reviewed_by_user_id IS DISTINCT FROM amended.owner_user_id THEN RETURN false; END IF;
  SELECT * INTO r FROM app_runtime_registrations WHERE org_id=previous.org_id AND id=previous.runtime_registration_id;
  IF r.id IS NULL OR r.state<>'active' OR r.owner_connection_admission_id IS NULL
    OR r.reviewed_by_user_id IS DISTINCT FROM previous.owner_user_id THEN RETURN false; END IF;
  SELECT * INTO a FROM app_owner_connection_admissions WHERE org_id=r.org_id AND id=r.owner_connection_admission_id;
  IF NOT app_owner_connection_admission_current(r.org_id,a.id,r.owner_connection_admission_digest)
    OR NOT app_owner_connection_member(previous.org_id,previous.owner_user_id)
    OR amended.max_records_per_page>(a.snapshot->'limits'->>'max_records_per_page')::integer
    OR EXISTS (SELECT 1 FROM app_runs WHERE org_id=previous.org_id AND origin_resource_binding_id=previous.id
      AND state IN ('pending','running','waiting_external'))
    OR EXISTS (SELECT 1 FROM app_runtime_sessions WHERE org_id=previous.org_id AND resource_binding_id=previous.id
      AND runtime_registration_id=r.id AND audience='app_resource_sync' AND revoked_at IS NULL)
    THEN RETURN false; END IF;
  RETURN true;
END; $function$;

CREATE OR REPLACE FUNCTION public.enforce_app_runtime_session()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APP_RUNTIME_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.renewal_lifetime='until_revoked' AND (NOT isfinite(NEW.expires_at) OR (NEW.expires_at AT TIME ZONE 'UTC')<=clock_timestamp() OR (NEW.expires_at AT TIME ZONE 'UTC')>clock_timestamp()+interval '15 minutes') THEN
    RAISE EXCEPTION 'APP_RUNTIME_RENEWAL_WINDOW_INVALID' USING ERRCODE='23514'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.org_id, NEW.runtime_registration_id, NEW.runtime_binding_id,
        NEW.operator_user_id, NEW.token_hash, NEW.audience, NEW.session_epoch,
        NEW.runtime_epoch, NEW.lifecycle_epoch, NEW.grant_epoch, NEW.created_at,
        NEW.renewal_lifetime, NEW.renewable_until, NEW.renewal_web_session_id, NEW.renewal_operator_role) IS DISTINCT FROM
       (OLD.org_id, OLD.runtime_registration_id, OLD.runtime_binding_id,
        OLD.operator_user_id, OLD.token_hash, OLD.audience, OLD.session_epoch,
        OLD.runtime_epoch, OLD.lifecycle_epoch, OLD.grant_epoch, OLD.created_at,
        OLD.renewal_lifetime, OLD.renewable_until, OLD.renewal_web_session_id, OLD.renewal_operator_role)
      OR NEW.next_sequence < OLD.next_sequence
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
      OR (NEW.expires_at IS DISTINCT FROM OLD.expires_at AND (
        (OLD.renewable_until IS NULL AND OLD.renewal_lifetime IS DISTINCT FROM 'until_revoked') OR (OLD.expires_at AT TIME ZONE 'UTC') <= clock_timestamp()
        OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NOT NULL
        OR NEW.expires_at < OLD.expires_at OR (OLD.renewal_lifetime IS NULL AND (NEW.expires_at AT TIME ZONE 'UTC') > OLD.renewable_until)
        OR (NEW.expires_at AT TIME ZONE 'UTC') > clock_timestamp() + interval '15 minutes'))
    THEN RAISE EXCEPTION 'APP_RUNTIME_IMMUTABLE_FIELD' USING ERRCODE = '55000'; END IF;
  END IF;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.enforce_app_v7_effective_grant_shape()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  version_row app_versions%ROWTYPE;
  installation_row app_installations%ROWTYPE;
  requested_row app_grant_snapshots%ROWTYPE;
  snapshot_json jsonb;
  descriptor jsonb;
  declared_descriptors jsonb;
  policy jsonb;
  policy_key text;
  policy_max numeric;
  payload_policy jsonb;
  previous_action_key text;
  seen_payload_actions text[] := ARRAY[]::text[];
  change_descriptor jsonb;
  previous_change_key text;
  local_job_descriptor jsonb;
  previous_local_job_key text;
BEGIN
  IF NEW.snapshot_kind <> 'effective' THEN RETURN NEW; END IF;
  SELECT * INTO version_row FROM app_versions WHERE org_id=NEW.org_id
    AND installation_id=NEW.app_installation_id AND id=NEW.app_version_id;
  IF NOT FOUND OR version_row.protocol_version<>'7' THEN RETURN NEW; END IF;
  SELECT * INTO installation_row FROM app_installations WHERE org_id=NEW.org_id AND id=NEW.app_installation_id;
  SELECT * INTO requested_row FROM app_grant_snapshots WHERE org_id=NEW.org_id
    AND app_installation_id=NEW.app_installation_id AND app_version_id=NEW.app_version_id
    AND id=NEW.requested_snapshot_id AND snapshot_kind='requested';
  IF installation_row.id IS NULL OR requested_row.id IS NULL THEN
    RAISE EXCEPTION 'APP_V7_GRANT_ANCESTRY_MISSING' USING ERRCODE='23514'; END IF;
  snapshot_json:=NEW.canonical_snapshot;
  IF NOT(snapshot_json ?& ARRAY['schema','lineage_key','package_digest','manifest_digest','sync_descriptors','modules','runtime_actions','native_actions','public_actions','experiences','host_policy','organization_id','app_installation_id','app_version_id','requested_snapshot_id','requested_snapshot_digest','classification','review_digest']) OR snapshot_json-ARRAY['integration_tools','record_stores','owner_connections','private_state','schema','lineage_key','package_digest','manifest_digest','sync_descriptors','modules','runtime_actions','native_actions','public_actions','experiences','host_policy','organization_id','app_installation_id','app_version_id','requested_snapshot_id','requested_snapshot_digest','classification','review_digest']<>'{}'::jsonb
    OR snapshot_json->>'schema' IS NULL OR snapshot_json->>'schema' NOT IN ('deft.app_blob_grant.v1','deft.app_blob_grant.v2')
    OR snapshot_json->>'lineage_key' IS DISTINCT FROM installation_row.lineage_key
    OR snapshot_json->>'package_digest' IS DISTINCT FROM version_row.package_digest
    OR snapshot_json->>'manifest_digest' IS DISTINCT FROM version_row.manifest_digest
    OR snapshot_json->>'organization_id' IS DISTINCT FROM NEW.org_id
    OR snapshot_json->>'app_installation_id' IS DISTINCT FROM NEW.app_installation_id
    OR snapshot_json->>'app_version_id' IS DISTINCT FROM NEW.app_version_id
    OR snapshot_json->>'requested_snapshot_id' IS DISTINCT FROM NEW.requested_snapshot_id
    OR snapshot_json->>'requested_snapshot_digest' IS DISTINCT FROM requested_row.snapshot_digest
    OR NOT COALESCE(snapshot_json->>'review_digest' ~ '^sha256:[a-f0-9]{64}$',false)
    OR NEW.resource_rights<>'[]'::jsonb
    OR NEW.classification<>'{"authority_state":"effective","executable":false,"provider_access":false,"runtime_binding_review_required":true,"resource_binding_consent_required":true,"attachment_policy_review_required":true}'::jsonb
    OR snapshot_json->'classification' IS DISTINCT FROM NEW.classification
    OR snapshot_json->'host_policy' IS DISTINCT FROM '{"encrypted_custody":true,"current_parent_required":true,"provider_url_fetch":false,"irrecoverable_host_purge":true,"owner_only":true,"stage_ceiling_seconds":3600}'::jsonb THEN
    RAISE EXCEPTION 'APP_V7_GRANT_SHAPE_INVALID' USING ERRCODE='23514'; END IF;
  -- E4 declarations stay bound to the exact signed installed manifest. Legacy
  -- v7 packages without tools retain the original absence semantics.
  IF (snapshot_json ? 'integration_tools') IS DISTINCT FROM (version_row.manifest ? 'integration_tools')
    OR COALESCE(snapshot_json->'integration_tools','[]'::jsonb) IS DISTINCT FROM COALESCE(version_row.manifest->'integration_tools','[]'::jsonb)
    OR (snapshot_json ? 'integration_tools' AND (
      jsonb_typeof(snapshot_json->'integration_tools') IS DISTINCT FROM 'array'
      OR jsonb_array_length(snapshot_json->'integration_tools') NOT BETWEEN 1 AND 32)) THEN
    RAISE EXCEPTION 'APP_V7_INTEGRATION_TOOLS_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
  IF jsonb_typeof(snapshot_json->'sync_descriptors') IS DISTINCT FROM 'array'
    OR jsonb_typeof(snapshot_json->'modules') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'APP_V7_GRANT_ARRAY_INVALID' USING ERRCODE='23514'; END IF;
  IF jsonb_array_length(snapshot_json->'sync_descriptors') NOT BETWEEN 1 AND 8
    OR jsonb_array_length(snapshot_json->'modules')>15
    OR snapshot_json->'modules' IS DISTINCT FROM version_row.manifest->'modules'
    OR snapshot_json->'native_actions' IS DISTINCT FROM '[]'::jsonb
    OR snapshot_json->'public_actions' IS DISTINCT FROM '[]'::jsonb
    OR version_row.manifest->'native_actions' IS DISTINCT FROM '[]'::jsonb
    OR version_row.manifest->'public_actions' IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'APP_V7_GRANT_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
  IF snapshot_json->>'schema'='deft.app_blob_grant.v1' THEN
    -- Preserve the exact v1 empty-plane requirement; no existing grant widens.
    IF snapshot_json->'runtime_actions' IS DISTINCT FROM '[]'::jsonb
      OR snapshot_json->'experiences' IS DISTINCT FROM '[]'::jsonb
      OR version_row.manifest->'runtime_actions' IS DISTINCT FROM '[]'::jsonb
      OR version_row.manifest->'experiences' IS DISTINCT FROM '[]'::jsonb
      OR version_row.manifest->'private_capabilities' IS DISTINCT FROM '[]'::jsonb THEN
      RAISE EXCEPTION 'APP_V7_GRANT_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
  ELSE
    -- Only the separately reviewed composition shape admits Runtime and
    -- verified Experience declarations; native and public stay empty above.
    IF jsonb_typeof(snapshot_json->'runtime_actions') IS DISTINCT FROM 'array'
      OR jsonb_typeof(version_row.manifest->'runtime_actions') IS DISTINCT FROM 'array'
      OR jsonb_typeof(version_row.manifest->'private_capabilities') IS DISTINCT FROM 'array'
      OR jsonb_typeof(version_row.manifest->'runtime_requirements') IS DISTINCT FROM 'array'
      OR jsonb_typeof(version_row.manifest->'experiences') IS DISTINCT FROM 'array'
      OR snapshot_json->'experiences' IS DISTINCT FROM version_row.manifest->'experiences' THEN
      RAISE EXCEPTION 'APP_V7_COMPOSITION_ARRAY_INVALID' USING ERRCODE='23514'; END IF;
    IF jsonb_array_length(snapshot_json->'runtime_actions')<>jsonb_array_length(version_row.manifest->'runtime_actions') THEN
      RAISE EXCEPTION 'APP_V7_COMPOSITION_ACTION_MISMATCH' USING ERRCODE='23514'; END IF;
    FOR descriptor IN SELECT value FROM jsonb_array_elements(snapshot_json->'runtime_actions') LOOP
      IF jsonb_typeof(descriptor) IS DISTINCT FROM 'object'
        OR NOT(descriptor ?& ARRAY['action_key','runtime_requirement_key','interface','operation_name','input_schema','output_schema','contract_digest','host_policy'])
        OR descriptor-ARRAY['action_key','runtime_requirement_key','interface','operation_name','input_schema','output_schema','contract_digest','host_policy']<>'{}'::jsonb
        OR NOT COALESCE(descriptor->>'contract_digest' ~ '^sha256:[a-f0-9]{64}$',false)
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(version_row.manifest->'runtime_actions') action
          JOIN jsonb_array_elements(version_row.manifest->'private_capabilities') capability
            ON capability->>'key'=action->>'capability_key'
          JOIN jsonb_array_elements(version_row.manifest->'runtime_requirements') requirement
            ON requirement->>'key'=action->>'runtime_requirement_key'
          WHERE requirement->>'protocol_version'='deft.app_runtime_channel.v1'
            AND capability->>'version'='1'
            AND jsonb_typeof(capability->'input_schema')='object'
            AND jsonb_typeof(capability->'output_schema')='object'
            AND descriptor-'contract_digest'=jsonb_build_object(
              'action_key',action->'key','runtime_requirement_key',action->'runtime_requirement_key',
              'interface',jsonb_build_object('namespace','app_lineage','key',capability->'key','version',capability->'version'),
              'operation_name',action->'key','input_schema',capability->'input_schema','output_schema',capability->'output_schema',
              'host_policy','{"risk_class":"external_write","review_requirement":"always","review_scope":"per_invocation","retry_class":"unsafe_or_unknown","retention_class":"standard"}'::jsonb)) THEN
        RAISE EXCEPTION 'APP_V7_COMPOSITION_ACTION_MISMATCH' USING ERRCODE='23514'; END IF;
    END LOOP;
    IF (SELECT count(DISTINCT value->>'action_key') FROM jsonb_array_elements(snapshot_json->'runtime_actions'))<>jsonb_array_length(snapshot_json->'runtime_actions') THEN
      RAISE EXCEPTION 'APP_V7_COMPOSITION_ACTION_MISMATCH' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT COALESCE(jsonb_agg(item.value-'descriptor_digest' ORDER BY item.ordinality),'[]'::jsonb)
    INTO declared_descriptors FROM jsonb_array_elements(snapshot_json->'sync_descriptors') WITH ORDINALITY AS item(value,ordinality);
  IF declared_descriptors IS DISTINCT FROM version_row.manifest->'sync_descriptors' THEN
    RAISE EXCEPTION 'APP_V7_GRANT_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
  FOR descriptor IN SELECT value FROM jsonb_array_elements(snapshot_json->'sync_descriptors') LOOP
    IF jsonb_typeof(descriptor) IS DISTINCT FROM 'object'
      OR NOT(descriptor ?& ARRAY['schema_version','key','runtime_requirement_key','resource_type','requested_visibility','record_schema','label_field','attachments','descriptor_digest'])
      OR descriptor-ARRAY['schema_version','key','runtime_requirement_key','resource_type','requested_visibility','record_schema','label_field','attachments','descriptor_digest']<>'{}'::jsonb
      OR descriptor->>'schema_version' IS DISTINCT FROM 'deft.app_sync_descriptor.v2'
      OR descriptor->>'requested_visibility' IS DISTINCT FROM 'user_private'
      OR NOT COALESCE(descriptor->>'descriptor_digest' ~ '^sha256:[a-f0-9]{64}$',false)
      OR jsonb_typeof(descriptor->'record_schema') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'APP_V7_GRANT_DESCRIPTOR_INVALID' USING ERRCODE='23514'; END IF;
    policy:=descriptor->'attachments';
    IF jsonb_typeof(policy) IS DISTINCT FROM 'object'
      OR NOT(policy ?& ARRAY['max_attachment_bytes','max_attachments_per_record','max_attachments_per_run','max_attachment_bytes_per_run','retention_days','allowed_media_types'])
      OR policy-ARRAY['max_attachment_bytes','max_attachments_per_record','max_attachments_per_run','max_attachment_bytes_per_run','retention_days','allowed_media_types']<>'{}'::jsonb THEN
      RAISE EXCEPTION 'APP_V7_GRANT_ATTACHMENT_POLICY_INVALID' USING ERRCODE='23514'; END IF;
    FOR policy_key,policy_max IN VALUES ('max_attachment_bytes',2097152),('max_attachments_per_record',8),
      ('max_attachments_per_run',32),('max_attachment_bytes_per_run',8388608),('retention_days',30) LOOP
      IF jsonb_typeof(policy->policy_key) IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'APP_V7_GRANT_ATTACHMENT_POLICY_INVALID' USING ERRCODE='23514'; END IF;
      IF (policy->>policy_key)::numeric NOT BETWEEN 1 AND policy_max
        OR (policy->>policy_key)::numeric<>trunc((policy->>policy_key)::numeric) THEN
        RAISE EXCEPTION 'APP_V7_GRANT_ATTACHMENT_POLICY_INVALID' USING ERRCODE='23514'; END IF;
    END LOOP;
    IF jsonb_typeof(policy->'allowed_media_types') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'APP_V7_GRANT_ATTACHMENT_POLICY_INVALID' USING ERRCODE='23514'; END IF;
    IF jsonb_array_length(policy->'allowed_media_types') NOT BETWEEN 1 AND 8
      OR NOT(policy->'allowed_media_types'<@'["text/plain","text/csv","application/json","image/png","image/jpeg","image/gif","image/webp","application/pdf"]'::jsonb)
      OR jsonb_array_length(policy->'allowed_media_types')<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(policy->'allowed_media_types')) THEN
      RAISE EXCEPTION 'APP_V7_GRANT_ATTACHMENT_POLICY_INVALID' USING ERRCODE='23514'; END IF;
  END LOOP;
  -- Separately reviewed app-owned stores preserve every existing private-state budget.
  IF snapshot_json ? 'record_stores' OR version_row.manifest ? 'record_stores' THEN
    IF snapshot_json->>'schema' IS DISTINCT FROM 'deft.app_blob_grant.v2'
      OR snapshot_json->'record_stores' IS DISTINCT FROM version_row.manifest->'record_stores'
      OR jsonb_typeof(snapshot_json->'record_stores') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
    IF jsonb_array_length(snapshot_json->'record_stores') NOT BETWEEN 1 AND 16 THEN
      RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
    previous_action_key:=NULL;
    FOR policy IN SELECT value FROM jsonb_array_elements(snapshot_json->'record_stores') LOOP
      IF NOT COALESCE(jsonb_typeof(policy)='object'
        AND policy ?& ARRAY['schema_version','key','resource_key','runtime_requirement_key','max_record_bytes','max_files','max_file_bytes','max_total_file_bytes']
        AND policy-ARRAY['schema_version','key','resource_key','runtime_requirement_key','max_record_bytes','max_files','max_file_bytes','max_total_file_bytes','resource_content','record_changes','local_job_operations','future_record_actions','record_mirrors','source_projection','supplemental_effects']='{}'::jsonb
        AND policy->>'schema_version'='deft.app_record_store.v1'
        AND policy->>'key' ~ '^[a-z][a-z0-9_]{0,47}$'
        AND policy->>'key' NOT IN ('constructor','prototype','__proto__')
        AND policy->>'resource_key' ~ '^[a-z][a-z0-9_]{0,47}$'
        AND policy->>'runtime_requirement_key' ~ '^[a-z][a-z0-9_]{0,47}$',false) THEN
        RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
      FOR policy_key,policy_max IN VALUES ('max_record_bytes',491520),('max_files',32),('max_file_bytes',26214400),('max_total_file_bytes',26214400) LOOP
        IF jsonb_typeof(policy->policy_key) IS DISTINCT FROM 'number' THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
        IF (policy->>policy_key)::numeric NOT BETWEEN (CASE WHEN policy_key='max_files' THEN 0 ELSE 1 END) AND policy_max
          OR (policy->>policy_key)::numeric<>trunc((policy->>policy_key)::numeric) THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
      END LOOP;
      IF (policy->>'max_file_bytes')::numeric>(policy->>'max_total_file_bytes')::numeric
        OR previous_action_key IS NOT NULL AND previous_action_key COLLATE "C">=(policy->>'key') COLLATE "C"
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'sync_descriptors') d WHERE d->>'key'=policy->>'resource_key'
          AND d->>'runtime_requirement_key'=policy->>'runtime_requirement_key' AND d->>'requested_visibility'='user_private')
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'owner_connections') p WHERE p->>'resource_key'=policy->>'resource_key'
          AND p->>'runtime_requirement_key'=policy->>'runtime_requirement_key' AND p ? 'provider_profile_key') THEN
        RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
      IF policy ? 'supplemental_effects' AND NOT public.deft_app_supplemental_effects_valid(policy->'supplemental_effects',policy,snapshot_json) THEN RAISE EXCEPTION 'APP_V7_SUPPLEMENTAL_EFFECT_INVALID' USING ERRCODE='23514';END IF;
      IF policy ? 'source_projection' AND NOT deft_app_integration_source_projection_valid(policy->'source_projection',policy,snapshot_json) THEN RAISE EXCEPTION 'APP_V7_SOURCE_PROJECTION_INVALID' USING ERRCODE='23514';END IF;
      IF policy ? 'record_mirrors' AND NOT deft_app_record_mirrors_valid(policy->'record_mirrors',snapshot_json) THEN RAISE EXCEPTION 'APP_V7_RECORD_MIRROR_INVALID' USING ERRCODE='23514';END IF;
      IF policy ? 'future_record_actions' AND NOT deft_app_future_record_actions_valid(policy->'future_record_actions',snapshot_json) THEN RAISE EXCEPTION 'APP_V7_FUTURE_RECORD_ACTION_INVALID' USING ERRCODE='23514';END IF;
      IF policy ? 'local_job_operations' THEN
        IF jsonb_typeof(policy->'local_job_operations') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514';END IF;
        IF jsonb_array_length(policy->'local_job_operations') NOT BETWEEN 1 AND 8 THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514';END IF;
        previous_local_job_key:=NULL;
        FOR local_job_descriptor IN SELECT value FROM jsonb_array_elements(policy->'local_job_operations') LOOP
          IF NOT COALESCE(jsonb_typeof(local_job_descriptor)='object'
            AND local_job_descriptor ?& ARRAY['key','local_only'] AND local_job_descriptor-ARRAY['key','local_only']='{}'::jsonb
            AND local_job_descriptor->>'key' ~ '^[a-z][a-z0-9_]{0,47}$' AND local_job_descriptor->>'key' NOT IN ('constructor','prototype','__proto__')
            AND local_job_descriptor->'local_only'='true'::jsonb,false)
            OR previous_local_job_key IS NOT NULL AND previous_local_job_key COLLATE "C">=(local_job_descriptor->>'key') COLLATE "C" THEN
            RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514';END IF;
          previous_local_job_key:=local_job_descriptor->>'key';
        END LOOP;
      END IF;
      IF policy ? 'record_changes' THEN
        IF jsonb_typeof(policy->'record_changes') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
        IF jsonb_array_length(policy->'record_changes') NOT BETWEEN 1 AND 8 THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
        previous_change_key:=NULL;
        FOR change_descriptor IN SELECT value FROM jsonb_array_elements(policy->'record_changes') LOOP
          IF NOT COALESCE(jsonb_typeof(change_descriptor)='object'
            AND change_descriptor ?& ARRAY['key','source_store_key']
            AND change_descriptor-ARRAY['key','source_store_key']='{}'::jsonb
            AND change_descriptor->>'key' ~ '^[a-z][a-z0-9_]{0,47}$'
            AND change_descriptor->>'key' NOT IN ('constructor','prototype','__proto__')
            AND change_descriptor->>'source_store_key' ~ '^[a-z][a-z0-9_]{0,47}$'
            AND change_descriptor->>'source_store_key' NOT IN ('constructor','prototype','__proto__')
            AND change_descriptor->>'source_store_key'<>policy->>'key',false)
            OR previous_change_key IS NOT NULL AND previous_change_key COLLATE "C">=(change_descriptor->>'key') COLLATE "C"
            OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'record_stores') source_store
              WHERE source_store->>'key'=change_descriptor->>'source_store_key'
                AND source_store->>'resource_key'=policy->>'resource_key'
                AND source_store->>'runtime_requirement_key'=policy->>'runtime_requirement_key') THEN
            RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
          previous_change_key:=change_descriptor->>'key';
        END LOOP;
      END IF;
      IF policy ? 'resource_content' THEN
        payload_policy:=policy->'resource_content';
        IF NOT COALESCE(jsonb_typeof(payload_policy)='object' AND payload_policy ?& ARRAY['max_presentation_bytes','max_source_bytes','max_file_bytes','max_image_bytes']
          AND payload_policy-ARRAY['max_presentation_bytes','max_source_bytes','max_file_bytes','max_image_bytes']='{}'::jsonb,false) THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
        FOR policy_key,policy_max IN VALUES ('max_presentation_bytes',262144),('max_source_bytes',36700160),('max_file_bytes',26214400),('max_image_bytes',2097152) LOOP
          IF jsonb_typeof(payload_policy->policy_key) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
          IF (payload_policy->>policy_key)::numeric NOT BETWEEN 1 AND policy_max OR (payload_policy->>policy_key)::numeric<>trunc((payload_policy->>policy_key)::numeric) THEN
            RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
        END LOOP;
      END IF;
      previous_action_key:=policy->>'key';
    END LOOP;
  END IF;
  -- Optional state is separately reviewed and exactly binds the signed manifest.
  IF snapshot_json ? 'private_state' OR version_row.manifest ? 'private_state' THEN
    IF snapshot_json->>'schema' IS DISTINCT FROM 'deft.app_blob_grant.v2'
      OR snapshot_json->'private_state' IS DISTINCT FROM version_row.manifest->'private_state'
      OR jsonb_typeof(snapshot_json->'private_state') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
    IF jsonb_array_length(snapshot_json->'private_state') NOT BETWEEN 1 AND 16 THEN
      RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
    FOR descriptor IN SELECT value FROM jsonb_array_elements(snapshot_json->'private_state') LOOP
      IF jsonb_typeof(descriptor) IS DISTINCT FROM 'object'
        OR NOT(descriptor ?& ARRAY['key','label','schema','max_record_bytes','max_records','max_total_bytes','retention_days'])
        OR descriptor-ARRAY['key','label','schema','max_record_bytes','max_records','max_total_bytes','retention_days','files','action_payloads']<>'{}'::jsonb
        OR NOT COALESCE(descriptor->>'key' ~ '^[a-z][a-z0-9_]{0,47}$',false)
        OR jsonb_typeof(descriptor->'label') IS DISTINCT FROM 'string'
        OR length(descriptor->>'label') NOT BETWEEN 1 AND 128
        OR jsonb_typeof(descriptor->'schema') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
      FOR policy_key,policy_max IN VALUES ('max_record_bytes',16384),('max_records',32),('max_total_bytes',131072),('retention_days',30) LOOP
        IF jsonb_typeof(descriptor->policy_key) IS DISTINCT FROM 'number' THEN
          RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
        IF (descriptor->>policy_key)::numeric NOT BETWEEN 1 AND policy_max
          OR (descriptor->>policy_key)::numeric<>trunc((descriptor->>policy_key)::numeric) THEN
          RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
      END LOOP;
      IF descriptor ? 'files' THEN
        policy := descriptor->'files';
        IF jsonb_typeof(policy) IS DISTINCT FROM 'object'
          OR NOT(policy ?& ARRAY['max_file_bytes','max_files_per_record','max_total_bytes_per_record','allowed_media_types'])
          OR policy-ARRAY['max_file_bytes','max_files_per_record','max_total_bytes_per_record','allowed_media_types']<>'{}'::jsonb THEN
          RAISE EXCEPTION 'APP_V7_PRIVATE_FILE_POLICY_INVALID' USING ERRCODE='23514'; END IF;
        FOR policy_key,policy_max IN VALUES ('max_file_bytes',2097152),('max_files_per_record',8),('max_total_bytes_per_record',8388608) LOOP
          IF jsonb_typeof(policy->policy_key) IS DISTINCT FROM 'number' THEN
            RAISE EXCEPTION 'APP_V7_PRIVATE_FILE_POLICY_INVALID' USING ERRCODE='23514'; END IF;
          IF (policy->>policy_key)::numeric NOT BETWEEN 1 AND policy_max
            OR (policy->>policy_key)::numeric<>trunc((policy->>policy_key)::numeric) THEN
            RAISE EXCEPTION 'APP_V7_PRIVATE_FILE_POLICY_INVALID' USING ERRCODE='23514'; END IF;
        END LOOP;
        IF (policy->>'max_file_bytes')::numeric>(policy->>'max_total_bytes_per_record')::numeric
          OR jsonb_typeof(policy->'allowed_media_types') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'APP_V7_PRIVATE_FILE_POLICY_INVALID' USING ERRCODE='23514'; END IF;
        IF jsonb_array_length(policy->'allowed_media_types') NOT BETWEEN 1 AND 8
          OR NOT(policy->'allowed_media_types'<@'["text/plain","text/csv","application/json","image/png","image/jpeg","image/gif","image/webp","application/pdf"]'::jsonb)
          OR jsonb_array_length(policy->'allowed_media_types')<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(policy->'allowed_media_types')) THEN
          RAISE EXCEPTION 'APP_V7_PRIVATE_FILE_POLICY_INVALID' USING ERRCODE='23514'; END IF;
      END IF;
      IF descriptor ? 'action_payloads' THEN
        IF jsonb_typeof(descriptor->'action_payloads') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'APP_V7_ACTION_PAYLOAD_POLICY_INVALID' USING ERRCODE='23514'; END IF;
        IF jsonb_array_length(descriptor->'action_payloads') NOT BETWEEN 1 AND 16 THEN
          RAISE EXCEPTION 'APP_V7_ACTION_PAYLOAD_POLICY_INVALID' USING ERRCODE='23514'; END IF;
        previous_action_key := NULL;
        FOR payload_policy IN SELECT value FROM jsonb_array_elements(descriptor->'action_payloads') LOOP
          IF jsonb_typeof(payload_policy) IS DISTINCT FROM 'object'
            OR NOT(payload_policy ?& ARRAY['action_key','max_payload_bytes'])
            OR payload_policy-ARRAY['action_key','max_payload_bytes']<>'{}'::jsonb
            OR NOT COALESCE(payload_policy->>'action_key' ~ '^[a-z][a-z0-9_]{0,47}$',false)
            OR payload_policy->>'action_key' IN ('constructor','prototype','__proto__')
            OR payload_policy->>'action_key' ~ '^(deft|core|system)(_|$)'
            OR jsonb_typeof(payload_policy->'max_payload_bytes') IS DISTINCT FROM 'number' THEN
            RAISE EXCEPTION 'APP_V7_ACTION_PAYLOAD_POLICY_INVALID' USING ERRCODE='23514'; END IF;
          IF (payload_policy->>'max_payload_bytes')::numeric NOT BETWEEN 1 AND 8388608
            OR (payload_policy->>'max_payload_bytes')::numeric<>trunc((payload_policy->>'max_payload_bytes')::numeric)
            OR (previous_action_key IS NOT NULL AND previous_action_key COLLATE "C">=(payload_policy->>'action_key') COLLATE "C")
            OR payload_policy->>'action_key'=ANY(seen_payload_actions)
            OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(version_row.manifest->'runtime_actions') action WHERE action->>'key'=payload_policy->>'action_key') THEN
            RAISE EXCEPTION 'APP_V7_ACTION_PAYLOAD_POLICY_INVALID' USING ERRCODE='23514'; END IF;
          previous_action_key := payload_policy->>'action_key';
          seen_payload_actions := array_append(seen_payload_actions,previous_action_key);
        END LOOP;
      END IF;
      IF (descriptor->>'max_record_bytes')::numeric>(descriptor->>'max_total_bytes')::numeric THEN
        RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
    END LOOP;
    IF (SELECT count(DISTINCT value->>'key') FROM jsonb_array_elements(snapshot_json->'private_state'))<>jsonb_array_length(snapshot_json->'private_state') THEN
      RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
  END IF;

  -- Optional member ownership is independently reviewed and cannot widen a
  -- resource or action declaration. Absence preserves historical grants.
  IF snapshot_json ? 'owner_connections' OR version_row.manifest ? 'owner_connections' THEN
    IF snapshot_json->>'schema' IS DISTINCT FROM 'deft.app_blob_grant.v2'
      OR snapshot_json->'owner_connections' IS DISTINCT FROM version_row.manifest->'owner_connections'
      OR jsonb_typeof(snapshot_json->'owner_connections') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'APP_V7_OWNER_CONNECTION_POLICY_INVALID' USING ERRCODE='23514'; END IF;
    IF jsonb_array_length(snapshot_json->'owner_connections') NOT BETWEEN 1 AND 16 THEN
      RAISE EXCEPTION 'APP_V7_OWNER_CONNECTION_POLICY_INVALID' USING ERRCODE='23514'; END IF;
    previous_action_key:=NULL;
    FOR policy IN SELECT value FROM jsonb_array_elements(snapshot_json->'owner_connections') LOOP
      IF jsonb_typeof(policy) IS DISTINCT FROM 'object'
        OR NOT(policy ?& ARRAY['key','resource_key','action_keys','max_consent_seconds'])
        OR policy-ARRAY['key','resource_key','action_keys','max_consent_seconds','allow_until_revoked','provider_profile_key','runtime_requirement_key']<>'{}'::jsonb
        OR (policy ? 'allow_until_revoked' AND policy->'allow_until_revoked' IS DISTINCT FROM 'true'::jsonb)
        OR jsonb_typeof(policy->'key') IS DISTINCT FROM 'string'
        OR jsonb_typeof(policy->'resource_key') IS DISTINCT FROM 'string'
        OR NOT COALESCE(policy->>'key' ~ '^[a-z][a-z0-9_]{0,47}$',false)
        OR NOT COALESCE(policy->>'resource_key' ~ '^[a-z][a-z0-9_]{0,47}$',false)
        OR policy->>'key' IN ('constructor','prototype','__proto__')
        OR jsonb_typeof(policy->'action_keys') IS DISTINCT FROM 'array'
        OR jsonb_typeof(policy->'max_consent_seconds') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'APP_V7_OWNER_CONNECTION_POLICY_INVALID' USING ERRCODE='23514'; END IF;
      IF (policy->>'max_consent_seconds')::numeric NOT BETWEEN 1 AND 7776000
        OR (policy->>'max_consent_seconds')::numeric<>trunc((policy->>'max_consent_seconds')::numeric)
        OR jsonb_array_length(policy->'action_keys')>16
        OR (previous_action_key IS NOT NULL AND previous_action_key COLLATE "C">=(policy->>'key') COLLATE "C")
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'sync_descriptors') d
          WHERE d->>'key'=policy->>'resource_key' AND d->>'requested_visibility'='user_private') THEN
        RAISE EXCEPTION 'APP_V7_OWNER_CONNECTION_POLICY_INVALID' USING ERRCODE='23514'; END IF;
      IF (policy ? 'provider_profile_key') <> (policy ? 'runtime_requirement_key')
        OR (policy ? 'provider_profile_key' AND NOT COALESCE(
          jsonb_typeof(policy->'provider_profile_key') = 'string'
          AND jsonb_typeof(policy->'runtime_requirement_key') = 'string'
          AND policy->>'provider_profile_key' ~ '^[a-z][a-z0-9_]{0,47}$'
          AND policy->>'runtime_requirement_key' ~ '^[a-z][a-z0-9_]{0,47}$'
          AND policy->>'provider_profile_key' NOT IN ('constructor','prototype','__proto__')
          AND policy->>'runtime_requirement_key' NOT IN ('constructor','prototype','__proto__')
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'sync_descriptors') d
            WHERE d->>'key'=policy->>'resource_key' AND d->>'runtime_requirement_key'=policy->>'runtime_requirement_key')
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(version_row.manifest->'runtime_requirements') r
            WHERE r->>'key'=policy->>'runtime_requirement_key' AND r->>'protocol_version'='deft.app_runtime_channel.v3'),false)) THEN
        RAISE EXCEPTION 'APP_V7_OWNER_CONNECTION_PROFILE_INVALID' USING ERRCODE='23514';
      END IF;
      previous_action_key:=policy->>'key';
      policy_key:=NULL;
      FOR descriptor IN SELECT value FROM jsonb_array_elements(policy->'action_keys') LOOP
        IF jsonb_typeof(descriptor) IS DISTINCT FROM 'string'
          OR NOT COALESCE(descriptor#>>'{}' ~ '^[a-z][a-z0-9_]{0,47}$',false)
          OR (policy_key IS NOT NULL AND policy_key COLLATE "C">=(descriptor#>>'{}') COLLATE "C")
          OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'runtime_actions') d WHERE d->>'action_key'=descriptor#>>'{}') THEN
          RAISE EXCEPTION 'APP_V7_OWNER_CONNECTION_POLICY_INVALID' USING ERRCODE='23514'; END IF;
        policy_key:=descriptor#>>'{}';
      END LOOP;
    END LOOP;
  END IF;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.deft_resource_observation_consent_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE scope jsonb; record jsonb; form jsonb; receipt jsonb; continuation jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'observation consent history retained';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['state','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','updated_at'])
   OR OLD.state='revoked' AND NEW.state<>'revoked'
   OR OLD.state='active' AND NEW.state NOT IN ('active','revoked')
   OR NEW.updated_at<OLD.updated_at THEN RAISE EXCEPTION 'observation consent immutable identity';END IF;
 ELSE
  IF NEW.state<>'proposed' THEN RAISE EXCEPTION 'observation review required';END IF;
 END IF;
 IF TG_OP='UPDATE' AND NEW.state='revoked' THEN RETURN NEW;END IF;
 scope:=NEW.snapshot->'scope';
 SELECT s.record INTO record FROM app_connection_sessions s WHERE s.org_id=NEW.org_id AND s.owner_user_id=NEW.owner_user_id AND s.session_id=NEW.connection_session_id FOR SHARE;
 SELECT f.record INTO form FROM app_connection_forms f WHERE f.org_id=NEW.org_id AND f.owner_user_id=NEW.owner_user_id AND f.session_id=NEW.connection_session_id FOR SHARE;
 IF form IS NOT NULL THEN
  IF NOT deft_app_connection_form_record_valid(form) OR form->>'state' IS DISTINCT FROM 'connected'
   OR form->'session_id' IS DISTINCT FROM record->'session_id' OR form->'revision' IS DISTINCT FROM record->'revision'
   OR form->'scope' IS DISTINCT FROM record->'scope' OR form->'action_consents' IS DISTINCT FROM record->'action_consents'
   OR form->'runtime_session_ref' IS DISTINCT FROM record->'runtime_session_ref'
   OR form->'account'->'account_ref' IS DISTINCT FROM record->'account'->'account_ref'
   OR form->'account'->'label' IS DISTINCT FROM record->'account'->'label'
   OR form->'input_expires_at' IS DISTINCT FROM record->'callback_expires_at'
   OR form->'authorization_origin' IS DISTINCT FROM record->'profile'->'authorization_origin'
   OR form->'created_at' IS DISTINCT FROM record->'created_at' OR form->'updated_at' IS DISTINCT FROM record->'updated_at'
   OR record->'callback_consumed' IS DISTINCT FROM 'true'::jsonb
   THEN RAISE EXCEPTION 'observation form connection pins mismatch';END IF;
  receipt:=jsonb_build_object('custody_generation',form->'receipt'->'custody_generation','receipt_digest',form->'receipt'->'digest');
 ELSE
  SELECT c.record INTO continuation FROM app_connection_consent_continuations c
   WHERE c.org_id=NEW.org_id AND c.owner_user_id=NEW.owner_user_id AND c.session_id=NEW.connection_session_id FOR SHARE;
  IF continuation IS NOT NULL THEN
   IF NOT deft_app_consent_continuation_valid(continuation)
    OR continuation->>'state' IS DISTINCT FROM 'connected'
    OR continuation->'activation_started' IS DISTINCT FROM 'true'::jsonb
    OR continuation->'review' IS NOT DISTINCT FROM 'null'::jsonb
    OR continuation->'session_id' IS DISTINCT FROM record->'session_id'
    OR continuation->'scope' IS DISTINCT FROM record->'scope'
    OR continuation->'profile' IS DISTINCT FROM record->'profile'
    OR continuation->'action_consents' IS DISTINCT FROM record->'action_consents'
    OR continuation->'result'->>'state' IS DISTINCT FROM 'connected'
    OR continuation->'result'->'account' IS DISTINCT FROM record->'account'
    OR continuation->'result'->'runtime_session_ref' IS DISTINCT FROM record->'runtime_session_ref'
    THEN RAISE EXCEPTION 'observation continuation connection pins mismatch';END IF;
   receipt:=jsonb_build_object('custody_generation',continuation->'result'->'custody_generation','receipt_digest',continuation->'result'->'receipt_digest');
  ELSE
   receipt:=COALESCE(record->'credential_repair'->'receipt',record->'upgrade'->'receipt',record->'reattachment'->'receipt','null'::jsonb);
  END IF;
 END IF;

 IF record IS NULL OR record->>'state' IS DISTINCT FROM 'connected' OR scope IS DISTINCT FROM record->'scope'
  OR NEW.snapshot->'connection'->'runtime_session_ref' IS DISTINCT FROM record->'runtime_session_ref'
  OR NEW.snapshot->'connection'->'account_ref' IS DISTINCT FROM record->'account'->'account_ref'
  OR NEW.snapshot->'connection'->'expected_custody_generation' IS DISTINCT FROM COALESCE(receipt->'custody_generation','null'::jsonb)
  OR NEW.snapshot->'connection'->'receipt_digest' IS DISTINCT FROM COALESCE(receipt->'receipt_digest','null'::jsonb)
  OR NOT deft_app_consent_snapshot_valid(NEW.snapshot,NEW.expires_at,NEW.created_at)
  THEN RAISE EXCEPTION 'observation connection pins mismatch';END IF;
 IF NEW.snapshot ? 'consent_lifetime' AND (TG_OP='INSERT' OR (OLD.state='proposed' AND NEW.state='active'))
  AND (NEW.snapshot->>'review_expires_at')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'observation review expired'; END IF;
 RETURN NEW;
END;$function$;

CREATE OR REPLACE FUNCTION public.guard_app_data_consent()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'proposed' THEN RAISE EXCEPTION 'App data consent must be reviewed first'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app_connection_sessions c WHERE c.org_id=NEW.org_id AND c.owner_user_id=NEW.owner_user_id AND c.session_id=NEW.connection_session_id
    AND c.record->>'state'='connected' AND c.record->'scope'=NEW.snapshot->'scope'
    AND c.record->>'runtime_session_ref'=NEW.snapshot->'connection'->>'runtime_session_ref'
    AND c.record->'account'->>'account_ref'=NEW.snapshot->'connection'->>'account_ref'
    AND c.revision=(NEW.snapshot->'connection'->>'session_revision')::integer) THEN
   RAISE EXCEPTION 'App data consent connection authority mismatch'; END IF;
 ELSE
  IF ROW(NEW.org_id,NEW.owner_user_id,NEW.consent_id,NEW.connection_session_id,NEW.store_key,NEW.consent_digest,NEW.snapshot,NEW.expires_at,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.org_id,OLD.owner_user_id,OLD.consent_id,OLD.connection_session_id,OLD.store_key,OLD.consent_digest,OLD.snapshot,OLD.expires_at,OLD.created_at)
   OR NOT (NEW.state=OLD.state OR OLD.state='proposed' AND NEW.state IN ('active','revoked') OR OLD.state='active' AND NEW.state='revoked') THEN
   RAISE EXCEPTION 'App data consent identity is immutable';
  END IF;
 END IF;
 IF NEW.snapshot ? 'consent_lifetime' AND (TG_OP='INSERT' OR (OLD.state='proposed' AND NEW.state='active'))
  AND (NEW.snapshot->>'review_expires_at')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'App data review expired'; END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.deft_app_local_job_snapshot_valid(s jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
BEGIN
 RETURN COALESCE(jsonb_typeof(s)='object'
 AND s ?& ARRAY['schema_version','scope','connection','store_key','operation_key','resource','record_authority','job']
 AND s-ARRAY['schema_version','scope','connection','store_key','operation_key','resource','record_authority','job']='{}'::jsonb
 AND s->>'schema_version'='deft.app_local_job_schedule.v1' AND public.deft_resource_observation_scope_valid(s->'scope')
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['store_key','operation_key']) k WHERE jsonb_typeof(s->k) IS DISTINCT FROM 'string' OR s->>k !~ '^[a-z][a-z0-9_]{0,47}$' OR s->>k IN ('constructor','prototype','__proto__'))
 AND jsonb_typeof(s->'connection')='object' AND (s->'connection') ?& ARRAY['session_id','runtime_session_ref','account_ref'] AND (s->'connection')-ARRAY['session_id','runtime_session_ref','account_ref']='{}'::jsonb
 AND s->'connection'->>'session_id' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
 AND s->'connection'->>'account_ref' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
 AND s->'connection'->>'runtime_session_ref' ~ '^[A-Za-z0-9_-]+$' AND length(s->'connection'->>'runtime_session_ref') BETWEEN 1 AND 512
 AND jsonb_typeof(s->'resource')='object' AND (s->'resource') ?& ARRAY['resource_key','record_id','content_digest'] AND (s->'resource')-ARRAY['resource_key','record_id','content_digest']='{}'::jsonb
 AND s->'resource'->>'resource_key'=s->'scope'->>'resource_key'
 AND s->'resource'->>'record_id' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
 AND s->'resource'->>'content_digest' ~ '^sha256:[a-f0-9]{64}$'
 AND jsonb_typeof(s->'record_authority')='object' AND (s->'record_authority') ?& ARRAY['consent_id','consent_digest','data_policy_digest','consent_expires_at'] AND (s->'record_authority')-ARRAY['consent_lifetime','consent_id','consent_digest','data_policy_digest','consent_expires_at']='{}'::jsonb
 AND s->'record_authority'->>'consent_id' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
 AND s->'record_authority'->>'consent_digest' ~ '^sha256:[a-f0-9]{64}$' AND s->'record_authority'->>'data_policy_digest' ~ '^sha256:[a-f0-9]{64}$'
 AND jsonb_typeof(s->'job')='object' AND (s->'job') ?& ARRAY['job_id','revision','job_digest','account_ref','custody_generation','due_at','expires_at'] AND (s->'job')-ARRAY['job_id','revision','job_digest','account_ref','custody_generation','due_at','expires_at']='{}'::jsonb
 AND s->'job'->>'job_id' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' AND s->'job'->>'job_digest' ~ '^sha256:[a-f0-9]{64}$' AND s->'job'->>'account_ref'=s->'connection'->>'account_ref'
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['revision','custody_generation']) k WHERE jsonb_typeof(s->'job'->k) IS DISTINCT FROM 'number' OR (s->'job'->>k)::numeric NOT BETWEEN 1 AND 2147483646 OR (s->'job'->>k)::numeric<>trunc((s->'job'->>k)::numeric))
 AND isfinite((s->'job'->>'due_at')::timestamptz) AND isfinite((s->'job'->>'expires_at')::timestamptz)
 AND (s->'job'->>'due_at')::timestamptz<(s->'job'->>'expires_at')::timestamptz
 AND (s->'job'->>'expires_at')::timestamptz<=LEAST(deft_app_consent_deadline(s->'scope'),deft_app_consent_deadline(s->'record_authority')),false);
EXCEPTION WHEN OTHERS THEN RETURN false;END;$function$;

CREATE OR REPLACE FUNCTION public.app_integration_invocation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE c jsonb; t jsonb; a jsonb;
BEGIN
 IF NEW.context->>'kind'='tool' THEN
  c:=NEW.context->'caller'; t:=NEW.context->'target'; a:=NEW.context->'envelope';
  IF octet_length(NEW.context::text)>32768 OR jsonb_typeof(c) IS DISTINCT FROM 'object' OR jsonb_typeof(t) IS DISTINCT FROM 'object' OR jsonb_typeof(a) IS DISTINCT FROM 'object'
   OR (NEW.context-ARRAY['kind','caller','target','envelope','input_digest','declaration_digest','field_digests','grant','authority_identity','authority_expires_at'])<>'{}'::jsonb
   OR (c-ARRAY['org_id','user_id','kind','principal_id','access_expires_at','authorization_version','conversation_id','employee_id'])<>'{}'::jsonb
   OR (t-ARRAY['installation_id','account_ref','store_key','resource_binding_id'])<>'{}'::jsonb
   OR (a-ARRAY['request_id','scope','connection','authority','tool_key','tool_operation','store_key','expires_at','prepare_expires_at','source_refs'])<>'{}'::jsonb
   OR jsonb_typeof(a->'scope') IS DISTINCT FROM 'object' OR jsonb_typeof(a->'connection') IS DISTINCT FROM 'object' OR jsonb_typeof(a->'authority') IS DISTINCT FROM 'object'
   OR ((a->'scope')-ARRAY['consent_lifetime','org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','package_digest','grant_snapshot_digest','lifecycle_epoch','grant_epoch','target_key','resource_key','resource_binding_id','runtime_registration_id','operator_user_id','runtime_epoch','profile_digest','consent_expires_at'])<>'{}'::jsonb
   OR ((a->'connection')-ARRAY['session_id','session_revision','runtime_session_ref','account_ref'])<>'{}'::jsonb
   OR ((a->'authority')-ARRAY['consent_id','consent_digest','data_policy_digest'])<>'{}'::jsonb
   OR ((NEW.context->'grant')-ARRAY['id','revision','digest'])<>'{}'::jsonb
   OR NOT deft_app_consent_valid(a->'scope')
   OR jsonb_typeof(a->'source_refs') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'source_refs')>25
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->'source_refs') ref WHERE jsonb_typeof(ref)<>'object' OR (ref-ARRAY['resource_key','record_id','content_digest'])<>'{}'::jsonb)
   OR c->>'org_id' IS DISTINCT FROM NEW.org_id OR c->>'user_id' IS DISTINCT FROM NEW.owner_user_id
   OR c->>'kind' IS DISTINCT FROM NEW.principal_kind OR NEW.principal_kind NOT IN ('defty','personal_mcp')
   OR c->>'principal_id' IS DISTINCT FROM NEW.principal_id OR t->>'installation_id' IS DISTINCT FROM NEW.installation_id
   OR a->>'request_id' IS DISTINCT FROM NEW.request_id::text OR NEW.purpose IS DISTINCT FROM 'tool_'||(a->>'tool_operation')
   OR NEW.operation IS DISTINCT FROM 'tool:'||(a->>'tool_key') OR NEW.input_digest IS DISTINCT FROM NEW.context->>'input_digest'
   OR NEW.authority_identity IS DISTINCT FROM NEW.context->>'authority_identity'
   OR NEW.authority_expires_at IS DISTINCT FROM to_timestamp((NEW.context->>'authority_expires_at')::double precision/1000)
   OR a->'scope'->>'org_id' IS DISTINCT FROM NEW.org_id OR a->'scope'->>'owner_user_id' IS DISTINCT FROM NEW.owner_user_id
   OR a->'scope'->>'installation_id' IS DISTINCT FROM NEW.installation_id OR a->'scope'->>'resource_binding_id' IS DISTINCT FROM t->>'resource_binding_id'
   OR a->'connection'->>'account_ref' IS DISTINCT FROM t->>'account_ref' OR a->>'store_key' IS DISTINCT FROM t->>'store_key'
   OR a->'authority'->>'consent_id' IS DISTINCT FROM NEW.context->'grant'->>'id'
   OR a->'authority'->>'consent_digest' IS DISTINCT FROM NEW.context->'grant'->>'digest'
   OR (a->>'expires_at')::timestamptz IS DISTINCT FROM NEW.expires_at
   OR jsonb_typeof(NEW.context->'field_digests') IS DISTINCT FROM 'object'
   OR EXISTS(SELECT 1 FROM jsonb_each_text(NEW.context->'field_digests') v WHERE v.value !~ '^sha256:[a-f0-9]{64}$') THEN
   RAISE EXCEPTION 'Invalid delegated tool metadata';
  END IF;
  IF NEW.prepared_locator IS NOT NULL THEN
   IF NEW.state<>'completed' OR NEW.purpose NOT IN ('tool_triage','tool_send') OR jsonb_typeof(NEW.prepared_locator)<>'object'
    OR NOT (NEW.prepared_locator ?& ARRAY['kind','snapshot_id','snapshot_digest','action_key','input_digest','expires_at'])
    OR NEW.prepared_locator->>'snapshot_id' IS DISTINCT FROM NEW.request_id::text
    OR (NEW.prepared_locator-ARRAY['kind','snapshot_id','snapshot_digest','action_key','input_digest','record_id','revision','expires_at'])<>'{}'::jsonb
    OR NEW.prepared_locator->>'kind' NOT IN ('record','resource') OR (NEW.prepared_locator->>'snapshot_digest') !~ '^sha256:[a-f0-9]{64}$'
    OR (NEW.prepared_locator->>'input_digest') !~ '^sha256:[a-f0-9]{64}$'
    OR (NEW.prepared_locator->>'expires_at')::timestamptz>NEW.authority_expires_at
    OR (NEW.prepared_locator->>'kind'='record') IS DISTINCT FROM (NEW.prepared_locator ?& ARRAY['record_id','revision']) THEN RAISE EXCEPTION 'Invalid tool preparation'; END IF;
  END IF;
  IF TG_OP='INSERT' THEN
   IF NEW.state<>'inflight' OR NEW.revision<>1 OR NEW.prepared_locator IS NOT NULL OR NEW.accepted_run_id IS NOT NULL OR NEW.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Invalid initial tool invocation'; END IF;
   IF NOT EXISTS(SELECT 1 FROM app_integration_principal_grants g WHERE g.id::text=NEW.context->'grant'->>'id' AND g.org_id=NEW.org_id AND g.owner_user_id=NEW.owner_user_id
    AND g.installation_id=NEW.installation_id AND g.resource_binding_id=t->>'resource_binding_id' AND g.account_ref=t->>'account_ref' AND g.store_key=t->>'store_key'
    AND g.principal_kind=NEW.principal_kind AND g.principal_id=NEW.principal_id AND g.revision=(NEW.context->'grant'->>'revision')::integer
    AND g.operations @> ARRAY[a->>'tool_operation'] AND g.revoked_at IS NULL AND g.expires_at>=NEW.authority_expires_at) THEN RAISE EXCEPTION 'Tool original grant mismatch'; END IF;
  ELSE
   IF NEW.revision<>OLD.revision+1 OR (to_jsonb(NEW)-ARRAY['state','revision','updated_at','prepared_locator','accepted_run_id','accepted_input_digest','accepted_runtime_binding_id'])
     IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','updated_at','prepared_locator','accepted_run_id','accepted_input_digest','accepted_runtime_binding_id'])
    OR NOT ((OLD.state='inflight' AND NEW.state IN ('completed','indeterminate') AND NEW.accepted_run_id IS NULL)
     OR (OLD.state='completed' AND NEW.state='completed' AND OLD.prepared_locator IS NOT NULL AND OLD.accepted_run_id IS NULL AND NEW.accepted_run_id IS NOT NULL AND NEW.prepared_locator=OLD.prepared_locator)) THEN
    RAISE EXCEPTION 'Tool invocation immutable or terminal';
   END IF;
  END IF;
  IF NEW.accepted_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_runs r WHERE r.org_id=NEW.org_id AND r.id=NEW.accepted_run_id
   AND r.initiating_actor_type='human' AND r.initiating_actor_id=NEW.owner_user_id AND r.execution_actor_type='human' AND r.execution_actor_id=NEW.owner_user_id
   AND r.origin_kind='app' AND r.provider_kind='app_runtime' AND r.origin_app_installation_id=NEW.installation_id
   AND r.origin_runtime_binding_id=NEW.accepted_runtime_binding_id AND r.operation_name=NEW.prepared_locator->>'action_key'
   AND r.origin_app_version_id=a->'scope'->>'app_version_id' AND r.origin_app_grant_snapshot_id=a->'scope'->>'grant_snapshot_id') THEN
   RAISE EXCEPTION 'Tool Run identity mismatch';
  END IF;
  RETURN NEW;
 END IF;
 c:=NEW.context->'caller'; t:=NEW.context->'target'; a:=NEW.context->'authority';
 IF NEW.prepared_locator IS NOT NULL OR NEW.accepted_run_id IS NOT NULL THEN RAISE EXCEPTION 'Source invocation cannot authorize a Run'; END IF;
 IF octet_length(NEW.context::text)>32768 OR jsonb_typeof(c)<>'object' OR jsonb_typeof(t)<>'object' OR jsonb_typeof(a)<>'object'
  OR (NEW.context-ARRAY['caller','target','authority'])<>'{}'::jsonb
  OR (c-ARRAY['org_id','user_id','kind','principal_id','access_expires_at','authorization_version','conversation_id','employee_id','capture_delivery','notification_delivery'])<>'{}'::jsonb
  OR (t-ARRAY['installation_id','account_ref','store_key'])<>'{}'::jsonb
  OR (a-ARRAY['schema_version','request_id','scope','connection','authority','operation','expires_at','input_digest'])<>'{}'::jsonb
  OR c->>'org_id' IS DISTINCT FROM NEW.org_id OR c->>'user_id' IS DISTINCT FROM NEW.owner_user_id
  OR (NEW.principal_kind='notification_policy') IS DISTINCT FROM (NEW.purpose='notification_projection')
  OR (NEW.principal_kind='capture_policy') IS DISTINCT FROM (NEW.purpose='knowledge_capture')
  OR NEW.purpose='notification_projection' AND (NEW.operation<>'resource_read_metadata' OR jsonb_typeof(c->'notification_delivery') IS DISTINCT FROM 'object' OR c ? 'capture_delivery')
  OR c ? 'notification_delivery' AND ((c->'notification_delivery')-ARRAY['job_id','lock_token','policy_revision'])<>'{}'::jsonb
  OR c ? 'capture_delivery' AND ((c->'capture_delivery')-ARRAY['job_id','lock_token','policy_revision'])<>'{}'::jsonb
  OR c->>'kind' IS DISTINCT FROM NEW.principal_kind OR c->>'principal_id' IS DISTINCT FROM NEW.principal_id
  OR t->>'installation_id' IS DISTINCT FROM NEW.installation_id
  OR a->>'request_id' IS DISTINCT FROM NEW.request_id::text OR a->>'operation' IS DISTINCT FROM NEW.operation
  OR a->>'input_digest' IS DISTINCT FROM NEW.input_digest OR a->>'schema_version'<>'deft.app_data_authority.v1'
  OR a->'scope'->>'org_id' IS DISTINCT FROM NEW.org_id OR a->'scope'->>'owner_user_id' IS DISTINCT FROM NEW.owner_user_id
  OR a->'scope'->>'installation_id' IS DISTINCT FROM NEW.installation_id
  OR a->'connection'->>'account_ref' IS DISTINCT FROM t->>'account_ref'
  OR (a->>'expires_at')::timestamptz IS DISTINCT FROM NEW.expires_at
  OR NEW.expires_at<=NEW.created_at OR NEW.authority_expires_at<=NEW.created_at THEN
  RAISE EXCEPTION 'Invalid integration invocation metadata';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'inflight' OR NEW.revision<>1 OR NEW.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Invalid initial integration invocation'; END IF;
 ELSE
  IF OLD.state<>'inflight' OR NEW.state NOT IN ('completed','indeterminate') OR NEW.revision<>OLD.revision+1
   OR (to_jsonb(NEW)-ARRAY['state','revision','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','updated_at']) THEN
   RAISE EXCEPTION 'Integration invocation immutable or terminal';
  END IF;
 END IF;
 RETURN NEW;
END $function$;

DROP TRIGGER app_runtime_session_guard_trigger ON app_runtime_sessions;
CREATE TRIGGER app_runtime_session_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON app_runtime_sessions FOR EACH ROW EXECUTE FUNCTION enforce_app_runtime_session();

ALTER TABLE app_resource_bindings DROP CONSTRAINT app_resource_bindings_review_check;
ALTER TABLE app_resource_bindings ADD CONSTRAINT app_resource_bindings_review_check CHECK (((state='disabled' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL AND consent_expires_at IS NULL AND consent_lifetime IS NULL) OR (state IN ('active','revoked') AND reviewed_by_user_id=owner_user_id AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL AND ((consent_lifetime IS NULL AND consent_expires_at IS NOT NULL AND consent_expires_at>reviewed_at AND consent_expires_at<=reviewed_at+interval '90 days') OR (consent_lifetime='until_revoked' AND consent_expires_at IS NULL)))) IS TRUE);

ALTER TABLE app_runtime_sessions DROP CONSTRAINT app_runtime_sessions_renewal_check;
ALTER TABLE app_runtime_sessions ADD CONSTRAINT app_runtime_sessions_renewal_check CHECK (((renewal_lifetime IS NULL AND renewable_until IS NULL AND renewal_web_session_id IS NULL AND renewal_operator_role IS NULL) OR (renewal_web_session_id IS NOT NULL AND length(renewal_web_session_id)>0 AND renewal_operator_role IS NOT NULL AND renewal_operator_role IN ('owner','admin','member') AND ((renewal_lifetime IS NULL AND audience='app_runtime' AND renewable_until IS NOT NULL AND (expires_at AT TIME ZONE 'UTC')<=renewable_until AND renewable_until>(created_at AT TIME ZONE 'UTC')) OR (renewal_lifetime='until_revoked' AND audience IN ('app_runtime','app_resource_sync') AND renewable_until IS NULL AND isfinite(expires_at) AND isfinite(created_at) AND expires_at>created_at)))) IS TRUE);

ALTER TABLE app_data_consents DROP CONSTRAINT app_data_consents_identity_check;
ALTER TABLE app_data_consents ADD CONSTRAINT app_data_consents_identity_check CHECK ((jsonb_typeof(snapshot) = 'object'::text AND (snapshot ->> 'schema_version'::text) = 'deft.app_data_consent.v1'::text AND (snapshot ->> 'consent_id'::text) = consent_id AND ((snapshot -> 'scope'::text) ->> 'org_id'::text) = org_id AND ((snapshot -> 'scope'::text) ->> 'owner_user_id'::text) = owner_user_id AND ((snapshot -> 'connection'::text) ->> 'session_id'::text) = connection_session_id AND ((snapshot -> 'store'::text) ->> 'key'::text) = store_key AND (snapshot ->> 'purpose'::text) = 'human_record_write'::text AND consent_digest ~ '^sha256:[a-f0-9]{64}$'::text AND jsonb_typeof(snapshot -> 'scope'::text) = 'object'::text AND jsonb_typeof(snapshot -> 'connection'::text) = 'object'::text AND jsonb_typeof(snapshot -> 'store'::text) = 'object'::text AND (snapshot - 'schema_version'::text - 'consent_id'::text - 'scope'::text - 'connection'::text - 'store'::text - 'data_policy_digest'::text - 'purpose'::text - 'expires_at'::text - 'consent_lifetime'::text - 'review_expires_at'::text) = '{}'::jsonb AND snapshot ?& ARRAY['schema_version'::text, 'consent_id'::text, 'scope'::text, 'connection'::text, 'store'::text, 'data_policy_digest'::text, 'purpose'::text, 'expires_at'::text] AND (snapshot ->> 'data_policy_digest'::text) ~ '^sha256:[a-f0-9]{64}$'::text AND (snapshot -> 'connection'::text) ?& ARRAY['session_id'::text, 'session_revision'::text, 'runtime_session_ref'::text, 'account_ref'::text] AND ((snapshot -> 'connection'::text) - ARRAY['session_id'::text, 'session_revision'::text, 'runtime_session_ref'::text, 'account_ref'::text]) = '{}'::jsonb AND ((snapshot -> 'connection'::text) ->> 'runtime_session_ref'::text) ~ '^[A-Za-z0-9_-]+$'::text AND char_length((snapshot -> 'connection'::text) ->> 'runtime_session_ref'::text) >= 1 AND char_length((snapshot -> 'connection'::text) ->> 'runtime_session_ref'::text) <= 512 AND ((snapshot -> 'connection'::text) ->> 'account_ref'::text) ~ '^[A-Za-z0-9_-]+$'::text AND char_length((snapshot -> 'connection'::text) ->> 'account_ref'::text) >= 1 AND char_length((snapshot -> 'connection'::text) ->> 'account_ref'::text) <= 512 AND (((snapshot -> 'connection'::text) ->> 'session_revision'::text)::numeric) >= 1::numeric AND (((snapshot -> 'connection'::text) ->> 'session_revision'::text)::numeric) <= 2147483646::numeric AND isfinite(created_at) AND isfinite(updated_at) AND deft_app_consent_snapshot_valid(snapshot,expires_at,created_at)) IS TRUE);

ALTER TABLE app_resource_observation_consents DROP CONSTRAINT app_resource_observation_identity;
ALTER TABLE app_resource_observation_consents ADD CONSTRAINT app_resource_observation_identity CHECK ((jsonb_typeof(snapshot) = 'object'::text AND snapshot ?& ARRAY['schema_version'::text, 'consent_id'::text, 'scope'::text, 'connection'::text, 'resource_policy_digest'::text, 'interval_seconds'::text, 'expires_at'::text] AND (snapshot - ARRAY['consent_lifetime'::text, 'review_expires_at'::text, 'schema_version'::text, 'consent_id'::text, 'scope'::text, 'connection'::text, 'resource_policy_digest'::text, 'interval_seconds'::text, 'expires_at'::text]) = '{}'::jsonb AND (snapshot ->> 'schema_version'::text) = 'deft.app_resource_observation_consent.v1'::text AND (snapshot ->> 'consent_id'::text) = consent_id AND consent_id ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'::text AND deft_resource_observation_scope_valid(snapshot -> 'scope'::text) AND ((snapshot -> 'scope'::text) ->> 'org_id'::text) = org_id AND ((snapshot -> 'scope'::text) ->> 'owner_user_id'::text) = owner_user_id AND ((snapshot -> 'scope'::text) ->> 'resource_binding_id'::text) = resource_binding_id AND (snapshot ->> 'resource_policy_digest'::text) ~ '^sha256:[a-f0-9]{64}$'::text AND jsonb_typeof(snapshot -> 'interval_seconds'::text) = 'number'::text AND ((snapshot ->> 'interval_seconds'::text)::numeric) >= 60::numeric AND ((snapshot ->> 'interval_seconds'::text)::numeric) <= 86400::numeric AND ((snapshot ->> 'interval_seconds'::text)::numeric) = trunc((snapshot ->> 'interval_seconds'::text)::numeric) AND jsonb_typeof(snapshot -> 'connection'::text) = 'object'::text AND (snapshot -> 'connection'::text) ?& ARRAY['session_id'::text, 'runtime_session_ref'::text, 'account_ref'::text, 'expected_custody_generation'::text, 'receipt_digest'::text] AND ((snapshot -> 'connection'::text) - ARRAY['session_id'::text, 'runtime_session_ref'::text, 'account_ref'::text, 'expected_custody_generation'::text, 'receipt_digest'::text]) = '{}'::jsonb AND ((snapshot -> 'connection'::text) ->> 'session_id'::text) = connection_session_id AND ((snapshot -> 'connection'::text) ->> 'runtime_session_ref'::text) ~ '^[A-Za-z0-9_-]+$'::text AND length((snapshot -> 'connection'::text) ->> 'runtime_session_ref'::text) >= 1 AND length((snapshot -> 'connection'::text) ->> 'runtime_session_ref'::text) <= 512 AND ((snapshot -> 'connection'::text) ->> 'account_ref'::text) ~ '^[A-Za-z0-9_-]+$'::text AND length((snapshot -> 'connection'::text) ->> 'account_ref'::text) >= 1 AND length((snapshot -> 'connection'::text) ->> 'account_ref'::text) <= 512 AND (((snapshot -> 'connection'::text) -> 'expected_custody_generation'::text) = 'null'::jsonb AND ((snapshot -> 'connection'::text) -> 'receipt_digest'::text) = 'null'::jsonb OR jsonb_typeof((snapshot -> 'connection'::text) -> 'expected_custody_generation'::text) = 'number'::text AND (((snapshot -> 'connection'::text) ->> 'expected_custody_generation'::text)::numeric) >= 1::numeric AND (((snapshot -> 'connection'::text) ->> 'expected_custody_generation'::text)::numeric) <= 2147483646::numeric AND (((snapshot -> 'connection'::text) ->> 'expected_custody_generation'::text)::numeric) = trunc(((snapshot -> 'connection'::text) ->> 'expected_custody_generation'::text)::numeric) AND ((snapshot -> 'connection'::text) ->> 'receipt_digest'::text) ~ '^sha256:[a-f0-9]{64}$'::text) AND deft_app_consent_snapshot_valid(snapshot,expires_at,created_at) AND isfinite(created_at) AND isfinite(updated_at) AND (expires_at IS NULL OR expires_at > created_at) AND updated_at >= created_at) IS TRUE);

ALTER TABLE app_data_invocations DROP CONSTRAINT app_data_invocations_identity_check;
ALTER TABLE app_data_invocations ADD CONSTRAINT app_data_invocations_identity_check CHECK ((jsonb_typeof(context) = 'object'::text AND (context ->> 'schema_version'::text) = 'deft.app_data_authority.v1'::text AND (context ->> 'request_id'::text) = request_id AND (context ->> 'operation'::text) = operation AND (context ->> 'input_digest'::text) = input_digest AND ((context -> 'scope'::text) ->> 'org_id'::text) = org_id AND ((context -> 'scope'::text) ->> 'owner_user_id'::text) = owner_user_id AND ((context -> 'connection'::text) ->> 'session_id'::text) = connection_session_id AND input_digest ~ '^sha256:[a-f0-9]{64}$'::text AND jsonb_typeof(context -> 'scope'::text) = 'object'::text AND jsonb_typeof(context -> 'connection'::text) = 'object'::text AND jsonb_typeof(context -> 'authority'::text) = 'object'::text AND (context - 'schema_version'::text - 'request_id'::text - 'scope'::text - 'connection'::text - 'authority'::text - 'operation'::text - 'input_digest'::text - 'expires_at'::text) = '{}'::jsonb AND context ?& ARRAY['schema_version'::text, 'request_id'::text, 'scope'::text, 'connection'::text, 'authority'::text, 'operation'::text, 'input_digest'::text, 'expires_at'::text] AND (context -> 'connection'::text) ?& ARRAY['session_id'::text, 'session_revision'::text, 'runtime_session_ref'::text, 'account_ref'::text] AND ((context -> 'connection'::text) - ARRAY['session_id'::text, 'session_revision'::text, 'runtime_session_ref'::text, 'account_ref'::text]) = '{}'::jsonb AND (context -> 'authority'::text) ?& ARRAY['consent_id'::text, 'consent_digest'::text, 'data_policy_digest'::text] AND ((context -> 'authority'::text) - ARRAY['consent_id'::text, 'consent_digest'::text, 'data_policy_digest'::text]) = '{}'::jsonb AND ((context -> 'authority'::text) ->> 'data_policy_digest'::text) ~ '^sha256:[a-f0-9]{64}$'::text AND (((context -> 'authority'::text) -> 'consent_id'::text) = 'null'::jsonb AND ((context -> 'authority'::text) -> 'consent_digest'::text) = 'null'::jsonb OR jsonb_typeof((context -> 'authority'::text) -> 'consent_id'::text) = 'string'::text AND ((context -> 'authority'::text) ->> 'consent_digest'::text) ~ '^sha256:[a-f0-9]{64}$'::text) AND ((context -> 'connection'::text) ->> 'runtime_session_ref'::text) ~ '^[A-Za-z0-9_-]+$'::text AND char_length((context -> 'connection'::text) ->> 'runtime_session_ref'::text) >= 1 AND char_length((context -> 'connection'::text) ->> 'runtime_session_ref'::text) <= 512 AND ((context -> 'connection'::text) ->> 'account_ref'::text) ~ '^[A-Za-z0-9_-]+$'::text AND char_length((context -> 'connection'::text) ->> 'account_ref'::text) >= 1 AND char_length((context -> 'connection'::text) ->> 'account_ref'::text) <= 512 AND (((context -> 'connection'::text) ->> 'session_revision'::text)::numeric) >= 1::numeric AND (((context -> 'connection'::text) ->> 'session_revision'::text)::numeric) <= 2147483646::numeric AND isfinite(expires_at) AND isfinite(access_expires_at) AND isfinite(created_at) AND isfinite(updated_at) AND ((context ->> 'expires_at'::text)::timestamp with time zone) = expires_at AND expires_at <= access_expires_at AND expires_at <= deft_app_consent_deadline(context -> 'scope'::text) AND (operation <> ALL (ARRAY['record_prepare_change'::text, 'record_apply_change'::text])) OR jsonb_typeof(context) = 'object'::text AND (context ->> 'schema_version'::text) = 'deft.app_data_authority.v2'::text AND (operation = ANY (ARRAY['record_prepare_change'::text, 'record_apply_change'::text])) AND (context ->> 'request_id'::text) = request_id AND (context ->> 'operation'::text) = operation AND (context ->> 'input_digest'::text) = input_digest AND ((context -> 'scope'::text) ->> 'org_id'::text) = org_id AND ((context -> 'scope'::text) ->> 'owner_user_id'::text) = owner_user_id AND ((context -> 'connection'::text) ->> 'session_id'::text) = connection_session_id AND input_digest ~ '^sha256:[a-f0-9]{64}$'::text AND jsonb_typeof(context -> 'scope'::text) = 'object'::text AND jsonb_typeof(context -> 'connection'::text) = 'object'::text AND context ?& ARRAY['schema_version'::text, 'request_id'::text, 'scope'::text, 'connection'::text, 'record_authorities'::text, 'operation'::text, 'input_digest'::text, 'expires_at'::text] AND (context - ARRAY['schema_version'::text, 'request_id'::text, 'scope'::text, 'connection'::text, 'record_authorities'::text, 'operation'::text, 'input_digest'::text, 'expires_at'::text]) = '{}'::jsonb AND (context -> 'connection'::text) ?& ARRAY['session_id'::text, 'session_revision'::text, 'runtime_session_ref'::text, 'account_ref'::text] AND ((context -> 'connection'::text) - ARRAY['session_id'::text, 'session_revision'::text, 'runtime_session_ref'::text, 'account_ref'::text]) = '{}'::jsonb AND ((context -> 'connection'::text) ->> 'runtime_session_ref'::text) ~ '^[A-Za-z0-9_-]+$'::text AND char_length((context -> 'connection'::text) ->> 'runtime_session_ref'::text) >= 1 AND char_length((context -> 'connection'::text) ->> 'runtime_session_ref'::text) <= 512 AND ((context -> 'connection'::text) ->> 'account_ref'::text) ~ '^[A-Za-z0-9_-]+$'::text AND char_length((context -> 'connection'::text) ->> 'account_ref'::text) >= 1 AND char_length((context -> 'connection'::text) ->> 'account_ref'::text) <= 512 AND (((context -> 'connection'::text) ->> 'session_revision'::text)::numeric) >= 1::numeric AND (((context -> 'connection'::text) ->> 'session_revision'::text)::numeric) <= 2147483646::numeric AND isfinite(expires_at) AND isfinite(access_expires_at) AND isfinite(created_at) AND isfinite(updated_at) AND ((context ->> 'expires_at'::text)::timestamp with time zone) = expires_at AND expires_at <= access_expires_at AND expires_at <= deft_app_consent_deadline(context -> 'scope'::text) AND jsonb_typeof(context -> 'record_authorities'::text) = 'array'::text AND jsonb_array_length(context -> 'record_authorities'::text) = 2 AND (((context -> 'record_authorities'::text) -> 0) ->> 'role'::text) = 'destination'::text AND (((context -> 'record_authorities'::text) -> 1) ->> 'role'::text) = 'source'::text AND (((context -> 'record_authorities'::text) -> 0) ->> 'store_key'::text) <> (((context -> 'record_authorities'::text) -> 1) ->> 'store_key'::text) AND jsonb_typeof((context -> 'record_authorities'::text) -> 0) = 'object'::text AND ((context -> 'record_authorities'::text) -> 0) ?& ARRAY['role'::text, 'store_key'::text, 'consent_id'::text, 'consent_digest'::text, 'data_policy_digest'::text, 'consent_expires_at'::text] AND (((context -> 'record_authorities'::text) -> 0) - ARRAY['consent_lifetime'::text, 'role'::text, 'store_key'::text, 'consent_id'::text, 'consent_digest'::text, 'data_policy_digest'::text, 'consent_expires_at'::text]) = '{}'::jsonb AND (((context -> 'record_authorities'::text) -> 0) ->> 'store_key'::text) ~ '^[a-z][a-z0-9_]{0,47}$'::text AND ((((context -> 'record_authorities'::text) -> 0) ->> 'store_key'::text) <> ALL (ARRAY['constructor'::text, 'prototype'::text, '__proto__'::text])) AND (((context -> 'record_authorities'::text) -> 0) ->> 'consent_id'::text) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'::text AND (((context -> 'record_authorities'::text) -> 0) ->> 'consent_digest'::text) ~ '^sha256:[a-f0-9]{64}$'::text AND (((context -> 'record_authorities'::text) -> 0) ->> 'data_policy_digest'::text) ~ '^sha256:[a-f0-9]{64}$'::text AND deft_app_consent_valid((context -> 'record_authorities'::text) -> 0) AND expires_at <= deft_app_consent_deadline((context -> 'record_authorities'::text) -> 0) AND jsonb_typeof((context -> 'record_authorities'::text) -> 1) = 'object'::text AND ((context -> 'record_authorities'::text) -> 1) ?& ARRAY['role'::text, 'store_key'::text, 'consent_id'::text, 'consent_digest'::text, 'data_policy_digest'::text, 'consent_expires_at'::text] AND (((context -> 'record_authorities'::text) -> 1) - ARRAY['consent_lifetime'::text, 'role'::text, 'store_key'::text, 'consent_id'::text, 'consent_digest'::text, 'data_policy_digest'::text, 'consent_expires_at'::text]) = '{}'::jsonb AND (((context -> 'record_authorities'::text) -> 1) ->> 'store_key'::text) ~ '^[a-z][a-z0-9_]{0,47}$'::text AND ((((context -> 'record_authorities'::text) -> 1) ->> 'store_key'::text) <> ALL (ARRAY['constructor'::text, 'prototype'::text, '__proto__'::text])) AND (((context -> 'record_authorities'::text) -> 1) ->> 'consent_id'::text) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'::text AND (((context -> 'record_authorities'::text) -> 1) ->> 'consent_digest'::text) ~ '^sha256:[a-f0-9]{64}$'::text AND (((context -> 'record_authorities'::text) -> 1) ->> 'data_policy_digest'::text) ~ '^sha256:[a-f0-9]{64}$'::text AND deft_app_consent_valid((context -> 'record_authorities'::text) -> 1) AND expires_at <= deft_app_consent_deadline((context -> 'record_authorities'::text) -> 1)) IS TRUE);

ALTER TABLE app_connection_sessions DROP CONSTRAINT app_connection_sessions_record_identity;
ALTER TABLE app_connection_sessions ADD CONSTRAINT app_connection_sessions_record_identity CHECK (
CASE
    WHEN record ? 'credential_repair'::text THEN (deft_app_connection_credential_repair_record_valid(record) AND (record ->> 'session_id'::text) = session_id AND ((record ->> 'revision'::text)::integer) = revision AND ((record -> 'scope'::text) ->> 'org_id'::text) = org_id AND ((record -> 'scope'::text) ->> 'owner_user_id'::text) = owner_user_id) IS TRUE
    ELSE (jsonb_typeof(record) = 'object'::text AND record ?& ARRAY['session_id'::text, 'revision'::text, 'scope'::text, 'profile'::text, 'state'::text, 'callback_state_hash'::text, 'callback_consumed'::text, 'callback_expires_at'::text, 'runtime_session_ref'::text, 'account'::text, 'created_at'::text, 'updated_at'::text] AND (record - ARRAY['session_id'::text, 'revision'::text, 'scope'::text, 'profile'::text, 'state'::text, 'callback_state_hash'::text, 'callback_consumed'::text, 'callback_expires_at'::text, 'runtime_session_ref'::text, 'account'::text, 'created_at'::text, 'updated_at'::text, 'action_consent'::text, 'reattachment'::text, 'action_consents'::text, 'upgrade'::text]) = '{}'::jsonb AND jsonb_typeof(record -> 'scope'::text) = 'object'::text AND jsonb_typeof(record -> 'profile'::text) = 'object'::text AND (record -> 'scope'::text) ?& ARRAY['org_id'::text, 'owner_user_id'::text] AND (record ->> 'session_id'::text) = session_id AND ((record ->> 'revision'::text)::integer) = revision AND ((record -> 'scope'::text) ->> 'org_id'::text) = org_id AND ((record -> 'scope'::text) ->> 'owner_user_id'::text) = owner_user_id AND (record ->> 'callback_state_hash'::text) ~ '^[a-f0-9]{64}$'::text AND jsonb_typeof(record -> 'callback_consumed'::text) = 'boolean'::text AND (NOT record ? 'action_consent'::text OR jsonb_typeof(record -> 'action_consent'::text) = 'object'::text AND (record -> 'action_consent'::text) ?& ARRAY['action_binding_id'::text, 'action_key'::text, 'authority_epoch'::text, 'consent_id'::text, 'consent_digest'::text, 'expires_at'::text] AND ((record -> 'action_consent'::text) - ARRAY['consent_lifetime'::text, 'action_binding_id'::text, 'action_key'::text, 'authority_epoch'::text, 'consent_id'::text, 'consent_digest'::text, 'expires_at'::text]) = '{}'::jsonb AND ((record -> 'action_consent'::text) ->> 'action_binding_id'::text) ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'::text AND ((record -> 'action_consent'::text) ->> 'consent_id'::text) = ((record -> 'action_consent'::text) ->> 'action_binding_id'::text) AND ((record -> 'action_consent'::text) ->> 'action_key'::text) ~ '^[a-z][a-z0-9_]{0,47}$'::text AND jsonb_typeof((record -> 'action_consent'::text) -> 'authority_epoch'::text) = 'number'::text AND (((record -> 'action_consent'::text) ->> 'authority_epoch'::text)::numeric) >= 0::numeric AND (((record -> 'action_consent'::text) ->> 'authority_epoch'::text)::numeric) <= 2147483647::numeric AND (((record -> 'action_consent'::text) ->> 'authority_epoch'::text)::numeric) = trunc(((record -> 'action_consent'::text) ->> 'authority_epoch'::text)::numeric) AND ((record -> 'action_consent'::text) ->> 'consent_digest'::text) ~ '^sha256:[a-f0-9]{64}$'::text AND deft_app_consent_valid(record -> 'action_consent'::text,'expires_at') AND deft_app_consent_deadline(record -> 'action_consent'::text,'expires_at') <= deft_app_consent_deadline(record -> 'scope'::text)) AND (((record ->> 'state'::text) = ANY (ARRAY['starting'::text, 'awaiting_callback'::text, 'connecting'::text, 'checking'::text, 'disconnecting'::text, 'connected'::text, 'not_connected'::text, 'disconnected'::text, 'indeterminate'::text])) OR record ? 'reattachment'::text AND ((record ->> 'state'::text) = ANY (ARRAY['reattach_reviewed'::text, 'reattaching'::text, 'reattach_checking'::text])) OR record ? 'upgrade'::text AND ((record ->> 'state'::text) = ANY (ARRAY['upgrade_reviewed'::text, 'upgrade_starting'::text, 'upgrade_checking'::text]))) AND (NOT record ? 'action_consents'::text OR NOT record ? 'action_consent'::text AND deft_app_connection_actions_v2_valid(record -> 'action_consents'::text, record -> 'scope'::text)) AND (NOT record ? 'upgrade'::text OR NOT record ? 'reattachment'::text AND record ? 'action_consents'::text AND deft_app_connection_upgrade_valid(record -> 'upgrade'::text, record -> 'scope'::text)) AND deft_app_connection_reattachment_valid(record -> 'reattachment'::text, record -> 'scope'::text) AND (NOT record ? 'reattachment'::text OR ((record ->> 'state'::text) <> ALL (ARRAY['awaiting_callback'::text, 'connecting'::text])))) IS TRUE
END);

