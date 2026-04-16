CREATE TABLE IF NOT EXISTS duplicate_flags (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  task_a_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_b_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  similarity numeric,
  created_at timestamp NOT NULL DEFAULT NOW(),
  CHECK (task_a_id < task_b_id),
  UNIQUE (task_a_id, task_b_id)
);

CREATE INDEX IF NOT EXISTS duplicate_flags_org_idx ON duplicate_flags(org_id);
