-- M20 tranche: metadata-only, account-scoped new-mail event outbox and local unread snooze projection.
CREATE TABLE IF NOT EXISTS email_notification_states (
  org_id text NOT NULL,
  owner_user_id text NOT NULL,
  account_id text NOT NULL,
  initial_inventory_complete boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_notification_states_pkey PRIMARY KEY (org_id, owner_user_id, account_id),
  CONSTRAINT email_notification_states_account_fk FOREIGN KEY (org_id, owner_user_id, account_id)
    REFERENCES email_accounts(org_id, owner_user_id, account_id) ON DELETE RESTRICT
);

-- Existing complete inventories are already past initial backfill and may notify on future arrivals.
INSERT INTO email_notification_states(org_id, owner_user_id, account_id, initial_inventory_complete)
SELECT org_id, owner_user_id, account_id, coverage = 'complete' FROM email_checkpoints
ON CONFLICT (org_id, owner_user_id, account_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS email_notification_events (
  org_id text NOT NULL,
  owner_user_id text NOT NULL,
  account_id text NOT NULL,
  notification_id uuid NOT NULL,
  logical_message_id text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  authority_revision integer NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  projected_at timestamptz,
  CONSTRAINT email_notification_events_pkey PRIMARY KEY (org_id, owner_user_id, account_id, notification_id),
  CONSTRAINT email_notification_events_message_unique UNIQUE (org_id, owner_user_id, account_id, logical_message_id),
  CONSTRAINT email_notification_events_account_fk FOREIGN KEY (org_id, owner_user_id, account_id)
    REFERENCES email_accounts(org_id, owner_user_id, account_id) ON DELETE RESTRICT,
  CONSTRAINT email_notification_events_identity_check CHECK (logical_message_id ~ '^mail_[a-f0-9]{64}$' AND revision > 0 AND authority_revision > 0),
  CONSTRAINT email_notification_events_state_check CHECK (state IN ('pending','projected','suppressed'))
);
CREATE INDEX IF NOT EXISTS email_notification_events_pending_idx
  ON email_notification_events(org_id, owner_user_id, account_id, created_at) WHERE state = 'pending';
