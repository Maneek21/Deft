-- Task 4.11 — tasks.metadata JSONB for skill-defined custom fields.
--
-- Resolved skill configs can declare arbitrary custom fields (text, select,
-- number, date, url, user, currency). The UI writes these back to a single
-- JSONB column keyed by the field id (e.g. { "contact_name": "Acme",
-- "deal_value": 12500 }). We keep native task columns canonical — metadata
-- is purely for skill-extension data so deleting/reattaching a skill never
-- requires a schema change.
--
-- Additive + idempotent. No FTS integration (tasks.search_vector still
-- covers title + description only — metadata FTS is a follow-up).

ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
