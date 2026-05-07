-- Self-hosted v1 — agent_employees soft-delete columns.
--
-- Before: the DELETE /api/agent-employees/:id handler only set is_active=false,
-- identical to PAUSE. The list endpoint didn't filter by is_active, so
-- "deleted" agents reappeared on the next page load as "paused". There was no
-- way to distinguish a paused-but-live agent from one the user had explicitly
-- removed.
--
-- After: is_deleted boolean + deleted_at timestamp, following the same pattern
-- used by `skills`, `tasks`, etc. DELETE flips is_deleted=true; the list
-- endpoint filters is_deleted=false. Paused agents (is_active=false,
-- is_deleted=false) keep showing up so users can resume them.

ALTER TABLE agent_employees
  ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;

ALTER TABLE agent_employees
  ADD COLUMN IF NOT EXISTS deleted_at timestamp;

CREATE INDEX IF NOT EXISTS agent_employees_not_deleted_idx
  ON agent_employees (org_id)
  WHERE is_deleted = false;
