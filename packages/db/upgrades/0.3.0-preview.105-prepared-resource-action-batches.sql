-- Additive only: scalar batches retain their existing defaults and guards.
ALTER TABLE app_action_batches ADD COLUMN IF NOT EXISTS release_mode text NOT NULL DEFAULT 'parallel_approval';
ALTER TABLE app_action_batches ADD COLUMN IF NOT EXISTS experience_session_id text;
ALTER TABLE app_action_batches ADD COLUMN IF NOT EXISTS connection_session_id text;
ALTER TABLE app_action_batches ADD COLUMN IF NOT EXISTS account_ref text;
ALTER TABLE app_action_batches ADD COLUMN IF NOT EXISTS resource_store_key text;
ALTER TABLE app_action_batches ADD COLUMN IF NOT EXISTS action_key text;
ALTER TABLE app_action_batches ADD COLUMN IF NOT EXISTS operation_key text;
ALTER TABLE app_action_batches ADD COLUMN IF NOT EXISTS review_expires_at timestamptz;
ALTER TABLE app_action_batches ADD COLUMN IF NOT EXISTS execution_expires_at timestamptz;
ALTER TABLE app_action_batches ADD COLUMN IF NOT EXISTS expected_child_count integer;
ALTER TABLE app_action_batch_items ADD COLUMN IF NOT EXISTS source_refs jsonb;
DO $guard$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='app_action_batches'::regclass AND conname='app_action_batch_release_mode') THEN
  ALTER TABLE app_action_batches ADD CONSTRAINT app_action_batch_release_mode CHECK(release_mode IN ('parallel_approval','prepared_resource_sequential'));
 ELSE
  CREATE TEMP TABLE deft_expected_app_action_batch_release_mode (LIKE app_action_batches) ON COMMIT DROP;
  ALTER TABLE deft_expected_app_action_batch_release_mode ADD CONSTRAINT app_action_batch_release_mode CHECK(release_mode IN ('parallel_approval','prepared_resource_sequential'));
  IF NOT EXISTS (SELECT 1 FROM pg_constraint actual JOIN pg_constraint expected ON expected.conrelid='deft_expected_app_action_batch_release_mode'::regclass AND expected.conname='app_action_batch_release_mode' WHERE actual.conrelid='app_action_batches'::regclass AND actual.conname='app_action_batch_release_mode' AND actual.contype='c' AND actual.convalidated AND pg_get_constraintdef(actual.oid)=pg_get_constraintdef(expected.oid)) THEN
   RAISE EXCEPTION 'Existing app_action_batch_release_mode does not match reviewed definition';
  END IF;
 END IF;
END $guard$;
DO $guard$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='app_action_batches'::regclass AND conname='app_action_batch_prepared_scope') THEN
  ALTER TABLE app_action_batches ADD CONSTRAINT app_action_batch_prepared_scope CHECK(release_mode='parallel_approval' OR (source='defty' AND employee_id IS NULL AND token_id IS NULL AND experience_session_id IS NOT NULL AND connection_session_id IS NOT NULL AND account_ref IS NOT NULL AND resource_store_key IS NOT NULL AND action_key IS NOT NULL AND operation_key IS NOT NULL AND review_expires_at IS NOT NULL AND expected_child_count IS NOT NULL AND expected_child_count BETWEEN 1 AND 4));
 ELSE
  CREATE TEMP TABLE deft_expected_app_action_batch_prepared_scope (LIKE app_action_batches) ON COMMIT DROP;
  ALTER TABLE deft_expected_app_action_batch_prepared_scope ADD CONSTRAINT app_action_batch_prepared_scope CHECK(release_mode='parallel_approval' OR (source='defty' AND employee_id IS NULL AND token_id IS NULL AND experience_session_id IS NOT NULL AND connection_session_id IS NOT NULL AND account_ref IS NOT NULL AND resource_store_key IS NOT NULL AND action_key IS NOT NULL AND operation_key IS NOT NULL AND review_expires_at IS NOT NULL AND expected_child_count IS NOT NULL AND expected_child_count BETWEEN 1 AND 4));
  IF NOT EXISTS (SELECT 1 FROM pg_constraint actual JOIN pg_constraint expected ON expected.conrelid='deft_expected_app_action_batch_prepared_scope'::regclass AND expected.conname='app_action_batch_prepared_scope' WHERE actual.conrelid='app_action_batches'::regclass AND actual.conname='app_action_batch_prepared_scope' AND actual.contype='c' AND actual.convalidated AND pg_get_constraintdef(actual.oid)=pg_get_constraintdef(expected.oid)) THEN
   RAISE EXCEPTION 'Existing app_action_batch_prepared_scope does not match reviewed definition';
  END IF;
 END IF;
END $guard$;
DO $guard$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='app_action_batch_items'::regclass AND conname='app_action_batch_prepared_sources') THEN
  ALTER TABLE app_action_batch_items ADD CONSTRAINT app_action_batch_prepared_sources CHECK(source_refs IS NULL OR jsonb_typeof(source_refs)='array' AND jsonb_array_length(source_refs) BETWEEN 1 AND 25);
 ELSE
  CREATE TEMP TABLE deft_expected_app_action_batch_prepared_sources (LIKE app_action_batch_items) ON COMMIT DROP;
  ALTER TABLE deft_expected_app_action_batch_prepared_sources ADD CONSTRAINT app_action_batch_prepared_sources CHECK(source_refs IS NULL OR jsonb_typeof(source_refs)='array' AND jsonb_array_length(source_refs) BETWEEN 1 AND 25);
  IF NOT EXISTS (SELECT 1 FROM pg_constraint actual JOIN pg_constraint expected ON expected.conrelid='deft_expected_app_action_batch_prepared_sources'::regclass AND expected.conname='app_action_batch_prepared_sources' WHERE actual.conrelid='app_action_batch_items'::regclass AND actual.conname='app_action_batch_prepared_sources' AND actual.contype='c' AND actual.convalidated AND pg_get_constraintdef(actual.oid)=pg_get_constraintdef(expected.oid)) THEN
   RAISE EXCEPTION 'Existing app_action_batch_prepared_sources does not match reviewed definition';
  END IF;
 END IF;
