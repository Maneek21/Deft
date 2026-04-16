-- Task 3.3: agent attribution for task_activity rows.
--
-- Two nullable FKs:
--   agent_action_id              -> agent_actions(id)     ON DELETE SET NULL
--   acting_agent_employee_id     -> agent_employees(id)   ON DELETE SET NULL
--
-- Additive, idempotent. Safe to re-run.

ALTER TABLE task_activity ADD COLUMN IF NOT EXISTS agent_action_id text;
ALTER TABLE task_activity ADD COLUMN IF NOT EXISTS acting_agent_employee_id text;

DO $$ BEGIN
  ALTER TABLE task_activity
    ADD CONSTRAINT task_activity_agent_action_id_fk
    FOREIGN KEY (agent_action_id) REFERENCES agent_actions(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN null;
  WHEN undefined_table THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE task_activity
    ADD CONSTRAINT task_activity_acting_agent_employee_id_fk
    FOREIGN KEY (acting_agent_employee_id) REFERENCES agent_employees(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN null;
  WHEN undefined_table THEN null;
END $$;

CREATE INDEX IF NOT EXISTS task_activity_agent_action_idx ON task_activity(agent_action_id) WHERE agent_action_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_activity_acting_agent_emp_idx ON task_activity(acting_agent_employee_id) WHERE acting_agent_employee_id IS NOT NULL;
