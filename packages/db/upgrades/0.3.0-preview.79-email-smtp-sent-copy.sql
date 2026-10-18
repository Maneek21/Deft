-- A separate accepted-send copy journal never authorizes SMTP retransmission.
DO $$ BEGIN
 ALTER TABLE email_operations DROP CONSTRAINT IF EXISTS email_operations_kind_check;
 ALTER TABLE email_operations ADD CONSTRAINT email_operations_kind_check CHECK(kind IN ('triage','draft_sync','send_upload','sent_copy'));
END $$;
