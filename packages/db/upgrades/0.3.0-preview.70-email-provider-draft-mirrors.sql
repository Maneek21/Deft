-- Native provider draft mirroring is dormant unless the owner explicitly opts in.
ALTER TABLE email_accounts
  ADD COLUMN IF NOT EXISTS provider_draft_sync_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS email_provider_draft_mirrors (
  org_id text NOT NULL, owner_user_id text NOT NULL, account_id text NOT NULL, draft_id text NOT NULL,
  desired_revision integer NOT NULL, synced_revision integer, generation integer NOT NULL DEFAULT 1,
  envelope_revision integer NOT NULL DEFAULT 0, claim_token_hash text, claim_generation integer, claim_revision integer, claim_operation_id text,
  state text NOT NULL DEFAULT 'queued', provider_envelope jsonb,
  last_error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_provider_draft_mirrors_pkey PRIMARY KEY (org_id,owner_user_id,account_id,draft_id),
  CONSTRAINT email_provider_draft_mirrors_account_fk FOREIGN KEY (org_id,owner_user_id,account_id)
    REFERENCES email_accounts(org_id,owner_user_id,account_id) ON DELETE RESTRICT,
  CONSTRAINT email_provider_draft_mirrors_draft_fk FOREIGN KEY (org_id,owner_user_id,account_id,draft_id)
    REFERENCES email_drafts(org_id,owner_user_id,account_id,draft_id) ON DELETE RESTRICT,
  CONSTRAINT email_provider_draft_mirrors_revision_check CHECK (desired_revision>0 AND (synced_revision IS NULL OR synced_revision>0) AND generation>0 AND envelope_revision>=0),
  CONSTRAINT email_provider_draft_mirrors_state_check CHECK (state IN ('queued','syncing','synced','conflict','unknown','unsupported','delete_pending','deleted','paused')),
  CONSTRAINT email_provider_draft_mirrors_claim_check CHECK (claim_token_hash IS NULL OR claim_token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT email_provider_draft_mirrors_lease_state_check CHECK ((state='syncing') = (claim_token_hash IS NOT NULL AND claim_generation IS NOT NULL AND claim_revision IS NOT NULL AND claim_operation_id IS NOT NULL)
    AND (state='syncing' OR (claim_generation IS NULL AND claim_revision IS NULL AND claim_operation_id IS NULL))),
  CONSTRAINT email_provider_draft_mirrors_operation_check CHECK (claim_operation_id IS NULL OR claim_operation_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  CONSTRAINT email_provider_draft_mirrors_synced_envelope_check CHECK (state<>'synced' OR provider_envelope IS NOT NULL),
  CONSTRAINT email_provider_draft_mirrors_error_check CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,64}$')
);
CREATE INDEX IF NOT EXISTS email_provider_draft_mirrors_repair_idx
  ON email_provider_draft_mirrors(org_id,owner_user_id,account_id,state,updated_at);
