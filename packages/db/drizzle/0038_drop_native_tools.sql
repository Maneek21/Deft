-- Task 4.12 — Drop the legacy agent_employees.native_tools[] column.
--
-- Phase 4 promoted per-employee tool selection to the skills primitive
-- (see migrations 0035/0036/0037). The native_tools text[] column is the
-- last vestige of the pre-skills model. Nothing in the runtime reads it
-- any more — the Phase 4 audit confirmed the tool-filter path in
-- apps/api/src/routes/agent.ts is superseded by the skills junction, and
-- every role template seeds native_tools = NULL.
--
-- IF EXISTS keeps this idempotent across environments that may have
-- already been re-seeded. CASCADE drops any lingering indexes or
-- dependent views (there are none at the time of this migration, but the
-- guard is cheap).

ALTER TABLE agent_employees DROP COLUMN IF EXISTS native_tools CASCADE;
