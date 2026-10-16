-- Dormant independent exact-purpose MCP grants; no credential or human-grant backfill.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='mcp_tokens'::regclass AND conname='mcp_tokens_org_identity_unique') THEN
 ALTER TABLE mcp_tokens ADD CONSTRAINT mcp_tokens_org_identity_unique UNIQUE(org_id,id);
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS app_private_mcp_grants (
 id text PRIMARY KEY, org_id text NOT NULL, owner_user_id text NOT NULL, subject_user_id text NOT NULL,
 mcp_token_id text NOT NULL, app_installation_id text NOT NULL, resource_binding_id text NOT NULL,
 checkpoint_id text NOT NULL, projection_id text NOT NULL, review_digest text NOT NULL, snapshot jsonb NOT NULL,
 accepted_sequence bigserial NOT NULL, accepted_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 revoked_at timestamptz, revoked_by_user_id text,
 CONSTRAINT app_private_mcp_grants_owner_fk FOREIGN KEY(org_id,resource_binding_id,owner_user_id) REFERENCES app_resource_bindings(org_id,id,owner_user_id) ON DELETE RESTRICT,
 CONSTRAINT app_private_mcp_grants_checkpoint_fk FOREIGN KEY(org_id,checkpoint_id,resource_binding_id) REFERENCES app_sync_checkpoints(org_id,id,resource_binding_id) ON DELETE CASCADE,
 CONSTRAINT app_private_mcp_grants_projection_fk FOREIGN KEY(org_id,projection_id) REFERENCES app_resource_projections(org_id,id) ON DELETE CASCADE,
 CONSTRAINT app_private_mcp_grants_subject_fk FOREIGN KEY(org_id,subject_user_id) REFERENCES org_members(org_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT app_private_mcp_grants_token_fk FOREIGN KEY(org_id,mcp_token_id) REFERENCES mcp_tokens(org_id,id) ON DELETE RESTRICT,
 CONSTRAINT app_private_mcp_grants_review_unique UNIQUE(org_id,owner_user_id,review_digest),
 CONSTRAINT app_private_mcp_grants_digest_check CHECK(review_digest ~ '^sha256:[a-f0-9]{64}$'),
 CONSTRAINT app_private_mcp_grants_expiry_check CHECK(expires_at>accepted_at AND expires_at<=accepted_at+interval '15 minutes'),
 CONSTRAINT app_private_mcp_grants_revocation_check CHECK((revoked_at IS NULL AND revoked_by_user_id IS NULL) OR (revoked_at IS NOT NULL AND revoked_by_user_id=owner_user_id)),
 CONSTRAINT app_private_mcp_grants_snapshot_check CHECK(COALESCE(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=8192 AND snapshot ?& ARRAY['schema_version','purpose','org_id','owner_user_id','app_installation_id','app_version_id','grant_snapshot_id','lifecycle_epoch','grant_epoch','registration_id','operator_user_id','runtime_epoch','resource_binding_id','descriptor_digest','checkpoint_id','generation','ref','revision_digest','content_digest','operations','field_keys','app_label','expires_at','review_expires_at','destination','subject_user_id','employee_id','token_authorization_version','token_hash_digest','scope_digest','subject_membership_authorization_version','employee_authorization_version','token_label','subject_label'] AND (snapshot-ARRAY['schema_version','purpose','org_id','owner_user_id','app_installation_id','app_version_id','grant_snapshot_id','lifecycle_epoch','grant_epoch','registration_id','operator_user_id','runtime_epoch','resource_binding_id','descriptor_digest','checkpoint_id','generation','ref','revision_digest','content_digest','operations','field_keys','app_label','expires_at','review_expires_at','destination','subject_user_id','employee_id','token_authorization_version','token_hash_digest','scope_digest','subject_membership_authorization_version','employee_authorization_version','token_label','subject_label'])='{}'::jsonb AND snapshot->>'schema_version'='deft.app_private_mcp_snapshot.v1' AND snapshot->>'purpose'='mcp_private_context' AND snapshot->>'org_id'=org_id AND snapshot->>'owner_user_id'=owner_user_id AND snapshot->>'subject_user_id'=subject_user_id AND snapshot->>'app_installation_id'=app_installation_id AND snapshot->>'resource_binding_id'=resource_binding_id AND snapshot->>'checkpoint_id'=checkpoint_id AND jsonb_typeof(snapshot->'destination')='object' AND ((snapshot->'destination')-ARRAY['kind','token_id'])='{}'::jsonb AND (snapshot->'destination') ?& ARRAY['kind','token_id'] AND snapshot#>>'{destination,token_id}'=mcp_token_id AND snapshot#>>'{destination,kind}' IN ('personal_mcp','employee_mcp') AND jsonb_typeof(snapshot->'ref')='object' AND ((snapshot->'ref')-ARRAY['schema_version','provider','resource_type','resource_id'])='{}'::jsonb AND (snapshot->'ref') ?& ARRAY['schema_version','provider','resource_type','resource_id'] AND snapshot#>>'{ref,schema_version}'='deft.resource_ref.v2' AND snapshot#>>'{ref,resource_id}'=projection_id AND jsonb_typeof(snapshot#>'{ref,provider}')='object' AND ((snapshot#>'{ref,provider}')-ARRAY['kind','provider_instance_id'])='{}'::jsonb AND (snapshot#>'{ref,provider}') ?& ARRAY['kind','provider_instance_id'] AND snapshot#>>'{ref,provider,kind}'='app_runtime' AND snapshot#>>'{ref,provider,provider_instance_id}'=snapshot->>'registration_id' AND jsonb_typeof(snapshot->'field_keys')='array' AND jsonb_array_length(snapshot->'field_keys') BETWEEN 1 AND 32 AND snapshot->'operations' IN ('["cite"]'::jsonb,'["read"]'::jsonb,'["search"]'::jsonb,'["cite","read"]'::jsonb,'["cite","search"]'::jsonb,'["read","search"]'::jsonb,'["cite","read","search"]'::jsonb) AND jsonb_typeof(snapshot->'app_version_id')='string' AND jsonb_typeof(snapshot->'grant_snapshot_id')='string' AND jsonb_typeof(snapshot->'registration_id')='string' AND jsonb_typeof(snapshot->'operator_user_id')='string' AND jsonb_typeof(snapshot->'descriptor_digest')='string' AND jsonb_typeof(snapshot->'revision_digest')='string' AND jsonb_typeof(snapshot->'content_digest')='string' AND jsonb_typeof(snapshot->'expires_at')='string' AND jsonb_typeof(snapshot->'review_expires_at')='string' AND jsonb_typeof(snapshot->'app_label')='string' AND jsonb_typeof(snapshot->'token_hash_digest')='string' AND jsonb_typeof(snapshot->'scope_digest')='string' AND jsonb_typeof(snapshot->'token_label')='string' AND jsonb_typeof(snapshot->'subject_label')='string' AND jsonb_typeof(snapshot->'lifecycle_epoch')='number' AND jsonb_typeof(snapshot->'grant_epoch')='number' AND jsonb_typeof(snapshot->'runtime_epoch')='number' AND jsonb_typeof(snapshot->'generation')='number' AND jsonb_typeof(snapshot->'token_authorization_version')='number' AND jsonb_typeof(snapshot->'subject_membership_authorization_version')='number' AND length(snapshot->>'app_label')<=200 AND length(snapshot->>'token_label')<=200 AND length(snapshot->>'subject_label')<=200 AND ((snapshot#>>'{destination,kind}'='personal_mcp' AND snapshot->'employee_id'='null'::jsonb AND snapshot->'employee_authorization_version'='null'::jsonb) OR (snapshot#>>'{destination,kind}'='employee_mcp' AND jsonb_typeof(snapshot->'employee_id')='string' AND jsonb_typeof(snapshot->'employee_authorization_version')='number')),false))
);
CREATE INDEX IF NOT EXISTS app_private_mcp_grants_owner_idx ON app_private_mcp_grants(org_id,owner_user_id,app_installation_id);
CREATE INDEX IF NOT EXISTS app_private_mcp_grants_subject_idx ON app_private_mcp_grants(org_id,subject_user_id,accepted_sequence);
CREATE INDEX IF NOT EXISTS app_private_mcp_grants_token_binding_idx ON app_private_mcp_grants(org_id,mcp_token_id,resource_binding_id,accepted_sequence);
ALTER SEQUENCE app_private_mcp_grants_accepted_sequence_seq CACHE 1 NO CYCLE;
CREATE OR REPLACE FUNCTION enforce_app_private_mcp_grants() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field text; previous_field text; key text;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-'revoked_at'-'revoked_by_user_id') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at'-'revoked_by_user_id') OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
   RAISE EXCEPTION 'MCP private grants permit only one-way owner revocation';
  END IF;
 END IF;
 FOR key IN SELECT unnest(ARRAY['org_id','owner_user_id','subject_user_id','app_installation_id','app_version_id','grant_snapshot_id','registration_id','operator_user_id','resource_binding_id','checkpoint_id']) LOOP
  IF (NEW.snapshot->>key)!~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN
   RAISE EXCEPTION 'MCP private authority identity is malformed';
  END IF;
 END LOOP;
 FOR key IN SELECT unnest(ARRAY['descriptor_digest','revision_digest','content_digest','scope_digest']) LOOP
  IF (NEW.snapshot->>key)!~ '^sha256:[a-f0-9]{64}$' THEN RAISE EXCEPTION 'MCP private authority digest is malformed'; END IF;
 END LOOP;
 IF (NEW.snapshot->>'token_hash_digest')!~ '^[a-f0-9]{64}$' OR NEW.snapshot#>>'{ref,resource_type}' IS NULL OR NEW.snapshot#>>'{ref,resource_type}' !~ '^[a-z][a-z0-9_]{0,63}$' THEN
  RAISE EXCEPTION 'MCP private payload scope is malformed';
 END IF;
 previous_field := NULL;
 FOR field IN SELECT jsonb_array_elements_text(NEW.snapshot->'field_keys') LOOP
  IF field IS NULL OR field !~ '^[a-z][a-z0-9_]{0,47}$' OR (previous_field IS NOT NULL AND previous_field>=field COLLATE "C") THEN
   RAISE EXCEPTION 'MCP private grant fields must be sorted unique declared keys';
  END IF;
  previous_field := field;
 END LOOP;
 FOR key IN SELECT unnest(ARRAY['lifecycle_epoch','grant_epoch','runtime_epoch','generation','token_authorization_version','subject_membership_authorization_version']) LOOP
  IF (NEW.snapshot->>key)!~ '^[0-9]+$' OR (NEW.snapshot->>key)::numeric < (CASE WHEN key IN ('lifecycle_epoch','grant_epoch') THEN 0 ELSE 1 END) THEN
   RAISE EXCEPTION 'MCP private authority versions must be nonnegative integers';
  END IF;
 END LOOP;
 IF NEW.snapshot#>>'{destination,kind}'='employee_mcp' AND ((NEW.snapshot->>'employee_authorization_version')!~ '^[1-9][0-9]*$' OR (NEW.snapshot->>'employee_id')!~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') THEN
  RAISE EXCEPTION 'MCP private employee authority is malformed';
 END IF;
 IF (NEW.snapshot->>'expires_at')::timestamptz IS DISTINCT FROM NEW.expires_at OR (NEW.snapshot->>'review_expires_at')::timestamptz>NEW.expires_at OR (TG_OP='INSERT' AND (NEW.snapshot->>'review_expires_at')::timestamptz<=NEW.accepted_at) THEN
  RAISE EXCEPTION 'MCP private grant deadline differs from reviewed authority';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_private_mcp_grants_guard ON app_private_mcp_grants;
CREATE TRIGGER app_private_mcp_grants_guard BEFORE INSERT OR UPDATE ON app_private_mcp_grants FOR EACH ROW EXECUTE FUNCTION enforce_app_private_mcp_grants();
