-- Recognize the existing owner-reviewed consent-continuation carrier.
-- Retains SQL104 form/legacy receipts and all identity/expiry/transition checks.
CREATE OR REPLACE FUNCTION deft_resource_observation_consent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
   receipt:=COALESCE(record->'upgrade'->'receipt',record->'reattachment'->'receipt','null'::jsonb);
  END IF;
 END IF;

 IF record IS NULL OR record->>'state' IS DISTINCT FROM 'connected' OR scope IS DISTINCT FROM record->'scope'
  OR NEW.snapshot->'connection'->'runtime_session_ref' IS DISTINCT FROM record->'runtime_session_ref'
  OR NEW.snapshot->'connection'->'account_ref' IS DISTINCT FROM record->'account'->'account_ref'
  OR NEW.snapshot->'connection'->'expected_custody_generation' IS DISTINCT FROM COALESCE(receipt->'custody_generation','null'::jsonb)
  OR NEW.snapshot->'connection'->'receipt_digest' IS DISTINCT FROM COALESCE(receipt->'receipt_digest','null'::jsonb)
  OR NOT COALESCE(isfinite((scope->>'consent_expires_at')::timestamptz) AND NEW.expires_at<=(scope->>'consent_expires_at')::timestamptz,false)
  THEN RAISE EXCEPTION 'observation connection pins mismatch';END IF;
 RETURN NEW;
END;$$;
