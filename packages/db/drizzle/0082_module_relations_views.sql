-- Generic module relations and personal saved views.

-- 0081 originally expressed composite FK targets as unique indexes. Attach
-- those exact indexes as named constraints so supported upgrades converge
-- with fresh Drizzle pushes (which declare the constraints inline). PostgreSQL
-- keeps the same physical indexes and existing foreign keys remain valid.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_member_unique') THEN
    ALTER TABLE org_members
      ADD CONSTRAINT org_member_unique UNIQUE USING INDEX org_member_unique;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'module_installations_org_id_id_unique') THEN
    ALTER TABLE module_installations
      ADD CONSTRAINT module_installations_org_id_id_unique
      UNIQUE USING INDEX module_installations_org_id_id_unique;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'module_versions_org_installation_id_unique') THEN
    ALTER TABLE module_versions
      ADD CONSTRAINT module_versions_org_installation_id_unique
      UNIQUE USING INDEX module_versions_org_installation_id_unique;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'module_records_org_installation_id_unique') THEN
    ALTER TABLE module_records
      ADD CONSTRAINT module_records_org_installation_id_unique
      UNIQUE USING INDEX module_records_org_installation_id_unique;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS module_record_relations (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  installation_id text NOT NULL,
  field_key text NOT NULL,
  source_record_id text NOT NULL,
  target_record_id text NOT NULL,
  position integer NOT NULL DEFAULT 0,
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
  CONSTRAINT module_record_relations_org_installation_fk
    FOREIGN KEY (org_id, installation_id)
    REFERENCES module_installations (org_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT module_record_relations_source_record_fk
    FOREIGN KEY (org_id, installation_id, source_record_id)
    REFERENCES module_records (org_id, installation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT module_record_relations_target_record_fk
    FOREIGN KEY (org_id, installation_id, target_record_id)
    REFERENCES module_records (org_id, installation_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT module_record_relations_field_key_not_empty
    CHECK (length(btrim(field_key)) > 0),
  CONSTRAINT module_record_relations_position_nonnegative
    CHECK (position >= 0),
  CONSTRAINT module_record_relations_deleted_state_check
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

CREATE UNIQUE INDEX IF NOT EXISTS module_record_relations_active_unique
  ON module_record_relations (
    org_id,
    installation_id,
    source_record_id,
    field_key,
    target_record_id
  )
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS module_record_relations_source_idx
  ON module_record_relations (
    org_id,
    installation_id,
    source_record_id,
    field_key,
    is_deleted,
    position
  );
CREATE INDEX IF NOT EXISTS module_record_relations_target_idx
  ON module_record_relations (
    org_id,
    installation_id,
    target_record_id,
    is_deleted
  );

CREATE TABLE IF NOT EXISTS module_saved_views (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  installation_id text NOT NULL,
  collection_key text NOT NULL,
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  view_type text NOT NULL,
  config jsonb NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  deleted_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT module_saved_views_org_installation_fk
    FOREIGN KEY (org_id, installation_id)
    REFERENCES module_installations (org_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT module_saved_views_owner_member_fk
    FOREIGN KEY (org_id, owner_user_id)
    REFERENCES org_members (org_id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT module_saved_views_collection_key_not_empty
    CHECK (length(btrim(collection_key)) > 0),
  CONSTRAINT module_saved_views_name_not_empty
    CHECK (length(btrim(name)) > 0),
  CONSTRAINT module_saved_views_type_check
    CHECK (view_type IN ('table', 'board', 'timeline')),
  CONSTRAINT module_saved_views_config_object_check
    CHECK (jsonb_typeof(config) = 'object'),
  CONSTRAINT module_saved_views_config_type_check
    CHECK (config->>'type' = view_type),
  CONSTRAINT module_saved_views_deleted_state_check
    CHECK (
      (is_deleted AND deleted_at IS NOT NULL)
      OR (NOT is_deleted AND deleted_at IS NULL)
    )
);

-- Keep this migration retryable if a prior process created the table before
-- reaching the owner-membership constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'module_saved_views_owner_member_fk'
  ) THEN
    ALTER TABLE module_saved_views
      ADD CONSTRAINT module_saved_views_owner_member_fk
      FOREIGN KEY (org_id, owner_user_id)
      REFERENCES org_members (org_id, user_id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS module_saved_views_active_name_unique
  ON module_saved_views (
    org_id,
    installation_id,
    collection_key,
    owner_user_id,
    name
  )
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS module_saved_views_owner_idx
  ON module_saved_views (
    org_id,
    owner_user_id,
    installation_id,
    collection_key,
    is_deleted,
    updated_at
  );
