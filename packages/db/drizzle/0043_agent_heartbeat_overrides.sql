-- Task 8.2 — agent_employees.heartbeat_overrides
--
-- Per-employee overlay for the heartbeat prompt + cadence. The column is
-- optional jsonb so rows seeded pre-Phase-8 keep working without a default
-- payload. Supported keys (documented in apps/api/src/lib/heartbeat-prompt.ts):
--
--   {
--     "checklist": ["foo", "bar"],      -- additional checklist items (deduped
--                                          against skill-derived ones)
--     "cadence_minutes": 60             -- per-employee cron cadence override
--                                          (min 5, max 360) — used by Task 8.3
--   }
--
-- Additive + idempotent.

ALTER TABLE "agent_employees"
  ADD COLUMN IF NOT EXISTS "heartbeat_overrides" jsonb;
