-- ICS calendar sync — read external calendars without OAuth.
--
-- Two directions:
--   Inbound  (user's calendar → Deft): the user pastes a secret ICS feed URL
--            (Google "Secret address in iCal format", iCloud "Public Calendar
--            URL", Outlook ICS link) into Settings → Calendar. A worker fetches
--            it on `sync_interval_min` and upserts rows into `events` with
--            source='ics'. Read-only into Deft.
--   Outbound (Deft → user's calendar): each user gets a personal ICS feed URL
--            secured by a per-user `ics_publish_token`. The user pastes that
--            into Apple/Google/Outlook, which subscribes and reads on its own
--            schedule.
--
-- Both directions are pure protocol — no OAuth, no client_id, no managed
-- vendor. Apple Calendar / Google Calendar / Outlook all speak this with no
-- platform credentials.

-- 1. Extend the event_source enum so ICS-ingested events fit the unified
--    `events` table alongside Google/GitHub/Slack/Gmail.
ALTER TYPE event_source ADD VALUE IF NOT EXISTS 'ics';

-- 2. Per-user outbound feed token. Lazily generated the first time the
--    user opens Settings → Calendar; never leaves the server otherwise.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ics_publish_token text;
CREATE UNIQUE INDEX IF NOT EXISTS users_ics_publish_token_uidx
  ON users (ics_publish_token) WHERE ics_publish_token IS NOT NULL;

-- 3. Inbound subscriptions. One row per (user, ICS feed URL).
CREATE TABLE IF NOT EXISTS ics_subscriptions (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ics_url text NOT NULL,
  label text,
  sync_interval_min integer NOT NULL DEFAULT 15,
  is_active boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  last_error text,
  last_event_count integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ics_subscriptions_user_idx ON ics_subscriptions (user_id);
CREATE INDEX IF NOT EXISTS ics_subscriptions_org_idx ON ics_subscriptions (org_id);
CREATE INDEX IF NOT EXISTS ics_subscriptions_active_idx ON ics_subscriptions (is_active) WHERE is_active = true;
