ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "profile_summary" text,
  ADD COLUMN IF NOT EXISTS "expertise_tags" text[];
