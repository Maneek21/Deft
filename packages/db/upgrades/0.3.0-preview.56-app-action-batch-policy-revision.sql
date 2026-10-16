-- Existing preview55 batches have no pinned policy epoch and fail closed.
ALTER TABLE app_action_batches ADD COLUMN IF NOT EXISTS policy_revision integer NOT NULL DEFAULT -1;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_action_batches'::regclass AND conname='app_action_batches_policy_revision_check') THEN
  ALTER TABLE app_action_batches ADD CONSTRAINT app_action_batches_policy_revision_check CHECK(policy_revision>=-1);
 END IF;
END $$;
