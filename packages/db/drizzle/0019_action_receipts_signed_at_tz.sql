-- Phase 12 review fix — action_receipts.signed_at was `timestamp`
-- (without time zone). Drizzle writes a JS Date as UTC but the naked
-- timestamp column strips the offset, so on read it gets re-interpreted
-- as local time. The generate-side canonical envelope had the UTC ISO
-- string; the verify-side got the local-shifted Date, producing a
-- different ISO string. Receipts generated after the Phase 12 expansion
-- of the signed envelope would then fail verification.
--
-- Fix: convert signed_at (and the surrounding created_at/updated_at for
-- consistency) to timestamptz so the offset round-trips cleanly.
ALTER TABLE "action_receipts"
  ALTER COLUMN "signed_at" TYPE timestamptz USING "signed_at" AT TIME ZONE 'UTC';

ALTER TABLE "action_receipts"
  ALTER COLUMN "created_at" TYPE timestamptz USING "created_at" AT TIME ZONE 'UTC';

ALTER TABLE "action_receipts"
  ALTER COLUMN "updated_at" TYPE timestamptz USING "updated_at" AT TIME ZONE 'UTC';
