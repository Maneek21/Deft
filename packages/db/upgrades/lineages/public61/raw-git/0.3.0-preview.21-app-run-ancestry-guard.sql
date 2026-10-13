-- Forward-only child Run lineage guard for the still-guarded App Run engine.
-- No current entrance creates child Runs; this protects the boundary before
-- future App orchestration can reach it.

CREATE OR REPLACE FUNCTION enforce_app_run_ancestry_insert() RETURNS trigger AS $$
DECLARE
  parent_row app_runs%ROWTYPE;
  root_row app_runs%ROWTYPE;
BEGIN
  IF NEW.depth = 0 THEN
    RETURN NEW;
  END IF;

  SELECT * INTO parent_row
    FROM app_runs
    WHERE org_id = NEW.org_id AND id = NEW.parent_run_id
    FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'APP_RUN_ANCESTRY_INVALID' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO root_row
    FROM app_runs
    WHERE org_id = NEW.org_id AND id = NEW.root_run_id
    FOR KEY SHARE;
  IF NOT FOUND OR root_row.depth <> 0 OR root_row.root_run_id <> root_row.id THEN
    RAISE EXCEPTION 'APP_RUN_ANCESTRY_INVALID' USING ERRCODE = '55000';
  END IF;

  IF parent_row.state NOT IN ('running', 'waiting_external')
    OR NEW.depth <> parent_row.depth + 1
    OR NEW.root_run_id <> parent_row.root_run_id
    OR NEW.id = NEW.parent_run_id
    OR NEW.id = NEW.root_run_id
  THEN
    RAISE EXCEPTION 'APP_RUN_ANCESTRY_INVALID' USING ERRCODE = '55000';
  END IF;

  IF (NEW.initiating_actor_type, NEW.initiating_actor_id,
      NEW.execution_actor_type, NEW.execution_actor_id, NEW.origin_kind)
    IS DISTINCT FROM
     (parent_row.initiating_actor_type, parent_row.initiating_actor_id,
      parent_row.execution_actor_type, parent_row.execution_actor_id, parent_row.origin_kind)
  THEN
    RAISE EXCEPTION 'APP_RUN_AUTHORIZATION_CEILING' USING ERRCODE = '55000';
  END IF;

  IF jsonb_typeof(NEW.authorization_snapshot->'authority_refs') <> 'array'
    OR jsonb_typeof(parent_row.authorization_snapshot->'authority_refs') <> 'array'
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(NEW.authorization_snapshot->'authority_refs') child_ref
      WHERE child_ref->>'authority_kind' IN (
        'membership', 'token_scope', 'employee_health', 'employee_budget'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(parent_row.authorization_snapshot->'authority_refs') parent_ref
        WHERE parent_ref->>'authority_kind' = child_ref->>'authority_kind'
          AND parent_ref->>'authority_id' = child_ref->>'authority_id'
          AND parent_ref->>'version' = child_ref->>'version'
      )
    )
  THEN
    RAISE EXCEPTION 'APP_RUN_AUTHORIZATION_CEILING' USING ERRCODE = '55000';
  END IF;

  IF (CASE NEW.risk_class
       WHEN 'read' THEN 0 WHEN 'internal_write' THEN 1 WHEN 'external_write' THEN 2
       WHEN 'destructive' THEN 3 WHEN 'privileged' THEN 4 ELSE 99 END)
     > (CASE parent_row.risk_class
       WHEN 'read' THEN 0 WHEN 'internal_write' THEN 1 WHEN 'external_write' THEN 2
       WHEN 'destructive' THEN 3 WHEN 'privileged' THEN 4 ELSE -1 END)
    OR (parent_row.review_requirement = 'always' AND NEW.review_requirement <> 'always')
    OR NEW.review_scope <> parent_row.review_scope
    OR (CASE NEW.retry_class
       WHEN 'unsafe_or_unknown' THEN 0 WHEN 'idempotent_with_key' THEN 1
       WHEN 'safe' THEN 2 ELSE 99 END)
       > (CASE parent_row.retry_class
       WHEN 'unsafe_or_unknown' THEN 0 WHEN 'idempotent_with_key' THEN 1
       WHEN 'safe' THEN 2 ELSE -1 END)
    OR (CASE NEW.retention_class
       WHEN 'ephemeral' THEN 0 WHEN 'standard' THEN 1 WHEN 'extended' THEN 2 ELSE 99 END
       > (CASE parent_row.retention_class
       WHEN 'ephemeral' THEN 0 WHEN 'standard' THEN 1 WHEN 'extended' THEN 2 ELSE -1 END))
    OR NEW.input_expires_at > parent_row.input_expires_at
    OR NEW.result_expires_at > parent_row.result_expires_at
    OR NEW.idempotency_expires_at > parent_row.idempotency_expires_at
    OR NEW.attempt_limit > parent_row.attempt_limit
  THEN
    RAISE EXCEPTION 'APP_RUN_POLICY_CEILING' USING ERRCODE = '55000';
  END IF;

  IF (NEW.budget_reserved_count, NEW.budget_limit_at_reservation)
    IS DISTINCT FROM
     (root_row.budget_reserved_count, root_row.budget_limit_at_reservation)
    OR date_trunc('milliseconds', NEW.budget_reserved_at)
      IS DISTINCT FROM date_trunc('milliseconds', root_row.budget_reserved_at)
    OR (
      NEW.execution_actor_type = 'agent_employee'
      AND root_row.budget_reserved_at IS NULL
    )
  THEN
    RAISE EXCEPTION 'APP_RUN_BUDGET_CONTINUITY' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_runs_ancestry_insert_trigger ON app_runs;
CREATE TRIGGER app_runs_ancestry_insert_trigger
  BEFORE INSERT ON app_runs
  FOR EACH ROW EXECUTE FUNCTION enforce_app_run_ancestry_insert();
