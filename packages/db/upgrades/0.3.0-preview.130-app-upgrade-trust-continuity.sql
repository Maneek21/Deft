-- Carry only existing persistent owner consent under an exact audited installation trust proof.
-- Every immutable-field, membership, admission and revocation guard is retained.
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
              AND (prior.manifest-ARRAY['version','name','description'])=(target.manifest-ARRAY['version','name','description'])
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
