-- E4 allocated append-only integration migration. Historical upgrades remain unchanged.

-- Unnumbered review leaf. Root owns schema IDs, Drizzle exports and manifests.
-- No native Email account FK or independent account/source identity catalogue.
CREATE TABLE IF NOT EXISTS app_integration_principal_grants (
 id uuid PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id), owner_user_id text NOT NULL REFERENCES users(id),
 installation_id text NOT NULL, resource_binding_id text NOT NULL,
 account_ref text NOT NULL CHECK(length(account_ref) BETWEEN 1 AND 512), store_key text NOT NULL CHECK(store_key ~ '^[a-z][a-z0-9_]{0,47}$'),
 principal_kind text NOT NULL CHECK(principal_kind IN ('defty','personal_mcp')), principal_id text NOT NULL,
 operations text[] NOT NULL CHECK(cardinality(operations) BETWEEN 1 AND 4 AND operations <@ ARRAY['read','draft','triage','send']::text[]),
 revision integer NOT NULL CHECK(revision>0), expires_at timestamptz NOT NULL, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,installation_id) REFERENCES app_installations(org_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(org_id,resource_binding_id,owner_user_id) REFERENCES app_resource_bindings(org_id,id,owner_user_id) ON DELETE RESTRICT,
 FOREIGN KEY(org_id,owner_user_id) REFERENCES org_members(org_id,user_id) ON DELETE RESTRICT,
 CHECK(expires_at>created_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS app_integration_principal_grants_active_unique ON app_integration_principal_grants(org_id,owner_user_id,installation_id,account_ref,resource_binding_id,store_key,principal_kind,principal_id) WHERE revoked_at IS NULL;
-- A retained actor and exact metadata envelope; no token, input bytes or result
-- content is stored here. Callback never accepts an actor from Runtime input.
CREATE TABLE IF NOT EXISTS app_integration_data_invocations (
 request_id uuid PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id), owner_user_id text NOT NULL REFERENCES users(id),
 installation_id text NOT NULL,
 principal_kind text NOT NULL CHECK(principal_kind IN ('human','defty','personal_mcp','capture_policy','notification_policy')),
 principal_id text NOT NULL, purpose text NOT NULL CHECK(purpose IN ('read','tool_read','tool_draft','tool_triage','tool_send','transfer','knowledge_capture','notification_projection')),
 authority_identity text NOT NULL, authority_expires_at timestamptz NOT NULL,
 operation text NOT NULL, input_digest text NOT NULL CHECK(input_digest ~ '^sha256:[a-f0-9]{64}$'),
 context jsonb NOT NULL CHECK(jsonb_typeof(context)='object'),
 prepared_locator jsonb, accepted_run_id text, accepted_input_digest text, accepted_runtime_binding_id text,
 state text NOT NULL CHECK(state IN ('inflight','completed','indeterminate')), revision integer NOT NULL CHECK(revision>0),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,installation_id) REFERENCES app_installations(org_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(org_id,owner_user_id) REFERENCES org_members(org_id,user_id) ON DELETE RESTRICT,
 FOREIGN KEY(org_id,accepted_run_id) REFERENCES app_runs(org_id,id) ON DELETE RESTRICT,
 UNIQUE(org_id,accepted_run_id),
 CHECK((accepted_run_id IS NULL AND accepted_input_digest IS NULL AND accepted_runtime_binding_id IS NULL)
  OR (accepted_run_id IS NOT NULL AND accepted_input_digest ~ '^sha256:[a-f0-9]{64}$' AND accepted_runtime_binding_id IS NOT NULL AND prepared_locator IS NOT NULL AND state='completed')),
 CHECK(expires_at<=authority_expires_at AND expires_at<=created_at+interval '30 seconds')
);

CREATE OR REPLACE FUNCTION app_integration_grant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF cardinality(NEW.operations)<>(SELECT count(DISTINCT op) FROM unnest(NEW.operations) op)
  OR NOT EXISTS(SELECT 1 FROM app_resource_bindings b WHERE b.org_id=NEW.org_id AND b.id=NEW.resource_binding_id
   AND b.owner_user_id=NEW.owner_user_id AND b.app_installation_id=NEW.installation_id) THEN
  RAISE EXCEPTION 'Invalid integration grant target or operations';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR NEW.revoked_at IS NOT NULL OR NEW.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Invalid initial integration grant'; END IF;
 ELSE
  IF NEW.revision<>OLD.revision+1 OR (to_jsonb(NEW)-ARRAY['operations','expires_at','revoked_at','revision','updated_at'])
   IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['operations','expires_at','revoked_at','revision','updated_at'])
   OR OLD.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'Integration grant immutable lineage or revoked'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_integration_grant_guard ON app_integration_principal_grants;
CREATE TRIGGER app_integration_grant_guard BEFORE INSERT OR UPDATE ON app_integration_principal_grants FOR EACH ROW EXECUTE FUNCTION app_integration_grant_guard();

