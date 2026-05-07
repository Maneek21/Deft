-- Migration 0063: Add users.kind enum
-- Phase 1 of agent-chat unification (docs/superpowers/specs/2026-05-07-agent-chat-unification.md).
-- Introduces a participant-kind enum on users. Backfills from is_agent and email patterns.
-- is_agent is retained for backwards compat; a follow-on plan drops it.

-- 1. Create the enum
DO $$ BEGIN
  CREATE TYPE user_kind AS ENUM ('human', 'agent', 'system');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 2. Add the column with default 'human'
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS kind user_kind NOT NULL DEFAULT 'human';

-- 3. Backfill: rows with is_agent=true become 'agent'
UPDATE users SET kind = 'agent' WHERE is_agent = true;

-- 4. Backfill: the well-known Defty system user becomes 'agent' (it's an agent participant, not 'system')
--    'system' is reserved for cron/webhook senders we'll add in Phase 5.
UPDATE users SET kind = 'agent' WHERE email = 'deft-agent@system.local';

-- 5. Index for the common filter (e.g. @-autocomplete sorting)
CREATE INDEX IF NOT EXISTS users_kind_idx ON users(kind);
