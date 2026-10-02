-- Additive retained public control; no legacy authority or ciphertext rewrite.
ALTER TABLE app_public_endpoints ADD COLUMN IF NOT EXISTS cancellation_policy jsonb;
ALTER TABLE app_public_endpoints ADD COLUMN IF NOT EXISTS cancel_native_binding_id text GENERATED ALWAYS AS (cancellation_policy->>'cancel_native_binding_id') STORED;
ALTER TABLE app_public_endpoints DROP CONSTRAINT IF EXISTS app_public_endpoints_cancel_binding_fk;
ALTER TABLE app_public_endpoints ADD CONSTRAINT app_public_endpoints_cancel_binding_fk
  FOREIGN KEY(org_id,app_installation_id,app_version_id,grant_snapshot_id,cancel_native_binding_id,approver_user_id)
  REFERENCES app_native_bindings(org_id,app_installation_id,app_version_id,grant_snapshot_id,id,owner_user_id) ON DELETE RESTRICT;
ALTER TABLE app_canonical_claims ADD COLUMN IF NOT EXISTS control_digest text;
ALTER TABLE app_canonical_claims ADD COLUMN IF NOT EXISTS control_expires_at timestamp;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='app_public_endpoints'::regclass AND conname='app_public_endpoints_app_id_unique') THEN
    ALTER TABLE app_public_endpoints ADD CONSTRAINT app_public_endpoints_app_id_unique UNIQUE(org_id,app_installation_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='app_canonical_claims'::regclass AND conname='app_canonical_claims_endpoint_id_unique') THEN
    ALTER TABLE app_canonical_claims ADD CONSTRAINT app_canonical_claims_endpoint_id_unique UNIQUE(org_id,endpoint_id,id);
  END IF;
