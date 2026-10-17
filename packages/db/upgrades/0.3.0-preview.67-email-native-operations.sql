-- Additive durable native Email triage journals. No existing operation is replayed.
CREATE TABLE IF NOT EXISTS email_operations (
  org_id text NOT NULL, owner_user_id text NOT NULL, account_id text NOT NULL,
  operation_id text NOT NULL, kind text NOT NULL,
  revision integer NOT NULL DEFAULT 0, content_envelope jsonb,
  lease_token text, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_operations_pkey PRIMARY KEY(org_id,owner_user_id,account_id,operation_id),
  CONSTRAINT email_operations_account_fk FOREIGN KEY(org_id,owner_user_id,account_id)
    REFERENCES email_accounts(org_id,owner_user_id,account_id) ON DELETE RESTRICT,
  CONSTRAINT email_operations_kind_check CHECK(kind='triage'),
  CONSTRAINT email_operations_revision_check CHECK(revision>=0 AND ((revision=0 AND content_envelope IS NULL) OR (revision>0 AND content_envelope IS NOT NULL))),
  CONSTRAINT email_operations_lease_check CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
