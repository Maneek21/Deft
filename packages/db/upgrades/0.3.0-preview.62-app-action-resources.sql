-- Immutable owner-reviewed native source companion; no action input or receipt rewrite.
ALTER TABLE app_run_secret_payloads DROP CONSTRAINT IF EXISTS app_run_secret_payloads_kind_shape_check;
ALTER TABLE app_run_secret_payloads ADD CONSTRAINT app_run_secret_payloads_kind_shape_check CHECK (
 (payload_kind='input' AND attempt_id IS NULL AND payload_bytes BETWEEN 1 AND 262144)
 OR (payload_kind='output' AND attempt_id IS NOT NULL AND payload_bytes BETWEEN 1 AND 1048576)
 OR (payload_kind='action_resources' AND attempt_id IS NULL AND payload_bytes BETWEEN 1 AND 196608));
CREATE UNIQUE INDEX IF NOT EXISTS app_run_secret_payloads_action_resources_unique ON app_run_secret_payloads(org_id,run_id,payload_kind) WHERE payload_kind='action_resources';
