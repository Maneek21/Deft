DO $$ BEGIN
  ALTER TABLE task_labels ADD PRIMARY KEY (task_id, label_id);
EXCEPTION
  WHEN invalid_table_definition THEN null;
  WHEN duplicate_table THEN null;
  WHEN duplicate_object THEN null;
END $$;

DROP INDEX IF EXISTS task_label_unique;
