-- Task 5.8 — Project soft-delete support.
--
-- Adds `is_deleted` + `deleted_at` to projects. `is_archived` already
-- exists. Soft-delete is the DELETE behaviour; tasks remain in the DB
-- for audit. A 7-day recovery window is enforced by a read-side filter
-- (`deleted_at > NOW() - INTERVAL '7 days'`).
--
-- Additive + idempotent.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "is_deleted" boolean NOT NULL DEFAULT false;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;

CREATE INDEX IF NOT EXISTS "projects_is_deleted_idx" ON "projects" ("is_deleted");
