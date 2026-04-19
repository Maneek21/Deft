-- Phase-4 reversal — remove project-level customization surface.
-- See docs/superpowers/specs/2026-04-18-simplify-skills-templates-design.md.

BEGIN;

-- 1. Strip agent_employee_skills rows that point at the three project-only
--    bundled skills. Required because the FK is ON DELETE RESTRICT.
DELETE FROM agent_employee_skills
WHERE skill_id IN (
  SELECT id FROM skills
  WHERE source = 'bundled' AND slug IN ('engineering','marketing-campaign','sales-pipeline')
);

-- 2. Drop the project_skills junction table entirely (multi-skill-per-project,
--    attachment ordering, first-attached-wins resolution — all retired).
DROP TABLE IF EXISTS project_skills;

-- 3. Drop the project_config jsonb column from skills. Everything it expressed
--    (statuses, priority vocab, default view, custom fields, task templates,
--    allowed transitions) is either hardcoded to engineering defaults or moved
--    to the first-class task_templates table.
ALTER TABLE skills DROP COLUMN IF EXISTS project_config;

-- 4. Delete the three bundled skill rows that existed only to carry
--    project_config. Engineering's PHASE3_TASK_TOOLS were folded into the
--    deft-workspace bundled skill in Task 7.
DELETE FROM skills
WHERE source = 'bundled'
  AND slug IN ('engineering','marketing-campaign','sales-pipeline');

COMMIT;