END $$;
ALTER TABLE app_public_endpoints DROP CONSTRAINT IF EXISTS app_public_endpoints_cancellation_policy_check;
ALTER TABLE app_public_endpoints ADD CONSTRAINT app_public_endpoints_cancellation_policy_check CHECK (
  cancellation_policy IS NULL OR COALESCE((native_binding_id IS NOT NULL AND runtime_binding_id IS NULL
    AND jsonb_typeof(cancellation_policy)='object' AND octet_length(cancellation_policy::text)<=1024
    AND cancellation_policy->>'schema_version'='deft.app_public_cancellation_policy.v1'
    AND jsonb_typeof(cancellation_policy->'control_ttl_seconds')='number'
    AND (cancellation_policy->>'control_ttl_seconds')::numeric BETWEEN 1 AND 604800
    AND (cancellation_policy->>'control_ttl_seconds')::numeric=trunc((cancellation_policy->>'control_ttl_seconds')::numeric)
    AND cancellation_policy->>'cancel_native_binding_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    AND cancellation_policy->>'expected_cancel_consent_digest' ~ '^sha256:[a-f0-9]{64}$'
    AND cancellation_policy-ARRAY['schema_version','control_ttl_seconds','cancel_native_binding_id','expected_cancel_consent_digest']='{}'::jsonb),false)
);
ALTER TABLE app_canonical_claims DROP CONSTRAINT IF EXISTS app_canonical_claims_control_check;
ALTER TABLE app_canonical_claims ADD CONSTRAINT app_canonical_claims_control_check CHECK (
  (control_digest IS NULL AND control_expires_at IS NULL) OR COALESCE((control_digest ~ '^sha256:[a-f0-9]{64}$'
    AND control_expires_at IS NOT NULL AND budget_reserved_at IS NOT NULL
    AND control_expires_at > budget_reserved_at AND control_expires_at <= budget_reserved_at+interval '7 days'),false)
);
CREATE TABLE IF NOT EXISTS app_public_cancellations (
  id text PRIMARY KEY, org_id text NOT NULL, app_installation_id text NOT NULL,
  endpoint_id text NOT NULL, claim_id text NOT NULL, original_run_id text,
  request_key_digest text NOT NULL, state text NOT NULL, accepted_at timestamp NOT NULL, settled_at timestamp,
  CONSTRAINT app_public_cancellations_claim_fk FOREIGN KEY(org_id,endpoint_id,claim_id)
    REFERENCES app_canonical_claims(org_id,endpoint_id,id) ON DELETE RESTRICT,
  CONSTRAINT app_public_cancellations_endpoint_fk FOREIGN KEY(org_id,app_installation_id,endpoint_id)
    REFERENCES app_public_endpoints(org_id,app_installation_id,id) ON DELETE RESTRICT,
  CONSTRAINT app_public_cancellations_run_fk FOREIGN KEY(org_id,original_run_id) REFERENCES app_runs(org_id,id) ON DELETE RESTRICT,
  CONSTRAINT app_public_cancellations_claim_unique UNIQUE(org_id,claim_id),
  CONSTRAINT app_public_cancellations_key_check CHECK(request_key_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT app_public_cancellations_state_check CHECK(state IN ('released_before_effect','withdrawal_requested','cancellation_unavailable')
    AND ((state='withdrawal_requested' AND settled_at IS NULL) OR (state<>'withdrawal_requested' AND settled_at IS NOT NULL AND settled_at>=accepted_at)))
);
CREATE INDEX IF NOT EXISTS app_public_cancellations_app_accepted_idx ON app_public_cancellations(org_id,app_installation_id,accepted_at);
CREATE OR REPLACE FUNCTION enforce_app_public_control_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.control_digest IS NOT NULL AND (NEW.control_digest IS DISTINCT FROM OLD.control_digest
    OR NEW.control_expires_at IS DISTINCT FROM OLD.control_expires_at) THEN
    RAISE EXCEPTION 'APP_PUBLIC_CONTROL_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_public_control_immutable ON app_canonical_claims;
CREATE TRIGGER app_public_control_immutable BEFORE UPDATE ON app_canonical_claims FOR EACH ROW EXECUTE FUNCTION enforce_app_public_control_immutable();
CREATE OR REPLACE FUNCTION enforce_app_public_cancellation_policy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.cancellation_policy IS DISTINCT FROM OLD.cancellation_policy THEN
    RAISE EXCEPTION 'APP_PUBLIC_CANCELLATION_POLICY_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_public_cancellation_policy_immutable ON app_public_endpoints;
CREATE TRIGGER app_public_cancellation_policy_immutable BEFORE UPDATE ON app_public_endpoints
  FOR EACH ROW EXECUTE FUNCTION enforce_app_public_cancellation_policy_immutable();
CREATE OR REPLACE FUNCTION enforce_app_public_cancellation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'APP_PUBLIC_CANCELLATION_RETAINED'; END IF;
  IF ROW(NEW.id,NEW.org_id,NEW.app_installation_id,NEW.endpoint_id,NEW.claim_id,NEW.original_run_id,NEW.request_key_digest,NEW.accepted_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.org_id,OLD.app_installation_id,OLD.endpoint_id,OLD.claim_id,OLD.original_run_id,OLD.request_key_digest,OLD.accepted_at) THEN
    RAISE EXCEPTION 'APP_PUBLIC_CANCELLATION_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_public_cancellation_immutable ON app_public_cancellations;
CREATE TRIGGER app_public_cancellation_immutable BEFORE UPDATE OR DELETE ON app_public_cancellations
  FOR EACH ROW EXECUTE FUNCTION enforce_app_public_cancellation_immutable();
ALTER TABLE app_public_ingress DROP CONSTRAINT IF EXISTS app_public_ingress_follow_up_check;
ALTER TABLE app_public_ingress ADD CONSTRAINT app_public_ingress_follow_up_check CHECK (
  (follow_up_state='pending' AND follow_up_code IS NULL AND handled_at IS NULL)
  OR (follow_up_state='run_created' AND follow_up_code IS NULL AND handled_at IS NOT NULL)
  OR (follow_up_state='unsupported' AND follow_up_code IN ('APP_HANDLER_UNAVAILABLE','ENDPOINT_REVOKED','PUBLIC_WITHDRAWN') AND handled_at IS NOT NULL)
);
