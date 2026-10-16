-- Forward-only protocol 6 and host-native Calendar. No retained-row backfill or authority carry.
ALTER TABLE app_runs ADD COLUMN IF NOT EXISTS origin_native_binding_id text;
ALTER TABLE app_public_endpoints ADD COLUMN IF NOT EXISTS native_binding_id text;
ALTER TABLE app_public_endpoints ADD COLUMN IF NOT EXISTS native_input_mapping jsonb;
ALTER TABLE app_canonical_claims ADD COLUMN IF NOT EXISTS claimed_resource_revision integer;
-- Additive host-native Calendar authority; retain all previous rows and contract branches.
CREATE TABLE IF NOT EXISTS "app_native_bindings" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "app_installation_id" text NOT NULL,
  "app_version_id" text NOT NULL,
  "grant_snapshot_id" text NOT NULL,
  "grant_snapshot_kind" text NOT NULL DEFAULT 'effective',
  "action_key" text NOT NULL,
  "operation_name" text NOT NULL,
  "provider_kind" text NOT NULL DEFAULT 'native',
  "provider_instance_id" text NOT NULL,
  "provider_snapshot_id" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "stage_manager_user_id" text NOT NULL,
  "stage_manager_authorization_version" integer NOT NULL,
  "owner_authorization_version" integer NOT NULL,
  "installation_lifecycle_epoch" integer NOT NULL,
  "installation_grant_epoch" integer NOT NULL,
  "package_digest" text NOT NULL,
  "grant_snapshot_digest" text NOT NULL,
  "target" jsonb NOT NULL,
  "proposal_digest" text NOT NULL,
  "consent_digest" text,
  "reviewed_contract_digest" text NOT NULL,
  "risk_class" text NOT NULL DEFAULT 'internal_write',
  "review_requirement" text NOT NULL DEFAULT 'always',
  "review_scope" text NOT NULL DEFAULT 'per_invocation',
  "retry_class" text NOT NULL DEFAULT 'idempotent_with_key',
  "retention_class" text NOT NULL DEFAULT 'standard',
  "state" text NOT NULL DEFAULT 'staged',
  "reviewed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "app_native_bindings_org_id_id_unique" UNIQUE ("org_id", "id"),
  CONSTRAINT "app_native_bindings_owner_identity_unique" UNIQUE ("org_id", "app_installation_id", "app_version_id", "grant_snapshot_id", "id", "owner_user_id"),
  CONSTRAINT "app_native_bindings_run_identity_unique" UNIQUE ("org_id", "app_installation_id", "app_version_id", "grant_snapshot_id", "id", "provider_kind", "provider_instance_id", "operation_name", "provider_snapshot_id", "owner_user_id", "risk_class", "review_requirement", "review_scope", "retry_class", "retention_class"),
  CONSTRAINT "app_native_bindings_grant_fk" FOREIGN KEY ("org_id", "app_installation_id", "app_version_id", "grant_snapshot_id", "grant_snapshot_kind") REFERENCES "app_grant_snapshots" ("org_id", "app_installation_id", "app_version_id", "id", "snapshot_kind") ON DELETE restrict,
  CONSTRAINT "app_native_bindings_provider_fk" FOREIGN KEY ("org_id", "provider_kind", "provider_instance_id", "provider_snapshot_id") REFERENCES "capability_provider_snapshots" ("org_id", "provider_kind", "provider_instance_id", "id") ON DELETE restrict,
  CONSTRAINT "app_native_bindings_owner_fk" FOREIGN KEY ("org_id", "owner_user_id") REFERENCES "org_members" ("org_id", "user_id") ON DELETE restrict,
  CONSTRAINT "app_native_bindings_manager_fk" FOREIGN KEY ("org_id", "stage_manager_user_id") REFERENCES "org_members" ("org_id", "user_id") ON DELETE restrict,
  CONSTRAINT "app_native_bindings_identity_check" CHECK ("provider_kind" = 'native' AND "grant_snapshot_kind" = 'effective'
    AND "provider_instance_id" = 'calendar:' || "owner_user_id"
    AND "operation_name" IN ('calendar.events.create.v1', 'calendar.events.cancel.v1')
    AND "action_key" ~ '^[a-z][a-z0-9_]{0,47}$' AND "action_key" !~ '^(deft|core|system)(_|$)'),
  CONSTRAINT "app_native_bindings_policy_check" CHECK ("risk_class" = 'internal_write' AND "review_requirement" = 'always'
    AND "review_scope" = 'per_invocation' AND "retry_class" = 'idempotent_with_key' AND "retention_class" = 'standard'),
  CONSTRAINT "app_native_bindings_epoch_check" CHECK ("installation_lifecycle_epoch" >= 0 AND "installation_grant_epoch" >= 1
    AND "stage_manager_authorization_version" >= 1 AND "owner_authorization_version" >= 1),
  CONSTRAINT "app_native_bindings_digest_check" CHECK ("proposal_digest" ~ '^sha256:[a-f0-9]{64}$'
    AND "reviewed_contract_digest" ~ '^sha256:[a-f0-9]{64}$' AND "package_digest" ~ '^sha256:[a-f0-9]{64}$'
    AND "grant_snapshot_digest" ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT "app_native_bindings_state_check" CHECK ("state" IN ('staged', 'active', 'revoked')
    AND (("consent_digest" IS NULL AND "reviewed_at" IS NULL AND "state" <> 'active')
      OR ("consent_digest" IS NOT NULL AND "consent_digest" ~ '^sha256:[a-f0-9]{64}$' AND "reviewed_at" IS NOT NULL AND "state" <> 'staged'))),
  CONSTRAINT "app_native_bindings_target_check" CHECK (jsonb_typeof("target") = 'object' AND octet_length("target"::text) <= 1024)
);
CREATE UNIQUE INDEX IF NOT EXISTS "app_native_bindings_current_action_unique" ON "app_native_bindings" ("org_id", "app_installation_id", "app_version_id", "grant_snapshot_id", "action_key") WHERE "state" <> 'revoked';
ALTER TABLE "app_runs" DROP CONSTRAINT IF EXISTS "app_runs_native_binding_fk";
ALTER TABLE "app_runs" ADD CONSTRAINT "app_runs_native_binding_fk" FOREIGN KEY ("org_id", "origin_app_installation_id", "origin_app_version_id", "origin_app_grant_snapshot_id", "origin_native_binding_id", "provider_kind", "provider_instance_id", "operation_name", "provider_snapshot_id", "execution_actor_id", "risk_class", "review_requirement", "review_scope", "retry_class", "retention_class") REFERENCES "app_native_bindings" ("org_id", "app_installation_id", "app_version_id", "grant_snapshot_id", "id", "provider_kind", "provider_instance_id", "operation_name", "provider_snapshot_id", "owner_user_id", "risk_class", "review_requirement", "review_scope", "retry_class", "retention_class") ON DELETE restrict;
ALTER TABLE "app_public_endpoints" DROP CONSTRAINT IF EXISTS "app_public_endpoints_native_binding_fk";
ALTER TABLE "app_public_endpoints" ADD CONSTRAINT "app_public_endpoints_native_binding_fk" FOREIGN KEY ("org_id", "app_installation_id", "app_version_id", "grant_snapshot_id", "native_binding_id", "approver_user_id") REFERENCES "app_native_bindings" ("org_id", "app_installation_id", "app_version_id", "grant_snapshot_id", "id", "owner_user_id") ON DELETE restrict;