CREATE OR REPLACE FUNCTION app_integration_invocation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c jsonb; t jsonb; a jsonb;
BEGIN
 IF NEW.context->>'kind'='tool' THEN
  c:=NEW.context->'caller'; t:=NEW.context->'target'; a:=NEW.context->'envelope';
  IF octet_length(NEW.context::text)>32768 OR jsonb_typeof(c) IS DISTINCT FROM 'object' OR jsonb_typeof(t) IS DISTINCT FROM 'object' OR jsonb_typeof(a) IS DISTINCT FROM 'object'
   OR (NEW.context-ARRAY['kind','caller','target','envelope','input_digest','declaration_digest','field_digests','grant','authority_identity','authority_expires_at'])<>'{}'::jsonb
   OR (c-ARRAY['org_id','user_id','kind','principal_id','access_expires_at','authorization_version','conversation_id','employee_id'])<>'{}'::jsonb
   OR (t-ARRAY['installation_id','account_ref','store_key','resource_binding_id'])<>'{}'::jsonb
   OR (a-ARRAY['request_id','scope','connection','authority','tool_key','tool_operation','store_key','expires_at','prepare_expires_at','source_refs'])<>'{}'::jsonb
   OR jsonb_typeof(a->'scope') IS DISTINCT FROM 'object' OR jsonb_typeof(a->'connection') IS DISTINCT FROM 'object' OR jsonb_typeof(a->'authority') IS DISTINCT FROM 'object'
   OR ((a->'scope')-ARRAY['org_id','owner_user_id','installation_id','app_version_id','grant_snapshot_id','package_digest','grant_snapshot_digest','lifecycle_epoch','grant_epoch','target_key','resource_key','resource_binding_id','runtime_registration_id','operator_user_id','runtime_epoch','profile_digest','consent_expires_at'])<>'{}'::jsonb
   OR ((a->'connection')-ARRAY['session_id','session_revision','runtime_session_ref','account_ref'])<>'{}'::jsonb
   OR ((a->'authority')-ARRAY['consent_id','consent_digest','data_policy_digest'])<>'{}'::jsonb
   OR ((NEW.context->'grant')-ARRAY['id','revision','digest'])<>'{}'::jsonb
   OR jsonb_typeof(a->'source_refs') IS DISTINCT FROM 'array' OR jsonb_array_length(a->'source_refs')>25
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(a->'source_refs') ref WHERE jsonb_typeof(ref)<>'object' OR (ref-ARRAY['resource_key','record_id','content_digest'])<>'{}'::jsonb)
   OR c->>'org_id' IS DISTINCT FROM NEW.org_id OR c->>'user_id' IS DISTINCT FROM NEW.owner_user_id
   OR c->>'kind' IS DISTINCT FROM NEW.principal_kind OR NEW.principal_kind NOT IN ('defty','personal_mcp')
   OR c->>'principal_id' IS DISTINCT FROM NEW.principal_id OR t->>'installation_id' IS DISTINCT FROM NEW.installation_id
   OR a->>'request_id' IS DISTINCT FROM NEW.request_id::text OR NEW.purpose IS DISTINCT FROM 'tool_'||(a->>'tool_operation')
   OR NEW.operation IS DISTINCT FROM 'tool:'||(a->>'tool_key') OR NEW.input_digest IS DISTINCT FROM NEW.context->>'input_digest'
   OR NEW.authority_identity IS DISTINCT FROM NEW.context->>'authority_identity'
   OR NEW.authority_expires_at IS DISTINCT FROM to_timestamp((NEW.context->>'authority_expires_at')::double precision/1000)
   OR a->'scope'->>'org_id' IS DISTINCT FROM NEW.org_id OR a->'scope'->>'owner_user_id' IS DISTINCT FROM NEW.owner_user_id
   OR a->'scope'->>'installation_id' IS DISTINCT FROM NEW.installation_id OR a->'scope'->>'resource_binding_id' IS DISTINCT FROM t->>'resource_binding_id'
   OR a->'connection'->>'account_ref' IS DISTINCT FROM t->>'account_ref' OR a->>'store_key' IS DISTINCT FROM t->>'store_key'
   OR a->'authority'->>'consent_id' IS DISTINCT FROM NEW.context->'grant'->>'id'
   OR a->'authority'->>'consent_digest' IS DISTINCT FROM NEW.context->'grant'->>'digest'
   OR (a->>'expires_at')::timestamptz IS DISTINCT FROM NEW.expires_at
   OR jsonb_typeof(NEW.context->'field_digests') IS DISTINCT FROM 'object'
   OR EXISTS(SELECT 1 FROM jsonb_each_text(NEW.context->'field_digests') v WHERE v.value !~ '^sha256:[a-f0-9]{64}$') THEN
   RAISE EXCEPTION 'Invalid delegated tool metadata';
  END IF;
  IF NEW.prepared_locator IS NOT NULL THEN
   IF NEW.state<>'completed' OR NEW.purpose NOT IN ('tool_triage','tool_send') OR jsonb_typeof(NEW.prepared_locator)<>'object'
    OR NOT (NEW.prepared_locator ?& ARRAY['kind','snapshot_id','snapshot_digest','action_key','input_digest','expires_at'])
    OR NEW.prepared_locator->>'snapshot_id' IS DISTINCT FROM NEW.request_id::text
    OR (NEW.prepared_locator-ARRAY['kind','snapshot_id','snapshot_digest','action_key','input_digest','record_id','revision','expires_at'])<>'{}'::jsonb
    OR NEW.prepared_locator->>'kind' NOT IN ('record','resource') OR (NEW.prepared_locator->>'snapshot_digest') !~ '^sha256:[a-f0-9]{64}$'
    OR (NEW.prepared_locator->>'input_digest') !~ '^sha256:[a-f0-9]{64}$'
    OR (NEW.prepared_locator->>'expires_at')::timestamptz>NEW.authority_expires_at
    OR (NEW.prepared_locator->>'kind'='record') IS DISTINCT FROM (NEW.prepared_locator ?& ARRAY['record_id','revision']) THEN RAISE EXCEPTION 'Invalid tool preparation'; END IF;
  END IF;
  IF TG_OP='INSERT' THEN
   IF NEW.state<>'inflight' OR NEW.revision<>1 OR NEW.prepared_locator IS NOT NULL OR NEW.accepted_run_id IS NOT NULL OR NEW.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Invalid initial tool invocation'; END IF;
   IF NOT EXISTS(SELECT 1 FROM app_integration_principal_grants g WHERE g.id::text=NEW.context->'grant'->>'id' AND g.org_id=NEW.org_id AND g.owner_user_id=NEW.owner_user_id
    AND g.installation_id=NEW.installation_id AND g.resource_binding_id=t->>'resource_binding_id' AND g.account_ref=t->>'account_ref' AND g.store_key=t->>'store_key'
    AND g.principal_kind=NEW.principal_kind AND g.principal_id=NEW.principal_id AND g.revision=(NEW.context->'grant'->>'revision')::integer
    AND g.operations @> ARRAY[a->>'tool_operation'] AND g.revoked_at IS NULL AND g.expires_at>=NEW.authority_expires_at) THEN RAISE EXCEPTION 'Tool original grant mismatch'; END IF;
  ELSE
   IF NEW.revision<>OLD.revision+1 OR (to_jsonb(NEW)-ARRAY['state','revision','updated_at','prepared_locator','accepted_run_id','accepted_input_digest','accepted_runtime_binding_id'])
     IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','updated_at','prepared_locator','accepted_run_id','accepted_input_digest','accepted_runtime_binding_id'])
    OR NOT ((OLD.state='inflight' AND NEW.state IN ('completed','indeterminate') AND NEW.accepted_run_id IS NULL)
     OR (OLD.state='completed' AND NEW.state='completed' AND OLD.prepared_locator IS NOT NULL AND OLD.accepted_run_id IS NULL AND NEW.accepted_run_id IS NOT NULL AND NEW.prepared_locator=OLD.prepared_locator)) THEN
    RAISE EXCEPTION 'Tool invocation immutable or terminal';
   END IF;
  END IF;
  IF NEW.accepted_run_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM app_runs r WHERE r.org_id=NEW.org_id AND r.id=NEW.accepted_run_id
   AND r.initiating_actor_type='human' AND r.initiating_actor_id=NEW.owner_user_id AND r.execution_actor_type='human' AND r.execution_actor_id=NEW.owner_user_id
   AND r.origin_kind='app' AND r.provider_kind='app_runtime' AND r.origin_app_installation_id=NEW.installation_id
   AND r.origin_runtime_binding_id=NEW.accepted_runtime_binding_id AND r.operation_name=NEW.prepared_locator->>'action_key'
   AND r.origin_app_version_id=a->'scope'->>'app_version_id' AND r.origin_app_grant_snapshot_id=a->'scope'->>'grant_snapshot_id') THEN
   RAISE EXCEPTION 'Tool Run identity mismatch';
  END IF;
  RETURN NEW;
 END IF;
 c:=NEW.context->'caller'; t:=NEW.context->'target'; a:=NEW.context->'authority';
 IF NEW.prepared_locator IS NOT NULL OR NEW.accepted_run_id IS NOT NULL THEN RAISE EXCEPTION 'Source invocation cannot authorize a Run'; END IF;
 IF octet_length(NEW.context::text)>32768 OR jsonb_typeof(c)<>'object' OR jsonb_typeof(t)<>'object' OR jsonb_typeof(a)<>'object'
  OR (NEW.context-ARRAY['caller','target','authority'])<>'{}'::jsonb
  OR (c-ARRAY['org_id','user_id','kind','principal_id','access_expires_at','authorization_version','conversation_id','employee_id','capture_delivery','notification_delivery'])<>'{}'::jsonb
  OR (t-ARRAY['installation_id','account_ref','store_key'])<>'{}'::jsonb
  OR (a-ARRAY['schema_version','request_id','scope','connection','authority','operation','expires_at','input_digest'])<>'{}'::jsonb
  OR c->>'org_id' IS DISTINCT FROM NEW.org_id OR c->>'user_id' IS DISTINCT FROM NEW.owner_user_id
  OR (NEW.principal_kind='notification_policy') IS DISTINCT FROM (NEW.purpose='notification_projection')
  OR (NEW.principal_kind='capture_policy') IS DISTINCT FROM (NEW.purpose='knowledge_capture')
  OR NEW.purpose='notification_projection' AND (NEW.operation<>'resource_read_metadata' OR jsonb_typeof(c->'notification_delivery') IS DISTINCT FROM 'object' OR c ? 'capture_delivery')
  OR c ? 'notification_delivery' AND ((c->'notification_delivery')-ARRAY['job_id','lock_token','policy_revision'])<>'{}'::jsonb
  OR c ? 'capture_delivery' AND ((c->'capture_delivery')-ARRAY['job_id','lock_token','policy_revision'])<>'{}'::jsonb
  OR c->>'kind' IS DISTINCT FROM NEW.principal_kind OR c->>'principal_id' IS DISTINCT FROM NEW.principal_id
  OR t->>'installation_id' IS DISTINCT FROM NEW.installation_id
  OR a->>'request_id' IS DISTINCT FROM NEW.request_id::text OR a->>'operation' IS DISTINCT FROM NEW.operation
  OR a->>'input_digest' IS DISTINCT FROM NEW.input_digest OR a->>'schema_version'<>'deft.app_data_authority.v1'
  OR a->'scope'->>'org_id' IS DISTINCT FROM NEW.org_id OR a->'scope'->>'owner_user_id' IS DISTINCT FROM NEW.owner_user_id
  OR a->'scope'->>'installation_id' IS DISTINCT FROM NEW.installation_id
  OR a->'connection'->>'account_ref' IS DISTINCT FROM t->>'account_ref'
  OR (a->>'expires_at')::timestamptz IS DISTINCT FROM NEW.expires_at
  OR NEW.expires_at<=NEW.created_at OR NEW.authority_expires_at<=NEW.created_at THEN
  RAISE EXCEPTION 'Invalid integration invocation metadata';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'inflight' OR NEW.revision<>1 OR NEW.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Invalid initial integration invocation'; END IF;
 ELSE
  IF OLD.state<>'inflight' OR NEW.state NOT IN ('completed','indeterminate') OR NEW.revision<>OLD.revision+1
   OR (to_jsonb(NEW)-ARRAY['state','revision','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','updated_at']) THEN
   RAISE EXCEPTION 'Integration invocation immutable or terminal';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_integration_invocation_guard ON app_integration_data_invocations;
CREATE TRIGGER app_integration_invocation_guard BEFORE INSERT OR UPDATE ON app_integration_data_invocations FOR EACH ROW EXECUTE FUNCTION app_integration_invocation_guard();


