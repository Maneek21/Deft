-- Additive owner-only protocol7/channel3 custody. No retained authority backfill.
ALTER TABLE app_versions DROP CONSTRAINT IF EXISTS app_versions_protocol_supported_check;
ALTER TABLE app_versions ADD CONSTRAINT app_versions_protocol_supported_check
  CHECK (protocol_version IN ('0','1','2','3','4','5','6','7'));
ALTER TABLE app_runtime_registrations DROP CONSTRAINT IF EXISTS app_runtime_registrations_contract_check;
ALTER TABLE app_runtime_registrations ADD CONSTRAINT app_runtime_registrations_contract_check
  CHECK (contract_version IN ('deft.app_runtime_channel.v1','deft.app_runtime_channel.v2','deft.app_runtime_channel.v3'));
ALTER TABLE app_resource_bindings DROP CONSTRAINT IF EXISTS app_resource_bindings_identity_check;
ALTER TABLE app_resource_bindings ADD CONSTRAINT app_resource_bindings_identity_check CHECK (
  grant_snapshot_kind = 'effective' AND provider_kind = 'app_runtime'
  AND provider_instance_id = runtime_registration_id AND owner_scope = 'private_user'
  AND resource_key ~ '^[a-z][a-z0-9_]{0,47}$'
  AND resource_family ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$' AND octet_length(resource_family) <= 64
  AND operation_name = 'sync_' || resource_key AND descriptor_digest ~ '^sha256:[a-f0-9]{64}$'
  AND ((registration_contract_version = 'deft.app_runtime_channel.v2'
    AND interface_identity = 'deft.resource_sync.v2:' || lower(org_id) || ':' || lower(app_installation_id) || ':' || resource_key)
    OR (registration_contract_version = 'deft.app_runtime_channel.v3'
    AND interface_identity = 'deft.resource_sync.v3:' || lower(org_id) || ':' || lower(app_installation_id) || ':' || resource_key))
);
ALTER TABLE app_resource_bindings DROP CONSTRAINT IF EXISTS app_resource_bindings_descriptor_check;
ALTER TABLE app_resource_bindings ADD CONSTRAINT app_resource_bindings_descriptor_check CHECK (
  jsonb_typeof(reviewed_descriptor) = 'object' AND octet_length(reviewed_descriptor::text) <= 65536
  AND ((registration_contract_version = 'deft.app_runtime_channel.v2'
    AND coalesce(reviewed_descriptor->>'schema_version','') = 'deft.app_sync_descriptor.v1')
    OR (registration_contract_version = 'deft.app_runtime_channel.v3'
    AND coalesce(reviewed_descriptor->>'schema_version','') = 'deft.app_sync_descriptor.v2'
    AND jsonb_typeof(reviewed_descriptor->'attachments') = 'object'))
);