ALTER TABLE capability_provider_snapshots DROP CONSTRAINT IF EXISTS capability_provider_snapshots_kind_check;
ALTER TABLE capability_provider_snapshots ADD CONSTRAINT capability_provider_snapshots_kind_check CHECK (provider_kind IN ('mcp', 'app_runtime', 'native'));

ALTER TABLE app_runs DROP CONSTRAINT IF EXISTS app_runs_provider_kind_check;
ALTER TABLE app_runs ADD CONSTRAINT app_runs_provider_kind_check CHECK (provider_kind IN ('mcp', 'app_runtime', 'native'));

ALTER TABLE app_runs DROP CONSTRAINT IF EXISTS app_runs_app_origin_coherence_check;
ALTER TABLE app_runs ADD CONSTRAINT app_runs_app_origin_coherence_check CHECK (
    (origin_native_binding_id IS NULL AND (
    (
      origin_kind = 'app'
      AND origin_app_installation_id IS NOT NULL
      AND origin_app_version_id IS NOT NULL
      AND provider_kind = 'mcp'
      AND origin_app_binding_key IS NOT NULL
      AND origin_runtime_binding_id IS NULL
      AND origin_resource_binding_id IS NULL
      AND origin_public_endpoint_id IS NULL
      AND origin_public_ingress_id IS NULL
      AND origin_app_grant_snapshot_id IS NOT NULL
      AND risk_class = 'external_write'
      AND review_requirement = 'always'
      AND retry_class = 'idempotent_with_key'
      AND retention_class = 'standard'
      AND (
        (
          review_scope = 'per_invocation'
          AND origin_app_automation_definition_id IS NULL
          AND origin_app_automation_fire_id IS NULL
          AND initiating_actor_type <> 'automation'
          AND initiating_actor_type <> 'app_public'
          AND execution_actor_type <> 'automation'
        ) OR (
          review_scope = 'approved_automation_definition'
          AND origin_app_automation_definition_id IS NOT NULL
          AND origin_app_automation_fire_id IS NOT NULL
          AND initiating_actor_type = 'human'
          AND execution_actor_type = 'automation'
          AND execution_actor_id = origin_app_automation_definition_id
        )
      )
    ) OR (
      origin_kind = 'app'
      AND provider_kind = 'app_runtime'
      AND origin_app_installation_id IS NOT NULL
      AND origin_app_version_id IS NOT NULL
      AND origin_app_grant_snapshot_id IS NOT NULL
      AND origin_app_binding_key IS NULL
      AND origin_runtime_binding_id IS NOT NULL
      AND origin_resource_binding_id IS NULL
      AND origin_app_automation_definition_id IS NULL
      AND origin_app_automation_fire_id IS NULL
      AND (
        (initiating_actor_type = 'app_public'
          AND execution_actor_type = 'human'
          AND initiating_actor_id = origin_public_ingress_id
          AND origin_public_endpoint_id IS NOT NULL
          AND origin_public_ingress_id IS NOT NULL)
        OR (initiating_actor_type <> 'automation'
          AND initiating_actor_type <> 'app_public'
          AND execution_actor_type <> 'automation'
          AND origin_public_endpoint_id IS NULL
          AND origin_public_ingress_id IS NULL)
      )
      AND review_scope = 'per_invocation'
    ) OR (
      origin_kind = 'app'
      AND provider_kind = 'app_runtime'
      AND origin_app_installation_id IS NOT NULL
      AND origin_app_version_id IS NOT NULL
      AND origin_app_grant_snapshot_id IS NOT NULL
      AND origin_resource_binding_id IS NOT NULL
      AND origin_runtime_binding_id IS NULL
      AND origin_app_binding_key IS NULL
      AND origin_public_endpoint_id IS NULL
      AND origin_public_ingress_id IS NULL
      AND origin_app_automation_definition_id IS NULL
      AND origin_app_automation_fire_id IS NULL
      AND initiating_actor_type = 'system'
      AND execution_actor_type = 'system'
      AND initiating_actor_id = origin_resource_binding_id
      AND execution_actor_id = origin_resource_binding_id
      AND risk_class = 'internal_write'
      AND review_requirement = 'policy'
      AND review_scope = 'reviewed_resource_sync'
      AND retry_class = 'unsafe_or_unknown'
      AND retention_class = 'standard'
    ) OR (
      origin_kind <> 'app'
      AND provider_kind = 'mcp'
      AND origin_app_installation_id IS NULL
      AND origin_app_version_id IS NULL
      AND origin_app_binding_key IS NULL
      AND origin_runtime_binding_id IS NULL
      AND origin_resource_binding_id IS NULL
      AND origin_app_grant_snapshot_id IS NULL
      AND origin_app_automation_definition_id IS NULL
      AND origin_app_automation_fire_id IS NULL
      AND origin_public_endpoint_id IS NULL
      AND origin_public_ingress_id IS NULL
      AND initiating_actor_type <> 'automation'
      AND initiating_actor_type <> 'app_public'
      AND execution_actor_type <> 'automation'
    ))) OR (
      origin_kind = 'app' AND provider_kind = 'native'
      AND origin_app_installation_id IS NOT NULL AND origin_app_version_id IS NOT NULL
      AND origin_app_grant_snapshot_id IS NOT NULL AND origin_native_binding_id IS NOT NULL
      AND origin_app_binding_key IS NULL AND origin_runtime_binding_id IS NULL AND origin_resource_binding_id IS NULL
      AND origin_app_automation_definition_id IS NULL AND origin_app_automation_fire_id IS NULL
      AND execution_actor_type = 'human' AND review_scope = 'per_invocation'
      AND risk_class = 'internal_write' AND review_requirement = 'always'
      AND retry_class = 'idempotent_with_key' AND retention_class = 'standard'
      AND ((initiating_actor_type = 'human' AND initiating_actor_id = execution_actor_id
        AND origin_public_endpoint_id IS NULL AND origin_public_ingress_id IS NULL)
        OR (initiating_actor_type = 'app_public' AND initiating_actor_id = origin_public_ingress_id
          AND origin_public_endpoint_id IS NOT NULL AND origin_public_ingress_id IS NOT NULL))
    )
  );