-- Unallocated E4 leaf. Root assigns the supported schema upgrade entry/id.
CREATE TABLE IF NOT EXISTS app_integration_capture_policies (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id), owner_user_id text NOT NULL REFERENCES users(id),
 installation_id text NOT NULL, account_ref text NOT NULL, store_key text NOT NULL,
 revision integer NOT NULL CHECK(revision>0), enabled boolean NOT NULL DEFAULT false,
 input jsonb NOT NULL, history_since timestamptz NOT NULL, scan_checkpoint_id text, scan_after_projection_id text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id), UNIQUE(org_id,owner_user_id,installation_id,account_ref,store_key),
 FOREIGN KEY(org_id,installation_id) REFERENCES app_installations(org_id,id)
);
CREATE TABLE IF NOT EXISTS app_integration_capture_claims (
 id text PRIMARY KEY, org_id text NOT NULL, owner_user_id text NOT NULL, installation_id text NOT NULL,
 account_ref text NOT NULL, store_key text NOT NULL, policy_id text NOT NULL, policy_revision integer NOT NULL CHECK(policy_revision>0),
 thread_key text NOT NULL CHECK(thread_key ~ '^sha256:[a-f0-9]{64}$'), body_digest text NOT NULL CHECK(body_digest ~ '^sha256:[a-f0-9]{64}$'),
 target jsonb NOT NULL, state text NOT NULL DEFAULT 'processing' CHECK(state IN('processing','captured','updated','skipped','protected','failed')),
 page_id text, error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id), UNIQUE(org_id,owner_user_id,installation_id,account_ref,store_key,policy_revision,thread_key,body_digest),
 FOREIGN KEY(org_id,policy_id) REFERENCES app_integration_capture_policies(org_id,id)
);
CREATE TABLE IF NOT EXISTS app_integration_capture_threads (
 id text PRIMARY KEY, org_id text NOT NULL, owner_user_id text NOT NULL, installation_id text NOT NULL,
 account_ref text NOT NULL, store_key text NOT NULL, thread_key text NOT NULL, destination_key text NOT NULL,
 page_id text NOT NULL, page_version integer NOT NULL CHECK(page_version>0), last_observed_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,owner_user_id,installation_id,account_ref,store_key,thread_key,destination_key),
 FOREIGN KEY(page_id) REFERENCES wiki_pages(id)
);
CREATE TABLE IF NOT EXISTS app_integration_capture_sources (
 id text PRIMARY KEY, org_id text NOT NULL, owner_user_id text NOT NULL, installation_id text NOT NULL,
 account_ref text NOT NULL, store_key text NOT NULL, claim_id text NOT NULL, page_id text NOT NULL,
 target jsonb NOT NULL, publication jsonb NOT NULL, thread_key text NOT NULL, body_digest text NOT NULL,
 observed_at timestamptz NOT NULL, partial boolean NOT NULL DEFAULT true CHECK(partial=true),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,claim_id), FOREIGN KEY(org_id,claim_id) REFERENCES app_integration_capture_claims(org_id,id),
 FOREIGN KEY(page_id) REFERENCES wiki_pages(id)
);


-- Root allocates the schema upgrade; no schema ID or global registration here.
CREATE TABLE IF NOT EXISTS app_integration_destination_receipts (
 org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
 owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id text NOT NULL,
 request_digest text NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
 review_digest text NOT NULL CHECK (review_digest ~ '^sha256:[a-f0-9]{64}$'),
 source jsonb NOT NULL CHECK (jsonb_typeof(source)='object'),
 destination jsonb NOT NULL CHECK (jsonb_typeof(destination)='object'),
 result jsonb CHECK (result IS NULL OR jsonb_typeof(result)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,owner_user_id,request_id)
);


-- Root allocates the migration/schema version. An absent policy is Off.
CREATE TABLE IF NOT EXISTS app_integration_notification_policies (
 id text NOT NULL UNIQUE,
 org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
 owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 installation_id text NOT NULL,
 account_ref text NOT NULL,
 store_key text NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 2147483647),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,owner_user_id,installation_id,account_ref,store_key)
);


-- Bind optional integration tools to the exact signed v7 manifest.
CREATE OR REPLACE FUNCTION enforce_app_v7_effective_grant_shape() RETURNS trigger AS $$
DECLARE
  version_row app_versions%ROWTYPE;
  installation_row app_installations%ROWTYPE;
  requested_row app_grant_snapshots%ROWTYPE;
  snapshot_json jsonb;
  descriptor jsonb;
  declared_descriptors jsonb;
  policy jsonb;
  policy_key text;
  policy_max numeric;
  payload_policy jsonb;
  previous_action_key text;
  seen_payload_actions text[] := ARRAY[]::text[];
  change_descriptor jsonb;
  previous_change_key text;
  local_job_descriptor jsonb;
  previous_local_job_key text;