ALTER TABLE app_resource_bindings ADD COLUMN IF NOT EXISTS attachment_policy jsonb;
ALTER TABLE app_resource_bindings ADD COLUMN IF NOT EXISTS attachment_consent_digest text;
ALTER TABLE app_resource_bindings DROP CONSTRAINT IF EXISTS app_resource_bindings_attachment_policy_check;
ALTER TABLE app_resource_bindings ADD CONSTRAINT app_resource_bindings_attachment_policy_check CHECK (
  (registration_contract_version='deft.app_runtime_channel.v2' AND attachment_policy IS NULL AND attachment_consent_digest IS NULL)
  OR (registration_contract_version='deft.app_runtime_channel.v3' AND attachment_policy IS NOT NULL
    AND attachment_consent_digest IS NOT NULL AND attachment_consent_digest ~ '^sha256:[a-f0-9]{64}$'
    AND coalesce((jsonb_typeof(attachment_policy) = 'object'
      AND attachment_policy ?& ARRAY['max_attachment_bytes','max_attachments_per_record','max_attachments_per_run','max_attachment_bytes_per_run','retention_days','allowed_media_types']
      AND attachment_policy - ARRAY['max_attachment_bytes','max_attachments_per_record','max_attachments_per_run','max_attachment_bytes_per_run','retention_days','allowed_media_types'] = '{}'::jsonb
      AND jsonb_typeof(attachment_policy->'max_attachment_bytes') = 'number'
      AND (attachment_policy->>'max_attachment_bytes')::numeric BETWEEN 1 AND 2097152
      AND (attachment_policy->>'max_attachment_bytes')::numeric = trunc((attachment_policy->>'max_attachment_bytes')::numeric)
      AND (attachment_policy->>'max_attachment_bytes')::numeric <= ((reviewed_descriptor->'attachments')->>'max_attachment_bytes')::numeric
      AND jsonb_typeof(attachment_policy->'max_attachments_per_record') = 'number'
      AND (attachment_policy->>'max_attachments_per_record')::numeric BETWEEN 1 AND 8
      AND (attachment_policy->>'max_attachments_per_record')::numeric = trunc((attachment_policy->>'max_attachments_per_record')::numeric)
      AND (attachment_policy->>'max_attachments_per_record')::numeric <= ((reviewed_descriptor->'attachments')->>'max_attachments_per_record')::numeric
      AND jsonb_typeof(attachment_policy->'max_attachments_per_run') = 'number'
      AND (attachment_policy->>'max_attachments_per_run')::numeric BETWEEN 1 AND 32
      AND (attachment_policy->>'max_attachments_per_run')::numeric = trunc((attachment_policy->>'max_attachments_per_run')::numeric)
      AND (attachment_policy->>'max_attachments_per_run')::numeric <= ((reviewed_descriptor->'attachments')->>'max_attachments_per_run')::numeric
      AND jsonb_typeof(attachment_policy->'max_attachment_bytes_per_run') = 'number'
      AND (attachment_policy->>'max_attachment_bytes_per_run')::numeric BETWEEN 1 AND 8388608
      AND (attachment_policy->>'max_attachment_bytes_per_run')::numeric = trunc((attachment_policy->>'max_attachment_bytes_per_run')::numeric)
      AND (attachment_policy->>'max_attachment_bytes_per_run')::numeric <= ((reviewed_descriptor->'attachments')->>'max_attachment_bytes_per_run')::numeric
      AND jsonb_typeof(attachment_policy->'retention_days') = 'number'
      AND (attachment_policy->>'retention_days')::numeric BETWEEN 1 AND 30
      AND (attachment_policy->>'retention_days')::numeric = trunc((attachment_policy->>'retention_days')::numeric)
      AND (attachment_policy->>'retention_days')::numeric <= ((reviewed_descriptor->'attachments')->>'retention_days')::numeric
      AND jsonb_typeof((attachment_policy->'allowed_media_types')) = 'array'
      AND jsonb_array_length((attachment_policy->'allowed_media_types')) BETWEEN 1 AND 7
      AND (attachment_policy->'allowed_media_types') <@ '["text/plain","text/csv","application/json","image/png","image/jpeg","image/gif","image/webp"]'::jsonb
      AND (attachment_policy->'allowed_media_types') <@ ((reviewed_descriptor->'attachments')->'allowed_media_types')
      AND jsonb_array_length((attachment_policy->'allowed_media_types')) = (((attachment_policy->'allowed_media_types') @> '["text/plain"]'::jsonb)::integer + ((attachment_policy->'allowed_media_types') @> '["text/csv"]'::jsonb)::integer + ((attachment_policy->'allowed_media_types') @> '["application/json"]'::jsonb)::integer + ((attachment_policy->'allowed_media_types') @> '["image/png"]'::jsonb)::integer + ((attachment_policy->'allowed_media_types') @> '["image/jpeg"]'::jsonb)::integer + ((attachment_policy->'allowed_media_types') @> '["image/gif"]'::jsonb)::integer + ((attachment_policy->'allowed_media_types') @> '["image/webp"]'::jsonb)::integer)), false)));

CREATE OR REPLACE FUNCTION enforce_app_attachment_binding_policy() RETURNS trigger AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.attachment_policy,NEW.attachment_consent_digest) IS DISTINCT FROM (OLD.attachment_policy,OLD.attachment_consent_digest) THEN
    RAISE EXCEPTION 'APP_ATTACHMENT_CONSENT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_attachment_binding_policy_guard_trigger ON app_resource_bindings;