END $guard$;
-- Legacy prepared rows lack an execution bound and remain fail-closed at runtime.
-- No deadline is backfilled or renewed; newly accepted rows require the bound.
DO $guard$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='app_action_batches'::regclass AND conname='app_action_batch_execution_bound') THEN
  ALTER TABLE app_action_batches ADD CONSTRAINT app_action_batch_execution_bound CHECK(execution_expires_at IS NULL OR (release_mode='prepared_resource_sequential' AND isfinite(execution_expires_at) AND execution_expires_at>created_at));
 ELSE
  CREATE TEMP TABLE deft_expected_app_action_batch_execution_bound (LIKE app_action_batches) ON COMMIT DROP;
  ALTER TABLE deft_expected_app_action_batch_execution_bound ADD CONSTRAINT app_action_batch_execution_bound CHECK(execution_expires_at IS NULL OR (release_mode='prepared_resource_sequential' AND isfinite(execution_expires_at) AND execution_expires_at>created_at));
  IF NOT EXISTS (SELECT 1 FROM pg_constraint actual JOIN pg_constraint expected ON expected.conrelid='deft_expected_app_action_batch_execution_bound'::regclass AND expected.conname='app_action_batch_execution_bound' WHERE actual.conrelid='app_action_batches'::regclass AND actual.conname='app_action_batch_execution_bound' AND actual.contype='c' AND actual.convalidated AND pg_get_constraintdef(actual.oid)=pg_get_constraintdef(expected.oid)) THEN
   RAISE EXCEPTION 'Existing app_action_batch_execution_bound does not match reviewed definition';
  END IF;
 END IF;
END $guard$;
-- Existing immutable identity and membership triggers cover the new columns.
-- Membership is inserted while each Run is pending_approval, before human
-- confirmation queues it. The group is accepted atomically with all members.

CREATE OR REPLACE FUNCTION deft_prepared_resource_batch_acceptance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE members integer; first_ordinal integer; last_ordinal integer; references_count integer; distinct_count integer;
BEGIN
 IF NEW.release_mode<>'prepared_resource_sequential' OR NEW.state<>'approved' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN IF OLD.state='approved' THEN IF NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN RAISE EXCEPTION 'Prepared resource batch approval timestamp is immutable'; END IF; RETURN NEW; END IF; END IF;
 IF NEW.execution_expires_at IS NULL OR NEW.approved_at IS NULL OR NEW.approved_at>NEW.review_expires_at OR NEW.review_expires_at<=clock_timestamp() OR NEW.approved_at>clock_timestamp() OR NEW.execution_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Prepared resource batch execution authority is expired or missing'; END IF;
 SELECT count(*)::integer,min(i.ordinal),max(i.ordinal) INTO members,first_ordinal,last_ordinal
 FROM app_action_batch_items i WHERE i.org_id=NEW.org_id AND i.batch_id=NEW.id;
 IF members IS DISTINCT FROM NEW.expected_child_count OR first_ordinal IS DISTINCT FROM 0 OR last_ordinal IS DISTINCT FROM NEW.expected_child_count-1
 OR EXISTS(SELECT 1 FROM app_action_batch_items i JOIN app_runs r ON r.org_id=i.org_id AND r.id=i.run_id LEFT JOIN app_runtime_bindings binding ON binding.org_id=r.org_id AND binding.id=r.origin_runtime_binding_id WHERE i.org_id=NEW.org_id AND i.batch_id=NEW.id AND
 (i.source_refs IS NULL OR jsonb_typeof(i.source_refs)<>'array' OR jsonb_array_length(i.source_refs) NOT BETWEEN 1 AND 25
 OR r.state<>'pending_approval' OR binding.id IS NULL OR binding.action_key IS DISTINCT FROM NEW.action_key OR r.operation_name IS DISTINCT FROM binding.operation_name OR r.origin_runtime_binding_id IS DISTINCT FROM NEW.runtime_binding_id
 OR r.execution_actor_type<>'human' OR r.execution_actor_id<>NEW.owner_user_id OR NEW.execution_expires_at>r.input_expires_at OR NEW.execution_expires_at>r.result_expires_at)) THEN RAISE EXCEPTION 'Prepared resource batch membership is incomplete'; END IF;
 SELECT count(*)::integer,count(DISTINCT source->>'record_id')::integer INTO references_count,distinct_count
 FROM app_action_batch_items i CROSS JOIN LATERAL jsonb_array_elements(i.source_refs) source WHERE i.org_id=NEW.org_id AND i.batch_id=NEW.id;
 IF references_count NOT BETWEEN 1 AND 100 OR references_count<>distinct_count THEN RAISE EXCEPTION 'Prepared resource batch selection is not exact'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_prepared_resource_batch_acceptance_guard ON app_action_batches;
CREATE TRIGGER app_prepared_resource_batch_acceptance_guard BEFORE INSERT OR UPDATE ON app_action_batches FOR EACH ROW EXECUTE FUNCTION deft_prepared_resource_batch_acceptance_guard();