BEGIN
  IF NEW.snapshot_kind <> 'effective' THEN RETURN NEW; END IF;
  SELECT * INTO version_row FROM app_versions WHERE org_id=NEW.org_id
    AND installation_id=NEW.app_installation_id AND id=NEW.app_version_id;
  IF NOT FOUND OR version_row.protocol_version<>'7' THEN RETURN NEW; END IF;
  SELECT * INTO installation_row FROM app_installations WHERE org_id=NEW.org_id AND id=NEW.app_installation_id;
  SELECT * INTO requested_row FROM app_grant_snapshots WHERE org_id=NEW.org_id
    AND app_installation_id=NEW.app_installation_id AND app_version_id=NEW.app_version_id
    AND id=NEW.requested_snapshot_id AND snapshot_kind='requested';
  IF installation_row.id IS NULL OR requested_row.id IS NULL THEN
    RAISE EXCEPTION 'APP_V7_GRANT_ANCESTRY_MISSING' USING ERRCODE='23514'; END IF;
  snapshot_json:=NEW.canonical_snapshot;
  IF NOT(snapshot_json ?& ARRAY['schema','lineage_key','package_digest','manifest_digest','sync_descriptors','modules','runtime_actions','native_actions','public_actions','experiences','host_policy','organization_id','app_installation_id','app_version_id','requested_snapshot_id','requested_snapshot_digest','classification','review_digest']) OR snapshot_json-ARRAY['integration_tools','record_stores','owner_connections','private_state','schema','lineage_key','package_digest','manifest_digest','sync_descriptors','modules','runtime_actions','native_actions','public_actions','experiences','host_policy','organization_id','app_installation_id','app_version_id','requested_snapshot_id','requested_snapshot_digest','classification','review_digest']<>'{}'::jsonb
    OR snapshot_json->>'schema' IS NULL OR snapshot_json->>'schema' NOT IN ('deft.app_blob_grant.v1','deft.app_blob_grant.v2')
    OR snapshot_json->>'lineage_key' IS DISTINCT FROM installation_row.lineage_key
    OR snapshot_json->>'package_digest' IS DISTINCT FROM version_row.package_digest
    OR snapshot_json->>'manifest_digest' IS DISTINCT FROM version_row.manifest_digest
    OR snapshot_json->>'organization_id' IS DISTINCT FROM NEW.org_id
    OR snapshot_json->>'app_installation_id' IS DISTINCT FROM NEW.app_installation_id
    OR snapshot_json->>'app_version_id' IS DISTINCT FROM NEW.app_version_id
    OR snapshot_json->>'requested_snapshot_id' IS DISTINCT FROM NEW.requested_snapshot_id
    OR snapshot_json->>'requested_snapshot_digest' IS DISTINCT FROM requested_row.snapshot_digest
    OR NOT COALESCE(snapshot_json->>'review_digest' ~ '^sha256:[a-f0-9]{64}$',false)
    OR NEW.resource_rights<>'[]'::jsonb
    OR NEW.classification<>'{"authority_state":"effective","executable":false,"provider_access":false,"runtime_binding_review_required":true,"resource_binding_consent_required":true,"attachment_policy_review_required":true}'::jsonb
    OR snapshot_json->'classification' IS DISTINCT FROM NEW.classification
    OR snapshot_json->'host_policy' IS DISTINCT FROM '{"encrypted_custody":true,"current_parent_required":true,"provider_url_fetch":false,"irrecoverable_host_purge":true,"owner_only":true,"stage_ceiling_seconds":3600}'::jsonb THEN
    RAISE EXCEPTION 'APP_V7_GRANT_SHAPE_INVALID' USING ERRCODE='23514'; END IF;
  -- E4 declarations stay bound to the exact signed installed manifest. Legacy
  -- v7 packages without tools retain the original absence semantics.
  IF (snapshot_json ? 'integration_tools') IS DISTINCT FROM (version_row.manifest ? 'integration_tools')
    OR COALESCE(snapshot_json->'integration_tools','[]'::jsonb) IS DISTINCT FROM COALESCE(version_row.manifest->'integration_tools','[]'::jsonb)
    OR (snapshot_json ? 'integration_tools' AND (
      jsonb_typeof(snapshot_json->'integration_tools') IS DISTINCT FROM 'array'
      OR jsonb_array_length(snapshot_json->'integration_tools') NOT BETWEEN 1 AND 32)) THEN
    RAISE EXCEPTION 'APP_V7_INTEGRATION_TOOLS_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
  IF jsonb_typeof(snapshot_json->'sync_descriptors') IS DISTINCT FROM 'array'
    OR jsonb_typeof(snapshot_json->'modules') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'APP_V7_GRANT_ARRAY_INVALID' USING ERRCODE='23514'; END IF;
  IF jsonb_array_length(snapshot_json->'sync_descriptors') NOT BETWEEN 1 AND 8
    OR jsonb_array_length(snapshot_json->'modules')>15
    OR snapshot_json->'modules' IS DISTINCT FROM version_row.manifest->'modules'
    OR snapshot_json->'native_actions' IS DISTINCT FROM '[]'::jsonb
    OR snapshot_json->'public_actions' IS DISTINCT FROM '[]'::jsonb
    OR version_row.manifest->'native_actions' IS DISTINCT FROM '[]'::jsonb
    OR version_row.manifest->'public_actions' IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'APP_V7_GRANT_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
  IF snapshot_json->>'schema'='deft.app_blob_grant.v1' THEN
    -- Preserve the exact v1 empty-plane requirement; no existing grant widens.
    IF snapshot_json->'runtime_actions' IS DISTINCT FROM '[]'::jsonb
      OR snapshot_json->'experiences' IS DISTINCT FROM '[]'::jsonb
      OR version_row.manifest->'runtime_actions' IS DISTINCT FROM '[]'::jsonb
      OR version_row.manifest->'experiences' IS DISTINCT FROM '[]'::jsonb
      OR version_row.manifest->'private_capabilities' IS DISTINCT FROM '[]'::jsonb THEN
      RAISE EXCEPTION 'APP_V7_GRANT_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
  ELSE
    -- Only the separately reviewed composition shape admits Runtime and
    -- verified Experience declarations; native and public stay empty above.
    IF jsonb_typeof(snapshot_json->'runtime_actions') IS DISTINCT FROM 'array'
      OR jsonb_typeof(version_row.manifest->'runtime_actions') IS DISTINCT FROM 'array'
      OR jsonb_typeof(version_row.manifest->'private_capabilities') IS DISTINCT FROM 'array'
      OR jsonb_typeof(version_row.manifest->'runtime_requirements') IS DISTINCT FROM 'array'
      OR jsonb_typeof(version_row.manifest->'experiences') IS DISTINCT FROM 'array'
      OR snapshot_json->'experiences' IS DISTINCT FROM version_row.manifest->'experiences' THEN
      RAISE EXCEPTION 'APP_V7_COMPOSITION_ARRAY_INVALID' USING ERRCODE='23514'; END IF;
    IF jsonb_array_length(snapshot_json->'runtime_actions')<>jsonb_array_length(version_row.manifest->'runtime_actions') THEN
      RAISE EXCEPTION 'APP_V7_COMPOSITION_ACTION_MISMATCH' USING ERRCODE='23514'; END IF;
    FOR descriptor IN SELECT value FROM jsonb_array_elements(snapshot_json->'runtime_actions') LOOP
      IF jsonb_typeof(descriptor) IS DISTINCT FROM 'object'
        OR NOT(descriptor ?& ARRAY['action_key','runtime_requirement_key','interface','operation_name','input_schema','output_schema','contract_digest','host_policy'])
        OR descriptor-ARRAY['action_key','runtime_requirement_key','interface','operation_name','input_schema','output_schema','contract_digest','host_policy']<>'{}'::jsonb
        OR NOT COALESCE(descriptor->>'contract_digest' ~ '^sha256:[a-f0-9]{64}$',false)
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(version_row.manifest->'runtime_actions') action
          JOIN jsonb_array_elements(version_row.manifest->'private_capabilities') capability
            ON capability->>'key'=action->>'capability_key'
          JOIN jsonb_array_elements(version_row.manifest->'runtime_requirements') requirement
            ON requirement->>'key'=action->>'runtime_requirement_key'
          WHERE requirement->>'protocol_version'='deft.app_runtime_channel.v1'
            AND capability->>'version'='1'
            AND jsonb_typeof(capability->'input_schema')='object'
            AND jsonb_typeof(capability->'output_schema')='object'
            AND descriptor-'contract_digest'=jsonb_build_object(
              'action_key',action->'key','runtime_requirement_key',action->'runtime_requirement_key',
              'interface',jsonb_build_object('namespace','app_lineage','key',capability->'key','version',capability->'version'),
              'operation_name',action->'key','input_schema',capability->'input_schema','output_schema',capability->'output_schema',
              'host_policy','{"risk_class":"external_write","review_requirement":"always","review_scope":"per_invocation","retry_class":"unsafe_or_unknown","retention_class":"standard"}'::jsonb)) THEN
        RAISE EXCEPTION 'APP_V7_COMPOSITION_ACTION_MISMATCH' USING ERRCODE='23514'; END IF;
    END LOOP;
    IF (SELECT count(DISTINCT value->>'action_key') FROM jsonb_array_elements(snapshot_json->'runtime_actions'))<>jsonb_array_length(snapshot_json->'runtime_actions') THEN
      RAISE EXCEPTION 'APP_V7_COMPOSITION_ACTION_MISMATCH' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT COALESCE(jsonb_agg(item.value-'descriptor_digest' ORDER BY item.ordinality),'[]'::jsonb)
    INTO declared_descriptors FROM jsonb_array_elements(snapshot_json->'sync_descriptors') WITH ORDINALITY AS item(value,ordinality);
  IF declared_descriptors IS DISTINCT FROM version_row.manifest->'sync_descriptors' THEN
    RAISE EXCEPTION 'APP_V7_GRANT_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
  FOR descriptor IN SELECT value FROM jsonb_array_elements(snapshot_json->'sync_descriptors') LOOP
    IF jsonb_typeof(descriptor) IS DISTINCT FROM 'object'
      OR NOT(descriptor ?& ARRAY['schema_version','key','runtime_requirement_key','resource_type','requested_visibility','record_schema','label_field','attachments','descriptor_digest'])
      OR descriptor-ARRAY['schema_version','key','runtime_requirement_key','resource_type','requested_visibility','record_schema','label_field','attachments','descriptor_digest']<>'{}'::jsonb
      OR descriptor->>'schema_version' IS DISTINCT FROM 'deft.app_sync_descriptor.v2'
      OR descriptor->>'requested_visibility' IS DISTINCT FROM 'user_private'
      OR NOT COALESCE(descriptor->>'descriptor_digest' ~ '^sha256:[a-f0-9]{64}$',false)
      OR jsonb_typeof(descriptor->'record_schema') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'APP_V7_GRANT_DESCRIPTOR_INVALID' USING ERRCODE='23514'; END IF;
    policy:=descriptor->'attachments';
    IF jsonb_typeof(policy) IS DISTINCT FROM 'object'
      OR NOT(policy ?& ARRAY['max_attachment_bytes','max_attachments_per_record','max_attachments_per_run','max_attachment_bytes_per_run','retention_days','allowed_media_types'])
      OR policy-ARRAY['max_attachment_bytes','max_attachments_per_record','max_attachments_per_run','max_attachment_bytes_per_run','retention_days','allowed_media_types']<>'{}'::jsonb THEN
      RAISE EXCEPTION 'APP_V7_GRANT_ATTACHMENT_POLICY_INVALID' USING ERRCODE='23514'; END IF;
    FOR policy_key,policy_max IN VALUES ('max_attachment_bytes',2097152),('max_attachments_per_record',8),
      ('max_attachments_per_run',32),('max_attachment_bytes_per_run',8388608),('retention_days',30) LOOP
      IF jsonb_typeof(policy->policy_key) IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'APP_V7_GRANT_ATTACHMENT_POLICY_INVALID' USING ERRCODE='23514'; END IF;
      IF (policy->>policy_key)::numeric NOT BETWEEN 1 AND policy_max
        OR (policy->>policy_key)::numeric<>trunc((policy->>policy_key)::numeric) THEN
        RAISE EXCEPTION 'APP_V7_GRANT_ATTACHMENT_POLICY_INVALID' USING ERRCODE='23514'; END IF;
    END LOOP;
    IF jsonb_typeof(policy->'allowed_media_types') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'APP_V7_GRANT_ATTACHMENT_POLICY_INVALID' USING ERRCODE='23514'; END IF;
    IF jsonb_array_length(policy->'allowed_media_types') NOT BETWEEN 1 AND 8
      OR NOT(policy->'allowed_media_types'<@'["text/plain","text/csv","application/json","image/png","image/jpeg","image/gif","image/webp","application/pdf"]'::jsonb)
      OR jsonb_array_length(policy->'allowed_media_types')<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(policy->'allowed_media_types')) THEN
      RAISE EXCEPTION 'APP_V7_GRANT_ATTACHMENT_POLICY_INVALID' USING ERRCODE='23514'; END IF;
  END LOOP;
  -- Separately reviewed app-owned stores preserve every existing private-state budget.
  IF snapshot_json ? 'record_stores' OR version_row.manifest ? 'record_stores' THEN
    IF snapshot_json->>'schema' IS DISTINCT FROM 'deft.app_blob_grant.v2'
      OR snapshot_json->'record_stores' IS DISTINCT FROM version_row.manifest->'record_stores'
      OR jsonb_typeof(snapshot_json->'record_stores') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
    IF jsonb_array_length(snapshot_json->'record_stores') NOT BETWEEN 1 AND 16 THEN
      RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
    previous_action_key:=NULL;
    FOR policy IN SELECT value FROM jsonb_array_elements(snapshot_json->'record_stores') LOOP
      IF NOT COALESCE(jsonb_typeof(policy)='object'
        AND policy ?& ARRAY['schema_version','key','resource_key','runtime_requirement_key','max_record_bytes','max_files','max_file_bytes','max_total_file_bytes']
        AND policy-ARRAY['schema_version','key','resource_key','runtime_requirement_key','max_record_bytes','max_files','max_file_bytes','max_total_file_bytes','resource_content','record_changes','local_job_operations','future_record_actions','record_mirrors','source_projection']='{}'::jsonb
        AND policy->>'schema_version'='deft.app_record_store.v1'
        AND policy->>'key' ~ '^[a-z][a-z0-9_]{0,47}$'
        AND policy->>'key' NOT IN ('constructor','prototype','__proto__')
        AND policy->>'resource_key' ~ '^[a-z][a-z0-9_]{0,47}$'
        AND policy->>'runtime_requirement_key' ~ '^[a-z][a-z0-9_]{0,47}$',false) THEN
        RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
      FOR policy_key,policy_max IN VALUES ('max_record_bytes',491520),('max_files',32),('max_file_bytes',26214400),('max_total_file_bytes',26214400) LOOP
        IF jsonb_typeof(policy->policy_key) IS DISTINCT FROM 'number' THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
        IF (policy->>policy_key)::numeric NOT BETWEEN (CASE WHEN policy_key='max_files' THEN 0 ELSE 1 END) AND policy_max
          OR (policy->>policy_key)::numeric<>trunc((policy->>policy_key)::numeric) THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
      END LOOP;
      IF (policy->>'max_file_bytes')::numeric>(policy->>'max_total_file_bytes')::numeric
        OR previous_action_key IS NOT NULL AND previous_action_key COLLATE "C">=(policy->>'key') COLLATE "C"
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'sync_descriptors') d WHERE d->>'key'=policy->>'resource_key'
          AND d->>'runtime_requirement_key'=policy->>'runtime_requirement_key' AND d->>'requested_visibility'='user_private')
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'owner_connections') p WHERE p->>'resource_key'=policy->>'resource_key'
          AND p->>'runtime_requirement_key'=policy->>'runtime_requirement_key' AND p ? 'provider_profile_key') THEN
        RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
      IF policy ? 'source_projection' AND NOT deft_app_integration_source_projection_valid(policy->'source_projection',policy,snapshot_json) THEN RAISE EXCEPTION 'APP_V7_SOURCE_PROJECTION_INVALID' USING ERRCODE='23514';END IF;
      IF policy ? 'record_mirrors' AND NOT deft_app_record_mirrors_valid(policy->'record_mirrors',snapshot_json) THEN RAISE EXCEPTION 'APP_V7_RECORD_MIRROR_INVALID' USING ERRCODE='23514';END IF;
      IF policy ? 'future_record_actions' AND NOT deft_app_future_record_actions_valid(policy->'future_record_actions',snapshot_json) THEN RAISE EXCEPTION 'APP_V7_FUTURE_RECORD_ACTION_INVALID' USING ERRCODE='23514';END IF;
      IF policy ? 'local_job_operations' THEN
        IF jsonb_typeof(policy->'local_job_operations') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514';END IF;
        IF jsonb_array_length(policy->'local_job_operations') NOT BETWEEN 1 AND 8 THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514';END IF;
        previous_local_job_key:=NULL;
        FOR local_job_descriptor IN SELECT value FROM jsonb_array_elements(policy->'local_job_operations') LOOP
          IF NOT COALESCE(jsonb_typeof(local_job_descriptor)='object'
            AND local_job_descriptor ?& ARRAY['key','local_only'] AND local_job_descriptor-ARRAY['key','local_only']='{}'::jsonb
            AND local_job_descriptor->>'key' ~ '^[a-z][a-z0-9_]{0,47}$' AND local_job_descriptor->>'key' NOT IN ('constructor','prototype','__proto__')
            AND local_job_descriptor->'local_only'='true'::jsonb,false)
            OR previous_local_job_key IS NOT NULL AND previous_local_job_key COLLATE "C">=(local_job_descriptor->>'key') COLLATE "C" THEN
            RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514';END IF;
          previous_local_job_key:=local_job_descriptor->>'key';
        END LOOP;
      END IF;
      IF policy ? 'record_changes' THEN
        IF jsonb_typeof(policy->'record_changes') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
        IF jsonb_array_length(policy->'record_changes') NOT BETWEEN 1 AND 8 THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
        previous_change_key:=NULL;
        FOR change_descriptor IN SELECT value FROM jsonb_array_elements(policy->'record_changes') LOOP
          IF NOT COALESCE(jsonb_typeof(change_descriptor)='object'
            AND change_descriptor ?& ARRAY['key','source_store_key']
            AND change_descriptor-ARRAY['key','source_store_key']='{}'::jsonb
            AND change_descriptor->>'key' ~ '^[a-z][a-z0-9_]{0,47}$'
            AND change_descriptor->>'key' NOT IN ('constructor','prototype','__proto__')
            AND change_descriptor->>'source_store_key' ~ '^[a-z][a-z0-9_]{0,47}$'
            AND change_descriptor->>'source_store_key' NOT IN ('constructor','prototype','__proto__')
            AND change_descriptor->>'source_store_key'<>policy->>'key',false)
            OR previous_change_key IS NOT NULL AND previous_change_key COLLATE "C">=(change_descriptor->>'key') COLLATE "C"
            OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'record_stores') source_store
              WHERE source_store->>'key'=change_descriptor->>'source_store_key'
                AND source_store->>'resource_key'=policy->>'resource_key'
                AND source_store->>'runtime_requirement_key'=policy->>'runtime_requirement_key') THEN
            RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
          previous_change_key:=change_descriptor->>'key';
        END LOOP;
      END IF;
      IF policy ? 'resource_content' THEN
        payload_policy:=policy->'resource_content';
        IF NOT COALESCE(jsonb_typeof(payload_policy)='object' AND payload_policy ?& ARRAY['max_presentation_bytes','max_source_bytes','max_file_bytes','max_image_bytes']
          AND payload_policy-ARRAY['max_presentation_bytes','max_source_bytes','max_file_bytes','max_image_bytes']='{}'::jsonb,false) THEN
          RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
        FOR policy_key,policy_max IN VALUES ('max_presentation_bytes',262144),('max_source_bytes',36700160),('max_file_bytes',26214400),('max_image_bytes',2097152) LOOP
          IF jsonb_typeof(payload_policy->policy_key) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
          IF (payload_policy->>policy_key)::numeric NOT BETWEEN 1 AND policy_max OR (payload_policy->>policy_key)::numeric<>trunc((payload_policy->>policy_key)::numeric) THEN
            RAISE EXCEPTION 'APP_V7_RECORD_STORE_INVALID' USING ERRCODE='23514'; END IF;
        END LOOP;
      END IF;
      previous_action_key:=policy->>'key';
    END LOOP;
  END IF;
  -- Optional state is separately reviewed and exactly binds the signed manifest.
  IF snapshot_json ? 'private_state' OR version_row.manifest ? 'private_state' THEN
    IF snapshot_json->>'schema' IS DISTINCT FROM 'deft.app_blob_grant.v2'
      OR snapshot_json->'private_state' IS DISTINCT FROM version_row.manifest->'private_state'
      OR jsonb_typeof(snapshot_json->'private_state') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
    IF jsonb_array_length(snapshot_json->'private_state') NOT BETWEEN 1 AND 16 THEN
      RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
    FOR descriptor IN SELECT value FROM jsonb_array_elements(snapshot_json->'private_state') LOOP
      IF jsonb_typeof(descriptor) IS DISTINCT FROM 'object'
        OR NOT(descriptor ?& ARRAY['key','label','schema','max_record_bytes','max_records','max_total_bytes','retention_days'])
        OR descriptor-ARRAY['key','label','schema','max_record_bytes','max_records','max_total_bytes','retention_days','files','action_payloads']<>'{}'::jsonb
        OR NOT COALESCE(descriptor->>'key' ~ '^[a-z][a-z0-9_]{0,47}$',false)
        OR jsonb_typeof(descriptor->'label') IS DISTINCT FROM 'string'
        OR length(descriptor->>'label') NOT BETWEEN 1 AND 128
        OR jsonb_typeof(descriptor->'schema') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
      FOR policy_key,policy_max IN VALUES ('max_record_bytes',16384),('max_records',32),('max_total_bytes',131072),('retention_days',30) LOOP
        IF jsonb_typeof(descriptor->policy_key) IS DISTINCT FROM 'number' THEN
          RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
        IF (descriptor->>policy_key)::numeric NOT BETWEEN 1 AND policy_max
          OR (descriptor->>policy_key)::numeric<>trunc((descriptor->>policy_key)::numeric) THEN
          RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
      END LOOP;
      IF descriptor ? 'files' THEN
        policy := descriptor->'files';
        IF jsonb_typeof(policy) IS DISTINCT FROM 'object'
          OR NOT(policy ?& ARRAY['max_file_bytes','max_files_per_record','max_total_bytes_per_record','allowed_media_types'])
          OR policy-ARRAY['max_file_bytes','max_files_per_record','max_total_bytes_per_record','allowed_media_types']<>'{}'::jsonb THEN
          RAISE EXCEPTION 'APP_V7_PRIVATE_FILE_POLICY_INVALID' USING ERRCODE='23514'; END IF;
        FOR policy_key,policy_max IN VALUES ('max_file_bytes',2097152),('max_files_per_record',8),('max_total_bytes_per_record',8388608) LOOP
          IF jsonb_typeof(policy->policy_key) IS DISTINCT FROM 'number' THEN
            RAISE EXCEPTION 'APP_V7_PRIVATE_FILE_POLICY_INVALID' USING ERRCODE='23514'; END IF;
          IF (policy->>policy_key)::numeric NOT BETWEEN 1 AND policy_max
            OR (policy->>policy_key)::numeric<>trunc((policy->>policy_key)::numeric) THEN
            RAISE EXCEPTION 'APP_V7_PRIVATE_FILE_POLICY_INVALID' USING ERRCODE='23514'; END IF;
        END LOOP;
        IF (policy->>'max_file_bytes')::numeric>(policy->>'max_total_bytes_per_record')::numeric
          OR jsonb_typeof(policy->'allowed_media_types') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'APP_V7_PRIVATE_FILE_POLICY_INVALID' USING ERRCODE='23514'; END IF;
        IF jsonb_array_length(policy->'allowed_media_types') NOT BETWEEN 1 AND 8
          OR NOT(policy->'allowed_media_types'<@'["text/plain","text/csv","application/json","image/png","image/jpeg","image/gif","image/webp","application/pdf"]'::jsonb)
          OR jsonb_array_length(policy->'allowed_media_types')<>(SELECT count(DISTINCT value) FROM jsonb_array_elements(policy->'allowed_media_types')) THEN
          RAISE EXCEPTION 'APP_V7_PRIVATE_FILE_POLICY_INVALID' USING ERRCODE='23514'; END IF;
      END IF;
      IF descriptor ? 'action_payloads' THEN
        IF jsonb_typeof(descriptor->'action_payloads') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'APP_V7_ACTION_PAYLOAD_POLICY_INVALID' USING ERRCODE='23514'; END IF;
        IF jsonb_array_length(descriptor->'action_payloads') NOT BETWEEN 1 AND 16 THEN
          RAISE EXCEPTION 'APP_V7_ACTION_PAYLOAD_POLICY_INVALID' USING ERRCODE='23514'; END IF;
        previous_action_key := NULL;
        FOR payload_policy IN SELECT value FROM jsonb_array_elements(descriptor->'action_payloads') LOOP
          IF jsonb_typeof(payload_policy) IS DISTINCT FROM 'object'
            OR NOT(payload_policy ?& ARRAY['action_key','max_payload_bytes'])
            OR payload_policy-ARRAY['action_key','max_payload_bytes']<>'{}'::jsonb
            OR NOT COALESCE(payload_policy->>'action_key' ~ '^[a-z][a-z0-9_]{0,47}$',false)
            OR payload_policy->>'action_key' IN ('constructor','prototype','__proto__')
            OR payload_policy->>'action_key' ~ '^(deft|core|system)(_|$)'
            OR jsonb_typeof(payload_policy->'max_payload_bytes') IS DISTINCT FROM 'number' THEN
            RAISE EXCEPTION 'APP_V7_ACTION_PAYLOAD_POLICY_INVALID' USING ERRCODE='23514'; END IF;
          IF (payload_policy->>'max_payload_bytes')::numeric NOT BETWEEN 1 AND 8388608
            OR (payload_policy->>'max_payload_bytes')::numeric<>trunc((payload_policy->>'max_payload_bytes')::numeric)
            OR (previous_action_key IS NOT NULL AND previous_action_key COLLATE "C">=(payload_policy->>'action_key') COLLATE "C")
            OR payload_policy->>'action_key'=ANY(seen_payload_actions)
            OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(version_row.manifest->'runtime_actions') action WHERE action->>'key'=payload_policy->>'action_key') THEN
            RAISE EXCEPTION 'APP_V7_ACTION_PAYLOAD_POLICY_INVALID' USING ERRCODE='23514'; END IF;
          previous_action_key := payload_policy->>'action_key';
          seen_payload_actions := array_append(seen_payload_actions,previous_action_key);
        END LOOP;
      END IF;
      IF (descriptor->>'max_record_bytes')::numeric>(descriptor->>'max_total_bytes')::numeric THEN
        RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
    END LOOP;
    IF (SELECT count(DISTINCT value->>'key') FROM jsonb_array_elements(snapshot_json->'private_state'))<>jsonb_array_length(snapshot_json->'private_state') THEN
      RAISE EXCEPTION 'APP_V7_PRIVATE_STATE_DECLARATION_MISMATCH' USING ERRCODE='23514'; END IF;
  END IF;

  -- Optional member ownership is independently reviewed and cannot widen a
  -- resource or action declaration. Absence preserves historical grants.
  IF snapshot_json ? 'owner_connections' OR version_row.manifest ? 'owner_connections' THEN
    IF snapshot_json->>'schema' IS DISTINCT FROM 'deft.app_blob_grant.v2'
      OR snapshot_json->'owner_connections' IS DISTINCT FROM version_row.manifest->'owner_connections'
      OR jsonb_typeof(snapshot_json->'owner_connections') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'APP_V7_OWNER_CONNECTION_POLICY_INVALID' USING ERRCODE='23514'; END IF;
    IF jsonb_array_length(snapshot_json->'owner_connections') NOT BETWEEN 1 AND 16 THEN
      RAISE EXCEPTION 'APP_V7_OWNER_CONNECTION_POLICY_INVALID' USING ERRCODE='23514'; END IF;
    previous_action_key:=NULL;
    FOR policy IN SELECT value FROM jsonb_array_elements(snapshot_json->'owner_connections') LOOP
      IF jsonb_typeof(policy) IS DISTINCT FROM 'object'
        OR NOT(policy ?& ARRAY['key','resource_key','action_keys','max_consent_seconds'])
        OR policy-ARRAY['key','resource_key','action_keys','max_consent_seconds','provider_profile_key','runtime_requirement_key']<>'{}'::jsonb
        OR jsonb_typeof(policy->'key') IS DISTINCT FROM 'string'
        OR jsonb_typeof(policy->'resource_key') IS DISTINCT FROM 'string'
        OR NOT COALESCE(policy->>'key' ~ '^[a-z][a-z0-9_]{0,47}$',false)
        OR NOT COALESCE(policy->>'resource_key' ~ '^[a-z][a-z0-9_]{0,47}$',false)
        OR policy->>'key' IN ('constructor','prototype','__proto__')
        OR jsonb_typeof(policy->'action_keys') IS DISTINCT FROM 'array'
        OR jsonb_typeof(policy->'max_consent_seconds') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'APP_V7_OWNER_CONNECTION_POLICY_INVALID' USING ERRCODE='23514'; END IF;
      IF (policy->>'max_consent_seconds')::numeric NOT BETWEEN 1 AND 7776000
        OR (policy->>'max_consent_seconds')::numeric<>trunc((policy->>'max_consent_seconds')::numeric)
        OR jsonb_array_length(policy->'action_keys')>16
        OR (previous_action_key IS NOT NULL AND previous_action_key COLLATE "C">=(policy->>'key') COLLATE "C")
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'sync_descriptors') d
          WHERE d->>'key'=policy->>'resource_key' AND d->>'requested_visibility'='user_private') THEN
        RAISE EXCEPTION 'APP_V7_OWNER_CONNECTION_POLICY_INVALID' USING ERRCODE='23514'; END IF;
      IF (policy ? 'provider_profile_key') <> (policy ? 'runtime_requirement_key')
        OR (policy ? 'provider_profile_key' AND NOT COALESCE(
          jsonb_typeof(policy->'provider_profile_key') = 'string'
          AND jsonb_typeof(policy->'runtime_requirement_key') = 'string'
          AND policy->>'provider_profile_key' ~ '^[a-z][a-z0-9_]{0,47}$'
          AND policy->>'runtime_requirement_key' ~ '^[a-z][a-z0-9_]{0,47}$'
          AND policy->>'provider_profile_key' NOT IN ('constructor','prototype','__proto__')
          AND policy->>'runtime_requirement_key' NOT IN ('constructor','prototype','__proto__')
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'sync_descriptors') d
            WHERE d->>'key'=policy->>'resource_key' AND d->>'runtime_requirement_key'=policy->>'runtime_requirement_key')
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(version_row.manifest->'runtime_requirements') r
            WHERE r->>'key'=policy->>'runtime_requirement_key' AND r->>'protocol_version'='deft.app_runtime_channel.v3'),false)) THEN
        RAISE EXCEPTION 'APP_V7_OWNER_CONNECTION_PROFILE_INVALID' USING ERRCODE='23514';
      END IF;
      previous_action_key:=policy->>'key';
      policy_key:=NULL;
      FOR descriptor IN SELECT value FROM jsonb_array_elements(policy->'action_keys') LOOP
        IF jsonb_typeof(descriptor) IS DISTINCT FROM 'string'
          OR NOT COALESCE(descriptor#>>'{}' ~ '^[a-z][a-z0-9_]{0,47}$',false)
          OR (policy_key IS NOT NULL AND policy_key COLLATE "C">=(descriptor#>>'{}') COLLATE "C")
          OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'runtime_actions') d WHERE d->>'action_key'=descriptor#>>'{}') THEN
          RAISE EXCEPTION 'APP_V7_OWNER_CONNECTION_POLICY_INVALID' USING ERRCODE='23514'; END IF;
        policy_key:=descriptor#>>'{}';
      END LOOP;
    END LOOP;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- Strict declaration admission matching the current signed Kit source mapping.
CREATE OR REPLACE FUNCTION deft_app_integration_source_projection_valid(mapping jsonb, store_policy jsonb, snapshot_json jsonb) RETURNS boolean AS $$
DECLARE
 descriptor jsonb; entry_key text; field_name text; field_limit numeric; field_schema jsonb; max_length numeric;
BEGIN
 IF jsonb_typeof(mapping) IS DISTINCT FROM 'object'
  OR NOT(mapping ?& ARRAY['sync_descriptor_key','record_id_field','content_digest_field','observed_at_field','projection_identity_field','navigation_entry_key'])
  OR mapping-ARRAY['sync_descriptor_key','record_id_field','content_digest_field','observed_at_field','projection_identity_field','navigation_entry_key']<>'{}'::jsonb THEN RETURN false; END IF;
 FOR entry_key IN SELECT jsonb_object_keys(mapping) LOOP
  IF jsonb_typeof(mapping->entry_key) IS DISTINCT FROM 'string'
   OR NOT COALESCE(mapping->>entry_key ~ '^[a-z][a-z0-9_]{0,47}$',false)
   OR mapping->>entry_key IN ('constructor','prototype','__proto__') THEN RETURN false; END IF;
 END LOOP;
 IF (SELECT count(DISTINCT value) FROM jsonb_each_text(mapping) WHERE key IN ('record_id_field','content_digest_field','observed_at_field','projection_identity_field'))<>4
  OR mapping->>'sync_descriptor_key' IS DISTINCT FROM store_policy->>'resource_key'
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'experiences') e WHERE e->>'key'=mapping->>'navigation_entry_key') THEN RETURN false; END IF;
 SELECT d INTO descriptor FROM jsonb_array_elements(snapshot_json->'sync_descriptors') d
  WHERE d->>'key'=mapping->>'sync_descriptor_key' AND d->>'requested_visibility'='user_private'
   AND d->>'runtime_requirement_key'=store_policy->>'runtime_requirement_key';
 IF descriptor IS NULL OR jsonb_typeof(descriptor->'record_schema'->'properties') IS DISTINCT FROM 'object'
  OR jsonb_typeof(descriptor->'record_schema'->'required') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 FOR entry_key,field_limit IN VALUES ('record_id_field',36),('content_digest_field',71),('observed_at_field',64),('projection_identity_field',256) LOOP
  field_name:=mapping->>entry_key;field_schema:=descriptor->'record_schema'->'properties'->field_name;
  IF NOT COALESCE(descriptor->'record_schema'->'required' ? field_name,false)
   OR field_schema->>'type' IS DISTINCT FROM 'string'
   OR jsonb_typeof(field_schema->'maxLength') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  max_length:=(field_schema->>'maxLength')::numeric;
  IF max_length<>trunc(max_length) OR max_length NOT BETWEEN 1 AND field_limit THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END; $$ LANGUAGE plpgsql IMMUTABLE;


