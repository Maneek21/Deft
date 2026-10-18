CREATE TABLE IF NOT EXISTS email_account_consents (
 org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,
 provider text NOT NULL,principal_digest text NOT NULL,revision integer NOT NULL,native_revision integer NOT NULL,credential_revision integer NOT NULL,
 state text NOT NULL,capabilities jsonb NOT NULL,bridge_digest text NOT NULL,bridge_envelope jsonb NOT NULL,
 consented_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,revoked_at timestamptz,
 CONSTRAINT email_account_consents_pkey PRIMARY KEY(org_id,owner_user_id,account_id),
 CONSTRAINT email_account_consents_account_fk FOREIGN KEY(org_id,owner_user_id,account_id) REFERENCES email_accounts(org_id,owner_user_id,account_id) ON DELETE RESTRICT,
 CONSTRAINT email_account_consents_provider_check CHECK(provider IN ('gmail','microsoft','imap_smtp')),
 CONSTRAINT email_account_consents_identity_check CHECK(principal_digest ~ '^[a-f0-9]{64}$' AND bridge_digest ~ '^[a-f0-9]{64}$'),
 CONSTRAINT email_account_consents_revision_check CHECK(revision>0 AND native_revision>0 AND credential_revision>0),
 CONSTRAINT email_account_consents_bridge_bound_check CHECK(octet_length(bridge_envelope::text)<=8192),
 CONSTRAINT email_account_consents_state_check CHECK(state IN ('active','paused','disconnected','revoked') AND ((state='revoked')=(revoked_at IS NOT NULL))),
 CONSTRAINT email_account_consents_capabilities_check CHECK(capabilities IN ('["read"]'::jsonb,'["modify","read"]'::jsonb,'["read","send"]'::jsonb,'["modify","read","send"]'::jsonb))
);
CREATE OR REPLACE FUNCTION enforce_email_account_consent_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Native Email consent retention requires explicit purge policy'; END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.org_id,NEW.owner_user_id,NEW.account_id,NEW.provider,NEW.principal_digest,NEW.bridge_digest) IS DISTINCT FROM (OLD.org_id,OLD.owner_user_id,OLD.account_id,OLD.provider,OLD.principal_digest,OLD.bridge_digest) THEN RAISE EXCEPTION 'Native Email consent identity is immutable'; END IF;
  IF NEW.revision<>OLD.revision+1 OR NEW.native_revision<=OLD.native_revision OR NEW.credential_revision<OLD.credential_revision OR NEW.updated_at<OLD.updated_at THEN RAISE EXCEPTION 'Native Email consent revision conflict'; END IF;
  IF OLD.state='revoked' THEN RAISE EXCEPTION 'Native Email consent is revoked'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS email_account_consent_identity_trigger ON email_account_consents;
CREATE TRIGGER email_account_consent_identity_trigger BEFORE UPDATE OR DELETE ON email_account_consents FOR EACH ROW EXECUTE FUNCTION enforce_email_account_consent_identity();
