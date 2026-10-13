-- Keep existing receipt identities and destination copies; permit the shared
-- Chat forwarding destination through the same reviewed transfer transaction.
ALTER TABLE email_context_transfers DROP CONSTRAINT IF EXISTS email_context_transfer_kind_check;
ALTER TABLE email_context_transfers ADD CONSTRAINT email_context_transfer_kind_check
  CHECK (destination_kind IN ('note','knowledge','chat'));
