-- Task 4.14 — extend notification_type enum with 'skill_update_available'.
--
-- Pure ALTER TYPE ADD VALUE: fully backward-compatible, no data rewrite.
-- The IF NOT EXISTS clause (Postgres 12+) makes this migration idempotent.
-- Matches the same-shaped enum extension approach used elsewhere in the
-- project (see 0020_expand_role_enum.sql).

ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'skill_update_available';
