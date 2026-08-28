/**
 * Shared agent-actions task boundary regression tests.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/agent-actions-task-project-boundary.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import pg from 'pg';

import { executeAction, executeActionDirect } from '../src/lib/agent-actions.js';
import { closeDb } from '../src/lib/db.js';

const DATABASE_URL = process.env.DEFT_TEST_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/deft';
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const orgId = `agent-action-boundary-org-${suffix}`;
const ownerId = `agent-action-boundary-owner-${suffix}`;
const employeeUserId = `agent-action-boundary-shadow-${suffix}`;
const employeeId = `agent-action-boundary-employee-${suffix}`;
const allowedProjectId = `agent-action-boundary-allowed-${suffix}`;
const deniedProjectId = `agent-action-boundary-denied-${suffix}`;
const allowedTaskId = `agent-action-boundary-task-allowed-${suffix}`;
const restrictedTaskId = `agent-action-boundary-task-private-${suffix}`;
const deniedTaskAId = `agent-action-boundary-task-denied-a-${suffix}`;
const deniedTaskBId = `agent-action-boundary-task-denied-b-${suffix}`;
const deniedProjectName = `Agent action denied ${suffix}`;

let client: pg.Client;

type DurableSnapshot = {
  task_count: number;
  comment_count: number;
  activity_count: number;
  relationship_count: number;
  cross_reference_count: number;
  agent_action_count: number;
  action_receipt_count: number;
  audit_count: number;
  daily_action_count: number;
  denied_a_status: string;
  denied_a_priority: string;
  denied_a_assignee_id: string | null;
};

async function snapshot(): Promise<DurableSnapshot> {
  const result = await client.query<DurableSnapshot>(
    `SELECT
       (SELECT count(*)::int FROM tasks WHERE project_id = $1) AS task_count,
       (SELECT count(*)::int FROM task_comments WHERE task_id IN ($2, $3, $4)) AS comment_count,
       (SELECT count(*)::int FROM task_activity WHERE task_id IN ($2, $3, $4)) AS activity_count,
       (SELECT count(*)::int FROM task_relationships
         WHERE source_task_id IN ($2, $3, $4) OR target_task_id IN ($2, $3, $4)) AS relationship_count,
       (SELECT count(*)::int FROM cross_references
         WHERE org_id = $5 AND target_type = 'task' AND target_id IN ($2, $3, $4)) AS cross_reference_count,
       (SELECT count(*)::int FROM agent_actions WHERE org_id = $5 AND agent_employee_id = $6) AS agent_action_count,
       (SELECT count(*)::int FROM action_receipts WHERE org_id = $5 AND employee_id = $6) AS action_receipt_count,
       (SELECT count(*)::int FROM audit_log WHERE org_id = $5 AND actor_id = $7) AS audit_count,
       (SELECT daily_action_count::int FROM agent_employees WHERE id = $6) AS daily_action_count,
       (SELECT status FROM tasks WHERE id = $2) AS denied_a_status,
       (SELECT priority FROM tasks WHERE id = $2) AS denied_a_priority,
       (SELECT assignee_id FROM tasks WHERE id = $2) AS denied_a_assignee_id`,
    [
      deniedProjectId,
      deniedTaskAId,
      deniedTaskBId,
      restrictedTaskId,
      orgId,
      employeeId,
      employeeUserId,
    ],
  );
  return result.rows[0]!;
}

async function assertDirectDenied(
  action: string,
  params: Record<string, unknown>,
): Promise<void> {
  await assert.rejects(
    executeActionDirect(
      action,
      params,
      orgId,
      employeeUserId,
      null,
      'auto',
      { agentEmployeeId: employeeId, source: 'runner' },
    ),
    /not found|inactive|deleted|outside/i,
    `${action} must fail before action persistence`,
  );
}

before(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  await client.query(
    `INSERT INTO orgs (id, name, slug)
     VALUES ($1, 'Agent action task boundary', $2)`,
    [orgId, `agent-action-boundary-${suffix}`],
  );
  await client.query(
    `INSERT INTO users (id, email, name, kind, is_agent, email_verified)
     VALUES
       ($1, $2, 'Boundary Owner', 'human', false, true),
       ($3, NULL, 'Boundary Employee', 'agent', true, true)`,
    [ownerId, `agent-action-boundary-${suffix}@test.local`, employeeUserId],
  );
  await client.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active)
     VALUES
       ($1, $2, $3, 'owner', true),
       ($4, $2, $5, 'member', true)`,
    [randomUUID(), orgId, ownerId, randomUUID(), employeeUserId],
  );
  await client.query(
    `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
     VALUES
       ($1, $2, 'Agent action allowed', $3, $4, 2),
       ($5, $2, $6, $7, $4, 2)`,
    [
      allowedProjectId,
      orgId,
      `ABA${suffix.slice(0, 5).toUpperCase()}`,
      ownerId,
      deniedProjectId,
      deniedProjectName,
      `ABD${suffix.slice(0, 5).toUpperCase()}`,
    ],
  );
  await client.query(
    `INSERT INTO tasks
      (id, org_id, project_id, number, title, status, priority, assignee_id, created_by, metadata, is_deleted)
     VALUES
       ($1, $2, $3, 1, 'Allowed task', 'todo', 'p2', $4, $4, '{}'::jsonb, false),
       ($5, $2, $3, 2, 'Restricted task', 'todo', 'p2', NULL, $6,
         jsonb_build_object('visibility', 'restricted', 'visible_user_ids', jsonb_build_array($6::text)), false),
       ($7, $2, $8, 1, 'Denied task A', 'todo', 'p2', NULL, $6, '{}'::jsonb, false),
       ($9, $2, $8, 2, 'Denied task B', 'todo', 'p2', NULL, $6, '{}'::jsonb, false)`,
    [
      allowedTaskId,
      orgId,
      allowedProjectId,
      employeeUserId,
      restrictedTaskId,
      ownerId,
      deniedTaskAId,
      deniedProjectId,
      deniedTaskBId,
    ],
  );
  await client.query(
    `INSERT INTO agent_employees
      (id, org_id, user_id, name, slug, role, system_prompt, project_ids,
       trust_level, max_daily_actions, daily_action_count, created_by, is_active, is_deleted, is_byoa)
     VALUES
      ($1, $2, $3, 'Boundary Employee', $4, 'project_manager', 'Boundary test', ARRAY[$5]::text[],
       'autonomous', 100, 0, $6, true, false, true)`,
    [employeeId, orgId, employeeUserId, `boundary-${suffix}`, allowedProjectId, ownerId],
  );
});

after(async () => {
  if (!client) return;
  await client.query('DELETE FROM action_receipts WHERE org_id = $1', [orgId]);
  await client.query('DELETE FROM task_relationships WHERE source_task_id IN ($1, $2, $3, $4) OR target_task_id IN ($1, $2, $3, $4)', [
    allowedTaskId,
    restrictedTaskId,
    deniedTaskAId,
    deniedTaskBId,
  ]);
  await client.query("DELETE FROM cross_references WHERE org_id = $1", [orgId]);
  await client.query('DELETE FROM task_comments WHERE org_id = $1', [orgId]);
  await client.query('DELETE FROM task_activity WHERE org_id = $1', [orgId]);
  await client.query('DELETE FROM audit_log WHERE org_id = $1', [orgId]);
  await client.query('DELETE FROM agent_actions WHERE org_id = $1', [orgId]);
  await client.query('DELETE FROM tasks WHERE org_id = $1', [orgId]);
  await client.query('DELETE FROM agent_employees WHERE org_id = $1', [orgId]);
  await client.query('DELETE FROM projects WHERE org_id = $1', [orgId]);
  await client.query('DELETE FROM org_members WHERE org_id = $1', [orgId]);
  await client.query('DELETE FROM users WHERE id = ANY($1::text[])', [[ownerId, employeeUserId]]);
  await client.query('DELETE FROM orgs WHERE id = $1', [orgId]);
  await client.end();
  await closeDb();
});

test('direct task writes deny out-of-project and restricted targets before every durable side effect', async () => {
  const beforeState = await snapshot();
  const deniedCalls: Array<[string, Record<string, unknown>]> = [
    ['create_task', { title: 'Must not be created', resolved_project_id: deniedProjectId }],
    ['create_task', { title: 'Must not be created by name', project_name: deniedProjectName }],
    ['update_task_status', { resolved_task_id: deniedTaskAId, new_status: 'done' }],
    ['close_task', { task_identifier: deniedTaskAId }],
    ['reopen_task', { task_identifier: deniedTaskAId }],
    ['bulk_update_tasks', { task_identifiers: [deniedTaskAId, deniedTaskBId], updates: { priority: 'p0' } }],
    ['assign_task', { task_identifier: deniedTaskAId, assignee_name: 'Boundary Owner' }],
    ['comment_on_task', { task_identifier: deniedTaskAId, content: 'Must not persist' }],
    ['set_due_date', { task_identifier: deniedTaskAId, due_date: '2026-09-01' }],
    ['set_priority', { task_identifier: deniedTaskAId, priority: 'p0' }],
    ['add_label', { task_identifier: deniedTaskAId, label_name: 'must-not-persist' }],
    ['add_dependency', {
      source_task_identifier: allowedTaskId,
      target_task_identifier: deniedTaskAId,
      type: 'blocks',
    }],
    ['remove_dependency', {
      source_task_identifier: allowedTaskId,
      target_task_identifier: deniedTaskAId,
      type: 'blocks',
    }],
    ['module_record_task_link', {
      resource_id: `module_record:${suffix}`,
      task_identifier: deniedTaskAId,
      idempotency_key: randomUUID(),
    }],
    ['module_record_task_unlink', {
      resource_id: `module_record:${suffix}`,
      task_identifier: deniedTaskAId,
      idempotency_key: randomUUID(),
    }],
    ['link_decision_to_tasks', { decision_id: randomUUID(), task_ids: [allowedTaskId, deniedTaskAId] }],
    ['set_priority', { task_identifier: restrictedTaskId, priority: 'p0' }],
  ];

  for (const [action, params] of deniedCalls) {
    await assertDirectDenied(action, params);
  }

  assert.deepEqual(await snapshot(), beforeState);
});

test('approved execution rechecks current scope and rejects a stale queued task write', async () => {
  const actionId = randomUUID();
  await client.query(
    `INSERT INTO agent_actions
      (id, org_id, user_id, agent_employee_id, source, action, params,
       approval_tier, approval_status, approved_at)
     VALUES ($1, $2, $3, $4, 'plan', 'comment_on_task', $5::jsonb, 'quick', 'approved', now())`,
    [
      actionId,
      orgId,
      employeeUserId,
      employeeId,
      JSON.stringify({ task_identifier: allowedTaskId, content: 'Stale approval must not persist' }),
    ],
  );
  await client.query(
    'UPDATE agent_employees SET project_ids = ARRAY[$2]::text[] WHERE id = $1',
    [employeeId, deniedProjectId],
  );

  const beforeState = await snapshot();
  const executed = await executeAction(
    actionId,
    'comment_on_task',
    { task_identifier: allowedTaskId, content: 'Stale approval must not persist' },
    orgId,
    employeeUserId,
    { agentEmployeeId: employeeId },
  );
  assert.equal(executed.success, false);
  assert.match(executed.error ?? '', /not found/i);
  assert.deepEqual(await snapshot(), beforeState);

  const durable = await client.query(
    `SELECT executed_at, result, error
     FROM agent_actions WHERE id = $1`,
    [actionId],
  );
  assert.equal(durable.rows[0].executed_at, null);
  assert.equal(durable.rows[0].result, null);
  assert.equal(durable.rows[0].error, null);

  await client.query(
    'UPDATE agent_employees SET project_ids = ARRAY[$2]::text[] WHERE id = $1',
    [employeeId, allowedProjectId],
  );
});

test('direct create_task rejects an archived project before action or task persistence', async () => {
  const beforeCounts = await client.query<{
    task_count: number;
    action_count: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM tasks WHERE project_id = $1) AS task_count,
       (SELECT count(*)::int FROM agent_actions WHERE org_id = $2) AS action_count`,
    [allowedProjectId, orgId],
  );
  await client.query('UPDATE projects SET is_archived = true WHERE id = $1', [allowedProjectId]);

  try {
    await assert.rejects(
      executeActionDirect(
        'create_task',
        { title: 'Archived project direct write', resolved_project_id: allowedProjectId },
        orgId,
        employeeUserId,
        null,
        'auto',
        { agentEmployeeId: employeeId, source: 'runner' },
      ),
      /project not found|archived/i,
    );

    const afterCounts = await client.query<{
      task_count: number;
      action_count: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM tasks WHERE project_id = $1) AS task_count,
         (SELECT count(*)::int FROM agent_actions WHERE org_id = $2) AS action_count`,
      [allowedProjectId, orgId],
    );
    assert.deepEqual(afterCounts.rows[0], beforeCounts.rows[0]);
  } finally {
    await client.query('UPDATE projects SET is_archived = false WHERE id = $1', [allowedProjectId]);
  }
});

test('approved create_task rechecks project lifecycle and rejects archive-after-approval', async () => {
  const actionId = randomUUID();
  const params = {
    title: 'Archived after approval',
    resolved_project_id: allowedProjectId,
  };
  await client.query(
    `INSERT INTO agent_actions
      (id, org_id, user_id, agent_employee_id, source, action, params,
       approval_tier, approval_status, approved_at)
     VALUES ($1, $2, $3, $4, 'plan', 'create_task', $5::jsonb, 'quick', 'approved', now())`,
    [actionId, orgId, employeeUserId, employeeId, JSON.stringify(params)],
  );
  const beforeTasks = await client.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM tasks WHERE project_id = $1',
    [allowedProjectId],
  );
  await client.query('UPDATE projects SET is_archived = true WHERE id = $1', [allowedProjectId]);

  try {
    const executed = await executeAction(
      actionId,
      'create_task',
      params,
      orgId,
      employeeUserId,
      { agentEmployeeId: employeeId },
    );
    assert.equal(executed.success, false);
    assert.match(executed.error ?? '', /project not found|archived/i);

    const afterTasks = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM tasks WHERE project_id = $1',
      [allowedProjectId],
    );
    assert.equal(afterTasks.rows[0]!.count, beforeTasks.rows[0]!.count);

    const durable = await client.query(
      'SELECT executed_at, result FROM agent_actions WHERE id = $1',
      [actionId],
    );
    assert.equal(durable.rows[0].executed_at, null);
    assert.equal(durable.rows[0].result, null);
  } finally {
    await client.query('UPDATE projects SET is_archived = false WHERE id = $1', [allowedProjectId]);
  }
});

test('inactive employees fail closed before direct action persistence', async () => {
  await client.query('UPDATE agent_employees SET is_active = false WHERE id = $1', [employeeId]);
  const beforeState = await snapshot();
  await assertDirectDenied('comment_on_task', {
    task_identifier: allowedTaskId,
    content: 'Inactive employee must not write',
  });
  assert.deepEqual(await snapshot(), beforeState);
  await client.query('UPDATE agent_employees SET is_active = true WHERE id = $1', [employeeId]);
});

test('null and empty project scopes remain backward-compatible and unrestricted', async () => {
  for (const unrestrictedValue of [null, []] as const) {
    await client.query('UPDATE agent_employees SET project_ids = $2 WHERE id = $1', [
      employeeId,
      unrestrictedValue,
    ]);
    const result = await executeActionDirect(
      'set_priority',
      { task_identifier: deniedTaskAId, priority: unrestrictedValue === null ? 'p1' : 'p3' },
      orgId,
      employeeUserId,
      null,
      'auto',
      { agentEmployeeId: employeeId, source: 'runner' },
    );
    assert.equal(result.success, true, result.error);
  }
  await client.query(
    'UPDATE agent_employees SET project_ids = ARRAY[$2]::text[] WHERE id = $1',
    [employeeId, allowedProjectId],
  );
});
