-- Task 6.3 — Emoji reactions on tasks.
--
-- Slack-style quick reactions so a team can signal "seen" / "shipped" / "LGTM"
-- without dropping a comment. The (task_id, user_id, emoji) tuple is unique:
-- the same user reacting with the same emoji twice is a toggle-off, enforced
-- in the route handler. Counts are computed on read (GET /api/tasks/:id).
--
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS "task_reactions" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "orgs"("id") ON DELETE CASCADE,
  "task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "emoji" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT NOW(),
  UNIQUE ("task_id", "user_id", "emoji")
);

CREATE INDEX IF NOT EXISTS "task_reactions_task_idx" ON "task_reactions" ("task_id");
CREATE INDEX IF NOT EXISTS "task_reactions_org_idx" ON "task_reactions" ("org_id");
