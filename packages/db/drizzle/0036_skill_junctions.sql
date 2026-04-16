-- Task 4.2 — Junction tables linking skills to their two consumers.
--
-- agent_employee_skills: an employee "installs" a skill → gets its tools,
--   capability packs, triggers, prompt additions. ON DELETE CASCADE for the
--   employee side so tearing down an employee cleans up its installs;
--   ON DELETE RESTRICT on the skill side because deleting a skill that is
--   still installed would silently strip capabilities. Callers must
--   uninstall first or set `skills.is_deleted` so the seeder can skip it.
--
-- project_skills: a project "attaches" one or more skills to compose its
--   status/priority/view config. `attachment_order` breaks ties when two
--   attached skills both define project_config.statuses — the lowest order
--   wins (0 = default). Same FK semantics as the employee junction.

CREATE TABLE IF NOT EXISTS agent_employee_skills (
  agent_employee_id text NOT NULL REFERENCES agent_employees(id) ON DELETE CASCADE,
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  installed_at timestamp NOT NULL DEFAULT NOW(),
  installed_version text NOT NULL,
  PRIMARY KEY (agent_employee_id, skill_id)
);
CREATE INDEX IF NOT EXISTS aes_skill_idx ON agent_employee_skills(skill_id);

CREATE TABLE IF NOT EXISTS project_skills (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  attachment_order int NOT NULL DEFAULT 0,
  attached_at timestamp NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, skill_id)
);
CREATE INDEX IF NOT EXISTS ps_skill_idx ON project_skills(skill_id);
CREATE INDEX IF NOT EXISTS ps_project_order_idx ON project_skills(project_id, attachment_order);
