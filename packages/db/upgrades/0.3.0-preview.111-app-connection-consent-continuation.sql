-- Independent owner time-only consent; historical sessions and effects remain unchanged.
CREATE OR REPLACE FUNCTION deft_app_consent_continuation_valid(r jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s jsonb:=r->'source'; a jsonb; b jsonb; n integer;
BEGIN
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r-ARRAY['session_id','revision','state','activation_started','scope','profile','source','action_consents','transport_digest','review_expires_at','reviewed_at','binding_before','attachment_consent_digest','review','result','created_at','updated_at']<>'{}'::jsonb
  OR NOT r ?& ARRAY['session_id','revision','state','activation_started','scope','profile','source','action_consents','transport_digest','review_expires_at','reviewed_at','binding_before','attachment_consent_digest','review','result','created_at','updated_at']
  OR NOT COALESCE(r->>'session_id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false)
  OR r->>'session_id'=s->>'session_id' OR jsonb_typeof(r->'revision') IS DISTINCT FROM 'number'
  OR (r->>'revision')::numeric<>trunc((r->>'revision')::numeric) OR (r->>'revision')::numeric NOT BETWEEN 0 AND 2147483647
  OR r->>'state' NOT IN ('preparing','reviewed','activating','indeterminate','committing','connected','not_connected')
  OR jsonb_typeof(r->'activation_started') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(r->'binding_before') IS DISTINCT FROM 'object'
  OR jsonb_typeof(r->'profile') IS DISTINCT FROM 'object'
  OR NOT COALESCE(r->>'attachment_consent_digest' ~ '^sha256:[a-f0-9]{64}$',false)
  OR s-ARRAY['session_id','session_revision','scope','runtime_session_ref','account_ref','action_consents']<>'{}'::jsonb
  OR NOT s ?& ARRAY['session_id','session_revision','scope','runtime_session_ref','account_ref','action_consents']
  OR ((r->'scope')-'consent_expires_at') IS DISTINCT FROM ((s->'scope')-'consent_expires_at')
  OR NOT COALESCE((r->'scope'->>'consent_expires_at')::timestamptz>(s->'scope'->>'consent_expires_at')::timestamptz,false)
  OR NOT deft_app_connection_reattachment_valid(jsonb_build_object('schema_version','deft.app_connection_reattachment.v1','source',s-'action_consents','transport_digest',r->'transport_digest','review_expires_at',r->'review_expires_at','review',r->'review','receipt',null),r->'scope')
  OR NOT deft_app_connection_actions_v2_valid(s->'action_consents',s->'scope')
  OR NOT deft_app_connection_actions_v2_valid(r->'action_consents',r->'scope')
  OR jsonb_array_length(r->'action_consents')<>jsonb_array_length(s->'action_consents')
  OR NOT COALESCE((r->>'reviewed_at')::timestamptz=(r->>'created_at')::timestamptz
    AND (r->>'review_expires_at')::timestamptz>(r->>'reviewed_at')::timestamptz
    AND (r->>'review_expires_at')::timestamptz<=(r->>'reviewed_at')::timestamptz+interval '120 seconds'
    AND (r->>'updated_at')::timestamptz>=(r->>'created_at')::timestamptz,false) THEN RETURN false; END IF;
 FOR n IN 0..jsonb_array_length(r->'action_consents')-1 LOOP
  a:=r->'action_consents'->n;b:=s->'action_consents'->n;
  IF (a-ARRAY['consent_digest','expires_at']) IS DISTINCT FROM (b-ARRAY['consent_digest','expires_at'])
    OR (a->>'expires_at')::timestamptz<=(b->>'expires_at')::timestamptz
    OR (a->>'expires_at')::timestamptz<(r->>'review_expires_at')::timestamptz THEN RETURN false; END IF;
 END LOOP;
 IF r->>'state' IN ('reviewed','activating','committing','connected') AND r->'review'='null'::jsonb THEN RETURN false; END IF;
 IF r->>'state' IN ('activating','committing','connected') AND r->'activation_started'<>'true'::jsonb THEN RETURN false; END IF;
 IF r->>'state'='not_connected' AND r->'activation_started'<>'false'::jsonb THEN RETURN false; END IF;
 IF r->'result'<>'null'::jsonb THEN
  IF jsonb_typeof(r->'result') IS DISTINCT FROM 'object' OR r->'result'->>'state'<>'connected'
   OR (r->'result')-ARRAY['schema_version','session_id','state','account','runtime_session_ref','custody_generation','receipt_digest']<>'{}'::jsonb
   OR NOT (r->'result') ?& ARRAY['schema_version','session_id','state','account','runtime_session_ref','custody_generation','receipt_digest']
   OR r->'result'->>'schema_version'<>'deft.app_connection_consent_continuation_runtime.v1'
   OR r->'result'->'session_id' IS DISTINCT FROM r->'session_id'
   OR r->'result'->'account' IS DISTINCT FROM r->'review'->'account'
   OR r->'result'->'custody_generation' IS DISTINCT FROM r->'review'->'custody_generation'
   OR NOT COALESCE(r->'result'->>'receipt_digest' ~ '^sha256:[a-f0-9]{64}$',false)
   OR NOT COALESCE(r->'result'->>'runtime_session_ref' ~ '^[A-Za-z0-9_-]+$' AND char_length(r->'result'->>'runtime_session_ref') BETWEEN 1 AND 512,false)
   OR r->'result'->'runtime_session_ref'=s->'runtime_session_ref' THEN RETURN false; END IF;
 END IF;
 RETURN r->>'state' NOT IN ('committing','connected') OR r->'result'<>'null'::jsonb;
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN RETURN false;
END; $$;
CREATE TABLE IF NOT EXISTS app_connection_consent_continuations(
 org_id text NOT NULL,owner_user_id text NOT NULL,session_id text NOT NULL,source_session_id text NOT NULL,resource_binding_id text NOT NULL,
 web_session_id text NOT NULL,access_expires_at timestamptz NOT NULL,authority_operation text NOT NULL,authority_expires_at timestamptz NOT NULL,revision integer NOT NULL CHECK(revision>=0),record jsonb NOT NULL,
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,PRIMARY KEY(org_id,owner_user_id,session_id),
 CONSTRAINT app_connection_consent_continuations_owner_fk FOREIGN KEY(org_id,owner_user_id) REFERENCES org_members(org_id,user_id) ON DELETE RESTRICT,
 CONSTRAINT app_connection_consent_continuations_source_fk FOREIGN KEY(org_id,owner_user_id,source_session_id) REFERENCES app_connection_sessions(org_id,owner_user_id,session_id) ON DELETE RESTRICT,
 CONSTRAINT app_connection_consent_continuations_binding_fk FOREIGN KEY(org_id,resource_binding_id) REFERENCES app_resource_bindings(org_id,id) ON DELETE RESTRICT,
 CONSTRAINT app_connection_consent_continuations_web_fk FOREIGN KEY(web_session_id) REFERENCES web_sessions(id) ON DELETE RESTRICT,
 CONSTRAINT app_connection_consent_continuations_record_bound CHECK(octet_length(record::text)<=32768)
);
-- Install cross-table guards also when Drizzle created the table on a fresh init.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_connection_consent_continuations'::regclass AND conname='app_connection_consent_continuations_source_fk') THEN
  ALTER TABLE app_connection_consent_continuations ADD CONSTRAINT app_connection_consent_continuations_source_fk FOREIGN KEY(org_id,owner_user_id,source_session_id) REFERENCES app_connection_sessions(org_id,owner_user_id,session_id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_connection_consent_continuations'::regclass AND conname='app_connection_consent_continuations_owner_fk') THEN
  ALTER TABLE app_connection_consent_continuations ADD CONSTRAINT app_connection_consent_continuations_owner_fk FOREIGN KEY(org_id,owner_user_id) REFERENCES org_members(org_id,user_id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_connection_consent_continuations'::regclass AND conname='app_connection_consent_continuations_binding_fk') THEN
  ALTER TABLE app_connection_consent_continuations ADD CONSTRAINT app_connection_consent_continuations_binding_fk FOREIGN KEY(org_id,resource_binding_id) REFERENCES app_resource_bindings(org_id,id) ON DELETE RESTRICT;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_connection_consent_continuations'::regclass AND conname='app_connection_consent_continuations_web_fk') THEN
  ALTER TABLE app_connection_consent_continuations ADD CONSTRAINT app_connection_consent_continuations_web_fk FOREIGN KEY(web_session_id) REFERENCES web_sessions(id) ON DELETE RESTRICT;
 END IF;
END; $$;
CREATE INDEX IF NOT EXISTS app_connection_consent_continuations_owner_idx ON app_connection_consent_continuations(org_id,owner_user_id,updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS app_connection_consent_continuations_source_once ON app_connection_consent_continuations(org_id,owner_user_id,source_session_id) WHERE record->>'state'<>'not_connected';
CREATE OR REPLACE FUNCTION deft_app_consent_continuation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s app_connection_sessions%ROWTYPE; k text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 IF NOT deft_app_consent_continuation_valid(NEW.record) OR NEW.record->>'session_id'<>NEW.session_id
  OR NEW.record->'scope'->>'org_id'<>NEW.org_id OR NEW.record->'scope'->>'owner_user_id'<>NEW.owner_user_id
  OR NEW.record->'scope'->>'resource_binding_id'<>NEW.resource_binding_id OR NEW.record->'source'->>'session_id'<>NEW.source_session_id
  OR (NEW.record->>'revision')::integer<>NEW.revision OR (NEW.record->>'created_at')::timestamptz<>NEW.created_at
  OR (NEW.record->>'updated_at')::timestamptz<>NEW.updated_at OR NOT isfinite(NEW.access_expires_at)
  OR NEW.authority_operation NOT IN ('prepare','activate','status') OR NOT isfinite(NEW.authority_expires_at)
  OR NEW.authority_expires_at>NEW.access_expires_at OR NEW.authority_expires_at>(NEW.record->'scope'->>'consent_expires_at')::timestamptz
  OR (NEW.authority_operation<>'status' AND NEW.authority_expires_at>(NEW.record->>'review_expires_at')::timestamptz)
  OR NOT EXISTS(SELECT 1 FROM web_sessions w WHERE w.id=NEW.web_session_id AND w.org_id=NEW.org_id AND w.user_id=NEW.owner_user_id) THEN
  RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_INVALID' USING ERRCODE='23514'; END IF;
 SELECT * INTO s FROM app_connection_sessions WHERE org_id=NEW.org_id AND owner_user_id=NEW.owner_user_id AND session_id=NEW.source_session_id FOR SHARE;
 IF s.session_id IS NULL OR s.record->>'state'<>'connected' OR s.revision<>(NEW.record->'source'->>'session_revision')::integer
  OR s.record->'scope' IS DISTINCT FROM NEW.record->'source'->'scope' OR s.record->'profile' IS DISTINCT FROM NEW.record->'profile'
  OR s.record->'action_consents' IS DISTINCT FROM NEW.record->'source'->'action_consents'
  OR s.record->'runtime_session_ref' IS DISTINCT FROM NEW.record->'source'->'runtime_session_ref'
  OR s.record->'account'->'account_ref' IS DISTINCT FROM NEW.record->'source'->'account_ref' THEN
  RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_SOURCE_STALE' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>0 OR NEW.record->>'state'<>'preparing' OR NEW.record->'activation_started'<>'false'::jsonb OR NEW.record->'review'<>'null'::jsonb OR NEW.record->'result'<>'null'::jsonb THEN RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_INITIAL_STATE' USING ERRCODE='23514'; END IF;
 ELSE
  IF (NEW.org_id,NEW.owner_user_id,NEW.session_id,NEW.source_session_id,NEW.resource_binding_id,NEW.created_at) IS DISTINCT FROM
    (OLD.org_id,OLD.owner_user_id,OLD.session_id,OLD.source_session_id,OLD.resource_binding_id,OLD.created_at) OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_CAS' USING ERRCODE='23514'; END IF;
  IF (NEW.web_session_id,NEW.access_expires_at,NEW.authority_operation,NEW.authority_expires_at) IS DISTINCT FROM (OLD.web_session_id,OLD.access_expires_at,OLD.authority_operation,OLD.authority_expires_at) AND
    (OLD.record->>'state' IN ('connected','not_connected','committing') OR NEW.access_expires_at<=clock_timestamp()
     OR NOT EXISTS(SELECT 1 FROM web_sessions w WHERE w.id=NEW.web_session_id AND w.org_id=NEW.org_id AND w.user_id=NEW.owner_user_id AND w.revoked_at IS NULL AND w.expires_at>clock_timestamp())) THEN
    RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_WEB_AUTHORITY_INVALID' USING ERRCODE='23514'; END IF;
  FOREACH k IN ARRAY ARRAY['session_id','scope','profile','source','action_consents','transport_digest','review_expires_at','reviewed_at','binding_before','attachment_consent_digest','created_at'] LOOP
   IF NEW.record->k IS DISTINCT FROM OLD.record->k THEN RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_PINS_IMMUTABLE' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF OLD.record->'review'<>'null'::jsonb AND NEW.record->'review' IS DISTINCT FROM OLD.record->'review'
   OR OLD.record->'result'<>'null'::jsonb AND NEW.record->'result' IS DISTINCT FROM OLD.record->'result'
   OR OLD.record->'activation_started'='true'::jsonb AND NEW.record->'activation_started'<>'true'::jsonb
   OR OLD.record->'activation_started'='false'::jsonb AND NEW.record->'activation_started'='true'::jsonb AND NOT(OLD.record->>'state'='reviewed' AND NEW.record->>'state'='activating' AND (OLD.record->>'review_expires_at')::timestamptz>clock_timestamp())
   OR NOT ((OLD.record->>'state'=NEW.record->>'state' AND OLD.record->>'state' IN ('preparing','reviewed','activating','indeterminate'))
     OR (OLD.record->>'state' IN ('preparing','indeterminate') AND NEW.record->>'state' IN ('reviewed','indeterminate','committing','not_connected'))
     OR (OLD.record->>'state'='reviewed' AND NEW.record->>'state' IN ('activating','reviewed','indeterminate','not_connected'))
     OR (OLD.record->>'state'='activating' AND NEW.record->>'state' IN ('committing','indeterminate'))
     OR (OLD.record->>'state'='committing' AND NEW.record->>'state'='connected')) THEN
    RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS app_consent_continuation_guard ON app_connection_consent_continuations;
CREATE TRIGGER app_consent_continuation_guard BEFORE INSERT OR UPDATE OR DELETE ON app_connection_consent_continuations FOR EACH ROW EXECUTE FUNCTION deft_app_consent_continuation_guard();
CREATE OR REPLACE FUNCTION app_owner_resource_consent_continuation_allowed(previous app_resource_bindings,amended app_resource_bindings) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE j app_connection_consent_continuations%ROWTYPE;
BEGIN
 IF previous.state<>'active' OR amended.state<>'active' OR previous.consent_expires_at IS NULL
  OR amended.consent_expires_at<=previous.consent_expires_at OR amended.consent_expires_at<=clock_timestamp()
  OR amended.reviewed_at<=previous.reviewed_at OR amended.reviewed_at>clock_timestamp()
  OR amended.reviewed_by_user_id IS DISTINCT FROM amended.owner_user_id
  OR (to_jsonb(previous)-ARRAY['consent_expires_at','reviewed_at','attachment_consent_digest','updated_at']) IS DISTINCT FROM (to_jsonb(amended)-ARRAY['consent_expires_at','reviewed_at','attachment_consent_digest','updated_at']) THEN RETURN false; END IF;
 SELECT * INTO j FROM app_connection_consent_continuations WHERE org_id=previous.org_id AND owner_user_id=previous.owner_user_id AND resource_binding_id=previous.id
   AND record->>'state'='committing' AND record->'activation_started'='true'::jsonb AND record->'result'->>'state'='connected' FOR SHARE;
 IF j.session_id IS NULL OR j.record->'binding_before' IS DISTINCT FROM to_jsonb(previous)
  OR (j.record->'scope'->>'consent_expires_at')::timestamptz IS DISTINCT FROM amended.consent_expires_at
  OR (j.record->>'reviewed_at')::timestamptz IS DISTINCT FROM amended.reviewed_at
  OR j.record->>'attachment_consent_digest' IS DISTINCT FROM amended.attachment_consent_digest
  OR NOT app_owner_connection_member(previous.org_id,previous.owner_user_id)
  OR NOT EXISTS(SELECT 1 FROM web_sessions w WHERE w.id=j.web_session_id AND w.org_id=j.org_id AND w.user_id=j.owner_user_id AND w.revoked_at IS NULL AND w.expires_at>clock_timestamp() AND j.access_expires_at>clock_timestamp())
  OR EXISTS(SELECT 1 FROM app_run_attempts a JOIN app_runs r ON r.org_id=a.org_id AND r.id=a.run_id LEFT JOIN app_runtime_bindings b ON b.org_id=r.org_id AND b.id=r.origin_runtime_binding_id
    WHERE r.org_id=previous.org_id AND (r.origin_resource_binding_id=previous.id OR b.owner_resource_binding_id=previous.id) AND a.state IN ('claimed','provider_call_started')) THEN RETURN false; END IF;
 RETURN true;
END; $$;
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
        IS DISTINCT FROM (OLD.reviewed_by_user_id, OLD.reviewed_at, OLD.consent_expires_at)
        AND NOT app_owner_resource_consent_continuation_allowed(OLD,NEW) THEN
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
    AND NOT app_owner_resource_page_amendment_allowed(OLD,NEW)
    AND NOT app_owner_resource_consent_continuation_allowed(OLD,NEW) THEN
    RAISE EXCEPTION 'APP_ATTACHMENT_CONSENT_IMMUTABLE' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION deft_app_consent_continuation_pair_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j app_connection_consent_continuations%ROWTYPE; c app_connection_sessions%ROWTYPE; b app_resource_bindings%ROWTYPE;
BEGIN
 SELECT * INTO j FROM app_connection_consent_continuations WHERE org_id=NEW.org_id AND owner_user_id=NEW.owner_user_id AND session_id=NEW.session_id;
 IF j.session_id IS NULL THEN RETURN NEW; END IF;
 IF j.record->>'state'='committing' THEN RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_SPLIT_STATE' USING ERRCODE='23514'; END IF;
 IF j.record->>'state'<>'connected' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='app_connection_sessions' AND NEW.revision>1 THEN RETURN NEW; END IF;
 SELECT * INTO c FROM app_connection_sessions WHERE org_id=j.org_id AND owner_user_id=j.owner_user_id AND session_id=j.session_id;
 SELECT * INTO b FROM app_resource_bindings WHERE org_id=j.org_id AND id=j.resource_binding_id;
 IF c.session_id IS NULL OR b.id IS NULL OR c.record->'scope' IS DISTINCT FROM j.record->'scope' OR c.record->'profile' IS DISTINCT FROM j.record->'profile'
  OR c.record->'action_consents' IS DISTINCT FROM j.record->'action_consents' OR c.record->'account' IS DISTINCT FROM j.record->'result'->'account'
  OR c.record->'runtime_session_ref' IS DISTINCT FROM j.record->'result'->'runtime_session_ref' OR c.record->'callback_consumed'<>'true'::jsonb
  OR c.record ?| ARRAY['action_consent','reattachment','upgrade'] OR c.web_session_id<>j.web_session_id OR c.access_expires_at<>j.access_expires_at
  OR b.consent_expires_at IS DISTINCT FROM (j.record->'scope'->>'consent_expires_at')::timestamptz
  OR b.reviewed_at IS DISTINCT FROM (j.record->>'reviewed_at')::timestamptz OR b.attachment_consent_digest IS DISTINCT FROM j.record->>'attachment_consent_digest'
  OR (to_jsonb(b)-ARRAY['consent_expires_at','reviewed_at','attachment_consent_digest','updated_at']) IS DISTINCT FROM ((j.record->'binding_before')-ARRAY['consent_expires_at','reviewed_at','attachment_consent_digest','updated_at']) THEN
  RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_SPLIT_STATE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS app_consent_continuation_pair_guard ON app_connection_consent_continuations;
CREATE CONSTRAINT TRIGGER app_consent_continuation_pair_guard AFTER INSERT OR UPDATE ON app_connection_consent_continuations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION deft_app_consent_continuation_pair_guard();
DROP TRIGGER IF EXISTS app_consent_continuation_carrier_guard ON app_connection_sessions;
CREATE CONSTRAINT TRIGGER app_consent_continuation_carrier_guard AFTER INSERT OR UPDATE ON app_connection_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION deft_app_consent_continuation_pair_guard();

-- Atomic claim race fence shares the resource binding lock with activation.
-- Pending and terminal unknown rows are never rewritten by consent renewal.
CREATE OR REPLACE FUNCTION deft_app_consent_continuation_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding_id text;
BEGIN
 IF NEW.state NOT IN ('claimed','provider_call_started') THEN RETURN NEW; END IF;
 SELECT COALESCE(r.origin_resource_binding_id,b.owner_resource_binding_id) INTO binding_id FROM app_runs r
  LEFT JOIN app_runtime_bindings b ON b.org_id=r.org_id AND b.id=r.origin_runtime_binding_id WHERE r.org_id=NEW.org_id AND r.id=NEW.run_id;
 IF binding_id IS NULL THEN RETURN NEW; END IF;
 PERFORM id FROM app_resource_bindings WHERE org_id=NEW.org_id AND id=binding_id FOR SHARE;
 IF EXISTS(SELECT 1 FROM app_connection_consent_continuations WHERE org_id=NEW.org_id AND resource_binding_id=binding_id
  AND record->'activation_started'='true'::jsonb AND record->>'state'<>'connected') THEN
  RAISE EXCEPTION 'APP_CONSENT_CONTINUATION_ACTIVATION_PENDING' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS app_consent_continuation_claim_guard ON app_run_attempts;
CREATE TRIGGER app_consent_continuation_claim_guard BEFORE INSERT OR UPDATE ON app_run_attempts FOR EACH ROW EXECUTE FUNCTION deft_app_consent_continuation_claim_guard();
