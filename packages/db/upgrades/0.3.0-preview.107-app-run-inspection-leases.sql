-- Metadata only: never renews Send or carries content/credentials.
CREATE TABLE IF NOT EXISTS app_run_inspection_leases (
 org_id text NOT NULL,owner_user_id text NOT NULL,request_id text NOT NULL,
 experience_session_id text NOT NULL REFERENCES app_experience_sessions(id) ON DELETE RESTRICT,
 run_id text NOT NULL,attempt_id text NOT NULL,original_input_digest text NOT NULL,
 account_ref text NOT NULL,runtime_registration_id text NOT NULL,custody_generation integer NOT NULL,
 custody_receipt_digest text NOT NULL,retained_expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 PRIMARY KEY(org_id,owner_user_id,request_id),
 FOREIGN KEY(org_id,owner_user_id,request_id) REFERENCES app_data_invocations(org_id,owner_user_id,request_id) ON DELETE RESTRICT,
 FOREIGN KEY(org_id,run_id) REFERENCES app_runs(org_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(org_id,run_id,attempt_id) REFERENCES app_run_attempts(org_id,run_id,id) ON DELETE RESTRICT,
 CHECK(original_input_digest ~ '^sha256:[a-f0-9]{64}$' AND custody_receipt_digest ~ '^sha256:[a-f0-9]{64}$' AND custody_generation BETWEEN 1 AND 2147483646),
 CHECK(isfinite(created_at) AND isfinite(expires_at) AND isfinite(retained_expires_at) AND expires_at>created_at AND expires_at<=created_at+interval '30 seconds' AND expires_at<=retained_expires_at)
);
CREATE OR REPLACE FUNCTION guard_app_run_inspection_lease() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Run inspection locator is immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app_data_invocations i JOIN app_experience_sessions e ON e.id=NEW.experience_session_id
  JOIN app_runs r ON r.org_id=NEW.org_id AND r.id=NEW.run_id
  JOIN app_runtime_bindings b ON b.org_id=r.org_id AND b.id=r.origin_runtime_binding_id AND b.app_installation_id=r.origin_app_installation_id AND b.app_version_id=r.origin_app_version_id AND b.grant_snapshot_id=r.origin_app_grant_snapshot_id AND b.provider_instance_id=r.provider_instance_id AND b.provider_snapshot_id=r.provider_snapshot_id AND b.operation_name=r.operation_name AND b.state='active'
  JOIN app_run_attempts a ON a.org_id=r.org_id AND a.run_id=r.id AND a.id=NEW.attempt_id
  JOIN app_connection_forms f ON f.org_id=i.org_id AND f.owner_user_id=i.owner_user_id AND f.session_id=i.connection_session_id
  WHERE i.org_id=NEW.org_id AND i.owner_user_id=NEW.owner_user_id AND i.request_id=NEW.request_id
   AND i.state='inflight' AND i.result IS NULL AND i.revision=0 AND i.operation IN ('run_inspect','run_inspection_status')
   AND i.created_at=NEW.created_at AND i.expires_at=NEW.expires_at AND i.expires_at>clock_timestamp()
   AND e.org_id=i.org_id AND e.user_id=i.owner_user_id AND e.web_session_id=i.web_session_id AND e.revoked_at IS NULL AND e.expires_at>=i.expires_at
   AND e.app_installation_id=i.context->'scope'->>'installation_id' AND e.app_version_id=i.context->'scope'->>'app_version_id' AND e.grant_snapshot_id=i.context->'scope'->>'grant_snapshot_id'
   AND e.resource_target_key=i.context->'scope'->>'target_key' AND e.lifecycle_epoch=(i.context->'scope'->>'lifecycle_epoch')::integer AND e.grant_epoch=(i.context->'scope'->>'grant_epoch')::integer
   AND r.origin_app_installation_id=e.app_installation_id AND r.origin_app_version_id=e.app_version_id AND r.origin_app_grant_snapshot_id=e.grant_snapshot_id
   AND r.initiating_actor_type='human' AND r.initiating_actor_id=i.owner_user_id AND r.state='succeeded'
   AND r.input_purged_at IS NULL AND r.result_purged_at IS NULL AND r.input_expires_at>=NEW.retained_expires_at AND r.result_expires_at>=NEW.retained_expires_at
   AND a.state='succeeded' AND a.runtime_binding_id=r.origin_runtime_binding_id AND a.runtime_result_hmac IS NOT NULL AND a.provider_call_finished_at IS NOT NULL
   AND NEW.account_ref=i.context->'connection'->>'account_ref' AND NEW.runtime_registration_id=i.context->'scope'->>'runtime_registration_id'
   AND f.record->>'state'='connected' AND f.record->'receipt'->>'account_ref'=NEW.account_ref
   AND (f.record->'receipt'->>'custody_generation')::integer=NEW.custody_generation AND f.record->'receipt'->>'digest'=NEW.custody_receipt_digest
 ) THEN RAISE EXCEPTION 'Run inspection locator lineage denied'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_run_inspection_lease_guard ON app_run_inspection_leases;
CREATE TRIGGER app_run_inspection_lease_guard BEFORE INSERT OR UPDATE ON app_run_inspection_leases FOR EACH ROW EXECUTE FUNCTION guard_app_run_inspection_lease();
