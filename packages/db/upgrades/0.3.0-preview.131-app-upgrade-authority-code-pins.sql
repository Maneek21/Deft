-- Exempt exact code/compatibility leaves; compare every other raw JSON change strictly.
-- All live consent, trust proof, epoch, identity and immutable-row guards are retained.
CREATE OR REPLACE FUNCTION public.enforce_app_resource_binding()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APP_RESOURCE_BINDING_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'disabled' OR NEW.reviewed_by_user_id IS NOT NULL
      OR NEW.reviewed_at IS NOT NULL OR NEW.consent_expires_at IS NOT NULL OR NEW.consent_lifetime IS NOT NULL THEN
      RAISE EXCEPTION 'APP_RESOURCE_BINDING_REVIEW_REQUIRED' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.max_records_per_page IS DISTINCT FROM OLD.max_records_per_page
      AND NOT app_owner_resource_page_amendment_allowed(OLD, NEW) THEN
      RAISE EXCEPTION 'APP_RESOURCE_BINDING_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF (NEW.id, NEW.org_id, NEW.app_installation_id, NEW.app_version_id, NEW.grant_snapshot_id,
        NEW.grant_snapshot_kind, NEW.runtime_registration_id, NEW.registration_contract_version,
        NEW.provider_kind, NEW.provider_instance_id, NEW.provider_snapshot_id,
        NEW.resource_key, NEW.resource_family, NEW.operation_name, NEW.interface_identity,
        NEW.reviewed_descriptor, NEW.descriptor_digest, NEW.owner_user_id, NEW.owner_scope,
        NEW.risk_class, NEW.review_requirement, NEW.review_scope, NEW.retry_class,
        NEW.retention_class, NEW.max_page_bytes,
        NEW.max_retained_records, NEW.max_retained_bytes, NEW.min_interval_seconds,
        NEW.created_at) IS DISTINCT FROM
       (OLD.id, OLD.org_id, OLD.app_installation_id, OLD.app_version_id, OLD.grant_snapshot_id,
        OLD.grant_snapshot_kind, OLD.runtime_registration_id, OLD.registration_contract_version,
        OLD.provider_kind, OLD.provider_instance_id, OLD.provider_snapshot_id,
        OLD.resource_key, OLD.resource_family, OLD.operation_name, OLD.interface_identity,
        OLD.reviewed_descriptor, OLD.descriptor_digest, OLD.owner_user_id, OLD.owner_scope,
        OLD.risk_class, OLD.review_requirement, OLD.review_scope, OLD.retry_class,
        OLD.retention_class, OLD.max_page_bytes,
        OLD.max_retained_records, OLD.max_retained_bytes, OLD.min_interval_seconds,
        OLD.created_at) THEN
      RAISE EXCEPTION 'APP_RESOURCE_BINDING_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    IF OLD.state = 'disabled' AND NEW.state = 'active' THEN
      IF OLD.reviewed_by_user_id IS NOT NULL OR OLD.reviewed_at IS NOT NULL
        OR OLD.consent_expires_at IS NOT NULL OR NEW.reviewed_by_user_id <> NEW.owner_user_id
        OR NEW.reviewed_at IS NULL OR OLD.consent_lifetime IS NOT NULL
        OR NOT ((NEW.consent_expires_at IS NOT NULL AND NEW.consent_lifetime IS NULL)
          OR (NEW.consent_expires_at IS NULL AND NEW.consent_lifetime='until_revoked' AND EXISTS (
            SELECT 1 FROM public.audit_log proof
            JOIN public.app_installations installation ON installation.org_id=proof.org_id AND installation.id=NEW.app_installation_id
            JOIN public.app_resource_bindings source ON source.org_id=proof.org_id AND source.id=proof.metadata->'source_binding'->>'id'
            JOIN public.app_runtime_registrations old_registration ON old_registration.org_id=source.org_id AND old_registration.id=source.runtime_registration_id
            JOIN public.app_runtime_registrations new_registration ON new_registration.org_id=NEW.org_id AND new_registration.id=NEW.runtime_registration_id
            JOIN public.app_versions prior ON prior.org_id=source.org_id AND prior.id=source.app_version_id
            JOIN public.app_versions target ON target.org_id=NEW.org_id AND target.id=NEW.app_version_id
            JOIN LATERAL (SELECT trust.after_state FROM public.audit_log trust WHERE trust.org_id=NEW.org_id
              AND trust.entity_type='app_installation' AND trust.entity_id=NEW.app_installation_id
              AND trust.action='app.upgrade_continuity_trust_changed' AND trust.actor_type='human'
              ORDER BY (trust.after_state->>'revision')::integer DESC LIMIT 1) trust ON true
            WHERE proof.org_id=NEW.org_id AND proof.action='app.upgrade_continuity.authorized' AND proof.actor_type='system'
              AND proof.entity_type='app_connection_session' AND proof.entity_id=proof.metadata->>'request_id'
              AND proof.metadata->>'schema_version'='deft.app_upgrade_continuity.v1'
              AND proof.metadata->>'installation_id'=NEW.app_installation_id AND proof.metadata->>'version_id'=NEW.app_version_id
              AND proof.metadata->>'grant_id'=NEW.grant_snapshot_id AND proof.metadata->>'owner_id'=NEW.owner_user_id
              AND (proof.metadata->>'issuance_expires_at')::timestamptz>clock_timestamp()
              AND trust.after_state=jsonb_build_object('trusted',true,'revision',(proof.metadata->>'trust_revision')::integer)
              AND installation.state='active' AND installation.active_version_id=NEW.app_version_id
              AND installation.active_grant_snapshot_id=NEW.grant_snapshot_id
              AND installation.lifecycle_epoch=(proof.metadata->>'lifecycle_epoch')::integer
              AND installation.grant_epoch=(proof.metadata->>'grant_epoch')::integer
              AND source.state='active' AND source.consent_lifetime='until_revoked' AND source.consent_expires_at IS NULL
              AND source.owner_user_id=NEW.owner_user_id AND source.app_installation_id=NEW.app_installation_id
              AND source.resource_key=NEW.resource_key AND source.target_key=NEW.target_key
              AND source.descriptor_digest=NEW.descriptor_digest AND source.reviewed_descriptor=NEW.reviewed_descriptor
              AND source.attachment_policy=NEW.attachment_policy
              AND (source.max_records_per_page,source.max_page_bytes,source.max_retained_records,source.max_retained_bytes,source.min_interval_seconds)
                =(NEW.max_records_per_page,NEW.max_page_bytes,NEW.max_retained_records,NEW.max_retained_bytes,NEW.min_interval_seconds)
              AND old_registration.state='active' AND old_registration.operator_user_id=new_registration.operator_user_id
              AND prior.id=proof.metadata->>'prior_version_id' AND prior.installation_id=NEW.app_installation_id
              AND target.installation_id=NEW.app_installation_id
              AND NOT EXISTS (
                -- Walk both raw JSON trees. No schema parsing, key stripping or array normalization.
                WITH RECURSIVE nodes(path,b,a) AS (
                  SELECT ARRAY[]::text[], prior.manifest, target.manifest
                  UNION ALL
                  SELECT n.path || child.key, child.b, child.a FROM nodes n CROSS JOIN LATERAL (
                    SELECT key, n.b->key AS b, n.a->key AS a FROM (
                      SELECT key FROM jsonb_object_keys(CASE WHEN jsonb_typeof(n.b)='object' AND jsonb_typeof(n.a)='object' THEN n.b ELSE '{}'::jsonb END) key
                      UNION SELECT key FROM jsonb_object_keys(CASE WHEN jsonb_typeof(n.b)='object' AND jsonb_typeof(n.a)='object' THEN n.a ELSE '{}'::jsonb END) key
                    ) keys
                    UNION ALL
                    SELECT i::text, n.b->i, n.a->i FROM generate_series(0, CASE
                      WHEN jsonb_typeof(n.b)='array' AND jsonb_typeof(n.a)='array'
                      THEN LEAST(jsonb_array_length(n.b),jsonb_array_length(n.a))-1 ELSE -1 END) i
                  ) child
                )
                SELECT 1 FROM nodes n WHERE n.b IS DISTINCT FROM n.a AND NOT COALESCE(
                  (jsonb_typeof(n.b)='object' AND jsonb_typeof(n.a)='object')
                  OR (jsonb_typeof(n.b)='array' AND jsonb_typeof(n.a)='array' AND CASE WHEN jsonb_typeof(n.b)='array' AND jsonb_typeof(n.a)='array' THEN jsonb_array_length(n.b)=jsonb_array_length(n.a) ELSE false END)
                  OR ((n.b IS NULL OR jsonb_typeof(n.b)='string') AND (n.a IS NULL OR jsonb_typeof(n.a)='string')
                    AND ((n.path[1]='version' AND cardinality(n.path)=1)
                      OR (n.path[1]='name' AND cardinality(n.path)=1)
                      OR (n.path[1]='description' AND cardinality(n.path)=1)
                      OR (n.path[1]='compatibility' AND n.path[2]='host' AND n.path[3]='version' AND cardinality(n.path)=3)
                      OR (n.path[1]='compatibility' AND n.path[2]='host' AND n.path[3]='minimum_version' AND cardinality(n.path)=3)
                      OR (n.path[1]='compatibility' AND n.path[2]='host' AND n.path[3]='release_manifest' AND cardinality(n.path)=3)
                      OR (n.path[1]='compatibility' AND n.path[2]='kit' AND n.path[3]='version' AND cardinality(n.path)=3)
                      OR (n.path[1]='compatibility' AND n.path[2]='kit' AND n.path[3]='minimum_version' AND cardinality(n.path)=3)
                      OR (n.path[1]='compatibility' AND n.path[2]='kit' AND n.path[3]='release_manifest' AND cardinality(n.path)=3)
                      OR (n.path[1]='compatibility' AND n.path[2]='runtime' AND n.path[3]='version' AND cardinality(n.path)=3)
                      OR (n.path[1]='compatibility' AND n.path[2]='runtime' AND n.path[3]='minimum_version' AND cardinality(n.path)=3)
                      OR (n.path[1]='compatibility' AND n.path[2]='runtime' AND n.path[3]='release_manifest' AND cardinality(n.path)=3)
                      OR (n.path[1]='compatibility' AND n.path[2]='app_kit_version' AND cardinality(n.path)=2)
                      OR (n.path[1]='compatibility' AND n.path[2]='runtime_kit_version' AND cardinality(n.path)=2)
                      OR (n.path[1]='compatibility' AND n.path[2]='runtime_version' AND cardinality(n.path)=2)))
                  OR ((n.b IS NULL OR (jsonb_typeof(n.b)='string' AND n.b#>>'{}' ~ '^sha256:[a-f0-9]{64}$'))
                    AND (n.a IS NULL OR (jsonb_typeof(n.a)='string' AND n.a#>>'{}' ~ '^sha256:[a-f0-9]{64}$'))
                    AND ((n.path[1]='experiences' AND n.path[2] ~ '^(0|[1-9][0-9]*)$' AND n.path[3]='artifact_digest' AND cardinality(n.path)=3)
                      OR (n.path[1]='experiences' AND n.path[2] ~ '^(0|[1-9][0-9]*)$' AND n.path[3]='worker_digest' AND cardinality(n.path)=3)
                      OR (n.path[1]='runtime_requirements' AND n.path[2] ~ '^(0|[1-9][0-9]*)$' AND n.path[3]='package_digest' AND cardinality(n.path)=3)
                      OR (n.path[1]='runtime_requirements' AND n.path[2] ~ '^(0|[1-9][0-9]*)$' AND n.path[3]='worker_digest' AND cardinality(n.path)=3))), false)
              )
              AND (NOT prior.manifest ? 'experiences' OR jsonb_typeof(prior.manifest->'experiences')='array')
              AND (NOT target.manifest ? 'experiences' OR jsonb_typeof(target.manifest->'experiences')='array')
              AND (NOT prior.manifest ? 'runtime_requirements' OR jsonb_typeof(prior.manifest->'runtime_requirements')='array')
              AND (NOT target.manifest ? 'runtime_requirements' OR jsonb_typeof(target.manifest->'runtime_requirements')='array')
          )) )
        OR NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = NEW.org_id
          AND user_id = NEW.owner_user_id AND is_active) THEN
        RAISE EXCEPTION 'APP_RESOURCE_BINDING_REVIEW_INVALID' USING ERRCODE = '55000';
      END IF;
    ELSIF OLD.state = 'active' AND NEW.state = 'revoked' THEN
      IF (NEW.reviewed_by_user_id, NEW.reviewed_at, NEW.consent_expires_at, NEW.consent_lifetime)
        IS DISTINCT FROM (OLD.reviewed_by_user_id, OLD.reviewed_at, OLD.consent_expires_at, OLD.consent_lifetime) THEN
        RAISE EXCEPTION 'APP_RESOURCE_BINDING_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
    ELSIF NEW.state = OLD.state THEN
      IF (NEW.reviewed_by_user_id, NEW.reviewed_at, NEW.consent_expires_at, NEW.consent_lifetime)
        IS DISTINCT FROM (OLD.reviewed_by_user_id, OLD.reviewed_at, OLD.consent_expires_at, OLD.consent_lifetime)
        AND NOT app_owner_resource_consent_continuation_allowed(OLD,NEW) THEN
        RAISE EXCEPTION 'APP_RESOURCE_BINDING_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
    ELSE
      RAISE EXCEPTION 'APP_RESOURCE_BINDING_ILLEGAL_TRANSITION' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END; $function$
;