ALTER TABLE app_versions DROP CONSTRAINT IF EXISTS app_versions_protocol_supported_check;
ALTER TABLE app_versions ADD CONSTRAINT app_versions_protocol_supported_check CHECK (protocol_version IN ('0', '1', '2', '3', '4', '5', '6'));

ALTER TABLE app_public_endpoints DROP CONSTRAINT IF EXISTS app_public_endpoints_action_shape_check;
ALTER TABLE app_public_endpoints ADD CONSTRAINT app_public_endpoints_action_shape_check CHECK (
    (native_binding_id IS NULL AND native_input_mapping IS NULL AND (
    (public_action_key IS NULL AND runtime_binding_id IS NULL
      AND approver_user_id IS NULL AND input_mapping IS NULL AND mapping_digest IS NULL)
    OR (public_action_key IS NOT NULL AND public_action_key ~ '^[a-z][a-z0-9_]{0,47}$'
      AND runtime_binding_id IS NOT NULL AND approver_user_id IS NOT NULL
      AND input_mapping IS NOT NULL AND jsonb_typeof(input_mapping) = 'object'
      AND octet_length(input_mapping::text) <= 4096
      AND mapping_digest IS NOT NULL AND mapping_digest ~ '^sha256:[a-f0-9]{64}$')
    )) OR (native_binding_id IS NOT NULL AND runtime_binding_id IS NULL
      AND input_mapping IS NULL AND native_input_mapping IS NOT NULL
      AND jsonb_typeof(native_input_mapping) = 'object' AND octet_length(native_input_mapping::text) <= 4096
      AND public_action_key IS NOT NULL AND public_action_key ~ '^[a-z][a-z0-9_]{0,47}$'
      AND approver_user_id IS NOT NULL AND mapping_digest IS NOT NULL AND mapping_digest ~ '^sha256:[a-f0-9]{64}$')
  );

