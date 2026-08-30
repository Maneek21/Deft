CREATE TABLE IF NOT EXISTS app_installations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  app_id text NOT NULL,
  lineage_key text NOT NULL,
  lineage_authority_type text NOT NULL,
  lineage_authority_id text NOT NULL,
  source text NOT NULL DEFAULT 'local',
  state text NOT NULL DEFAULT 'staged',
  active_version_id text,
  lifecycle_epoch integer NOT NULL DEFAULT 0,
  installed_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  installed_by_actor_type text NOT NULL,
  installed_by_actor_id text NOT NULL,
  updated_by_actor_type text NOT NULL,
  updated_by_actor_id text NOT NULL,
  disabled_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_installations_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT app_installations_source_check CHECK (source = 'local'),
  CONSTRAINT app_installations_lineage_authority_check CHECK (lineage_authority_type = 'local_user'),
  CONSTRAINT app_installations_state_check CHECK (state IN ('staged', 'active', 'disabled', 'failed')),
  CONSTRAINT app_installations_epoch_nonnegative_check CHECK (lifecycle_epoch >= 0),
  CONSTRAINT app_installations_active_pointer_check CHECK (
    (state = 'staged' AND active_version_id IS NULL AND disabled_at IS NULL)
    OR (state = 'active' AND active_version_id IS NOT NULL AND disabled_at IS NULL)
    OR (state = 'disabled' AND active_version_id IS NOT NULL AND disabled_at IS NOT NULL)
    OR (state = 'failed' AND active_version_id IS NULL)
  )
);

ALTER TABLE app_installations
  ADD COLUMN IF NOT EXISTS lineage_authority_type text,
  ADD COLUMN IF NOT EXISTS lineage_authority_id text;
UPDATE app_installations
  SET lineage_authority_type = COALESCE(lineage_authority_type, 'local_user'),
      lineage_authority_id = COALESCE(lineage_authority_id, installed_by_user_id, installed_by_actor_id)
  WHERE lineage_authority_type IS NULL OR lineage_authority_id IS NULL;
ALTER TABLE app_installations
  ALTER COLUMN lineage_authority_type SET NOT NULL,
  ALTER COLUMN lineage_authority_id SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_installations_lineage_authority_check') THEN
    ALTER TABLE app_installations ADD CONSTRAINT app_installations_lineage_authority_check
      CHECK (lineage_authority_type = 'local_user');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS app_installations_org_app_id_unique ON app_installations(org_id, app_id);
CREATE UNIQUE INDEX IF NOT EXISTS app_installations_org_lineage_unique ON app_installations(org_id, lineage_key);
CREATE INDEX IF NOT EXISTS app_installations_org_state_idx ON app_installations(org_id, state);

CREATE TABLE IF NOT EXISTS app_versions (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  installation_id text NOT NULL,
  version text NOT NULL,
  protocol_version text NOT NULL,
  manifest jsonb NOT NULL,
  manifest_digest text NOT NULL,
  package_digest text NOT NULL,
  package jsonb NOT NULL,
  provenance jsonb,
  state text NOT NULL DEFAULT 'staged',
  staged_at timestamp NOT NULL DEFAULT now(),
  activated_at timestamp,
  failed_at timestamp,
  created_by_actor_type text NOT NULL,
  created_by_actor_id text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_versions_org_installation_fk FOREIGN KEY (org_id, installation_id)
    REFERENCES app_installations(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_versions_org_installation_id_unique UNIQUE (org_id, installation_id, id),
  CONSTRAINT app_versions_protocol_v0_check CHECK (protocol_version = '0'),
  CONSTRAINT app_versions_state_check CHECK (state IN ('staged', 'active', 'failed')),
  CONSTRAINT app_versions_manifest_object_check CHECK (jsonb_typeof(manifest) = 'object'),
  CONSTRAINT app_versions_package_object_check CHECK (jsonb_typeof(package) = 'object'),
  CONSTRAINT app_versions_manifest_digest_check CHECK (manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT app_versions_package_digest_check CHECK (package_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT app_versions_lifecycle_check CHECK (
    (state = 'staged' AND activated_at IS NULL AND failed_at IS NULL)
    OR (state = 'active' AND activated_at IS NOT NULL AND failed_at IS NULL)
    OR (state = 'failed' AND activated_at IS NULL AND failed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS app_versions_org_installation_version_unique ON app_versions(org_id, installation_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS app_versions_package_digest_unique ON app_versions(org_id, installation_id, package_digest);
CREATE UNIQUE INDEX IF NOT EXISTS app_versions_one_active_unique ON app_versions(org_id, installation_id) WHERE state = 'active';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_installations_active_version_fk') THEN
    ALTER TABLE app_installations
      ADD CONSTRAINT app_installations_active_version_fk
      FOREIGN KEY (org_id, id, active_version_id)
      REFERENCES app_versions(org_id, installation_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS app_module_bindings (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  app_installation_id text NOT NULL,
  app_version_id text NOT NULL,
  module_installation_id text NOT NULL,
  module_version_id text NOT NULL,
  module_id text NOT NULL,
  ownership text NOT NULL DEFAULT 'app',
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_module_bindings_app_installation_fk FOREIGN KEY (org_id, app_installation_id)
    REFERENCES app_installations(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_module_bindings_app_version_fk FOREIGN KEY (org_id, app_installation_id, app_version_id)
    REFERENCES app_versions(org_id, installation_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_module_bindings_module_installation_fk FOREIGN KEY (org_id, module_installation_id)
    REFERENCES module_installations(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_module_bindings_module_version_fk FOREIGN KEY (org_id, module_installation_id, module_version_id)
    REFERENCES module_versions(org_id, installation_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_module_bindings_ownership_check CHECK (ownership = 'app')
);

CREATE UNIQUE INDEX IF NOT EXISTS app_module_bindings_app_module_unique ON app_module_bindings(org_id, app_version_id, module_id);
CREATE UNIQUE INDEX IF NOT EXISTS app_module_bindings_owned_module_unique ON app_module_bindings(org_id, module_installation_id);

CREATE TABLE IF NOT EXISTS app_developer_pairings (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  code_hash text NOT NULL,
  created_by_user_id text NOT NULL,
  expires_at timestamp NOT NULL,
  consumed_at timestamp,
  revoked_at timestamp,
  session_token_hash text,
  session_expires_at timestamp,
  install_used_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_developer_pairings_creator_member_fk FOREIGN KEY (org_id, created_by_user_id)
    REFERENCES org_members(org_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT app_developer_pairings_code_hash_check CHECK (code_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT app_developer_pairings_session_hash_check CHECK (session_token_hash IS NULL OR session_token_hash ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT app_developer_pairings_exchange_state_check CHECK (
    (consumed_at IS NULL AND session_token_hash IS NULL AND session_expires_at IS NULL)
    OR (consumed_at IS NOT NULL AND session_token_hash IS NOT NULL AND session_expires_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS app_developer_pairings_code_hash_unique ON app_developer_pairings(code_hash);
CREATE UNIQUE INDEX IF NOT EXISTS app_developer_pairings_session_hash_unique ON app_developer_pairings(session_token_hash) WHERE session_token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS app_developer_pairings_org_idx ON app_developer_pairings(org_id, created_at);
