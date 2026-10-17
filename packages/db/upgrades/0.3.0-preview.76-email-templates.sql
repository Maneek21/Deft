-- Account-scoped compose templates. Title and compose content remain encrypted.
CREATE TABLE IF NOT EXISTS email_templates (
  org_id text NOT NULL,
  owner_user_id text NOT NULL,
  account_id text NOT NULL,
  template_id text NOT NULL,
  revision integer NOT NULL,
  status text NOT NULL DEFAULT 'active',
  content_envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_templates_pkey PRIMARY KEY (org_id,owner_user_id,account_id,template_id),
  CONSTRAINT email_templates_account_fk FOREIGN KEY (org_id,owner_user_id,account_id)
    REFERENCES email_accounts (org_id,owner_user_id,account_id) ON DELETE RESTRICT,
  CONSTRAINT email_templates_id_check CHECK (template_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  CONSTRAINT email_templates_revision_check CHECK (revision BETWEEN 1 AND 2147483647),
  CONSTRAINT email_templates_status_check CHECK (status IN ('active','archived'))
);
CREATE INDEX IF NOT EXISTS email_templates_owner_idx
  ON email_templates (org_id,owner_user_id,account_id,status,updated_at,template_id);