ALTER TABLE app_canonical_claims DROP CONSTRAINT IF EXISTS app_canonical_claims_revision_check;
ALTER TABLE app_canonical_claims ADD CONSTRAINT app_canonical_claims_revision_check CHECK (claimed_resource_revision IS NULL OR claimed_resource_revision >= 1);

CREATE OR REPLACE FUNCTION assert_app_installation_grant_coherence(
  checked_org_id text,
  checked_installation_id text
) RETURNS void AS $$
DECLARE
  installation app_installations%ROWTYPE;
  version_protocol text;
  version_state text;
BEGIN
  SELECT * INTO installation FROM app_installations
   WHERE org_id = checked_org_id AND id = checked_installation_id;
  IF NOT FOUND THEN RETURN; END IF;

  IF installation.active_version_id IS NULL THEN
    IF installation.active_grant_snapshot_id IS NOT NULL
      OR installation.active_grant_snapshot_kind IS NOT NULL
    THEN
      RAISE EXCEPTION 'APP_GRANT_POINTER_WITHOUT_VERSION' USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;

  SELECT protocol_version, state INTO version_protocol, version_state
    FROM app_versions
   WHERE org_id = checked_org_id
     AND installation_id = checked_installation_id
     AND id = installation.active_version_id;
  IF NOT FOUND OR version_state <> 'active' THEN
    RAISE EXCEPTION 'APP_ACTIVE_VERSION_INVALID' USING ERRCODE = '23514';
  END IF;

  IF installation.state = 'active' AND version_protocol IN ('1', '2', '3', '4', '5', '6') THEN
    IF installation.active_grant_snapshot_id IS NULL
      OR installation.active_grant_snapshot_kind <> 'effective'
    THEN
      RAISE EXCEPTION 'APP_EFFECTIVE_GRANT_REQUIRED' USING ERRCODE = '23514';
    END IF;
  ELSIF installation.active_grant_snapshot_id IS NOT NULL
    OR installation.active_grant_snapshot_kind IS NOT NULL
  THEN
    RAISE EXCEPTION 'APP_EFFECTIVE_GRANT_NOT_ALLOWED' USING ERRCODE = '23514';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_app_grant_snapshot_lineage() RETURNS trigger AS $$
