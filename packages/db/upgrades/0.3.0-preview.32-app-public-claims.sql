-- Gate G public claim foundation. Dormant until an explicitly reviewed endpoint
-- is enabled. Existing claims and ingress receipts survive disable/rollback.
CREATE TABLE IF NOT EXISTS app_public_endpoints (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  slug_digest text NOT NULL,
  app_installation_id text NOT NULL,
  app_version_id text NOT NULL,
  grant_snapshot_id text NOT NULL,
  installation_lifecycle_epoch integer NOT NULL,
  installation_grant_epoch integer NOT NULL,
  module_installation_id text NOT NULL,
  collection_key text NOT NULL,
  state text NOT NULL DEFAULT 'disabled',
  endpoint_epoch integer NOT NULL DEFAULT 1,
  review_digest text NOT NULL,
  reviewed_by_user_id text NOT NULL,
  reviewed_at timestamp NOT NULL,
  public_label text NOT NULL,
  max_body_bytes integer NOT NULL DEFAULT 1024,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_public_endpoints_version_fk FOREIGN KEY (org_id, app_installation_id, app_version_id)
    REFERENCES app_versions(org_id, installation_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_public_endpoints_grant_fk FOREIGN KEY (org_id, app_installation_id, app_version_id, grant_snapshot_id)
    REFERENCES app_grant_snapshots(org_id, app_installation_id, app_version_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_public_endpoints_module_fk FOREIGN KEY (org_id, module_installation_id)
    REFERENCES module_installations(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_public_endpoints_org_id_unique UNIQUE (org_id, id),
  CONSTRAINT app_public_endpoints_slug_digest_check CHECK (slug_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT app_public_endpoints_review_digest_check CHECK (review_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT app_public_endpoints_state_check CHECK (state IN ('disabled', 'enabled')),
  CONSTRAINT app_public_endpoints_epoch_check CHECK (endpoint_epoch >= 1
    AND installation_lifecycle_epoch >= 0 AND installation_grant_epoch >= 1),
  CONSTRAINT app_public_endpoints_collection_check CHECK (collection_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT app_public_endpoints_label_check CHECK (octet_length(public_label) BETWEEN 1 AND 200),
  CONSTRAINT app_public_endpoints_body_limit_check CHECK (max_body_bytes BETWEEN 128 AND 8192)
);
CREATE UNIQUE INDEX IF NOT EXISTS app_public_endpoints_slug_digest_unique ON app_public_endpoints(slug_digest);
CREATE INDEX IF NOT EXISTS app_public_endpoints_org_installation_idx
  ON app_public_endpoints(org_id, app_installation_id, state);

CREATE TABLE IF NOT EXISTS app_public_ingress (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  endpoint_id text NOT NULL,
  endpoint_epoch integer NOT NULL,
  request_key_digest text NOT NULL,
  input_digest text NOT NULL,
  state text NOT NULL,
  follow_up_state text NOT NULL DEFAULT 'pending',
  follow_up_code text,
  handled_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_public_ingress_endpoint_fk FOREIGN KEY (org_id, endpoint_id)
    REFERENCES app_public_endpoints(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_public_ingress_org_endpoint_id_unique UNIQUE (org_id, endpoint_id, id),
  CONSTRAINT app_public_ingress_epoch_check CHECK (endpoint_epoch >= 1),
  CONSTRAINT app_public_ingress_key_digest_check CHECK (request_key_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT app_public_ingress_input_digest_check CHECK (input_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT app_public_ingress_state_check CHECK (state IN ('processing', 'confirmed', 'conflict')),
  CONSTRAINT app_public_ingress_follow_up_check CHECK (
    (follow_up_state = 'pending' AND follow_up_code IS NULL AND handled_at IS NULL)
    OR (follow_up_state = 'unsupported' AND follow_up_code IS NOT NULL
      AND follow_up_code IN ('APP_HANDLER_UNAVAILABLE', 'ENDPOINT_REVOKED') AND handled_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS app_public_ingress_request_unique
  ON app_public_ingress(org_id, endpoint_id, endpoint_epoch, request_key_digest);
CREATE INDEX IF NOT EXISTS app_public_ingress_endpoint_created_idx
  ON app_public_ingress(org_id, endpoint_id, created_at);

CREATE TABLE IF NOT EXISTS app_canonical_claims (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  endpoint_id text NOT NULL,
  ingress_id text NOT NULL,
  provider_kind text NOT NULL,
  provider_instance_id text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  claim_kind text NOT NULL,
  released_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT app_canonical_claims_ingress_fk FOREIGN KEY (org_id, endpoint_id, ingress_id)
    REFERENCES app_public_ingress(org_id, endpoint_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_canonical_claims_module_record_fk FOREIGN KEY (org_id, provider_instance_id, resource_id)
    REFERENCES module_records(org_id, installation_id, id) ON DELETE RESTRICT,
  CONSTRAINT app_canonical_claims_org_id_unique UNIQUE (org_id, id),
  CONSTRAINT app_canonical_claims_provider_check CHECK (provider_kind = 'module'),
  CONSTRAINT app_canonical_claims_resource_type_check CHECK (resource_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT app_canonical_claims_kind_check CHECK (claim_kind = 'exclusive'),
  CONSTRAINT app_canonical_claims_release_check CHECK (released_at IS NULL OR released_at >= created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS app_canonical_claims_ingress_unique
  ON app_canonical_claims(org_id, ingress_id);
CREATE UNIQUE INDEX IF NOT EXISTS app_canonical_claims_active_resource_unique
  ON app_canonical_claims(org_id, provider_kind, provider_instance_id, resource_id, claim_kind)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS app_canonical_claims_endpoint_created_idx
  ON app_canonical_claims(org_id, endpoint_id, created_at);
