ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "notification_preferences" jsonb NOT NULL
  DEFAULT '{"keywords":[],"channels":{"chat":true,"tasks":true,"approvals":true,"calendar":true,"agents":true}}'::jsonb;

UPDATE "users"
SET "notification_preferences" = jsonb_set(
  "notification_preferences",
  '{keywords}',
  to_jsonb(COALESCE("notification_keywords", ARRAY[]::text[]))
)
WHERE "notification_keywords" IS NOT NULL;