BEGIN
  IF NEW.snapshot_kind = 'requested' THEN
    IF NOT EXISTS (
      SELECT 1 FROM app_versions
      WHERE org_id = NEW.org_id
        AND installation_id = NEW.app_installation_id
        AND id = NEW.app_version_id
        AND requested_grant_snapshot_id = NEW.id
    ) THEN
      RAISE EXCEPTION 'APP_GRANT_REQUEST_POINTER_MISMATCH' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM app_versions
      WHERE org_id = NEW.org_id
        AND installation_id = NEW.app_installation_id
        AND id = NEW.app_version_id
        AND protocol_version IN ('1', '2', '3', '4', '5', '6')
    ) THEN
      RAISE EXCEPTION 'APP_GRANT_EFFECTIVE_PROTOCOL_UNSUPPORTED' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM app_grant_snapshots
      WHERE org_id = NEW.org_id
        AND app_installation_id = NEW.app_installation_id
        AND app_version_id = NEW.app_version_id
        AND id = NEW.requested_snapshot_id
        AND snapshot_kind = 'requested'
    ) THEN
      RAISE EXCEPTION 'APP_GRANT_REQUEST_LINEAGE_MISMATCH' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM org_members
      WHERE org_id = NEW.org_id
        AND user_id = NEW.reviewed_by_actor_id
        AND is_active = true
        AND role IN ('owner', 'admin')
    ) THEN
      RAISE EXCEPTION 'APP_GRANT_REVIEWER_NOT_AUTHORIZED' USING ERRCODE = '23514';
    END IF;
    IF NEW.supersedes_snapshot_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM app_grant_snapshots
      WHERE org_id = NEW.org_id
        AND app_installation_id = NEW.app_installation_id
        AND id = NEW.supersedes_snapshot_id
        AND snapshot_kind = 'effective'
    ) THEN
      RAISE EXCEPTION 'APP_GRANT_SUPERSEDES_LINEAGE_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_app_native_binding_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'APP_NATIVE_BINDING_RETAINED' USING ERRCODE='55000'; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','consent_digest','reviewed_at','updated_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['state','consent_digest','reviewed_at','updated_at'])
    OR (OLD.state='revoked' AND NEW.state<>'revoked')
    OR (OLD.state='active' AND NEW.state NOT IN ('active','revoked'))
    OR (OLD.consent_digest IS NOT NULL AND
      (NEW.consent_digest IS DISTINCT FROM OLD.consent_digest OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at))
    OR (OLD.consent_digest IS NULL AND NEW.consent_digest IS NOT NULL AND
      NOT (OLD.state='staged' AND NEW.state='active'))
  THEN RAISE EXCEPTION 'APP_NATIVE_BINDING_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_native_binding_immutable ON app_native_bindings;
