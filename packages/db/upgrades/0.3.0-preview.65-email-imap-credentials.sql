-- Dormant encrypted credential storage; creating this table connects no account.
CREATE TABLE IF NOT EXISTS email_imap_credentials (
  org_id text NOT NULL,
  owner_user_id text NOT NULL,
  account_id text NOT NULL,
  principal_digest text NOT NULL,
  connection_revision integer NOT NULL,
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_imap_credentials_pkey PRIMARY KEY (org_id,owner_user_id,account_id),
  CONSTRAINT email_imap_credentials_account_fk FOREIGN KEY (org_id,owner_user_id,account_id)
    REFERENCES email_accounts (org_id,owner_user_id,account_id) ON DELETE RESTRICT,
  CONSTRAINT email_imap_credentials_identity_check CHECK (principal_digest ~ '^[a-f0-9]{64}$' AND connection_revision>0)
);
