-- Account-scoped local snooze and follow-up timers. Message identity and
-- reminder text live only in encrypted timer_envelope; the digest is a lookup key.
CREATE TABLE IF NOT EXISTS email_timers (
  org_id text NOT NULL,
  owner_user_id text NOT NULL,
  account_id text NOT NULL,
  timer_id text NOT NULL,
  logical_message_digest text NOT NULL,
  kind text NOT NULL,
  revision integer NOT NULL,
  state text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  display_timezone text NOT NULL,
  timer_envelope jsonb NOT NULL,
  firing_job_id text,
  firing_lock_token text,
  firing_lease_expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_timers_pkey PRIMARY KEY (org_id, owner_user_id, account_id, timer_id),
  CONSTRAINT email_timers_account_fk FOREIGN KEY (org_id, owner_user_id, account_id)
    REFERENCES email_accounts (org_id, owner_user_id, account_id) ON DELETE RESTRICT,
  CONSTRAINT email_timers_id_check CHECK (timer_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
  CONSTRAINT email_timers_target_digest_check CHECK (logical_message_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT email_timers_kind_check CHECK (kind IN ('snooze','follow_up')),
  CONSTRAINT email_timers_revision_check CHECK (revision BETWEEN 1 AND 2147483647),
  CONSTRAINT email_timers_state_check CHECK (state IN ('scheduled','firing','completed','cancelled','blocked')),
  CONSTRAINT email_timers_timezone_check CHECK (length(display_timezone) BETWEEN 1 AND 128),
  CONSTRAINT email_timers_envelope_check CHECK (jsonb_typeof(timer_envelope)='object' AND octet_length(timer_envelope::text)<=32768),
  CONSTRAINT email_timers_firing_lease_check CHECK (
    (state='firing' AND firing_job_id IS NOT NULL AND firing_lock_token IS NOT NULL AND firing_lease_expires_at IS NOT NULL)
    OR (state<>'firing' AND firing_job_id IS NULL AND firing_lock_token IS NULL AND firing_lease_expires_at IS NULL)),
  CONSTRAINT email_timers_completed_check CHECK ((state='completed' AND completed_at IS NOT NULL) OR (state<>'completed' AND completed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS email_timers_due_idx
  ON email_timers (org_id, owner_user_id, account_id, state, scheduled_at, timer_id);
CREATE INDEX IF NOT EXISTS email_timers_target_idx
  ON email_timers (org_id, owner_user_id, account_id, logical_message_digest, kind, state);
CREATE UNIQUE INDEX IF NOT EXISTS email_timers_active_snooze_unique
  ON email_timers (org_id, owner_user_id, account_id, logical_message_digest)
  WHERE kind='snooze' AND state IN ('scheduled','firing','blocked');