CREATE TRIGGER app_attachment_binding_policy_guard_trigger BEFORE UPDATE ON app_resource_bindings
  FOR EACH ROW EXECUTE FUNCTION enforce_app_attachment_binding_policy();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='app_resource_projections_attachment_identity_unique'
    AND conrelid='app_resource_projections'::regclass) THEN
    ALTER TABLE app_resource_projections ADD CONSTRAINT app_resource_projections_attachment_identity_unique
      UNIQUE (org_id,id,checkpoint_id,resource_binding_id);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS app_attachment_stages (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL,
  resource_binding_id text NOT NULL,
  checkpoint_id text NOT NULL,
  generation integer NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL,
  claim_token text NOT NULL,
  reservation_sequence integer NOT NULL,
  fingerprint_key_version text NOT NULL,
  parent_locator_hmac text NOT NULL,
  parent_revision_hmac text NOT NULL,
  attachment_key_hmac text NOT NULL,
  content_hmac text,
  declared_size_bytes integer NOT NULL,
  metadata_envelope jsonb,
  binary_key_version text,
  binary_nonce_b64 text,
  binary_auth_tag_b64 text,
  object_id text,
  state text NOT NULL DEFAULT 'uploading',
  stage_expires_at timestamp NOT NULL,
  linked_expires_at timestamp,
  projection_id text,
  parent_body_hmac text,
  accepted_at timestamp,
  retired_at timestamp,
  purged_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_attachment_stages_org_id_id_unique UNIQUE (org_id,id),
  CONSTRAINT app_attachment_stages_retry_unique UNIQUE (org_id,run_id,attempt_id,checkpoint_id,generation,
    fingerprint_key_version,parent_locator_hmac,parent_revision_hmac,attachment_key_hmac),
  CONSTRAINT app_attachment_stages_checkpoint_fk FOREIGN KEY (org_id,checkpoint_id,resource_binding_id)
    REFERENCES app_sync_checkpoints(org_id,id,resource_binding_id) ON DELETE RESTRICT,
  CONSTRAINT app_attachment_stages_attempt_fk FOREIGN KEY (org_id,run_id,attempt_id)
    REFERENCES app_run_attempts(org_id,run_id,id) ON DELETE RESTRICT,
  CONSTRAINT app_attachment_stages_projection_fk FOREIGN KEY (org_id,projection_id,checkpoint_id,resource_binding_id)
    REFERENCES app_resource_projections(org_id,id,checkpoint_id,resource_binding_id) ON DELETE RESTRICT,
  CONSTRAINT app_attachment_stages_identity_check CHECK (generation >= 1 AND reservation_sequence >= 1
    AND fingerprint_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND parent_locator_hmac ~ '^[a-f0-9]{64}$' AND parent_revision_hmac ~ '^[a-f0-9]{64}$'
    AND attachment_key_hmac ~ '^[a-f0-9]{64}$'
    AND (content_hmac IS NULL OR content_hmac ~ '^[a-f0-9]{64}$')
    AND (parent_body_hmac IS NULL OR parent_body_hmac ~ '^[a-f0-9]{64}$')
    AND declared_size_bytes BETWEEN 0 AND 2097152
    AND stage_expires_at > created_at AND stage_expires_at <= created_at + interval '1 hour'),
  CONSTRAINT app_attachment_stages_metadata_check CHECK ((state = 'purged' AND metadata_envelope IS NULL)
    OR (state <> 'purged' AND metadata_envelope IS NOT NULL AND jsonb_typeof(metadata_envelope) = 'object'
      AND octet_length(metadata_envelope::text) <= 16384)),
  CONSTRAINT app_attachment_stages_state_check CHECK (
    state IN ('uploading','ready','blocked','linked','linked_blocked','retired','purged')
    AND ((state IN ('linked','linked_blocked') AND projection_id IS NOT NULL AND parent_body_hmac IS NOT NULL
      AND accepted_at IS NOT NULL AND linked_expires_at IS NOT NULL AND linked_expires_at > accepted_at
      AND linked_expires_at <= accepted_at + interval '30 days')
      OR state NOT IN ('linked','linked_blocked'))
    AND (state NOT IN ('ready','blocked','linked','linked_blocked') OR content_hmac IS NOT NULL)
    AND (state NOT IN ('blocked','linked_blocked','purged') OR (object_id IS NULL AND binary_key_version IS NULL
      AND binary_nonce_b64 IS NULL AND binary_auth_tag_b64 IS NULL))
    AND (state NOT IN ('ready','linked') OR (object_id IS NOT NULL AND binary_key_version IS NOT NULL
      AND binary_nonce_b64 IS NOT NULL AND binary_auth_tag_b64 IS NOT NULL
      AND binary_key_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      AND binary_nonce_b64 ~ '^[A-Za-z0-9+/]{16}$' AND binary_auth_tag_b64 ~ '^[A-Za-z0-9+/]{22}==$'))
    AND (state <> 'retired' OR retired_at IS NOT NULL)
    AND (state <> 'purged' OR (retired_at IS NOT NULL AND purged_at IS NOT NULL)))
);
CREATE INDEX IF NOT EXISTS app_attachment_stages_cleanup_idx ON app_attachment_stages(state,stage_expires_at,id);
CREATE INDEX IF NOT EXISTS app_attachment_stages_parent_idx ON app_attachment_stages(org_id,resource_binding_id,projection_id,state);