-- Reconcile the exact106 mirror contracts omitted by historical fresh bootstrap.
-- Existing migrated tables retain their data and exact helper semantics.
-- Generic separately reviewed recurring record-write purpose. MIME and private
-- provider references remain exclusively in the independent runtime journal.
CREATE TABLE IF NOT EXISTS app_prepared_record_action_receipts (
 org_id text NOT NULL,run_id text NOT NULL,owner_user_id text NOT NULL,receipt jsonb NOT NULL,receipt_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
 PRIMARY KEY(org_id,run_id),
 CHECK(jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=8192 AND receipt_digest ~ '^sha256:[a-f0-9]{64}$' AND isfinite(expires_at) AND expires_at>created_at)
);

CREATE OR REPLACE FUNCTION deft_prepared_record_action_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'prepared record source receipt immutable';END IF;
 IF NOT EXISTS(SELECT 1 FROM app_runs r WHERE r.org_id=NEW.org_id AND r.id=NEW.run_id AND r.initiating_actor_type='human' AND r.initiating_actor_id=NEW.owner_user_id AND r.provider_kind='app_runtime' AND r.origin_kind='app'
  AND r.operation_name=NEW.receipt->>'action_key' AND r.input_fingerprint=NEW.receipt->>'run_input_fingerprint'
  AND r.origin_app_installation_id=NEW.receipt->'scope'->>'installation_id' AND r.origin_app_version_id=NEW.receipt->'scope'->>'app_version_id' AND r.origin_app_grant_snapshot_id=NEW.receipt->'scope'->>'grant_snapshot_id'
  AND NEW.expires_at<=r.result_expires_at) THEN RAISE EXCEPTION 'prepared record receipt requires exact reviewed Run';END IF;RETURN NEW;
