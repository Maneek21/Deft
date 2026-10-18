-- Durable native compose drafts. Existing Experience private-state drafts are
-- intentionally neither copied nor removed by this additive migration.
CREATE TABLE IF NOT EXISTS email_drafts (
  org_id text NOT NULL,
  owner_user_id text NOT NULL,
  account_id text NOT NULL,
  draft_id text NOT NULL,
  revision integer NOT NULL,
  content_revision integer NOT NULL,
  origin text NOT NULL,
  created_by_user_id text NOT NULL,
  origin_run_id text,
  last_edited_by_user_id text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  content_envelope jsonb NOT NULL,
  submitted_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_drafts_pkey PRIMARY KEY (org_id,owner_user_id,account_id,draft_id),
  CONSTRAINT email_drafts_account_fk FOREIGN KEY (org_id,owner_user_id,account_id)
    REFERENCES email_accounts (org_id,owner_user_id,account_id) ON DELETE RESTRICT,
  CONSTRAINT email_drafts_id_check CHECK (draft_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  CONSTRAINT email_drafts_revision_check CHECK (revision>0 AND content_revision>0 AND content_revision<=revision),
  CONSTRAINT email_drafts_origin_check CHECK (origin IN ('human','agent') AND char_length(created_by_user_id) BETWEEN 1 AND 256
    AND char_length(last_edited_by_user_id) BETWEEN 1 AND 256),
  CONSTRAINT email_drafts_status_check CHECK (status IN ('draft','submitted','archived')
    AND (status<>'submitted' OR submitted_at IS NOT NULL) AND (status<>'archived' OR archived_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS email_drafts_owner_idx ON email_drafts (org_id,owner_user_id,account_id,status,updated_at);
