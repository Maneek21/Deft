-- Durable idempotency receipts for explicitly reviewed native rule actions.
-- Rules remain disabled for automatic dispatch until a leased rule runner exists.
CREATE TABLE IF NOT EXISTS email_rule_receipts (
  org_id text NOT NULL,
  owner_user_id text NOT NULL,
  account_id text NOT NULL,
  rule_id text NOT NULL,
  rule_revision integer NOT NULL,
  target_digest text NOT NULL,
  action_index integer NOT NULL,
  operation_id text NOT NULL,
  storage_revision integer NOT NULL,
  state text NOT NULL,
  receipt_envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_rule_receipts_pkey PRIMARY KEY (org_id,owner_user_id,account_id,rule_id,rule_revision,target_digest,action_index),
  CONSTRAINT email_rule_receipts_account_fk FOREIGN KEY (org_id,owner_user_id,account_id)
    REFERENCES email_accounts (org_id,owner_user_id,account_id) ON DELETE RESTRICT,
  CONSTRAINT email_rule_receipts_rule_fk FOREIGN KEY (org_id,owner_user_id,account_id,rule_id)
    REFERENCES email_rules (org_id,owner_user_id,account_id,rule_id) ON DELETE RESTRICT,
  CONSTRAINT email_rule_receipts_revision_check CHECK (rule_revision > 0 AND storage_revision > 0),
  CONSTRAINT email_rule_receipts_target_check CHECK (target_digest ~ '^[a-f0-9]{64}$' AND action_index BETWEEN 0 AND 5),
  CONSTRAINT email_rule_receipts_operation_check CHECK (operation_id ~ '^[0-9a-fA-F-]{36}$'),
  CONSTRAINT email_rule_receipts_state_check CHECK (state IN ('planned','reserved','applied','failed','unknown','conflict')),
  CONSTRAINT email_rule_receipts_envelope_check CHECK (jsonb_typeof(receipt_envelope)='object' AND octet_length(receipt_envelope::text)<=65536)
);
CREATE INDEX IF NOT EXISTS email_rule_receipts_rule_idx ON email_rule_receipts (org_id,owner_user_id,account_id,rule_id,rule_revision,state);
