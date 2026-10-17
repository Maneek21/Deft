-- Refuse destructive rollback while unexpired retained source companions exist.
DO $$ BEGIN IF EXISTS(SELECT 1 FROM app_run_secret_payloads WHERE payload_kind='action_resources') THEN RAISE EXCEPTION 'Retained action resources must expire and be purged before rollback'; END IF; END $$;
DROP INDEX IF EXISTS app_run_secret_payloads_action_resources_unique;
ALTER TABLE app_run_secret_payloads DROP CONSTRAINT IF EXISTS app_run_secret_payloads_kind_shape_check;
ALTER TABLE app_run_secret_payloads ADD CONSTRAINT app_run_secret_payloads_kind_shape_check CHECK (
 (payload_kind='input' AND attempt_id IS NULL AND payload_bytes BETWEEN 1 AND 262144)
 OR (payload_kind='output' AND attempt_id IS NOT NULL AND payload_bytes BETWEEN 1 AND 1048576));
