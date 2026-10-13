-- SQL CHECK rejects FALSE but accepts NULL: effect-bearing states must require
-- both attempt markers explicitly, including on direct INSERT.
DO $$ BEGIN
 ALTER TABLE email_outbox DROP CONSTRAINT IF EXISTS email_outbox_state_check;
 ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_state_check CHECK (
  state IN ('queued','paused','submitting','accepted','uncertain','cancelled')
  AND ((state IN ('queued','paused','cancelled') AND attempt_id IS NULL AND attempt_lock_hash IS NULL AND started_at IS NULL)
   OR (state IN ('submitting','accepted','uncertain') AND attempt_id IS NOT NULL AND attempt_lock_hash IS NOT NULL
    AND attempt_id ~ '^[a-f0-9-]{36}$' AND attempt_lock_hash ~ '^[a-f0-9]{64}$' AND started_at IS NOT NULL))
 );
END $$;
