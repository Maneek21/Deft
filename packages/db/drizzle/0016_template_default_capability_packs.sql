-- Phase 9 — Move TEMPLATE_DEFAULT_PACKS from an in-code hashmap into a real
-- DB column so community-authored templates can declare their own defaults.
-- The Phase 8 hashmap in `apps/api/src/lib/capability-packs.ts` is retained
-- as a read-only fallback for any row that has not been re-seeded yet.
ALTER TABLE "agent_employee_templates"
  ADD COLUMN IF NOT EXISTS "default_capability_packs" text[];