END;$$;

DO $reconcile106$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='app_prepared_record_action_receipts'::regclass AND tgname='prepared_record_action_receipt_guard' AND NOT tgisinternal) THEN CREATE TRIGGER prepared_record_action_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON app_prepared_record_action_receipts FOR EACH ROW EXECUTE FUNCTION deft_prepared_record_action_receipt_guard(); ELSE IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='app_prepared_record_action_receipts'::regclass AND t.tgname='prepared_record_action_receipt_guard' AND p.proname='deft_prepared_record_action_receipt_guard') THEN RAISE EXCEPTION 'Migration106 trigger contract mismatch: prepared_record_action_receipt_guard'; END IF; END IF; END $reconcile106$;

CREATE TABLE IF NOT EXISTS app_record_mirror_authorities (
 org_id text NOT NULL,owner_user_id text NOT NULL,receipt_id text NOT NULL,
 request_id text NOT NULL,review_web_session_id text NOT NULL,
 revision integer NOT NULL DEFAULT 1,state text NOT NULL DEFAULT 'enabled',
 store_key text NOT NULL,mirror_key text NOT NULL,account_ref text NOT NULL,
 installation_id text NOT NULL,app_version_id text NOT NULL,grant_snapshot_id text NOT NULL,
 runtime_registration_id text NOT NULL,resource_binding_id text NOT NULL,
 reviewed_authority jsonb NOT NULL,authority_digest text NOT NULL,policy_digest text NOT NULL,
 expires_at timestamptz NOT NULL,max_attempts_per_day integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,receipt_id),UNIQUE(org_id,owner_user_id,request_id),
 CHECK((receipt_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 AND request_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 AND account_ref ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 AND revision BETWEEN 1 AND 2147483646 AND state IN ('enabled','paused','revoked','expired')
 AND store_key ~ '^[a-z][a-z0-9_]{0,47}$' AND mirror_key ~ '^[a-z][a-z0-9_]{0,47}$'
 AND authority_digest ~ '^sha256:[a-f0-9]{64}$' AND policy_digest ~ '^sha256:[a-f0-9]{64}$'
 AND jsonb_typeof(reviewed_authority)='object' AND octet_length(reviewed_authority::text)<=65536
 AND isfinite(created_at) AND isfinite(updated_at) AND isfinite(expires_at)
 AND created_at<=updated_at AND created_at<expires_at AND expires_at<=created_at+interval '90 days'
 AND max_attempts_per_day BETWEEN 1 AND 1000) IS TRUE)
);

