-- Short-lived host-owned browser sessions for immutable App Experiences.
-- An opaque session ID is a locator, never standalone authorization: every
-- request must also pass the current web SID, member, App and grant checks.
CREATE TABLE IF NOT EXISTS app_experience_sessions (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  user_id text NOT NULL,
  web_session_id text NOT NULL,
  app_installation_id text NOT NULL,
  app_version_id text NOT NULL,
  grant_snapshot_id text NOT NULL,
  grant_snapshot_kind text NOT NULL DEFAULT 'effective',
  experience_key text NOT NULL,
  artifact_digest text NOT NULL,
  lifecycle_epoch integer NOT NULL,
  grant_epoch integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT app_experience_sessions_member_fk FOREIGN KEY (org_id, user_id)
    REFERENCES org_members(org_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT app_experience_sessions_web_session_fk FOREIGN KEY (web_session_id)
    REFERENCES web_sessions(id) ON DELETE RESTRICT,
  CONSTRAINT app_experience_sessions_version_fk FOREIGN KEY
    (org_id, app_installation_id, app_version_id)
    REFERENCES app_versions(org_id, installation_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_experience_sessions_grant_fk FOREIGN KEY
    (org_id, app_installation_id, app_version_id, grant_snapshot_id, grant_snapshot_kind)
    REFERENCES app_grant_snapshots
    (org_id, app_installation_id, app_version_id, id, snapshot_kind) ON DELETE RESTRICT,
  CONSTRAINT app_experience_sessions_key_check CHECK
    (experience_key ~ '^[a-z][a-z0-9_]{0,47}$'),
  CONSTRAINT app_experience_sessions_digest_check CHECK
    (artifact_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT app_experience_sessions_epoch_check CHECK
    (lifecycle_epoch >= 0 AND grant_epoch >= 0),
  CONSTRAINT app_experience_sessions_kind_check CHECK
    (grant_snapshot_kind = 'effective'),
  CONSTRAINT app_experience_sessions_expiry_check CHECK
    (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS app_experience_sessions_web_app_idx
  ON app_experience_sessions(org_id, web_session_id, app_installation_id, expires_at);
CREATE INDEX IF NOT EXISTS app_experience_sessions_expires_idx
  ON app_experience_sessions(expires_at);
