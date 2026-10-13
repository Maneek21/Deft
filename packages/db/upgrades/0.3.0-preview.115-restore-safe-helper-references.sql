-- Candidate append-only115: exact actual111 CHECK helper qualification only.
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
 IF (r->>'input_expires_at')::timestamptz>(r->>'created_at')::timestamptz+interval '5 minutes' OR (r->>'input_expires_at')::timestamptz>(s->>'consent_expires_at')::timestamptz OR (r->>'updated_at')::timestamptz<(r->>'created_at')::timestamptz THEN RETURN false; END IF;
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
END; $function$
;

CREATE OR REPLACE FUNCTION public.deft_app_connection_upgrade_valid(r jsonb, current_scope jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
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
  RETURN public.deft_app_connection_reattachment_valid(
    (r-ARRAY['begin_consumed','closure'])||jsonb_build_object('schema_version','deft.app_connection_reattachment.v1'),
    current_scope||jsonb_build_object('profile_digest',r->'source'->'scope'->'profile_digest'));
END; $function$
;

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
 AND jsonb_typeof(s->'record_authority')='object' AND (s->'record_authority') ?& ARRAY['consent_id','consent_digest','data_policy_digest','consent_expires_at'] AND (s->'record_authority')-ARRAY['consent_id','consent_digest','data_policy_digest','consent_expires_at']='{}'::jsonb
 AND s->'record_authority'->>'consent_id' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'
 AND s->'record_authority'->>'consent_digest' ~ '^sha256:[a-f0-9]{64}$' AND s->'record_authority'->>'data_policy_digest' ~ '^sha256:[a-f0-9]{64}$'
 AND jsonb_typeof(s->'job')='object' AND (s->'job') ?& ARRAY['job_id','revision','job_digest','account_ref','custody_generation','due_at','expires_at'] AND (s->'job')-ARRAY['job_id','revision','job_digest','account_ref','custody_generation','due_at','expires_at']='{}'::jsonb
 AND s->'job'->>'job_id' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' AND s->'job'->>'job_digest' ~ '^sha256:[a-f0-9]{64}$' AND s->'job'->>'account_ref'=s->'connection'->>'account_ref'
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['revision','custody_generation']) k WHERE jsonb_typeof(s->'job'->k) IS DISTINCT FROM 'number' OR (s->'job'->>k)::numeric NOT BETWEEN 1 AND 2147483646 OR (s->'job'->>k)::numeric<>trunc((s->'job'->>k)::numeric))
 AND isfinite((s->'job'->>'due_at')::timestamptz) AND isfinite((s->'job'->>'expires_at')::timestamptz)
 AND (s->'job'->>'due_at')::timestamptz<(s->'job'->>'expires_at')::timestamptz
 AND (s->'job'->>'expires_at')::timestamptz<=LEAST((s->'scope'->>'consent_expires_at')::timestamptz,(s->'record_authority'->>'consent_expires_at')::timestamptz),false);
EXCEPTION WHEN OTHERS THEN RETURN false;END;$function$
;
