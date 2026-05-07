DO $$ BEGIN
  CREATE TYPE notification_type AS ENUM (
    'task',
    'task_assigned',
    'task_updated',
    'agent_suggestion',
    'mention',
    'message',
    'reminder',
    'huddle_started',
    'system',
    'blocked',
    'cross_reference',
    'workload_imbalance',
    'wiki_update'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

UPDATE notifications SET type = 'system' WHERE type NOT IN (
  'task','task_assigned','task_updated','agent_suggestion','mention','message','reminder','huddle_started','system','blocked','cross_reference','workload_imbalance','wiki_update'
);

ALTER TABLE notifications ALTER COLUMN type TYPE notification_type USING type::notification_type;
