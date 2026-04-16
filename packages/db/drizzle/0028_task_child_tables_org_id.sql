-- Task 2.5: add org_id to task_comments and task_activity, backfill, enforce NOT NULL + FK, add org-scoped indexes.

-- ─── task_comments ───
ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS org_id text;

UPDATE task_comments
SET org_id = (SELECT org_id FROM tasks WHERE tasks.id = task_comments.task_id)
WHERE org_id IS NULL;

ALTER TABLE task_comments ALTER COLUMN org_id SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE task_comments ADD CONSTRAINT task_comments_org_id_fk FOREIGN KEY (org_id) REFERENCES orgs(id);
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS task_comments_org_task_idx ON task_comments(org_id, task_id);

-- ─── task_activity ───
ALTER TABLE task_activity ADD COLUMN IF NOT EXISTS org_id text;

UPDATE task_activity
SET org_id = (SELECT org_id FROM tasks WHERE tasks.id = task_activity.task_id)
WHERE org_id IS NULL;

ALTER TABLE task_activity ALTER COLUMN org_id SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE task_activity ADD CONSTRAINT task_activity_org_id_fk FOREIGN KEY (org_id) REFERENCES orgs(id);
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS task_activity_org_task_idx ON task_activity(org_id, task_id);
