-- Task 61 — expand agent_employee_role enum to cover all 8 first-party
-- templates. Previously Phase 9 mapped 5 templates (designer, qa, cs,
-- community, cfo) to 'custom' because the enum only had 4 values.
--
-- ALTER TYPE … ADD VALUE must run outside a transaction block, so these
-- are top-level statements. IF NOT EXISTS makes the migration idempotent
-- in case a partial run already added some values.
ALTER TYPE "agent_employee_role" ADD VALUE IF NOT EXISTS 'product_designer';
ALTER TYPE "agent_employee_role" ADD VALUE IF NOT EXISTS 'qa_engineer';
ALTER TYPE "agent_employee_role" ADD VALUE IF NOT EXISTS 'customer_success';
ALTER TYPE "agent_employee_role" ADD VALUE IF NOT EXISTS 'community_manager';
ALTER TYPE "agent_employee_role" ADD VALUE IF NOT EXISTS 'cfo';

-- Backfill existing agent_employees rows that were deployed from these
-- templates before the enum expansion. Only touch rows still at 'custom'
-- so we don't clobber any operator-configured role override.
-- Safe to rerun — the WHERE clause filters idempotently.
UPDATE "agent_employees" SET "role" = 'product_designer'
  WHERE "template_slug" = 'designer' AND "role" = 'custom';
UPDATE "agent_employees" SET "role" = 'qa_engineer'
  WHERE "template_slug" = 'qa' AND "role" = 'custom';
UPDATE "agent_employees" SET "role" = 'customer_success'
  WHERE "template_slug" = 'cs' AND "role" = 'custom';
UPDATE "agent_employees" SET "role" = 'community_manager'
  WHERE "template_slug" = 'community' AND "role" = 'custom';
UPDATE "agent_employees" SET "role" = 'cfo'
  WHERE "template_slug" = 'cfo' AND "role" = 'custom';
