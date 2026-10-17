-- Additive native Email metadata custody. Existing accounts stay untouched;
-- activation requires a separately verified owner/account migration.
CREATE TABLE IF NOT EXISTS email_accounts (
 org_id text NOT NULL, owner_user_id text NOT NULL, account_id text NOT NULL,
 provider text NOT NULL, resource_binding_id text NOT NULL, principal_digest text,
 state text NOT NULL DEFAULT 'paused', authority_revision integer NOT NULL DEFAULT 1,
 consented_at timestamptz, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,owner_user_id,account_id),
 CONSTRAINT email_accounts_provider_check CHECK(provider IN ('gmail','microsoft','imap_smtp')),
 CONSTRAINT email_accounts_state_check CHECK(state IN ('active','paused','disconnected','revoked')),
 CONSTRAINT email_accounts_revision_check CHECK(authority_revision>0),
 CONSTRAINT email_accounts_consent_check CHECK(state<>'active' OR (consented_at IS NOT NULL AND revoked_at IS NULL))
);
CREATE INDEX IF NOT EXISTS email_accounts_binding_idx ON email_accounts(org_id,resource_binding_id);
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS principal_digest text;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='email_accounts_principal_check' AND conrelid='email_accounts'::regclass) THEN
  ALTER TABLE email_accounts ADD CONSTRAINT email_accounts_principal_check CHECK(
   (principal_digest IS NULL OR principal_digest ~ '^[a-f0-9]{64}$') AND (state<>'active' OR principal_digest IS NOT NULL));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='email_accounts_owner_fk') THEN
  ALTER TABLE email_accounts ADD CONSTRAINT email_accounts_owner_fk FOREIGN KEY(org_id,owner_user_id)
   REFERENCES org_members(org_id,user_id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='email_accounts_binding_fk') THEN
  ALTER TABLE email_accounts ADD CONSTRAINT email_accounts_binding_fk FOREIGN KEY(org_id,resource_binding_id,owner_user_id)
   REFERENCES app_resource_bindings(org_id,id,owner_user_id) ON DELETE RESTRICT;
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS email_checkpoints (
 org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,
 revision integer NOT NULL DEFAULT 0,cursor_envelope jsonb,observed_at timestamptz,fresh_until timestamptz,
 coverage text NOT NULL DEFAULT 'partial',has_more boolean NOT NULL DEFAULT false,sync_state text NOT NULL DEFAULT 'idle',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,owner_user_id,account_id),
 CONSTRAINT email_checkpoints_account_fk FOREIGN KEY(org_id,owner_user_id,account_id) REFERENCES email_accounts(org_id,owner_user_id,account_id) ON DELETE RESTRICT,
 CONSTRAINT email_checkpoints_revision_check CHECK(revision>=0),
 CONSTRAINT email_checkpoints_coverage_check CHECK(coverage IN ('partial','complete')),
 CONSTRAINT email_checkpoints_state_check CHECK(sync_state IN ('idle','queued','syncing','failed','paused'))
);
CREATE TABLE IF NOT EXISTS email_messages (
 org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,logical_message_id text NOT NULL,
 revision text NOT NULL,storage_revision integer NOT NULL,received_at timestamptz,sort_at timestamptz NOT NULL,
 seen boolean NOT NULL DEFAULT false,flagged boolean NOT NULL DEFAULT false,answered boolean NOT NULL DEFAULT false,
 summary_envelope jsonb,source_envelope jsonb,deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,owner_user_id,account_id,logical_message_id),
 CONSTRAINT email_messages_account_fk FOREIGN KEY(org_id,owner_user_id,account_id) REFERENCES email_accounts(org_id,owner_user_id,account_id) ON DELETE RESTRICT,
 CONSTRAINT email_messages_identity_check CHECK(logical_message_id ~ '^mail_[a-f0-9]{64}$' AND storage_revision>0),
 CONSTRAINT email_messages_content_check CHECK((deleted_at IS NULL AND summary_envelope IS NOT NULL AND source_envelope IS NOT NULL) OR (deleted_at IS NOT NULL AND summary_envelope IS NULL AND source_envelope IS NULL))
);
CREATE INDEX IF NOT EXISTS email_messages_page_idx ON email_messages(org_id,owner_user_id,account_id,sort_at,logical_message_id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS email_memberships (
 org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,logical_message_id text NOT NULL,folder text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,owner_user_id,account_id,logical_message_id,folder),
 CONSTRAINT email_memberships_message_fk FOREIGN KEY(org_id,owner_user_id,account_id,logical_message_id) REFERENCES email_messages(org_id,owner_user_id,account_id,logical_message_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS email_memberships_folder_idx ON email_memberships(org_id,owner_user_id,account_id,folder,logical_message_id);
CREATE TABLE IF NOT EXISTS email_sync_receipts (
 org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,page_id text NOT NULL,
 request_digest text NOT NULL,page_digest text NOT NULL,checkpoint_revision integer NOT NULL,observed_at timestamptz NOT NULL,complete boolean NOT NULL,has_more boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,owner_user_id,account_id,page_id),
 CONSTRAINT email_sync_receipts_account_fk FOREIGN KEY(org_id,owner_user_id,account_id) REFERENCES email_accounts(org_id,owner_user_id,account_id) ON DELETE RESTRICT,
 CONSTRAINT email_sync_receipts_digest_check CHECK(request_digest ~ '^[a-f0-9]{64}$' AND page_digest ~ '^[a-f0-9]{64}$' AND checkpoint_revision>0)
);
ALTER TABLE email_checkpoints ADD COLUMN IF NOT EXISTS has_more boolean NOT NULL DEFAULT false;
ALTER TABLE email_sync_receipts ADD COLUMN IF NOT EXISTS has_more boolean NOT NULL DEFAULT false;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS inventory_generation text;
ALTER TABLE email_memberships ADD COLUMN IF NOT EXISTS inventory_generation text;
CREATE INDEX IF NOT EXISTS email_messages_inventory_idx ON email_messages(org_id,owner_user_id,account_id,inventory_generation,logical_message_id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS email_provider_states (
 org_id text NOT NULL,owner_user_id text NOT NULL,account_id text NOT NULL,state_key text NOT NULL,
 storage_revision integer NOT NULL,generation text NOT NULL,state_envelope jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,owner_user_id,account_id,state_key),
 CONSTRAINT email_provider_states_account_fk FOREIGN KEY(org_id,owner_user_id,account_id) REFERENCES email_accounts(org_id,owner_user_id,account_id) ON DELETE RESTRICT,
 CONSTRAINT email_provider_states_identity_check CHECK(storage_revision>0 AND state_key ~ '^[a-f0-9]{64}$' AND char_length(generation) BETWEEN 1 AND 128)
);
-- An idle history/delta checkpoint can retain its opaque cursor. Coverage and
-- whether another page is ready are deliberately independent.
-- Custody identity is immutable. A reviewed reconnect/version migration may
-- replace the binding under the same owner only with a new authority revision.
CREATE OR REPLACE FUNCTION email_account_identity_immutable() RETURNS trigger AS $$ BEGIN
 IF (NEW.org_id,NEW.owner_user_id,NEW.account_id,NEW.provider)
  IS DISTINCT FROM (OLD.org_id,OLD.owner_user_id,OLD.account_id,OLD.provider) THEN
  RAISE EXCEPTION 'EMAIL_ACCOUNT_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 IF (NEW.state,NEW.consented_at,NEW.revoked_at,NEW.resource_binding_id) IS DISTINCT FROM (OLD.state,OLD.consented_at,OLD.revoked_at,OLD.resource_binding_id)
  AND NEW.authority_revision<=OLD.authority_revision THEN
  RAISE EXCEPTION 'EMAIL_ACCOUNT_REVISION_REQUIRED' USING ERRCODE='55000';
 END IF;
 IF NEW.authority_revision<OLD.authority_revision THEN RAISE EXCEPTION 'EMAIL_ACCOUNT_REVISION_ROLLBACK' USING ERRCODE='55000'; END IF;
 IF OLD.principal_digest IS NOT NULL AND NEW.principal_digest IS DISTINCT FROM OLD.principal_digest THEN
  RAISE EXCEPTION 'EMAIL_ACCOUNT_PRINCIPAL_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 IF NEW.principal_digest IS DISTINCT FROM OLD.principal_digest AND NEW.authority_revision<=OLD.authority_revision THEN
  RAISE EXCEPTION 'EMAIL_ACCOUNT_REVISION_REQUIRED' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS email_account_identity_trigger ON email_accounts;
CREATE TRIGGER email_account_identity_trigger BEFORE UPDATE ON email_accounts FOR EACH ROW EXECUTE FUNCTION email_account_identity_immutable();
