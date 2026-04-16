-- Task 3.9 — plan fail-fast + rollback-on-fail modes.
--
-- Two new booleans on agent_plans govern how the plan-execution engine
-- reacts when a step fails:
--   * fail_fast: when true, a step failure marks every later step as
--     'skipped_due_to_failure' (a new step status stored in the steps
--     jsonb array) and stops execution immediately.
--   * rollback_on_fail: when true AND fail_fast is also true, the engine
--     reverses every successful write-action step taken earlier in the
--     plan (create_task → soft-delete, post_message → mark deleted, etc).
--
-- Both default false to preserve existing behavior for plans created
-- before this migration.

ALTER TABLE agent_plans
  ADD COLUMN IF NOT EXISTS fail_fast boolean NOT NULL DEFAULT false;

ALTER TABLE agent_plans
  ADD COLUMN IF NOT EXISTS rollback_on_fail boolean NOT NULL DEFAULT false;
