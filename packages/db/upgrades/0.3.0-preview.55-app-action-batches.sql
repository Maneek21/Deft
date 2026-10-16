CREATE TABLE IF NOT EXISTS app_action_batches (
 id text PRIMARY KEY, org_id text NOT NULL REFERENCES orgs(id), owner_user_id text NOT NULL REFERENCES users(id),
 runtime_binding_id text NOT NULL, source text NOT NULL CHECK(source IN ('defty','personal_mcp','employee_mcp')),
 employee_id text, token_id text, token_kind text, token_version integer,
 idempotency_digest text NOT NULL, content_digest text NOT NULL, title text NOT NULL CHECK(length(title)<=200),
 consent_grant_id text NOT NULL, consent_epoch integer NOT NULL,
 state text NOT NULL DEFAULT 'pending_approval' CHECK(state IN ('pending_approval','approved','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(), approved_at timestamptz, cancelled_at timestamptz,
 UNIQUE(org_id,id), UNIQUE(org_id,owner_user_id,source,idempotency_digest),
 FOREIGN KEY(org_id,runtime_binding_id) REFERENCES app_runtime_bindings(org_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(org_id,consent_grant_id,owner_user_id) REFERENCES app_experience_consent_grants(org_id,id,owner_user_id) ON DELETE RESTRICT,
 CHECK((source='defty' AND token_id IS NULL AND token_kind IS NULL) OR (source<>'defty' AND token_id IS NOT NULL AND token_kind IN ('mcp','oauth')))
);
CREATE TABLE IF NOT EXISTS app_action_batch_items (
 org_id text NOT NULL,batch_id text NOT NULL,item_key text NOT NULL,label text NOT NULL CHECK(length(label)<=200),
 ordinal integer NOT NULL CHECK(ordinal>=0 AND ordinal<10),run_id text NOT NULL,input_digest text NOT NULL,
 PRIMARY KEY(org_id,batch_id,item_key), UNIQUE(org_id,batch_id,ordinal), UNIQUE(org_id,run_id),
 FOREIGN KEY(org_id,batch_id) REFERENCES app_action_batches(org_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(org_id,run_id) REFERENCES app_runs(org_id,id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION deft_action_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Action batch identity is immutable'; END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['state','approved_at','cancelled_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','approved_at','cancelled_at']) THEN
  RAISE EXCEPTION 'Action batch identity is immutable'; END IF;
 IF TG_OP='UPDATE' AND (OLD.state='cancelled' AND NEW.state<>'cancelled' OR OLD.state='approved' AND NEW.state='pending_approval') THEN
  RAISE EXCEPTION 'Action batch release cannot be reset'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_action_batches_guard ON app_action_batches;
CREATE TRIGGER app_action_batches_guard BEFORE UPDATE OR DELETE ON app_action_batches FOR EACH ROW EXECUTE FUNCTION deft_action_batch_guard();
CREATE OR REPLACE FUNCTION deft_action_batch_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch_row app_action_batches%ROWTYPE; run_row app_runs%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Action batch membership is immutable'; END IF;
 SELECT * INTO batch_row FROM app_action_batches WHERE org_id=NEW.org_id AND id=NEW.batch_id FOR UPDATE;
 IF NOT FOUND OR batch_row.state<>'pending_approval' THEN RAISE EXCEPTION 'Action batch is closed'; END IF;
 SELECT * INTO run_row FROM app_runs WHERE org_id=NEW.org_id AND id=NEW.run_id;
 IF NOT FOUND OR run_row.state<>'pending_approval' OR run_row.provider_kind<>'app_runtime' OR run_row.origin_kind<>'app'
  OR run_row.origin_runtime_binding_id IS DISTINCT FROM batch_row.runtime_binding_id
  OR run_row.execution_actor_type<>'human' OR run_row.execution_actor_id<>batch_row.owner_user_id
  OR (batch_row.employee_id IS NULL AND (run_row.initiating_actor_type<>'human' OR run_row.initiating_actor_id<>batch_row.owner_user_id))
  OR (batch_row.employee_id IS NOT NULL AND (run_row.initiating_actor_type<>'agent_employee' OR run_row.initiating_actor_id<>batch_row.employee_id)) THEN
  RAISE EXCEPTION 'Action batch Run identity is invalid'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS app_action_batch_items_guard ON app_action_batch_items;
CREATE TRIGGER app_action_batch_items_guard BEFORE INSERT OR UPDATE OR DELETE ON app_action_batch_items FOR EACH ROW EXECUTE FUNCTION deft_action_batch_item_guard();

