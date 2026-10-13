CREATE TABLE IF NOT EXISTS automation_runs (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  kind text NOT NULL,
  subject_id text,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  agent_employee_id text,
  idempotency_key text NOT NULL,
  scheduled_for timestamp NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  generator text NOT NULL DEFAULT 'native',
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb,
  result_entity_id text,
  error text,
  started_at timestamp,
  completed_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_idempotency_unique
  ON automation_runs (org_id, idempotency_key);
CREATE INDEX IF NOT EXISTS automation_runs_org_kind_status_idx
  ON automation_runs (org_id, kind, status);
CREATE INDEX IF NOT EXISTS automation_runs_scheduled_idx
  ON automation_runs (scheduled_for);

DELETE FROM meeting_briefs older
USING meeting_briefs newer
WHERE older.event_id = newer.event_id
  AND older.user_id = newer.user_id
  AND (
    older.created_at < newer.created_at
    OR (older.created_at = newer.created_at AND older.id < newer.id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS meeting_briefs_event_user_unique
  ON meeting_briefs (event_id, user_id);
