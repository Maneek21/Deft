-- Additive discriminator only. Existing envelopes and operation kinds retained.
ALTER TABLE email_operations DROP CONSTRAINT email_operations_kind_check;
ALTER TABLE email_operations ADD CONSTRAINT email_operations_kind_check
  CHECK (kind IN ('triage','draft_sync','send_upload','sent_copy','folder_manage'));
