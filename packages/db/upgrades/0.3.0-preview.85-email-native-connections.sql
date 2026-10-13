-- Owner-native OAuth setup receipts. No App installation/binding/grant is
-- fabricated and no mailbox becomes active merely by applying this migration.
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS credential_source text NOT NULL DEFAULT 'retained_registry_v1';
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS retained_resource_binding_id text GENERATED ALWAYS AS (CASE WHEN credential_source='retained_registry_v1' THEN resource_binding_id ELSE NULL END) STORED;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='email_accounts'::regclass AND conname='email_accounts_source_check') THEN
  ALTER TABLE email_accounts ADD CONSTRAINT email_accounts_source_check CHECK(credential_source IN ('retained_registry_v1','native_owner_provider_v1') AND (credential_source<>'native_owner_provider_v1' OR provider IN ('gmail','microsoft')));
 END IF;
END $$;
ALTER TABLE email_accounts DROP CONSTRAINT IF EXISTS email_accounts_binding_fk;
ALTER TABLE email_accounts ADD CONSTRAINT email_accounts_binding_fk FOREIGN KEY(org_id,retained_resource_binding_id,owner_user_id) REFERENCES app_resource_bindings(org_id,id,owner_user_id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS email_accounts_retained_binding_idx ON email_accounts(org_id,retained_resource_binding_id);
CREATE OR REPLACE FUNCTION email_account_identity_immutable() RETURNS trigger AS $$ BEGIN
 IF (NEW.org_id,NEW.owner_user_id,NEW.account_id,NEW.provider,NEW.credential_source)
  IS DISTINCT FROM (OLD.org_id,OLD.owner_user_id,OLD.account_id,OLD.provider,OLD.credential_source)
  OR OLD.credential_source='native_owner_provider_v1' AND NEW.resource_binding_id IS DISTINCT FROM OLD.resource_binding_id THEN
  RAISE EXCEPTION 'EMAIL_ACCOUNT_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 IF (NEW.state,NEW.consented_at,NEW.revoked_at,NEW.resource_binding_id) IS DISTINCT FROM (OLD.state,OLD.consented_at,OLD.revoked_at,OLD.resource_binding_id)
  AND NEW.authority_revision<=OLD.authority_revision THEN RAISE EXCEPTION 'EMAIL_ACCOUNT_REVISION_REQUIRED' USING ERRCODE='55000'; END IF;
 IF NEW.authority_revision<OLD.authority_revision THEN RAISE EXCEPTION 'EMAIL_ACCOUNT_REVISION_ROLLBACK' USING ERRCODE='55000'; END IF;
 IF OLD.principal_digest IS NOT NULL AND NEW.principal_digest IS DISTINCT FROM OLD.principal_digest THEN RAISE EXCEPTION 'EMAIL_ACCOUNT_PRINCIPAL_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF NEW.principal_digest IS DISTINCT FROM OLD.principal_digest AND NEW.authority_revision<=OLD.authority_revision THEN RAISE EXCEPTION 'EMAIL_ACCOUNT_REVISION_REQUIRED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS email_account_identity_trigger ON email_accounts;
CREATE TRIGGER email_account_identity_trigger BEFORE UPDATE ON email_accounts FOR EACH ROW EXECUTE FUNCTION email_account_identity_immutable();
CREATE TABLE IF NOT EXISTS email_native_account_connections (
 org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,provider text NOT NULL,principal_digest text NOT NULL,
 bridge_digest text NOT NULL,revision integer NOT NULL DEFAULT 1,descriptor_envelope jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT email_native_account_connections_pkey PRIMARY KEY(org_id,owner_user_id,account_id),
 CONSTRAINT email_native_account_connections_account_fk FOREIGN KEY(org_id,owner_user_id,account_id) REFERENCES email_accounts(org_id,owner_user_id,account_id) ON DELETE RESTRICT,
 CONSTRAINT email_native_account_connections_identity_check CHECK(provider IN ('gmail','microsoft') AND principal_digest ~ '^[a-f0-9]{64}$' AND bridge_digest ~ '^[a-f0-9]{64}$' AND revision=1),
 CONSTRAINT email_native_account_connections_envelope_check CHECK(jsonb_typeof(descriptor_envelope)='object' AND octet_length(descriptor_envelope::text)<=8192)
);
CREATE OR REPLACE FUNCTION enforce_email_native_account_connection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'EMAIL_NATIVE_CONNECTION_IDENTITY_IMMUTABLE';
END $$;
DROP TRIGGER IF EXISTS email_native_account_connection_trigger ON email_native_account_connections;
CREATE TRIGGER email_native_account_connection_trigger BEFORE UPDATE OR DELETE ON email_native_account_connections FOR EACH ROW EXECUTE FUNCTION enforce_email_native_account_connection();
CREATE OR REPLACE FUNCTION enforce_email_native_account_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a email_accounts%ROWTYPE;
BEGIN
 SELECT * INTO a FROM email_accounts WHERE org_id=NEW.org_id AND owner_user_id=NEW.owner_user_id AND account_id=NEW.account_id;
 IF a.credential_source='native_owner_provider_v1' AND a.state='active' AND NOT EXISTS(
  SELECT 1 FROM email_native_account_connections n JOIN email_account_consents c USING(org_id,owner_user_id,account_id)
  WHERE n.org_id=a.org_id AND n.owner_user_id=a.owner_user_id AND n.account_id=a.account_id
   AND n.provider=a.provider AND c.provider=a.provider AND n.principal_digest=a.principal_digest AND c.principal_digest=a.principal_digest
   AND n.bridge_digest=c.bridge_digest AND c.state='active' AND c.native_revision<=a.authority_revision
 ) THEN RAISE EXCEPTION 'EMAIL_NATIVE_CONNECTION_ENROLLMENT_REQUIRED'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS email_native_account_source_trigger ON email_accounts;
CREATE CONSTRAINT TRIGGER email_native_account_source_trigger AFTER INSERT OR UPDATE ON email_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_email_native_account_source();
DROP TRIGGER IF EXISTS email_native_consent_source_trigger ON email_account_consents;
CREATE CONSTRAINT TRIGGER email_native_consent_source_trigger AFTER INSERT OR UPDATE ON email_account_consents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_email_native_account_source();
CREATE TABLE IF NOT EXISTS email_native_connection_owners (
 org_id text NOT NULL,owner_user_id text NOT NULL,
 request_count integer NOT NULL DEFAULT 0,active_count integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT email_native_connection_owners_pkey PRIMARY KEY(org_id,owner_user_id),
 CONSTRAINT email_native_connection_owners_member_fk FOREIGN KEY(org_id,owner_user_id) REFERENCES org_members(org_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT email_native_connection_owners_budget_check CHECK(request_count BETWEEN 0 AND 512 AND active_count BETWEEN 0 AND 8 AND active_count<=request_count)
);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='email_native_connection_owners'::regclass AND conname='email_native_connection_owners_member_fk') THEN
  ALTER TABLE email_native_connection_owners ADD CONSTRAINT email_native_connection_owners_member_fk FOREIGN KEY(org_id,owner_user_id) REFERENCES org_members(org_id,user_id) ON DELETE RESTRICT;
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS email_native_connection_requests (
 org_id text NOT NULL,owner_user_id text NOT NULL,request_id text NOT NULL,account_id text NOT NULL,provider text NOT NULL,
 request_digest text NOT NULL,binding_digest text NOT NULL,session_digest text NOT NULL,state text NOT NULL,revision integer NOT NULL,state_digest text,
 envelope jsonb NOT NULL,expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT email_native_connection_requests_pkey PRIMARY KEY(org_id,owner_user_id,request_id),
 CONSTRAINT email_native_connection_requests_owner_fk FOREIGN KEY(org_id,owner_user_id) REFERENCES email_native_connection_owners(org_id,owner_user_id) ON DELETE RESTRICT,
 CONSTRAINT email_native_connection_requests_identity_check CHECK(request_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' AND length(account_id) BETWEEN 1 AND 256 AND provider IN ('gmail','microsoft') AND request_digest ~ '^[a-f0-9]{64}$' AND binding_digest ~ '^[a-f0-9]{64}$' AND session_digest ~ '^[a-f0-9]{64}$'),
 CONSTRAINT email_native_connection_requests_state_check CHECK(state IN ('preparing','pending','exchanging','connected','failed','unknown','expired') AND revision BETWEEN 1 AND 2147483646 AND (state_digest IS NULL OR state_digest ~ '^[a-f0-9]{64}$') AND (state NOT IN ('pending','exchanging') OR state_digest IS NOT NULL)),
 CONSTRAINT email_native_connection_requests_envelope_check CHECK(jsonb_typeof(envelope)='object' AND octet_length(envelope::text)<=49152),
 CONSTRAINT email_native_connection_requests_expiry_check CHECK(expires_at>created_at AND expires_at<=created_at+interval '10 minutes')
);
CREATE INDEX IF NOT EXISTS email_native_connection_requests_state_idx ON email_native_connection_requests(org_id,owner_user_id,state_digest);
CREATE OR REPLACE FUNCTION enforce_email_native_connection_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'email connection receipt retention required'; END IF;
 IF (NEW.org_id,NEW.owner_user_id,NEW.request_id,NEW.account_id,NEW.provider,NEW.request_digest,NEW.binding_digest,NEW.session_digest,NEW.created_at) IS DISTINCT FROM
    (OLD.org_id,OLD.owner_user_id,OLD.request_id,OLD.account_id,OLD.provider,OLD.request_digest,OLD.binding_digest,OLD.session_digest,OLD.created_at)
    OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at OR NEW.expires_at>OLD.expires_at
    OR OLD.state_digest IS NOT NULL AND NEW.state_digest IS DISTINCT FROM OLD.state_digest
    OR NOT ((OLD.state='preparing' AND NEW.state IN ('pending','failed','expired'))
         OR (OLD.state='pending' AND NEW.state IN ('exchanging','failed','expired'))
         OR (OLD.state='exchanging' AND NEW.state IN ('connected','unknown')))
 THEN RAISE EXCEPTION 'email connection receipt transition denied'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS email_native_connection_request_trigger ON email_native_connection_requests;
CREATE TRIGGER email_native_connection_request_trigger BEFORE UPDATE OR DELETE ON email_native_connection_requests FOR EACH ROW EXECUTE FUNCTION enforce_email_native_connection_request();
