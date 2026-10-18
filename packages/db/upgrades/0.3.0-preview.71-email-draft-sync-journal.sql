-- Reuse the scoped encrypted operation journal for bounded native Graph draft
-- update sagas. Existing triage rows and started states remain unchanged.
DO $$ BEGIN
  ALTER TABLE email_operations DROP CONSTRAINT IF EXISTS email_operations_kind_check;
  ALTER TABLE email_operations ADD CONSTRAINT email_operations_kind_check
    CHECK(kind IN ('triage','draft_sync'));
END $$;
