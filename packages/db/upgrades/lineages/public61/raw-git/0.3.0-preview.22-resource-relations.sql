-- Additive, host-owned relation substrate for live-authorized ResourceRefs.
-- Rows retain opaque identities only; they never prove endpoint existence or
-- grant access. Existing module_record_relations remain unchanged.

CREATE TABLE IF NOT EXISTS resource_relation_sets (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  source_provider_kind text NOT NULL,
  source_provider_instance_id text NOT NULL,
  source_resource_type text NOT NULL,
  source_resource_id text NOT NULL,
  relation_key text NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  updated_by_actor_type text NOT NULL,
  updated_by_actor_id text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT resource_relation_sets_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT resource_relation_sets_provider_check CHECK (
    source_provider_kind = 'module'
    OR (
      source_provider_kind = 'core'
      AND source_provider_instance_id = 'tasks'
      AND source_resource_type = 'task'
    )
  ),
  CONSTRAINT resource_relation_sets_revision_check CHECK (revision >= 0),
  CONSTRAINT resource_relation_sets_relation_key_check CHECK (relation_key ~ '^[a-z][a-z0-9_]{0,47}$'),
  CONSTRAINT resource_relation_sets_actor_check CHECK (
    updated_by_actor_type IN ('human', 'defty', 'agent_employee', 'system')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS resource_relation_sets_identity_unique
  ON resource_relation_sets (
    org_id, source_provider_kind, source_provider_instance_id,
    source_resource_type, source_resource_id, relation_key
  );
CREATE INDEX IF NOT EXISTS resource_relation_sets_source_idx
  ON resource_relation_sets (
    org_id, source_provider_kind, source_provider_instance_id,
    source_resource_type, source_resource_id
  );

CREATE TABLE IF NOT EXISTS resource_relation_edges (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  relation_set_id text NOT NULL,
  target_provider_kind text NOT NULL,
  target_provider_instance_id text NOT NULL,
  target_resource_type text NOT NULL,
  target_resource_id text NOT NULL,
  position integer NOT NULL,
  created_by_actor_type text NOT NULL,
  created_by_actor_id text NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  deleted_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT resource_relation_edges_org_set_fk FOREIGN KEY (org_id, relation_set_id)
    REFERENCES resource_relation_sets(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT resource_relation_edges_provider_check CHECK (
    target_provider_kind = 'module'
    OR (
      target_provider_kind = 'core'
      AND target_provider_instance_id = 'tasks'
      AND target_resource_type = 'task'
    )
  ),
  CONSTRAINT resource_relation_edges_position_check CHECK (position >= 0),
  CONSTRAINT resource_relation_edges_actor_check CHECK (
    created_by_actor_type IN ('human', 'defty', 'agent_employee', 'system')
  ),
  CONSTRAINT resource_relation_edges_deleted_state_check CHECK (
    (is_deleted AND deleted_at IS NOT NULL)
    OR (NOT is_deleted AND deleted_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS resource_relation_edges_active_target_unique
  ON resource_relation_edges (
    org_id, relation_set_id, target_provider_kind, target_provider_instance_id,
    target_resource_type, target_resource_id
  ) WHERE is_deleted = false;
CREATE UNIQUE INDEX IF NOT EXISTS resource_relation_edges_active_position_unique
  ON resource_relation_edges (org_id, relation_set_id, position)
  WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS resource_relation_edges_target_idx
  ON resource_relation_edges (
    org_id, target_provider_kind, target_provider_instance_id,
    target_resource_type, target_resource_id, is_deleted
  );

CREATE TABLE IF NOT EXISTS resource_relation_receipts (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  relation_set_id text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  operation text NOT NULL DEFAULT 'replace',
  idempotency_key text NOT NULL,
  input_digest text NOT NULL,
  result_revision integer NOT NULL,
  result_refs jsonb NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT resource_relation_receipts_org_set_fk FOREIGN KEY (org_id, relation_set_id)
    REFERENCES resource_relation_sets(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT resource_relation_receipts_actor_check CHECK (
    actor_type IN ('human', 'defty', 'agent_employee', 'system')
  ),
  CONSTRAINT resource_relation_receipts_operation_check CHECK (operation = 'replace'),
  CONSTRAINT resource_relation_receipts_idempotency_check CHECK (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  ),
  CONSTRAINT resource_relation_receipts_digest_check CHECK (
    input_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  CONSTRAINT resource_relation_receipts_revision_check CHECK (result_revision >= 1),
  CONSTRAINT resource_relation_receipts_refs_check CHECK (jsonb_typeof(result_refs) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS resource_relation_receipts_idempotency_unique
  ON resource_relation_receipts (org_id, actor_type, actor_id, operation, idempotency_key);
