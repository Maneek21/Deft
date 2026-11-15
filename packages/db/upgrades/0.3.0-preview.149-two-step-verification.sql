-- Two-step verification (authenticator codes) and recovery codes. Add-only.
-- The tables belong to the account (users row), like the password.
-- No IF NOT EXISTS: a same-named leftover fails the upgrade instead of being
-- recorded as applied.

-- One row per person who has started or finished enrolment. The secret is
-- stored encrypted by the application; it is never stored in the clear.
CREATE TABLE user_two_step (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_encrypted text,
  confirmed_at timestamptz,
  pending_secret_encrypted text,
  pending_created_at timestamptz,
  last_used_step bigint NOT NULL DEFAULT 0,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT user_two_step_confirmed_has_secret CHECK (confirmed_at IS NULL OR secret_encrypted IS NOT NULL)
);

-- Recovery codes: only a hash is stored, and each works once.
CREATE TABLE user_two_step_recovery_codes (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX user_two_step_recovery_codes_hash_uidx ON user_two_step_recovery_codes (code_hash);
CREATE INDEX user_two_step_recovery_codes_user_idx ON user_two_step_recovery_codes (user_id);

-- A short-lived, single-purpose token issued after a correct password:
-- 'verify' is exchanged with a code for a session, 'enrol' can only set up
-- two-step verification. Only the token's hash is stored.
CREATE TABLE two_step_challenges (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('verify', 'enrol')),
  token_hash text NOT NULL,
  password_version integer NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX two_step_challenges_token_uidx ON two_step_challenges (token_hash);
CREATE INDEX two_step_challenges_user_idx ON two_step_challenges (user_id);