CREATE OR REPLACE FUNCTION enforce_app_attachment_stage() RETURNS trigger AS $$
DECLARE cp record; attempt record;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'APP_ATTACHMENT_STAGE_RETAINED' USING ERRCODE='55000'; END IF;
  -- Service writers take Run and authority locks before this checkpoint/stage.
  SELECT generation, state INTO cp FROM app_sync_checkpoints WHERE org_id=NEW.org_id
    AND id=NEW.checkpoint_id AND resource_binding_id=NEW.resource_binding_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APP_ATTACHMENT_CHECKPOINT_INVALID' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state <> 'uploading' OR NEW.generation <> cp.generation OR cp.state <> 'active'
      OR NEW.projection_id IS NOT NULL OR NEW.accepted_at IS NOT NULL OR NEW.parent_body_hmac IS NOT NULL
      OR NEW.content_hmac IS NOT NULL OR NEW.object_id IS NOT NULL
      OR NEW.binary_key_version IS NOT NULL OR NEW.binary_nonce_b64 IS NOT NULL OR NEW.binary_auth_tag_b64 IS NOT NULL THEN
      RAISE EXCEPTION 'APP_ATTACHMENT_RESERVATION_INVALID' USING ERRCODE='55000'; END IF;
    SELECT state,claim_token,runtime_sequence,resource_binding_id INTO attempt FROM app_run_attempts
      WHERE org_id=NEW.org_id AND run_id=NEW.run_id AND id=NEW.attempt_id;
    IF NOT FOUND OR attempt.state <> 'provider_call_started' OR attempt.claim_token IS DISTINCT FROM NEW.claim_token
      OR attempt.runtime_sequence IS DISTINCT FROM NEW.reservation_sequence
      OR attempt.resource_binding_id IS DISTINCT FROM NEW.resource_binding_id THEN
      RAISE EXCEPTION 'APP_ATTACHMENT_ATTEMPT_INVALID' USING ERRCODE='55000'; END IF;
  ELSE
    IF (NEW.id,NEW.org_id,NEW.resource_binding_id,NEW.checkpoint_id,NEW.generation,NEW.run_id,NEW.attempt_id,
      NEW.claim_token,NEW.reservation_sequence,NEW.fingerprint_key_version,NEW.parent_locator_hmac,NEW.parent_revision_hmac,
      NEW.attachment_key_hmac,NEW.declared_size_bytes,NEW.stage_expires_at,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.org_id,OLD.resource_binding_id,OLD.checkpoint_id,OLD.generation,OLD.run_id,OLD.attempt_id,
      OLD.claim_token,OLD.reservation_sequence,OLD.fingerprint_key_version,OLD.parent_locator_hmac,OLD.parent_revision_hmac,
      OLD.attachment_key_hmac,OLD.declared_size_bytes,OLD.stage_expires_at,OLD.created_at) THEN
      RAISE EXCEPTION 'APP_ATTACHMENT_STAGE_IMMUTABLE' USING ERRCODE='55000'; END IF;
    IF NOT ((OLD.state='uploading' AND NEW.state IN ('ready','blocked','retired'))
      OR (OLD.state='ready' AND NEW.state IN ('linked','retired'))
      OR (OLD.state='blocked' AND NEW.state IN ('linked_blocked','retired'))
      OR (OLD.state IN ('linked','linked_blocked') AND NEW.state='retired')
      OR (OLD.state='retired' AND NEW.state='purged')) THEN
      RAISE EXCEPTION 'APP_ATTACHMENT_STAGE_TRANSITION' USING ERRCODE='55000'; END IF;
    IF NEW.state IN ('ready','blocked','linked','linked_blocked') AND (NEW.generation <> cp.generation OR cp.state <> 'active') THEN
      RAISE EXCEPTION 'APP_ATTACHMENT_STAGE_STALE' USING ERRCODE='55000'; END IF;
    IF NEW.state <> 'purged' AND NEW.metadata_envelope IS DISTINCT FROM OLD.metadata_envelope THEN
      RAISE EXCEPTION 'APP_ATTACHMENT_METADATA_IMMUTABLE' USING ERRCODE='55000'; END IF;
    IF OLD.object_id IS NOT NULL AND NEW.state <> 'purged' AND
      (NEW.object_id,NEW.binary_key_version,NEW.binary_nonce_b64,NEW.binary_auth_tag_b64) IS DISTINCT FROM
      (OLD.object_id,OLD.binary_key_version,OLD.binary_nonce_b64,OLD.binary_auth_tag_b64) THEN
      RAISE EXCEPTION 'APP_ATTACHMENT_BINARY_IMMUTABLE' USING ERRCODE='55000'; END IF;
    IF OLD.content_hmac IS NOT NULL AND NEW.content_hmac IS DISTINCT FROM OLD.content_hmac THEN
      RAISE EXCEPTION 'APP_ATTACHMENT_CONTENT_IMMUTABLE' USING ERRCODE='55000'; END IF;
    IF OLD.projection_id IS NOT NULL AND (NEW.projection_id,NEW.parent_body_hmac,NEW.accepted_at,NEW.linked_expires_at)
      IS DISTINCT FROM (OLD.projection_id,OLD.parent_body_hmac,OLD.accepted_at,OLD.linked_expires_at) THEN
      RAISE EXCEPTION 'APP_ATTACHMENT_LINK_IMMUTABLE' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_attachment_stage_guard_trigger ON app_attachment_stages;
CREATE TRIGGER app_attachment_stage_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON app_attachment_stages
  FOR EACH ROW EXECUTE FUNCTION enforce_app_attachment_stage();

CREATE OR REPLACE FUNCTION account_app_attachment_stage() RETURNS trigger AS $$
DECLARE delta integer;
BEGIN
  IF TG_OP='INSERT' THEN delta := NEW.declared_size_bytes;
  ELSE delta := CASE WHEN NEW.state='purged' THEN 0 ELSE NEW.declared_size_bytes END
    - CASE WHEN OLD.state='purged' THEN 0 ELSE OLD.declared_size_bytes END; END IF;
  UPDATE app_sync_checkpoints SET retained_bytes=retained_bytes+delta,updated_at=now()
    WHERE org_id=NEW.org_id AND id=NEW.checkpoint_id AND resource_binding_id=NEW.resource_binding_id;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_attachment_stage_capacity_trigger ON app_attachment_stages;
CREATE TRIGGER app_attachment_stage_capacity_trigger AFTER INSERT OR UPDATE ON app_attachment_stages
  FOR EACH ROW EXECUTE FUNCTION account_app_attachment_stage();