CREATE UNIQUE INDEX IF NOT EXISTS app_record_mirror_current ON app_record_mirror_authorities(org_id,owner_user_id,installation_id,store_key,mirror_key,account_ref) WHERE state='enabled';

CREATE TABLE IF NOT EXISTS app_record_mirror_runs (
 org_id text NOT NULL,receipt_id text NOT NULL,run_id text NOT NULL,request_id text NOT NULL,
 input_digest text NOT NULL,run_input_fingerprint text NOT NULL,input jsonb NOT NULL,record_id text NOT NULL,record_revision integer NOT NULL,
 snapshot_digest text NOT NULL,operation text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,run_id),UNIQUE(org_id,receipt_id,request_id),
 FOREIGN KEY(org_id,receipt_id) REFERENCES app_record_mirror_authorities(org_id,receipt_id),
 CHECK((request_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 AND run_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 AND record_id ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 AND record_revision BETWEEN 1 AND 2147483646 AND input_digest ~ '^sha256:[a-f0-9]{64}$'
 AND run_input_fingerprint ~ '^hmac-sha256:[a-f0-9]{64}$' AND jsonb_typeof(input)='object' AND octet_length(input::text)<=8192 AND snapshot_digest ~ '^sha256:[a-f0-9]{64}$' AND operation IN ('create','update','inspect','delete') AND isfinite(created_at)) IS TRUE)
);

