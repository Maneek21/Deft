-- Encrypted sender-identity signature preferences; no signature plaintext is indexed.
CREATE TABLE IF NOT EXISTS email_signatures (
  org_id text NOT NULL,
  owner_user_id text NOT NULL,
  account_id text NOT NULL,
  revision integer NOT NULL,
  preferences_envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_signatures_pkey PRIMARY KEY (org_id,owner_user_id,account_id),
  CONSTRAINT email_signatures_account_fk FOREIGN KEY (org_id,owner_user_id,account_id)
    REFERENCES email_accounts (org_id,owner_user_id,account_id) ON DELETE RESTRICT,
  CONSTRAINT email_signatures_revision_check CHECK (revision BETWEEN 1 AND 2147483647)
);
