CREATE TABLE IF NOT EXISTS email_context_transfers (
  org_id text NOT NULL CONSTRAINT email_context_transfers_org_id_orgs_id_fk REFERENCES orgs(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL CONSTRAINT email_context_transfers_owner_user_id_users_id_fk REFERENCES users(id) ON DELETE CASCADE,
  request_id text NOT NULL,
  request_digest text NOT NULL CONSTRAINT email_context_transfer_digest_check CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  account_id text NOT NULL,
  logical_message_id text NOT NULL CONSTRAINT email_context_transfer_logical_check CHECK (logical_message_id ~ '^mail_[a-f0-9]{64}$'),
  source_digest text NOT NULL CONSTRAINT email_context_transfer_source_digest_check CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  mode text NOT NULL CONSTRAINT email_context_transfer_mode_check CHECK (mode IN ('source_link','excerpt')),
  review_digest text NOT NULL CONSTRAINT email_context_transfer_review_digest_check CHECK (review_digest ~ '^[a-f0-9]{64}$'),
  destination_kind text NOT NULL CONSTRAINT email_context_transfer_kind_check CHECK (destination_kind IN ('note','knowledge')),
  destination_id text NOT NULL,
  destination_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, owner_user_id, request_id),
  CONSTRAINT email_context_transfer_account_fk FOREIGN KEY (org_id, owner_user_id, account_id)
    REFERENCES email_accounts(org_id, owner_user_id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS email_context_transfer_source_idx
  ON email_context_transfers (org_id, owner_user_id, account_id, logical_message_id);
