-- Task 8.4 — agent_heartbeat_turns table.
-- Task 8.5 — cost guardrail columns on agent_employees.
--
-- The turns table is the session-inspector feed for heartbeats: one row per
-- heartbeat tick, whether it dispatched, was skipped for budget/idempotency,
-- or errored. Separate from `agent_session_turns` (which covers chat +
-- trigger invocations) so queries on "heartbeat-only" stay fast.
--
-- The agent_employees ALTERs carry the daily cost cap + circuit breaker
-- fields Task 8.5 introduces. Bundled into 0044 (rather than split into
-- 0045) per the Phase 8 plan note that the 8.5 schema can ride this
-- migration when cleaner.
--
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS "agent_heartbeat_turns" (
  "id" text PRIMARY KEY,
  "org_id" text NOT NULL REFERENCES "orgs"("id"),
  "agent_employee_id" text NOT NULL REFERENCES "agent_employees"("id") ON DELETE CASCADE,
  "fired_at" timestamp NOT NULL DEFAULT NOW(),
  "cadence_minutes" int NOT NULL,
  "prompt_sha" text NOT NULL,
  "action_count" int NOT NULL DEFAULT 0,
  "tokens_in" int,
  "tokens_out" int,
  "cost_cents" int,
  "outcome" text NOT NULL,
  "outcome_reason" text,
  "summary" text,
  "raw_response" jsonb
);

CREATE INDEX IF NOT EXISTS "aht_employee_fired_idx"
  ON "agent_heartbeat_turns" ("agent_employee_id", "fired_at" DESC);
CREATE INDEX IF NOT EXISTS "aht_org_fired_idx"
  ON "agent_heartbeat_turns" ("org_id", "fired_at" DESC);

-- Task 8.5 — daily cost + circuit breaker columns.
ALTER TABLE "agent_employees"
  ADD COLUMN IF NOT EXISTS "daily_budget_cents" int NOT NULL DEFAULT 10000,
  ADD COLUMN IF NOT EXISTS "daily_cost_cents" int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "unhealthy" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "unhealthy_reason" text;
