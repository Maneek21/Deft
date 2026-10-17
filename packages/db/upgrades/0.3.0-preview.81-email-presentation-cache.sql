CREATE TABLE IF NOT EXISTS email_presentation_cache (
 org_id text NOT NULL, owner_user_id text NOT NULL, account_id text NOT NULL,
 cache_key text NOT NULL, revision integer NOT NULL DEFAULT 1,
 content_envelope jsonb NOT NULL, byte_length integer NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT email_presentation_cache_pkey PRIMARY KEY (org_id,owner_user_id,account_id,cache_key),
 CONSTRAINT email_presentation_cache_account_fk FOREIGN KEY (org_id,owner_user_id,account_id) REFERENCES email_accounts(org_id,owner_user_id,account_id) ON DELETE RESTRICT,
 CONSTRAINT email_presentation_cache_value_check CHECK (cache_key ~ '^[a-f0-9]{64}$' AND revision=1 AND byte_length BETWEEN 1 AND 491520 AND expires_at>created_at)
);
CREATE INDEX IF NOT EXISTS email_presentation_cache_expiry_idx ON email_presentation_cache(org_id,owner_user_id,account_id,expires_at);
