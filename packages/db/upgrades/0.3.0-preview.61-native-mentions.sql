-- Version .61 avoids the active Platform candidate's reserved .31 through .60.
-- No historical publication or notification backfill occurs.
CREATE TABLE IF NOT EXISTS native_reference_states (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id text NOT NULL REFERENCES orgs(id),
  source_kind text NOT NULL,
  source_id text NOT NULL,
  content_hash text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  current_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  published_person_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  publication_revision integer NOT NULL DEFAULT 0,
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS native_reference_source_unique
  ON native_reference_states(org_id, source_kind, source_id);
CREATE INDEX IF NOT EXISTS native_reference_org_idx ON native_reference_states(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS native_reference_org_id_unique ON native_reference_states(org_id, id);
CREATE INDEX IF NOT EXISTS native_reference_refs_gin
  ON native_reference_states USING gin(current_refs jsonb_path_ops);

CREATE TABLE IF NOT EXISTS native_mention_deliveries (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  org_id text NOT NULL REFERENCES orgs(id),
  source_state_id text NOT NULL REFERENCES native_reference_states(id) ON DELETE CASCADE,
  publication_revision integer NOT NULL,
  recipient_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  attention_id text,
  reason text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT native_mention_source_org_fk FOREIGN KEY (org_id, source_state_id)
    REFERENCES native_reference_states(org_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS native_mention_delivery_unique
  ON native_mention_deliveries(org_id, source_state_id, publication_revision, recipient_user_id);
CREATE INDEX IF NOT EXISTS native_mention_recipient_idx
  ON native_mention_deliveries(org_id, recipient_user_id);

-- All native writers share reconciliation, including direct MCP/agent SQL.
-- Only a source identity enters the queue; TypeScript validates current content.
CREATE OR REPLACE FUNCTION deft_enqueue_native_reference_reconciliation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_row jsonb;
  previous_row jsonb;
  source_kind text := TG_ARGV[0];
  body_field text := TG_ARGV[1];
  source_org text;
  source_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN source_row := to_jsonb(OLD);
  ELSE source_row := to_jsonb(NEW);
  END IF;
  IF TG_OP = 'UPDATE' THEN
    previous_row := to_jsonb(OLD);
    IF source_row->body_field IS NOT DISTINCT FROM previous_row->body_field
       AND source_row->'is_deleted' IS NOT DISTINCT FROM previous_row->'is_deleted' THEN
      RETURN NEW;
    END IF;
  END IF;
  source_org := source_row->>'org_id';
  source_id := source_row->>'id';
  -- Legacy content creates no extra queue traffic while the feature is off.
  IF coalesce(source_row->>body_field, '') NOT LIKE '%data-deft-ref-kind%'
     AND coalesce(source_row->>body_field, '') NOT LIKE '%[[deft:%'
     AND coalesce(previous_row->>body_field, '') NOT LIKE '%data-deft-ref-kind%'
     AND coalesce(previous_row->>body_field, '') NOT LIKE '%[[deft:%'
     AND NOT EXISTS (SELECT 1 FROM native_reference_states nrs
       WHERE nrs.org_id = source_org AND nrs.source_kind = TG_ARGV[0] AND nrs.source_id = source_row->>'id') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  INSERT INTO job_queue(id, org_id, queue, name, data, status, max_attempts, run_at, dedupe_key)
  VALUES (gen_random_uuid()::text, source_org, 'agent-jobs', 'native-mention-reconcile',
    jsonb_build_object('orgId', source_org, 'source',
      jsonb_build_object('kind', source_kind, 'id', source_id)),
    'pending', 5, now(),
    'native-ref:' || source_kind || ':' || source_id || ':' || txid_current()::text)
  ON CONFLICT DO NOTHING;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS native_reference_messages ON messages;
CREATE TRIGGER native_reference_messages AFTER INSERT OR UPDATE OF content, is_deleted OR DELETE
  ON messages FOR EACH ROW EXECUTE FUNCTION deft_enqueue_native_reference_reconciliation('message', 'content');
DROP TRIGGER IF EXISTS native_reference_tasks ON tasks;
CREATE TRIGGER native_reference_tasks AFTER INSERT OR UPDATE OF description, is_deleted OR DELETE
  ON tasks FOR EACH ROW EXECUTE FUNCTION deft_enqueue_native_reference_reconciliation('task', 'description');
DROP TRIGGER IF EXISTS native_reference_task_comments ON task_comments;
CREATE TRIGGER native_reference_task_comments AFTER INSERT OR UPDATE OF content, is_deleted OR DELETE
  ON task_comments FOR EACH ROW EXECUTE FUNCTION deft_enqueue_native_reference_reconciliation('task_comment', 'content');
DROP TRIGGER IF EXISTS native_reference_wiki_pages ON wiki_pages;
CREATE TRIGGER native_reference_wiki_pages AFTER INSERT OR UPDATE OF content, is_deleted OR DELETE
  ON wiki_pages FOR EACH ROW EXECUTE FUNCTION deft_enqueue_native_reference_reconciliation('wiki_page', 'content');
