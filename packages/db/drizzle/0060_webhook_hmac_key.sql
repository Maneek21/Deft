-- Fix #7 — webhook HMAC-SHA256 signature auth.
--
-- Adds an encrypted per-webhook HMAC key alongside the existing scrypt
-- secret hash. New webhooks issue both at creation time so callers can
-- migrate to HMAC signing (`x-deft-webhook-signature: sha256=<hex>`),
-- which never ships the raw secret on the wire.
--
-- The legacy scrypt secret continues to work during the transition
-- window (`x-deft-webhook-secret`); existing rows have NULL
-- hmac_key_encrypted until they're rotated.

ALTER TABLE agent_webhooks ADD COLUMN IF NOT EXISTS hmac_key_encrypted text;
