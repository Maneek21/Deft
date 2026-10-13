-- Additive provenance only. Preserve this table when rolling back application code.
CREATE TABLE IF NOT EXISTS module_record_merges (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  installation_id text NOT NULL,
  source_record_id text NOT NULL,
  target_record_id text NOT NULL,
  source_revision integer NOT NULL,
  target_revision integer NOT NULL,
  source_data jsonb NOT NULL,
  target_data jsonb NOT NULL,
  link_snapshot jsonb NOT NULL,
  choices jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT module_record_merges_source_fk FOREIGN KEY (org_id, installation_id, source_record_id) REFERENCES module_records(org_id, installation_id, id) ON DELETE RESTRICT,
  CONSTRAINT module_record_merges_target_fk FOREIGN KEY (org_id, installation_id, target_record_id) REFERENCES module_records(org_id, installation_id, id) ON DELETE RESTRICT,
  CONSTRAINT module_record_merges_distinct_check CHECK (source_record_id <> target_record_id),
  CONSTRAINT module_record_merges_revision_check CHECK (source_revision > 0 AND target_revision > 0),
  CONSTRAINT module_record_merges_snapshot_check CHECK (jsonb_typeof(source_data) = 'object' AND jsonb_typeof(target_data) = 'object' AND jsonb_typeof(link_snapshot) = 'object' AND jsonb_typeof(choices) = 'object')
);
CREATE INDEX IF NOT EXISTS module_record_merges_target_idx ON module_record_merges(org_id, installation_id, target_record_id, created_at);
CREATE INDEX IF NOT EXISTS module_record_merges_source_idx ON module_record_merges(org_id, installation_id, source_record_id);
