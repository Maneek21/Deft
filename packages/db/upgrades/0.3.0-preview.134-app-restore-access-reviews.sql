-- Server-stored restore-access reviews. Each issued review is a single-use,
-- owner- and session-bound record of the exact offered grant set, so activation
-- can never be revived by recomputing a caller-visible digest after its window
-- has passed. Consumed reviews are retained for audit, never reused.
CREATE TABLE IF NOT EXISTS app_restore_access_reviews (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  owner_user_id text NOT NULL,
  installation_id text NOT NULL,
  target_key text NOT NULL,
  session_id text NOT NULL,
  account_ref text NOT NULL,
  offered_grants jsonb NOT NULL,
  review_digest text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_restore_access_reviews_digest_check CHECK (review_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT app_restore_access_reviews_target_check CHECK (target_key ~ '^[a-z][a-z0-9_]{0,47}$'),
  CONSTRAINT app_restore_access_reviews_expiry_check CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes'),
  CONSTRAINT app_restore_access_reviews_org_id_fkey FOREIGN KEY (org_id) REFERENCES orgs(id),
  CONSTRAINT app_restore_access_reviews_owner_fkey FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS app_restore_access_reviews_owner_idx
  ON app_restore_access_reviews (org_id, owner_user_id, installation_id, target_key);
