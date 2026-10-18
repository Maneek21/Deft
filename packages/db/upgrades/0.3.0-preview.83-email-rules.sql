-- Encrypted account-local rules. Rule content never becomes plaintext search metadata.
CREATE TABLE IF NOT EXISTS email_rules (
  org_id text NOT NULL,
  owner_user_id text NOT NULL,
  account_id text NOT NULL,
  rule_id text NOT NULL,
  revision integer NOT NULL,
  state text NOT NULL,
  order_index integer NOT NULL,
  content_envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_rules_pkey PRIMARY KEY (org_id,owner_user_id,account_id,rule_id),
  CONSTRAINT email_rules_account_fk FOREIGN KEY (org_id,owner_user_id,account_id)
    REFERENCES email_accounts (org_id,owner_user_id,account_id) ON DELETE RESTRICT,
  CONSTRAINT email_rules_id_check CHECK (rule_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  CONSTRAINT email_rules_revision_check CHECK (revision BETWEEN 1 AND 2147483647),
  CONSTRAINT email_rules_state_check CHECK (state IN ('active','paused','archived')),
  CONSTRAINT email_rules_order_check CHECK (order_index BETWEEN 0 AND 2147483647),
  CONSTRAINT email_rules_envelope_check CHECK (jsonb_typeof(content_envelope)='object' AND octet_length(content_envelope::text)<=49152)
);
CREATE INDEX IF NOT EXISTS email_rules_order_idx ON email_rules (org_id,owner_user_id,account_id,state,order_index,rule_id);
