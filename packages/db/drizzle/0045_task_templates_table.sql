-- Task templates — first-class catalog, not nested in skills.
-- source='bundled' rows have org_id IS NULL (cross-tenant).
-- source='org' rows have a real org_id.
-- 'marketplace' is reserved; no code path uses it yet.

CREATE TABLE IF NOT EXISTS task_templates (
  id              text PRIMARY KEY,
  org_id          text,
  name            text NOT NULL,
  description     text,
  icon            text,
  slug            text NOT NULL,
  source          text NOT NULL CHECK (source IN ('bundled', 'marketplace', 'org')),
  version         text NOT NULL DEFAULT '1.0.0',
  tasks           jsonb NOT NULL,
  created_by      text REFERENCES users(id),
  is_deleted      boolean NOT NULL DEFAULT false,
  usage_count     integer NOT NULL DEFAULT 0,
  created_at      timestamp NOT NULL DEFAULT now(),
  updated_at      timestamp NOT NULL DEFAULT now()
);

-- Same partial-unique-index trick the skills table uses so bundled rows
-- (org_id NULL) collide correctly on re-seed.
CREATE UNIQUE INDEX IF NOT EXISTS task_templates_source_org_slug_idx
  ON task_templates (source, COALESCE(org_id, ''), slug)
  WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS task_templates_org_idx ON task_templates (org_id);
CREATE INDEX IF NOT EXISTS task_templates_source_idx ON task_templates (source);
