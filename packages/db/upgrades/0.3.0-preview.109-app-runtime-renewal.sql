-- Opt-in technical renewal. Existing credentials remain non-renewable.
ALTER TABLE app_runtime_sessions
  ADD COLUMN IF NOT EXISTS renewable_until timestamptz,
  ADD COLUMN IF NOT EXISTS renewal_web_session_id text,
  ADD COLUMN IF NOT EXISTS renewal_operator_role text;
ALTER TABLE app_runtime_sessions DROP CONSTRAINT IF EXISTS app_runtime_sessions_renewal_check;
ALTER TABLE app_runtime_sessions ADD CONSTRAINT app_runtime_sessions_renewal_check CHECK (
  (renewable_until IS NULL AND renewal_web_session_id IS NULL AND renewal_operator_role IS NULL)
  OR (audience = 'app_runtime' AND renewable_until IS NOT NULL
    AND renewal_web_session_id IS NOT NULL AND length(renewal_web_session_id) > 0
    AND renewal_operator_role IS NOT NULL AND renewal_operator_role IN ('owner','admin','member')
    AND (expires_at AT TIME ZONE 'UTC') <= renewable_until AND renewable_until > (created_at AT TIME ZONE 'UTC'))
);

CREATE OR REPLACE FUNCTION enforce_app_runtime_session() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APP_RUNTIME_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.org_id, NEW.runtime_registration_id, NEW.runtime_binding_id,
        NEW.operator_user_id, NEW.token_hash, NEW.audience, NEW.session_epoch,
        NEW.runtime_epoch, NEW.lifecycle_epoch, NEW.grant_epoch, NEW.created_at,
        NEW.renewable_until, NEW.renewal_web_session_id, NEW.renewal_operator_role) IS DISTINCT FROM
       (OLD.org_id, OLD.runtime_registration_id, OLD.runtime_binding_id,
        OLD.operator_user_id, OLD.token_hash, OLD.audience, OLD.session_epoch,
        OLD.runtime_epoch, OLD.lifecycle_epoch, OLD.grant_epoch, OLD.created_at,
        OLD.renewable_until, OLD.renewal_web_session_id, OLD.renewal_operator_role)
      OR NEW.next_sequence < OLD.next_sequence
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
      OR (NEW.expires_at IS DISTINCT FROM OLD.expires_at AND (
        OLD.renewable_until IS NULL OR (OLD.expires_at AT TIME ZONE 'UTC') <= clock_timestamp()
        OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NOT NULL
        OR NEW.expires_at < OLD.expires_at OR (NEW.expires_at AT TIME ZONE 'UTC') > OLD.renewable_until
        OR (NEW.expires_at AT TIME ZONE 'UTC') > clock_timestamp() + interval '15 minutes'))
    THEN RAISE EXCEPTION 'APP_RUNTIME_IMMUTABLE_FIELD' USING ERRCODE = '55000'; END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