CREATE INDEX IF NOT EXISTS app_record_mirror_budget ON app_record_mirror_runs(org_id,receipt_id,created_at);

CREATE OR REPLACE FUNCTION deft_app_record_mirror_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'mirror authority history retained';END IF;
 IF TG_TABLE_NAME='app_record_mirror_runs' THEN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'mirror operation identity immutable';END IF;RETURN NEW;
 END IF;
 IF TG_OP='INSERT' THEN IF NEW.state<>'enabled' OR NEW.revision<>1 THEN RAISE EXCEPTION 'mirror requires human reviewed enable';END IF;RETURN NEW;END IF;
 IF (to_jsonb(NEW)-ARRAY['revision','state','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','state','updated_at'])
 OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at
 OR NOT(OLD.state='enabled' AND NEW.state IN ('paused','revoked','expired') OR OLD.state='paused' AND NEW.state IN ('revoked','expired'))
 THEN RAISE EXCEPTION 'mirror reviewed identity/expiry immutable';END IF;RETURN NEW;
END;$$;

DO $reconcile106$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='app_record_mirror_authorities'::regclass AND tgname='app_record_mirror_authority_history_guard' AND NOT tgisinternal) THEN CREATE TRIGGER app_record_mirror_authority_history_guard BEFORE INSERT OR UPDATE OR DELETE ON app_record_mirror_authorities FOR EACH ROW EXECUTE FUNCTION deft_app_record_mirror_history_guard(); ELSE IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='app_record_mirror_authorities'::regclass AND t.tgname='app_record_mirror_authority_history_guard' AND p.proname='deft_app_record_mirror_history_guard') THEN RAISE EXCEPTION 'Migration106 trigger contract mismatch: app_record_mirror_authority_history_guard'; END IF; END IF; END $reconcile106$;

DO $reconcile106$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='app_record_mirror_runs'::regclass AND tgname='app_record_mirror_run_history_guard' AND NOT tgisinternal) THEN CREATE TRIGGER app_record_mirror_run_history_guard BEFORE INSERT OR UPDATE OR DELETE ON app_record_mirror_runs FOR EACH ROW EXECUTE FUNCTION deft_app_record_mirror_history_guard(); ELSE IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='app_record_mirror_runs'::regclass AND t.tgname='app_record_mirror_run_history_guard' AND p.proname='deft_app_record_mirror_history_guard') THEN RAISE EXCEPTION 'Migration106 trigger contract mismatch: app_record_mirror_run_history_guard'; END IF; END IF; END $reconcile106$;

ALTER TABLE app_runs DROP CONSTRAINT IF EXISTS app_runs_execution_release_shape_check;

ALTER TABLE app_runs ADD CONSTRAINT app_runs_execution_release_shape_check CHECK (
 (execution_release_kind IS NULL AND execution_released_at IS NULL) OR
 (execution_release_kind IS NOT NULL AND execution_released_at IS NOT NULL AND (
  (review_requirement='always' AND review_scope='per_invocation' AND execution_release_kind IN ('approved','record_mirror')) OR
  (review_requirement='always' AND review_scope='approved_automation_definition' AND execution_release_kind='approved_automation_definition') OR
  (review_requirement='policy' AND execution_release_kind IN ('policy_satisfied','approved')))));

CREATE OR REPLACE FUNCTION deft_app_record_mirror_release_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.execution_release_kind='record_mirror' AND (TG_OP='INSERT' OR OLD.execution_release_kind IS NULL) THEN
  IF NEW.provider_kind<>'app_runtime' OR NEW.origin_kind<>'app' OR NEW.initiating_actor_type<>'human'
   OR NOT EXISTS(SELECT 1 FROM app_record_mirror_runs m JOIN app_record_mirror_authorities a ON a.org_id=m.org_id AND a.receipt_id=m.receipt_id
    WHERE m.org_id=NEW.org_id AND m.run_id=NEW.id AND m.run_input_fingerprint=NEW.input_fingerprint
     AND a.reviewed_authority->'policy'->>'action_key'=NEW.operation_name
     AND a.reviewed_authority->'action_consents'->0->>'action_binding_id'=NEW.origin_runtime_binding_id
     AND a.owner_user_id=NEW.initiating_actor_id AND a.installation_id=NEW.origin_app_installation_id
     AND a.app_version_id=NEW.origin_app_version_id AND a.grant_snapshot_id=NEW.origin_app_grant_snapshot_id
     AND a.state='enabled' AND a.expires_at>clock_timestamp())
  THEN RAISE EXCEPTION 'record mirror requires exact durable reviewed receipt';END IF;
 END IF;RETURN NEW;
END;$$;

DO $reconcile106$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='app_runs'::regclass AND tgname='app_record_mirror_release_guard' AND NOT tgisinternal) THEN CREATE TRIGGER app_record_mirror_release_guard BEFORE INSERT OR UPDATE ON app_runs FOR EACH ROW EXECUTE FUNCTION deft_app_record_mirror_release_guard(); ELSE IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='app_runs'::regclass AND t.tgname='app_record_mirror_release_guard' AND p.proname='deft_app_record_mirror_release_guard') THEN RAISE EXCEPTION 'Migration106 trigger contract mismatch: app_record_mirror_release_guard'; END IF; END IF; END $reconcile106$;

CREATE OR REPLACE FUNCTION deft_app_record_mirrors_valid(actions jsonb,snapshot_json jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb;previous_key text;name text;minimum numeric;ceiling numeric;
BEGIN
 IF jsonb_typeof(actions) IS DISTINCT FROM 'array' OR jsonb_array_length(actions) NOT BETWEEN 1 AND 4 THEN RETURN false;END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(actions) LOOP
  IF NOT COALESCE(jsonb_typeof(item)='object' AND item ?& ARRAY['schema_version','key','action_key','max_authority_seconds','max_attempts_per_day','max_mime_bytes','operations','cleanup'] AND item-ARRAY['schema_version','key','action_key','max_authority_seconds','max_attempts_per_day','max_mime_bytes','operations','cleanup','cleanup_action_keys']='{}'::jsonb
   AND item->>'schema_version'='deft.app_record_mirror.v1' AND item->>'key' ~ '^[a-z][a-z0-9_]{0,47}$' AND item->>'key' NOT IN ('constructor','prototype','__proto__') AND item->>'action_key' ~ '^[a-z][a-z0-9_]{0,47}$' AND item->>'action_key' NOT IN ('constructor','prototype','__proto__')
   AND (previous_key IS NULL OR previous_key COLLATE "C"<(item->>'key') COLLATE "C") AND item->'operations'='["create","update","inspect","delete"]'::jsonb AND item->>'cleanup'='matching_accepted_submission'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'runtime_actions') a WHERE a->>'action_key'=item->>'action_key'),false) THEN RETURN false;END IF;
  IF item ? 'cleanup_action_keys' AND (jsonb_typeof(item->'cleanup_action_keys') IS DISTINCT FROM 'array' OR jsonb_array_length(item->'cleanup_action_keys') NOT BETWEEN 1 AND 4 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(item->'cleanup_action_keys') k WHERE k !~ '^[a-z][a-z0-9_]{0,47}$' OR k=item->>'action_key' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(snapshot_json->'runtime_actions') a WHERE a->>'action_key'=k)) OR (SELECT count(DISTINCT k) FROM jsonb_array_elements_text(item->'cleanup_action_keys') k)<>jsonb_array_length(item->'cleanup_action_keys') OR item->'cleanup_action_keys'<>(SELECT jsonb_agg(k ORDER BY k COLLATE "C") FROM jsonb_array_elements_text(item->'cleanup_action_keys') k)) THEN RETURN false;END IF;
  FOR name,minimum,ceiling IN VALUES ('max_authority_seconds',60,7776000),('max_attempts_per_day',1,1000),('max_mime_bytes',1,36700160) LOOP
   IF jsonb_typeof(item->name) IS DISTINCT FROM 'number' OR (item->>name)::numeric NOT BETWEEN minimum AND ceiling OR (item->>name)::numeric<>trunc((item->>name)::numeric) THEN RETURN false;END IF;
  END LOOP;previous_key:=item->>'key';
 END LOOP;
 IF (SELECT count(DISTINCT value->>'action_key') FROM jsonb_array_elements(actions))<>jsonb_array_length(actions) THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;END;$$;
