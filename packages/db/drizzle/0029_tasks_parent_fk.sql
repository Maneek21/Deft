-- Task 2.6: add self-referential FK on tasks.parent_task_id with ON DELETE SET NULL.

-- Clean orphans first so the constraint can be added safely.
UPDATE tasks
SET parent_task_id = NULL
WHERE parent_task_id IS NOT NULL
  AND parent_task_id NOT IN (SELECT id FROM tasks);

DO $$ BEGIN
  ALTER TABLE tasks
    ADD CONSTRAINT fk_tasks_parent
    FOREIGN KEY (parent_task_id)
    REFERENCES tasks(id)
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;
