-- Block 3.1 — org-scoped agent employee templates.
--
-- Before: agent_employee_templates.slug had a global UNIQUE constraint and
-- no org_id column — the table was strictly first-party/community seed data.
--
-- After: org_id nullable (NULL = global first-party/community row; non-NULL
-- = "Save as template" output from an org). Uniqueness is scoped to
-- (COALESCE(org_id, ''), slug) so orgs can reuse names without colliding
-- with each other or with the first-party catalog.

ALTER TABLE agent_employee_templates
  ADD COLUMN IF NOT EXISTS org_id text REFERENCES orgs(id) ON DELETE CASCADE;

-- Swap the old global unique for a composite that keeps first-party rows
-- (org_id IS NULL) globally unique per slug.
ALTER TABLE agent_employee_templates
  DROP CONSTRAINT IF EXISTS agent_employee_templates_slug_unique;

-- Drop the old plain index too, if it exists under the default name
DROP INDEX IF EXISTS agent_employee_templates_slug_key;

CREATE UNIQUE INDEX IF NOT EXISTS agent_employee_templates_org_slug_uniq
  ON agent_employee_templates (COALESCE(org_id, ''), slug);

CREATE INDEX IF NOT EXISTS agent_employee_templates_org_idx
  ON agent_employee_templates (org_id);
