// One-shot idempotent cleanup for test-only rows that leaked into
// the seed DB from prior audit runs.
import 'dotenv/config';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const pool = new Pool({ connectionString });

async function main() {
  const client = await pool.connect();
  try {
    // Get test user IDs first
    const testUsers = await client.query(
      "select id from users where email like 'test-ui-shadow-%@test.local'",
    );
    const testUserIds = testUsers.rows.map((r: { id: string }) => r.id);

    if (testUserIds.length === 0) {
      console.log('No test shadow users found, skipping cleanup');
      return;
    }

    console.log(`Found ${testUserIds.length} test shadow user(s), cleaning up references...`);

    // Key tables that directly reference users; delete in dependency order
    // Complete list generated from information_schema.table_constraints
    const deleteSpecs = [
      { table: 'action_receipts', column: 'approver_id' },
      { table: 'agent_actions', column: 'user_id' },
      { table: 'agent_employee_templates', column: 'created_by' },
      { table: 'agent_employees', column: 'created_by' },
      { table: 'agent_employees', column: 'user_id' },
      { table: 'agent_memory', column: 'user_id' },
      { table: 'agent_nudges', column: 'user_id' },
      { table: 'agent_plans', column: 'user_id' },
      { table: 'api_keys', column: 'created_by' },
      { table: 'burnout_alerts', column: 'alerted_to' },
      { table: 'burnout_alerts', column: 'user_id' },
      { table: 'canvases', column: 'last_edited_by' },
      { table: 'clips', column: 'created_by' },
      { table: 'connected_accounts', column: 'user_id' },
      { table: 'cross_references', column: 'created_by' },
      { table: 'custom_emoji', column: 'uploaded_by' },
      { table: 'daily_notes', column: 'user_id' },
      { table: 'decisions', column: 'decided_by' },
      { table: 'events', column: 'user_id' },
      { table: 'favorites', column: 'user_id' },
      { table: 'files', column: 'uploaded_by' },
      { table: 'integrations', column: 'connected_by' },
      { table: 'invites', column: 'accepted_by' },
      { table: 'invites', column: 'invited_by' },
      { table: 'manager_settings', column: 'user_id' },
      { table: 'mcp_connections', column: 'created_by' },
      { table: 'meeting_briefs', column: 'user_id' },
      { table: 'message_bookmarks', column: 'user_id' },
      { table: 'messages', column: 'user_id' },
      { table: 'note_folders', column: 'user_id' },
      { table: 'note_shares', column: 'shared_with_user_id' },
      { table: 'notes', column: 'user_id' },
      { table: 'notifications', column: 'user_id' },
      { table: 'onboarding_state', column: 'user_id' },
      { table: 'oneone_preps', column: 'manager_id' },
      { table: 'oneone_preps', column: 'report_id' },
      { table: 'org_members', column: 'user_id' },
      { table: 'people_expertise', column: 'user_id' },
      { table: 'people_influence', column: 'user_id' },
      { table: 'people_interactions', column: 'user_a_id' },
      { table: 'people_interactions', column: 'user_b_id' },
      { table: 'people_patterns', column: 'user_id' },
      { table: 'people_relationships', column: 'user_a_id' },
      { table: 'people_relationships', column: 'user_b_id' },
      { table: 'pinned_messages', column: 'pinned_by' },
      { table: 'projects', column: 'lead_id' },
      { table: 'reactions', column: 'user_id' },
      { table: 'reminders', column: 'user_id' },
      { table: 'saved_views', column: 'user_id' },
      { table: 'scheduled_messages', column: 'user_id' },
      { table: 'skills', column: 'created_by' },
      { table: 'space_knowledge', column: 'created_by' },
      { table: 'space_members', column: 'user_id' },
      { table: 'spaces', column: 'created_by' },
      { table: 'task_activity', column: 'user_id' },
      { table: 'task_assignees', column: 'user_id' },
      { table: 'task_comments', column: 'user_id' },
      { table: 'task_watchers', column: 'user_id' },
      { table: 'tasks', column: 'assignee_id' },
      { table: 'tasks', column: 'created_by' },
      { table: 'thread_reads', column: 'user_id' },
      { table: 'triggers', column: 'created_by' },
      { table: 'user_group_members', column: 'user_id' },
      { table: 'user_groups', column: 'created_by' },
      { table: 'wiki_pages', column: 'user_id' },
      { table: 'workflow_rules', column: 'created_by' },
      { table: 'workflow_runs', column: 'triggered_by_user_id' },
    ];

    let totalDeleted = 0;
    for (const spec of deleteSpecs) {
      try {
        const result = await client.query(
          `delete from ${spec.table} where ${spec.column} = ANY($1::text[])`,
          [testUserIds],
        );
        const rowCount = result.rowCount ?? 0;
        if (rowCount > 0) {
          console.log(`  deleted ${rowCount} rows from ${spec.table}.${spec.column}`);
          totalDeleted += rowCount;
        }
      } catch (e: any) {
        // Skip if table/column doesn't exist
        if (!e.message.includes('does not exist') && !e.message.includes('column')) {
          throw e;
        }
      }
    }

    console.log(`Total rows cleaned up: ${totalDeleted}`);

    // Now delete the shadow users themselves
    const users = await client.query(
      'delete from users where email like $1 returning id',
      ['test-ui-shadow-%@test.local'],
    );
    console.log(`deleted ${users.rowCount} test shadow users`);

    // Delete BSL probe messages from old OpenClaw audits (if not already deleted)
    const msgs = await client.query(
      "delete from messages where content::text like '%@Test OpenClaw PM%BSL 1.1 licensing%' returning id",
    );
    console.log(`deleted ${msgs.rowCount} test BSL probe messages`);

    console.log('Cleanup complete');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
