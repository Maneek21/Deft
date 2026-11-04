-- Grace-resume for lapsed `until_revoked` runtime leases. A background lease that
-- expires may be resumed exactly once within the fixed 24-hour grace window by
-- extending only the lease expiry; every authority column stays unchanged. This
-- never widens the 15-minute rolling ceiling, never revives a revoked session,
-- and never moves an expiry backwards.
CREATE OR REPLACE FUNCTION public.app_runtime_session_resume_allowed(previous app_runtime_sessions, resumed app_runtime_sessions)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- COALESCE: a NULL renewal_lifetime (every finite session) must yield false.
  -- A NULL here would make the guard's NOT ...() NULL and silently allow an
  -- expired finite session's expiry to be extended.
  RETURN COALESCE(previous.renewal_lifetime = 'until_revoked'
    AND previous.renewable_until IS NULL
    AND previous.revoked_at IS NULL
    AND resumed.revoked_at IS NULL
    AND (previous.expires_at AT TIME ZONE 'UTC') <= clock_timestamp()
    AND (previous.expires_at AT TIME ZONE 'UTC') > clock_timestamp() - interval '24 hours'
    AND resumed.expires_at > previous.expires_at
    AND (resumed.expires_at AT TIME ZONE 'UTC') > clock_timestamp()
    AND (resumed.expires_at AT TIME ZONE 'UTC') <= clock_timestamp() + interval '15 minutes', false);
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
      OR (NEW.expires_at IS DISTINCT FROM OLD.expires_at AND NOT public.app_runtime_session_resume_allowed(OLD, NEW) AND (
        (OLD.renewable_until IS NULL AND OLD.renewal_lifetime IS DISTINCT FROM 'until_revoked') OR (OLD.expires_at AT TIME ZONE 'UTC') <= clock_timestamp()
        OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NOT NULL
        OR NEW.expires_at < OLD.expires_at OR (OLD.renewal_lifetime IS NULL AND (NEW.expires_at AT TIME ZONE 'UTC') > OLD.renewable_until)
        OR (NEW.expires_at AT TIME ZONE 'UTC') > clock_timestamp() + interval '15 minutes'))
    THEN RAISE EXCEPTION 'APP_RUNTIME_IMMUTABLE_FIELD' USING ERRCODE = '55000'; END IF;
  END IF;
  RETURN NEW;
END; $function$;