CREATE TRIGGER app_native_binding_immutable BEFORE UPDATE OR DELETE ON app_native_bindings
  FOR EACH ROW EXECUTE FUNCTION enforce_app_native_binding_immutable();
CREATE OR REPLACE FUNCTION enforce_app_run_native_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origin_native_binding_id IS DISTINCT FROM OLD.origin_native_binding_id THEN
    RAISE EXCEPTION 'APP_RUN_NATIVE_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_run_native_identity ON app_runs;
CREATE TRIGGER app_run_native_identity BEFORE UPDATE ON app_runs
  FOR EACH ROW EXECUTE FUNCTION enforce_app_run_native_identity();
CREATE OR REPLACE FUNCTION enforce_app_public_native_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.native_binding_id IS DISTINCT FROM OLD.native_binding_id
    OR NEW.native_input_mapping IS DISTINCT FROM OLD.native_input_mapping THEN
    RAISE EXCEPTION 'APP_PUBLIC_NATIVE_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_public_native_identity ON app_public_endpoints;
CREATE TRIGGER app_public_native_identity BEFORE UPDATE ON app_public_endpoints
  FOR EACH ROW EXECUTE FUNCTION enforce_app_public_native_identity();
CREATE OR REPLACE FUNCTION enforce_app_claim_native_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.claimed_resource_revision IS DISTINCT FROM OLD.claimed_resource_revision THEN
    RAISE EXCEPTION 'APP_CLAIM_NATIVE_REVISION_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_claim_native_revision ON app_canonical_claims;
CREATE TRIGGER app_claim_native_revision BEFORE UPDATE ON app_canonical_claims
  FOR EACH ROW EXECUTE FUNCTION enforce_app_claim_native_revision();

CREATE OR REPLACE FUNCTION enforce_app_v6_effective_grant_shape() RETURNS trigger AS $$
DECLARE
  version_row app_versions%ROWTYPE;
  installation_row app_installations%ROWTYPE;
  requested_row app_grant_snapshots%ROWTYPE;
  descriptor jsonb;
  snapshot_json jsonb;
  declared_descriptors jsonb;
