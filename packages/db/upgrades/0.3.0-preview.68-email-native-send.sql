-- Native send is reserved exactly once per immutable draft content revision.
-- Provider I/O happens only after this transaction commits; lost outcomes are
-- retained as unknown and are never replayed automatically.
CREATE TABLE IF NOT EXISTS email_send_operations (
  org_id text NOT NULL, owner_user_id text NOT NULL, account_id text NOT NULL,
  operation_id text NOT NULL, draft_id text NOT NULL, draft_revision integer NOT NULL,
  operation_digest text NOT NULL, state text NOT NULL,
  receipt_envelope jsonb NOT NULL, initiated_by_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_send_operations_pkey PRIMARY KEY(org_id,owner_user_id,account_id,operation_id),
  CONSTRAINT email_send_operations_account_fk FOREIGN KEY(org_id,owner_user_id,account_id)
    REFERENCES email_accounts(org_id,owner_user_id,account_id) ON DELETE RESTRICT,
  CONSTRAINT email_send_operations_draft_fk FOREIGN KEY(org_id,owner_user_id,account_id,draft_id)
    REFERENCES email_drafts(org_id,owner_user_id,account_id,draft_id) ON DELETE RESTRICT,
  CONSTRAINT email_send_operations_revision_unique UNIQUE(org_id,owner_user_id,account_id,draft_id,draft_revision),
  CONSTRAINT email_send_operations_identity_check CHECK(operation_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    AND draft_revision>0 AND operation_digest ~ '^[a-f0-9]{64}$' AND char_length(initiated_by_user_id) BETWEEN 1 AND 256),
  CONSTRAINT email_send_operations_state_check CHECK(state IN ('reserved','accepted','unknown'))
);
