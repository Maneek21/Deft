-- Human-owned per-account reading choices; default never loads remote images.
CREATE TABLE IF NOT EXISTS email_reading_preferences (
  org_id text NOT NULL,
  owner_user_id text NOT NULL,
  account_id text NOT NULL,
  external_images text NOT NULL DEFAULT 'ask',
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_reading_preferences_pkey PRIMARY KEY (org_id,owner_user_id,account_id),
  CONSTRAINT email_reading_preferences_account_fk FOREIGN KEY (org_id,owner_user_id,account_id)
    REFERENCES email_accounts (org_id,owner_user_id,account_id) ON DELETE RESTRICT,
  CONSTRAINT email_reading_preferences_policy_check CHECK (external_images IN ('ask','always') AND revision>0)
);
