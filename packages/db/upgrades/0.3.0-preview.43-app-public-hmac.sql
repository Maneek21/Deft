ALTER TABLE app_public_endpoints ADD COLUMN IF NOT EXISTS authentication_policy jsonb;
ALTER TABLE app_public_endpoints ADD COLUMN IF NOT EXISTS hmac_key_id text;
CREATE TABLE IF NOT EXISTS app_public_hmac_keys (
  id text PRIMARY KEY, org_id text NOT NULL, endpoint_id text NOT NULL,
  sealed_secret text NOT NULL, created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_public_hmac_keys_endpoint_fk FOREIGN KEY(org_id,endpoint_id)
    REFERENCES app_public_endpoints(org_id,id) ON DELETE RESTRICT,
  CONSTRAINT app_public_hmac_keys_identity_unique UNIQUE(org_id,endpoint_id,id)
);
CREATE TABLE IF NOT EXISTS app_public_hmac_nonces (
  id text PRIMARY KEY, org_id text NOT NULL, endpoint_id text NOT NULL, key_id text NOT NULL,
  nonce_digest text NOT NULL, signed_at timestamp NOT NULL, accepted_at timestamp NOT NULL, expires_at timestamp NOT NULL,
  CONSTRAINT app_public_hmac_nonces_key_fk FOREIGN KEY(org_id,endpoint_id,key_id)
    REFERENCES app_public_hmac_keys(org_id,endpoint_id,id) ON DELETE RESTRICT,
  CONSTRAINT app_public_hmac_nonces_replay_unique UNIQUE(org_id,endpoint_id,key_id,nonce_digest)
);
CREATE INDEX IF NOT EXISTS app_public_hmac_nonces_expiry_idx ON app_public_hmac_nonces(org_id,endpoint_id,expires_at);
ALTER TABLE app_public_endpoints DROP CONSTRAINT IF EXISTS app_public_endpoints_hmac_policy_check;
ALTER TABLE app_public_endpoints ADD CONSTRAINT app_public_endpoints_hmac_policy_check CHECK (
  (authentication_policy IS NULL AND hmac_key_id IS NULL) OR COALESCE((
    authentication_policy IS NOT NULL AND hmac_key_id IS NOT NULL AND public_action_key IS NOT NULL
    AND jsonb_typeof(authentication_policy)='object' AND octet_length(authentication_policy::text)<=512
    AND authentication_policy->>'schema_version'='deft.app_public_hmac.v1'
    AND authentication_policy->>'mode'='hmac_sha256'
    AND authentication_policy->'max_clock_skew_seconds'='300'::jsonb
    AND authentication_policy-ARRAY['schema_version','mode','max_clock_skew_seconds']='{}'::jsonb
  ),false)
);
ALTER TABLE app_public_endpoints DROP CONSTRAINT IF EXISTS app_public_endpoints_hmac_key_fk;
ALTER TABLE app_public_endpoints ADD CONSTRAINT app_public_endpoints_hmac_key_fk FOREIGN KEY(org_id,id,hmac_key_id)
  REFERENCES app_public_hmac_keys(org_id,endpoint_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE app_public_hmac_nonces DROP CONSTRAINT IF EXISTS app_public_hmac_nonces_shape_check;
ALTER TABLE app_public_hmac_nonces ADD CONSTRAINT app_public_hmac_nonces_shape_check CHECK (
  nonce_digest ~ '^sha256:[a-f0-9]{64}$' AND expires_at=signed_at+interval '300 seconds'
  AND accepted_at BETWEEN signed_at-interval '300 seconds' AND expires_at
);
CREATE OR REPLACE FUNCTION enforce_app_public_hmac_key_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'APP_PUBLIC_HMAC_KEY_IMMUTABLE'; END $$;
DROP TRIGGER IF EXISTS app_public_hmac_key_immutable ON app_public_hmac_keys;
CREATE TRIGGER app_public_hmac_key_immutable BEFORE UPDATE OR DELETE ON app_public_hmac_keys
  FOR EACH ROW EXECUTE FUNCTION enforce_app_public_hmac_key_immutable();
