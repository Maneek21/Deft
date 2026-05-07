-- Task 4.1 — Extend existing `skills` table into the unified Skill primitive.
--
-- Phase 4 of the task-management overhaul reuses the skeletal `skills` table
-- that existed since migration 0000. We layer on `source` (bundled /
-- marketplace / org), versioning, icon/description cosmetics, and two
-- jsonb configuration columns:
--
--   * agent_config  — tools[], capability_packs[], triggers[],
--                     system_prompt_addition, trust_level_override,
--                     model_recommendation, heartbeat_checklist,
--                     param_schema (folded from the old param_schema column)
--   * project_config — statuses[], priority vocab, default_view,
--                      hide_prefix_ids, custom_fields, task_templates,
--                      allowed_transitions
--
-- The legacy `system_prompt` + `param_schema` columns stay (agent_config now
-- mirrors them for back-compat). `org_id` becomes nullable so bundled
-- and marketplace skills can exist without a tenant.
--
-- Idempotent; safe to re-apply. Superseded index `skill_slug_unique` is
-- replaced with a source-aware unique index that scopes by source + org.

ALTER TABLE skills ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'org'
  CHECK (source IN ('bundled','marketplace','org'));
ALTER TABLE skills ADD COLUMN IF NOT EXISTS version text NOT NULL DEFAULT '1.0.0';
ALTER TABLE skills ADD COLUMN IF NOT EXISTS icon text;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS agent_config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS project_config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS source_url text;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS default_agent_employee_id text
  REFERENCES agent_employees(id) ON DELETE SET NULL;

-- Fold pre-Phase-4 rows into agent_config so callers only need to read
-- the new column. Only runs when agent_config is still the default empty
-- object, making it safe to re-apply.
UPDATE skills
  SET agent_config = jsonb_build_object(
    'system_prompt_addition', system_prompt,
    'param_schema', param_schema
  )
  WHERE agent_config = '{}'::jsonb AND (system_prompt IS NOT NULL OR param_schema IS NOT NULL);

-- Bundled + marketplace skills have no tenant; org_id must accept NULL.
ALTER TABLE skills ALTER COLUMN org_id DROP NOT NULL;

-- Bundled + marketplace skills are seeded without a creating user.
ALTER TABLE skills ALTER COLUMN created_by DROP NOT NULL;
-- Existing `system_prompt` was NOT NULL; bundled capability-pack skills
-- don't ship prompt overrides. Relax so seeded rows pass without a stub.
ALTER TABLE skills ALTER COLUMN system_prompt DROP NOT NULL;

-- Uniqueness model shifts: slug is unique within a (source, org) pair.
-- COALESCE lets the partial-index cover bundled/marketplace rows where org_id IS NULL.
DROP INDEX IF EXISTS skill_slug_unique;
DROP INDEX IF EXISTS skills_org_slug_unique;
CREATE UNIQUE INDEX IF NOT EXISTS skills_source_org_slug_idx
  ON skills (source, COALESCE(org_id,''), slug) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS skills_source_idx ON skills(source) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS skills_org_idx ON skills(org_id) WHERE is_deleted = false AND source = 'org';
