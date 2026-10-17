-- Declarative workspace modules: stable installations, immutable manifest
-- versions, and tenant-scoped JSON records with native full-text projection.

ALTER TABLE agent_actions
  ADD COLUMN IF NOT EXISTS approved_by_user_id text;

-- Receipt repair is intentionally retryable after process loss. Collapse any
-- historical duplicates before enforcing exactly one signed decision receipt.
DELETE FROM action_receipts newer
USING action_receipts older
WHERE newer.action_id = older.action_id
  AND newer.decision = older.decision
  AND (
    newer.created_at > older.created_at
    OR (newer.created_at = older.created_at AND newer.id > older.id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS receipt_action_decision_unique
  ON action_receipts (action_id, decision);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_actions_approved_by_user_id_fkey'
  ) THEN
    ALTER TABLE agent_actions
      ADD CONSTRAINT agent_actions_approved_by_user_id_fkey
      FOREIGN KEY (approved_by_user_id) REFERENCES users (id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS module_installations (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  module_id text NOT NULL,
  slug text NOT NULL,
  source text NOT NULL,
  is_enabled boolean NOT NULL DEFAULT true,
  disabled_at timestamp,
  agent_access text NOT NULL DEFAULT 'none',
  installed_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  installed_by_actor_type text NOT NULL,
  installed_by_actor_id text NOT NULL,
  updated_by_actor_type text NOT NULL,
  updated_by_actor_id text NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  deleted_at timestamp,
  deleted_by_actor_type text,
  deleted_by_actor_id text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT module_installations_module_id_not_empty
    CHECK (length(btrim(module_id)) > 0),
  CONSTRAINT module_installations_slug_not_empty
    CHECK (length(btrim(slug)) > 0),
  CONSTRAINT module_installations_source_check
    CHECK (source IN ('bundled', 'sideloaded', 'registry')),
  CONSTRAINT module_installations_agent_access_check
    CHECK (agent_access IN ('none', 'read', 'write')),
  CONSTRAINT module_installations_enabled_state_check
    CHECK (
      (is_enabled AND disabled_at IS NULL)
      OR (NOT is_enabled AND disabled_at IS NOT NULL)
    ),
  CONSTRAINT module_installations_deleted_state_check
    CHECK (
      (
        NOT is_deleted
        AND deleted_at IS NULL
        AND deleted_by_actor_type IS NULL
        AND deleted_by_actor_id IS NULL
      ) OR (
        is_deleted
        AND deleted_at IS NOT NULL
        AND deleted_by_actor_type IS NOT NULL
        AND deleted_by_actor_id IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS module_installations_org_id_id_unique
  ON module_installations (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS module_installations_org_module_id_unique
  ON module_installations (org_id, module_id);
CREATE UNIQUE INDEX IF NOT EXISTS module_installations_org_slug_unique
  ON module_installations (org_id, slug);
CREATE INDEX IF NOT EXISTS module_installations_org_visibility_idx
  ON module_installations (org_id, is_enabled, is_deleted);

CREATE TABLE IF NOT EXISTS module_versions (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  installation_id text NOT NULL,
  version text NOT NULL,
  manifest jsonb NOT NULL,
  manifest_digest text NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  activated_at timestamp,
  created_by_actor_type text NOT NULL,
  created_by_actor_id text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT module_versions_org_installation_fk
    FOREIGN KEY (org_id, installation_id)
    REFERENCES module_installations (org_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT module_versions_version_semver_check
    CHECK (
      version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
    ),
  CONSTRAINT module_versions_manifest_object_check
    CHECK (jsonb_typeof(manifest) = 'object'),
  CONSTRAINT module_versions_manifest_digest_sha256_check
    CHECK (manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT module_versions_active_state_check
    CHECK ((NOT is_active) OR activated_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS module_versions_org_installation_id_unique
  ON module_versions (org_id, installation_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS module_versions_org_installation_version_unique
  ON module_versions (org_id, installation_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS module_versions_one_active_unique
  ON module_versions (org_id, installation_id)
  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS module_versions_installation_digest_idx
  ON module_versions (org_id, installation_id, manifest_digest);

-- A module version is an immutable validation boundary. Activating or
-- deactivating a version is lifecycle state, but its identity, manifest, and
-- provenance may never be rewritten after insertion.
CREATE OR REPLACE FUNCTION enforce_module_version_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.org_id IS DISTINCT FROM OLD.org_id
    OR NEW.installation_id IS DISTINCT FROM OLD.installation_id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.manifest IS DISTINCT FROM OLD.manifest
    OR NEW.manifest_digest IS DISTINCT FROM OLD.manifest_digest
    OR NEW.created_by_actor_type IS DISTINCT FROM OLD.created_by_actor_type
    OR NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'module version identity, manifest, and provenance are immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS module_versions_immutable_fields_trigger ON module_versions;
CREATE TRIGGER module_versions_immutable_fields_trigger
  BEFORE UPDATE ON module_versions
  FOR EACH ROW
  EXECUTE FUNCTION enforce_module_version_immutability();

CREATE TABLE IF NOT EXISTS module_records (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  installation_id text NOT NULL,
  collection_key text NOT NULL,
  validated_version_id text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision integer NOT NULL DEFAULT 1,
  create_idempotency_key text,
  search_title text NOT NULL,
  search_subtitle text,
  search_text text NOT NULL DEFAULT '',
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple'::regconfig, COALESCE(search_title, '')), 'A') ||
    setweight(to_tsvector('simple'::regconfig, COALESCE(search_subtitle, '')), 'B') ||
    setweight(to_tsvector('simple'::regconfig, COALESCE(search_text, '')), 'C')
  ) STORED,
  created_by_actor_type text NOT NULL,
  created_by_actor_id text NOT NULL,
  updated_by_actor_type text NOT NULL,
  updated_by_actor_id text NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  deleted_at timestamp,
  deleted_by_actor_type text,
  deleted_by_actor_id text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT module_records_org_installation_fk
    FOREIGN KEY (org_id, installation_id)
    REFERENCES module_installations (org_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT module_records_validated_version_fk
    FOREIGN KEY (org_id, installation_id, validated_version_id)
    REFERENCES module_versions (org_id, installation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT module_records_collection_key_not_empty
    CHECK (length(btrim(collection_key)) > 0),
  CONSTRAINT module_records_data_object_check
    CHECK (jsonb_typeof(data) = 'object'),
  CONSTRAINT module_records_revision_positive_check
    CHECK (revision >= 1),
  CONSTRAINT module_records_create_idempotency_digest_check
    CHECK (create_idempotency_key IS NULL OR create_idempotency_key ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT module_records_deleted_state_check
    CHECK (
      (
        NOT is_deleted
        AND deleted_at IS NULL
        AND deleted_by_actor_type IS NULL
        AND deleted_by_actor_id IS NULL
      ) OR (
        is_deleted
        AND deleted_at IS NOT NULL
        AND deleted_by_actor_type IS NOT NULL
        AND deleted_by_actor_id IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS module_records_create_idempotency_unique
  ON module_records (org_id, installation_id, created_by_actor_type, created_by_actor_id, create_idempotency_key)
  WHERE create_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS module_records_org_installation_id_unique
  ON module_records (org_id, installation_id, id);
CREATE INDEX IF NOT EXISTS module_records_org_collection_idx
  ON module_records (org_id, installation_id, collection_key, is_deleted, updated_at);
CREATE INDEX IF NOT EXISTS module_records_validated_version_idx
  ON module_records (org_id, installation_id, validated_version_id);
CREATE INDEX IF NOT EXISTS module_records_search_idx
  ON module_records USING GIN (search_vector);

CREATE TABLE IF NOT EXISTS module_mutation_receipts (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  installation_id text NOT NULL,
  agent_action_id text REFERENCES agent_actions (id) ON DELETE RESTRICT,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  input_digest text NOT NULL,
  record_id text NOT NULL,
  result_revision integer NOT NULL,
  result_manifest_digest text NOT NULL,
  result_archived boolean NOT NULL,
  changed_fields text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT module_mutation_receipts_org_installation_fk
    FOREIGN KEY (org_id, installation_id)
    REFERENCES module_installations (org_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT module_mutation_receipts_record_fk
    FOREIGN KEY (org_id, installation_id, record_id)
    REFERENCES module_records (org_id, installation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT module_mutation_receipts_actor_type_check
    CHECK (actor_type IN ('human', 'defty', 'agent_employee', 'system')),
  CONSTRAINT module_mutation_receipts_actor_id_not_empty
    CHECK (length(btrim(actor_id)) > 0),
  CONSTRAINT module_mutation_receipts_operation_check
    CHECK (operation IN ('create', 'update', 'archive')),
  CONSTRAINT module_mutation_receipts_idempotency_key_digest_check
    CHECK (idempotency_key ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT module_mutation_receipts_input_digest_check
    CHECK (input_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT module_mutation_receipts_result_revision_check
    CHECK (result_revision >= 1),
  CONSTRAINT module_mutation_receipts_result_manifest_digest_check
    CHECK (result_manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT module_mutation_receipts_result_state_check
    CHECK (
      (operation = 'archive' AND result_archived)
      OR (operation IN ('create', 'update') AND NOT result_archived)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS module_mutation_receipts_idempotency_unique
  ON module_mutation_receipts (
    org_id,
    actor_type,
    actor_id,
    operation,
    idempotency_key
  );
CREATE UNIQUE INDEX IF NOT EXISTS module_mutation_receipts_agent_action_unique
  ON module_mutation_receipts (org_id, agent_action_id)
  WHERE agent_action_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS module_mutation_receipts_record_idx
  ON module_mutation_receipts (org_id, installation_id, record_id, created_at);
