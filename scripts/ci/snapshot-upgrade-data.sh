#!/usr/bin/env bash
set -euo pipefail

output_dir="${1:?usage: snapshot-upgrade-data.sh OUTPUT_DIR}"
: "${DATABASE_URL:?DATABASE_URL is required}"

mkdir -p "$output_dir"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  relation_name text;
  representative_row integer;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['messages', 'tasks', 'wiki_pages', 'teams', 'agent_actions']
  LOOP
    IF (SELECT count(*) FROM pg_catalog.pg_class WHERE relname = relation_name AND relkind = 'r') <> 1 THEN
      RAISE EXCEPTION 'required upgrade-certification relation % is missing', relation_name;
    END IF;
    representative_row := NULL;
    EXECUTE format('SELECT 1 FROM %I LIMIT 1', relation_name) INTO representative_row;
    IF representative_row IS NULL THEN
      RAISE EXCEPTION 'required upgrade-certification relation % is empty', relation_name;
    END IF;
  END LOOP;
END $$;
SQL

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "\copy (
  SELECT id, org_id, space_id, user_id, content, parent_id, is_pinned, is_deleted
  FROM messages ORDER BY id
) TO '$output_dir/messages.csv' WITH (FORMAT csv, HEADER true)"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "\copy (
  SELECT id, org_id, project_id, number, title, description, status, priority,
         assignee_id, created_by, is_template, recurrence, source_message_id,
         parent_task_id, is_deleted
  FROM tasks ORDER BY id
) TO '$output_dir/tasks.csv' WITH (FORMAT csv, HEADER true)"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "\copy (
  SELECT id, org_id, scope, space_id, user_id, type, title, slug, summary,
         content, confidence, version, previous_content, is_deleted
  FROM wiki_pages ORDER BY id
) TO '$output_dir/wiki-pages.csv' WITH (FORMAT csv, HEADER true)"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "\copy (
  SELECT id, org_id, name, handle, description, type, visibility, lead_user_id,
         default_space_id, is_archived, created_by
  FROM teams ORDER BY id
) TO '$output_dir/teams.csv' WITH (FORMAT csv, HEADER true)"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "\copy (
  SELECT id, org_id, user_id, conversation_id, message_id, agent_employee_id,
         tool_use_id, source, action, params, result, approval_tier,
         approval_status, error, before_state, after_state
  FROM agent_actions ORDER BY id
) TO '$output_dir/agent-actions.csv' WITH (FORMAT csv, HEADER true)"