BEGIN
  IF NEW.snapshot_kind <> 'effective' THEN RETURN NEW; END IF;
  SELECT * INTO version_row FROM app_versions WHERE org_id = NEW.org_id
    AND installation_id = NEW.app_installation_id AND id = NEW.app_version_id;
  IF NOT FOUND OR version_row.protocol_version <> '6' THEN RETURN NEW; END IF;
  SELECT * INTO installation_row FROM app_installations WHERE org_id = NEW.org_id
    AND id = NEW.app_installation_id;
  SELECT * INTO requested_row FROM app_grant_snapshots WHERE org_id = NEW.org_id
    AND app_installation_id = NEW.app_installation_id AND app_version_id = NEW.app_version_id
    AND id = NEW.requested_snapshot_id AND snapshot_kind = 'requested';
  IF installation_row.id IS NULL OR requested_row.id IS NULL THEN
    RAISE EXCEPTION 'APP_V6_GRANT_ANCESTRY_MISSING' USING ERRCODE = '23514';
  END IF;
  snapshot_json := NEW.canonical_snapshot;
  IF NOT (snapshot_json ?& ARRAY['schema','lineage_key','package_digest','manifest_digest',
      'runtime_actions','native_actions','sync_descriptors','modules','experiences','public_actions',
      'organization_id','app_installation_id','app_version_id','requested_snapshot_id',
      'requested_snapshot_digest','classification','review_digest'])
    OR snapshot_json - ARRAY['schema','lineage_key','package_digest','manifest_digest',
      'runtime_actions','native_actions','sync_descriptors','modules','experiences','public_actions',
      'organization_id','app_installation_id','app_version_id','requested_snapshot_id',
      'requested_snapshot_digest','classification','review_digest'] <> '{}'::jsonb
    OR snapshot_json->>'schema' IS DISTINCT FROM 'deft.app_native_grant.v1'
    OR snapshot_json->>'lineage_key' IS DISTINCT FROM installation_row.lineage_key
    OR snapshot_json->>'package_digest' IS DISTINCT FROM version_row.package_digest
    OR snapshot_json->>'manifest_digest' IS DISTINCT FROM version_row.manifest_digest
    OR snapshot_json->>'organization_id' IS DISTINCT FROM NEW.org_id
    OR snapshot_json->>'app_installation_id' IS DISTINCT FROM NEW.app_installation_id
    OR snapshot_json->>'app_version_id' IS DISTINCT FROM NEW.app_version_id
    OR snapshot_json->>'requested_snapshot_id' IS DISTINCT FROM NEW.requested_snapshot_id
    OR snapshot_json->>'requested_snapshot_digest' IS DISTINCT FROM requested_row.snapshot_digest
    OR NOT COALESCE((snapshot_json->>'review_digest' ~ '^sha256:[a-f0-9]{64}$'), false)
    OR NEW.resource_rights <> '[]'::jsonb
    OR NEW.classification <> '{"authority_state":"effective","executable":false,"provider_access":false,"runtime_binding_review_required":true,"resource_binding_consent_required":true,"native_binding_consent_required":true}'::jsonb
    OR snapshot_json->'classification' IS DISTINCT FROM NEW.classification THEN
    RAISE EXCEPTION 'APP_V6_GRANT_SHAPE_INVALID' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(snapshot_json->'native_actions') IS DISTINCT FROM 'array'
    OR jsonb_typeof(snapshot_json->'runtime_actions') IS DISTINCT FROM 'array'
    OR jsonb_typeof(snapshot_json->'sync_descriptors') IS DISTINCT FROM 'array'
    OR jsonb_typeof(snapshot_json->'modules') IS DISTINCT FROM 'array'
    OR jsonb_typeof(snapshot_json->'experiences') IS DISTINCT FROM 'array'
    OR jsonb_typeof(snapshot_json->'public_actions') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'APP_V6_GRANT_ARRAY_INVALID' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(snapshot_json->'sync_descriptors') NOT BETWEEN 0 AND 8
    OR jsonb_array_length(snapshot_json->'native_actions') NOT BETWEEN 1 AND 8
    OR jsonb_array_length(snapshot_json->'runtime_actions') > 16
    OR jsonb_array_length(snapshot_json->'modules') > 15
    OR jsonb_array_length(snapshot_json->'experiences') > 1
    OR jsonb_array_length(snapshot_json->'public_actions') > 8 THEN
    RAISE EXCEPTION 'APP_V6_GRANT_LIMIT_INVALID' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(jsonb_agg(item.value - 'descriptor_digest' ORDER BY item.ordinality), '[]'::jsonb)
    INTO declared_descriptors FROM jsonb_array_elements(snapshot_json->'sync_descriptors')
      WITH ORDINALITY AS item(value, ordinality);
  IF declared_descriptors IS DISTINCT FROM version_row.manifest->'sync_descriptors'
    OR snapshot_json->'modules' IS DISTINCT FROM version_row.manifest->'modules'
    OR snapshot_json->'experiences' IS DISTINCT FROM version_row.manifest->'experiences'
    OR snapshot_json->'public_actions' IS DISTINCT FROM version_row.manifest->'public_actions'
    OR jsonb_array_length(snapshot_json->'runtime_actions')
      IS DISTINCT FROM jsonb_array_length(version_row.manifest->'runtime_actions') THEN
    RAISE EXCEPTION 'APP_V6_GRANT_DECLARATION_MISMATCH' USING ERRCODE = '23514';
  END IF;
  FOR descriptor IN SELECT value FROM jsonb_array_elements(snapshot_json->'sync_descriptors') LOOP
    IF jsonb_typeof(descriptor) IS DISTINCT FROM 'object'
      OR NOT (descriptor ?& ARRAY['schema_version','key','runtime_requirement_key',
        'resource_type','requested_visibility','record_schema','label_field','descriptor_digest'])
      OR descriptor - ARRAY['schema_version','key','runtime_requirement_key',
        'resource_type','requested_visibility','record_schema','label_field','descriptor_digest'] <> '{}'::jsonb
      OR descriptor->>'schema_version' IS DISTINCT FROM 'deft.app_sync_descriptor.v1'
      OR descriptor->>'requested_visibility' IS DISTINCT FROM 'user_private'
      OR NOT COALESCE((descriptor->>'descriptor_digest' ~ '^sha256:[a-f0-9]{64}$'), false)
      OR jsonb_typeof(descriptor->'record_schema') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'APP_V6_GRANT_DESCRIPTOR_INVALID' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  SELECT COALESCE(jsonb_agg(item.value-ARRAY['input_schema','output_schema','contract_digest','host_policy'] ORDER BY item.ordinality), '[]'::jsonb)
    INTO declared_descriptors FROM jsonb_array_elements(snapshot_json->'native_actions') WITH ORDINALITY AS item(value,ordinality);
  IF declared_descriptors IS DISTINCT FROM version_row.manifest->'native_actions' THEN
    RAISE EXCEPTION 'APP_V6_NATIVE_DECLARATION_MISMATCH' USING ERRCODE='23514';
  END IF;
  FOR descriptor IN SELECT value FROM jsonb_array_elements(snapshot_json->'native_actions') LOOP
    IF jsonb_typeof(descriptor) IS DISTINCT FROM 'object'
      OR NOT (descriptor ?& ARRAY['key','label','capability_key','operation','input_schema','output_schema','contract_digest','host_policy'])
      OR descriptor-ARRAY['key','label','capability_key','operation','input_schema','output_schema','contract_digest','host_policy']<>'{}'::jsonb
      OR descriptor->'host_policy' IS DISTINCT FROM '{"risk_class":"internal_write","review_requirement":"always","review_scope":"per_invocation","retry_class":"idempotent_with_key","retention_class":"standard","automation_allowed":false}'::jsonb
      OR NOT COALESCE((descriptor->>'contract_digest' ~ '^sha256:[a-f0-9]{64}$'),false)
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(version_row.manifest->'private_capabilities') capability
        WHERE capability->>'key'=descriptor->>'capability_key' AND capability->'input_schema'=descriptor->'input_schema'
          AND capability->'output_schema'=descriptor->'output_schema')
    THEN RAISE EXCEPTION 'APP_V6_NATIVE_DESCRIPTOR_INVALID' USING ERRCODE='23514'; END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS app_grant_snapshots_v6_shape_trigger ON app_grant_snapshots;
CREATE CONSTRAINT TRIGGER app_grant_snapshots_v6_shape_trigger AFTER INSERT ON app_grant_snapshots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_app_v6_effective_grant_shape();
