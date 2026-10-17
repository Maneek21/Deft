-- Only owner-reviewed page-count amendments; all historical identity, state and custody guards remain.
-- No data rewrite, trigger disable, session variable or provider authority expansion.
CREATE OR REPLACE FUNCTION app_owner_resource_page_amendment_allowed(
  previous app_resource_bindings, amended app_resource_bindings) RETURNS boolean AS $$
DECLARE r app_runtime_registrations%ROWTYPE; a app_owner_connection_admissions%ROWTYPE;
BEGIN
  IF previous.state<>'active' OR amended.state<>'active'
    OR previous.registration_contract_version<>'deft.app_runtime_channel.v3'
    OR amended.max_records_per_page=previous.max_records_per_page
    OR amended.attachment_consent_digest IS NOT DISTINCT FROM previous.attachment_consent_digest
    OR amended.attachment_policy IS DISTINCT FROM previous.attachment_policy
    OR amended.consent_expires_at IS DISTINCT FROM previous.consent_expires_at
    OR amended.consent_expires_at IS NULL OR amended.consent_expires_at<=clock_timestamp()
    OR amended.reviewed_by_user_id IS DISTINCT FROM amended.owner_user_id THEN RETURN false; END IF;
  SELECT * INTO r FROM app_runtime_registrations WHERE org_id=previous.org_id AND id=previous.runtime_registration_id;
  IF r.id IS NULL OR r.state<>'active' OR r.owner_connection_admission_id IS NULL
    OR r.reviewed_by_user_id IS DISTINCT FROM previous.owner_user_id THEN RETURN false; END IF;
  SELECT * INTO a FROM app_owner_connection_admissions WHERE org_id=r.org_id AND id=r.owner_connection_admission_id;
  IF NOT app_owner_connection_admission_current(r.org_id,a.id,r.owner_connection_admission_digest)
    OR NOT app_owner_connection_member(previous.org_id,previous.owner_user_id)
    OR amended.max_records_per_page>(a.snapshot->'limits'->>'max_records_per_page')::integer
    OR EXISTS (SELECT 1 FROM app_runs WHERE org_id=previous.org_id AND origin_resource_binding_id=previous.id
      AND state IN ('pending','running','waiting_external'))
    OR EXISTS (SELECT 1 FROM app_runtime_sessions WHERE org_id=previous.org_id AND resource_binding_id=previous.id
      AND runtime_registration_id=r.id AND audience='app_resource_sync' AND revoked_at IS NULL)
    THEN RETURN false; END IF;
  RETURN true;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_app_resource_binding() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APP_RESOURCE_BINDING_APPEND_ONLY' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'disabled' OR NEW.reviewed_by_user_id IS NOT NULL
      OR NEW.reviewed_at IS NOT NULL OR NEW.consent_expires_at IS NOT NULL THEN
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
        OR NEW.reviewed_at IS NULL OR NEW.consent_expires_at IS NULL
        OR NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = NEW.org_id
          AND user_id = NEW.owner_user_id AND is_active) THEN
        RAISE EXCEPTION 'APP_RESOURCE_BINDING_REVIEW_INVALID' USING ERRCODE = '55000';
      END IF;
    ELSIF OLD.state = 'active' AND NEW.state = 'revoked' THEN
      IF (NEW.reviewed_by_user_id, NEW.reviewed_at, NEW.consent_expires_at)
        IS DISTINCT FROM (OLD.reviewed_by_user_id, OLD.reviewed_at, OLD.consent_expires_at) THEN
        RAISE EXCEPTION 'APP_RESOURCE_BINDING_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
    ELSIF NEW.state = OLD.state THEN
      IF (NEW.reviewed_by_user_id, NEW.reviewed_at, NEW.consent_expires_at)
        IS DISTINCT FROM (OLD.reviewed_by_user_id, OLD.reviewed_at, OLD.consent_expires_at) THEN
        RAISE EXCEPTION 'APP_RESOURCE_BINDING_IMMUTABLE' USING ERRCODE = '55000';
      END IF;
    ELSE
      RAISE EXCEPTION 'APP_RESOURCE_BINDING_ILLEGAL_TRANSITION' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_app_attachment_binding_policy() RETURNS trigger AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.attachment_policy,NEW.attachment_consent_digest) IS DISTINCT FROM (OLD.attachment_policy,OLD.attachment_consent_digest)
    AND NOT app_owner_resource_page_amendment_allowed(OLD,NEW) THEN
    RAISE EXCEPTION 'APP_ATTACHMENT_CONSENT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
