ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS org_id text;
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS dedupe_key text;
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS locked_by text;
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS lock_token text;
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS lock_expires_at timestamp;

-- Deploys upgrading from the pre-lease queue cannot prove ownership of rows
-- left in `running`. Recover retryable work and terminal-fail exhausted work
-- before a lease-aware worker starts claiming.
UPDATE job_queue
SET status = CASE WHEN attempts < max_attempts THEN 'pending' ELSE 'failed' END,
    run_at = CASE
      WHEN attempts < max_attempts THEN now() + interval '5 seconds'
      ELSE run_at
    END,
    started_at = CASE WHEN attempts < max_attempts THEN NULL ELSE started_at END,
    completed_at = CASE WHEN attempts < max_attempts THEN NULL ELSE now() END,
    error = 'recovered during lease migration',
    locked_by = NULL,
    lock_token = NULL,
    lock_expires_at = NULL
WHERE status = 'running';

-- Most existing payloads already carry tenant context. System cron jobs stay
-- NULL by design.
UPDATE job_queue
SET org_id = COALESCE(
  NULLIF(data->>'orgId', ''),
  NULLIF(data->>'org_id', '')
)
WHERE org_id IS NULL
  AND COALESCE(NULLIF(data->>'orgId', ''), NULLIF(data->>'org_id', '')) IS NOT NULL;

-- Backfill durable producer keys before enabling the constraint. Both camel-
-- and snake-case payload spellings are accepted for legacy rows.
UPDATE job_queue AS jq
SET org_id = COALESCE(jq.org_id, r.org_id),
    dedupe_key = 'reminder:' || r.id
FROM reminders AS r
WHERE jq.name = 'reminder-fire'
  AND jq.status IN ('pending', 'running')
  AND jq.dedupe_key IS NULL
  AND r.id = COALESCE(jq.data->>'reminderId', jq.data->>'reminder_id');

UPDATE job_queue AS jq
SET org_id = COALESCE(jq.org_id, sm.org_id),
    dedupe_key = 'scheduled-message:' || sm.id
FROM scheduled_messages AS sm
WHERE jq.name = 'scheduled-message-send'
  AND jq.status IN ('pending', 'running')
  AND jq.dedupe_key IS NULL
  AND sm.id = COALESCE(
    jq.data->>'scheduledId',
    jq.data->>'scheduledMessageId',
    jq.data->>'scheduled_message_id'
  );

-- Preserve one canonical row for each backfilled idempotency key. Superseded
-- rows stay in the audit trail but relinquish the key before the unique index
-- is created.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY org_id, dedupe_key
           ORDER BY
             CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
             run_at,
             created_at,
             id
         ) AS ordinal
  FROM job_queue
  WHERE dedupe_key IS NOT NULL
)
UPDATE job_queue AS jq
SET status = 'failed',
    completed_at = now(),
    error = 'superseded duplicate during queue hardening migration',
    dedupe_key = NULL,
    locked_by = NULL,
    lock_token = NULL,
    lock_expires_at = NULL
FROM ranked
WHERE jq.id = ranked.id
  AND ranked.ordinal > 1;

-- The old check-then-insert cron registration was race-prone. Retain the
-- earliest active occurrence and terminal-fail duplicate active rows before
-- replacing the non-unique lookup index.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY cron_key
           ORDER BY run_at, created_at, id
         ) AS ordinal
  FROM job_queue
  WHERE cron_key IS NOT NULL
    AND status IN ('pending', 'running')
)
UPDATE job_queue AS jq
SET status = 'failed',
    completed_at = now(),
    error = 'superseded duplicate cron occurrence during queue hardening migration',
    locked_by = NULL,
    lock_token = NULL,
    lock_expires_at = NULL
FROM ranked
WHERE jq.id = ranked.id
  AND ranked.ordinal > 1;

DROP INDEX IF EXISTS job_queue_cron_idx;

CREATE INDEX IF NOT EXISTS job_queue_org_idx ON job_queue (org_id);
CREATE INDEX IF NOT EXISTS job_queue_lease_idx
  ON job_queue (status, lock_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS job_queue_dedupe_unique
  ON job_queue (COALESCE(org_id, ''), dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS job_queue_active_cron_unique
  ON job_queue (cron_key)
  WHERE cron_key IS NOT NULL AND status IN ('pending', 'running');

-- Reminder delivery can be retried after an at-least-once lease loss. Retain
-- one historical notification per reminder before enforcing idempotent inserts.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY org_id, metadata->>'reminder_id'
           ORDER BY created_at, id
         ) AS ordinal
  FROM notifications
  WHERE type = 'reminder'
    AND metadata ? 'reminder_id'
)
DELETE FROM notifications AS n
USING ranked
WHERE n.id = ranked.id
  AND ranked.ordinal > 1;

CREATE UNIQUE INDEX IF NOT EXISTS notification_reminder_unique
  ON notifications (org_id, (metadata->>'reminder_id'))
  WHERE type = 'reminder' AND metadata ? 'reminder_id';
