/**
 * Employee MCP task project-boundary regression tests.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/mcp-task-project-boundary.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  employeeCanAccessProject,
  loadEmployeeProjectAccess,
} from '../src/lib/mcp-tools/employee-project-access.js';
import {
  projectProgress,
  taskDetail,
  teamWorkload,
} from '../src/lib/mcp-tools/reports.js';
import {
  executeTaskCreate,
  executeTaskUpdate,
  taskCreate,
  taskUpdate,
} from '../src/lib/mcp-tools/writes.js';
import type { ToolContext, ToolResult } from '../src/lib/mcp-tools/types.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let orgId = '';
let humanUserId = '';
let shadowUserId = '';
let scopedEmployeeId = '';
let nullScopeEmployeeId = '';
let emptyScopeEmployeeId = '';
let allowedProjectId = '';
let deniedProjectId = '';
let deletedProjectId = '';
let allowedTaskId = '';
let deniedTaskId = '';
let deletedProjectTaskId = '';
let restrictedTaskId = '';
let allowedPrefix = '';
const deniedMarker = `DENIED-PROJECT-SECRET-${suffix}`;
const restrictedMarker = `RESTRICTED-TASK-SECRET-${suffix}`;

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function context(employeeId = scopedEmployeeId): ToolContext {
  return {
    org_id: orgId,
    employee_id: employeeId,
    employee_slug: `scoped-${suffix}`,
    trust_level: 'standard',
  };
}

function payload(result: ToolResult): any {
  return JSON.parse(result.content[0]?.text ?? 'null');
}

before(async () => {
  await withClient(async (client) => {
    const org = await client.query<{ id: string }>(
      `INSERT INTO orgs (id, name, slug)
       VALUES (gen_random_uuid()::text, $1, $2)
       RETURNING id`,
      ['MCP project boundary', `mcp-project-boundary-${suffix}`],
    );
    orgId = org.rows[0]!.id;

    const human = await client.query<{ id: string }>(
      `INSERT INTO users (id, email, name, kind, is_agent, email_verified)
       VALUES (gen_random_uuid()::text, $1, 'MCP Boundary Owner', 'human', false, true)
       RETURNING id`,
      [`mcp-boundary-owner-${suffix}@test.local`],
    );
    humanUserId = human.rows[0]!.id;

    const shadow = await client.query<{ id: string }>(
      `INSERT INTO users (id, email, name, kind, is_agent, email_verified)
       VALUES (gen_random_uuid()::text, $1, 'MCP Boundary Agent', 'agent', true, true)
       RETURNING id`,
      [`mcp-boundary-agent-${suffix}@test.local`],
    );
    shadowUserId = shadow.rows[0]!.id;

    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES
         (gen_random_uuid()::text, $1, $2, 'owner', true),
         (gen_random_uuid()::text, $1, $3, 'member', true)`,
      [orgId, humanUserId, shadowUserId],
    );

    allowedPrefix = `A1${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const deniedPrefix = `D${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const projectRows = await client.query<{ id: string; prefix: string }>(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES
         (gen_random_uuid()::text, $1, $2, $3, $4, 2),
         (gen_random_uuid()::text, $1, $5, $6, $4, 1)
       RETURNING id, prefix`,
      [
        orgId,
        `Allowed project ${suffix}`,
        allowedPrefix,
        humanUserId,
        `Denied project ${suffix}`,
        deniedPrefix,
      ],
    );
    allowedProjectId = projectRows.rows.find((row) => row.prefix === allowedPrefix)!.id;
    deniedProjectId = projectRows.rows.find((row) => row.prefix === deniedPrefix)!.id;

    const deletedProject = await client.query<{ id: string }>(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter, is_deleted)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 1, true)
       RETURNING id`,
      [
        orgId,
        `Soft-deleted project ${suffix}`,
        `X${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        humanUserId,
      ],
    );
    deletedProjectId = deletedProject.rows[0]!.id;

    const taskRows = await client.query<{ id: string; project_id: string; title: string }>(
      `INSERT INTO tasks (
         id, org_id, project_id, number, title, status, priority,
         assignee_id, created_by, is_deleted, metadata
       ) VALUES
         (gen_random_uuid()::text, $1, $2, 1, $3, 'todo', 'p2', $4, $4, false, '{}'::jsonb),
         (gen_random_uuid()::text, $1, $5, 1, $6, 'todo', 'p2', $4, $4, false, '{}'::jsonb),
         (gen_random_uuid()::text, $1, $2, 2, $7, 'todo', 'p2', $8, $8, false, '{"visibility":"restricted"}'::jsonb)
       RETURNING id, project_id, title`,
      [
        orgId,
        allowedProjectId,
        `Allowed task ${suffix}`,
        shadowUserId,
        deniedProjectId,
        deniedMarker,
        restrictedMarker,
        humanUserId,
      ],
    );
    allowedTaskId = taskRows.rows.find((row) => row.title === `Allowed task ${suffix}`)!.id;
    deniedTaskId = taskRows.rows.find((row) => row.project_id === deniedProjectId)!.id;
    restrictedTaskId = taskRows.rows.find((row) => row.title === restrictedMarker)!.id;

    const deletedProjectTask = await client.query<{ id: string }>(
      `INSERT INTO tasks (
         id, org_id, project_id, number, title, status, priority,
         assignee_id, created_by, is_deleted, metadata
       ) VALUES (
         gen_random_uuid()::text, $1, $2, 1, $3, 'todo', 'p1', $4, $4, false, '{}'::jsonb
       ) RETURNING id`,
      [orgId, deletedProjectId, `Task in soft-deleted project ${suffix}`, shadowUserId],
    );
    deletedProjectTaskId = deletedProjectTask.rows[0]!.id;

    const employees = await client.query<{ id: string; slug: string }>(
      `INSERT INTO agent_employees (
         id, org_id, user_id, name, slug, role, system_prompt, project_ids,
         trust_level, max_daily_actions, created_by, is_active, is_byoa
       ) VALUES
         (gen_random_uuid()::text, $1, $2, 'Scoped employee', $3, 'project_manager', 'test', ARRAY[$4]::text[], 'standard', 50, $5, true, true),
         (gen_random_uuid()::text, $1, $2, 'Null-scope employee', $6, 'project_manager', 'test', NULL, 'standard', 50, $5, true, true),
         (gen_random_uuid()::text, $1, $2, 'Empty-scope employee', $7, 'project_manager', 'test', ARRAY[]::text[], 'standard', 50, $5, true, true)
       RETURNING id, slug`,
      [
        orgId,
        shadowUserId,
        `scoped-${suffix}`,
        allowedProjectId,
        humanUserId,
        `null-${suffix}`,
        `empty-${suffix}`,
      ],
    );
    scopedEmployeeId = employees.rows.find((row) => row.slug === `scoped-${suffix}`)!.id;
    nullScopeEmployeeId = employees.rows.find((row) => row.slug === `null-${suffix}`)!.id;
    emptyScopeEmployeeId = employees.rows.find((row) => row.slug === `empty-${suffix}`)!.id;
  });
});

after(async () => {
  if (!orgId) return;
  await withClient(async (client) => {
    await client.query(
      `DELETE FROM action_receipts
       WHERE action_id IN (SELECT id FROM agent_actions WHERE org_id = $1)`,
      [orgId],
    );
    await client.query(`DELETE FROM task_comments WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM task_activity WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM agent_actions WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM tasks WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM agent_employees WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM projects WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM org_members WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM users WHERE id IN ($1, $2)`, [humanUserId, shadowUserId]);
    await client.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
  });
});

test('project access treats null and [] as unrestricted and missing/deleted employees as denied', async () => {
  const scoped = await loadEmployeeProjectAccess(context());
  assert.equal(scoped.resolved, true);
  assert.equal(scoped.unrestricted, false);
  assert.deepEqual(scoped.projectIds, [allowedProjectId]);
  assert.equal(await employeeCanAccessProject(context(), allowedProjectId), true);
  assert.equal(await employeeCanAccessProject(context(), deniedProjectId), false);

  const nullScope = await loadEmployeeProjectAccess(context(nullScopeEmployeeId));
  assert.equal(nullScope.resolved, true);
  assert.equal(nullScope.unrestricted, true);

  const emptyScope = await loadEmployeeProjectAccess(context(emptyScopeEmployeeId));
  assert.equal(emptyScope.resolved, true);
  assert.equal(emptyScope.unrestricted, true);

  const missing = await loadEmployeeProjectAccess(context('missing-employee'));
  assert.equal(missing.resolved, false);
  assert.equal(await employeeCanAccessProject(context('missing-employee'), allowedProjectId), false);

  await withClient((client) => client.query(
    `UPDATE agent_employees SET is_deleted = true WHERE id = $1`,
    [emptyScopeEmployeeId],
  ));
  const deleted = await loadEmployeeProjectAccess(context(emptyScopeEmployeeId));
  assert.equal(deleted.resolved, false);
});

test('task detail, project progress, and team workload exclude projects outside employee scope', async () => {
  const allowedDetail = await taskDetail({ task_identifier: allowedTaskId }, context());
  assert.equal(allowedDetail.isError, false, JSON.stringify(allowedDetail));
  assert.equal(payload(allowedDetail).id, allowedTaskId);

  const allowedKeyDetail = await taskDetail({ task_identifier: `${allowedPrefix}-1` }, context());
  assert.equal(allowedKeyDetail.isError, false, JSON.stringify(allowedKeyDetail));
  assert.equal(payload(allowedKeyDetail).id, allowedTaskId);

  const deniedDetail = await taskDetail({ task_identifier: deniedTaskId }, context());
  assert.equal(deniedDetail.isError, true);
  assert.doesNotMatch(deniedDetail.content[0]?.text ?? '', new RegExp(deniedMarker));

  const restrictedDetail = await taskDetail({ task_identifier: restrictedTaskId }, context());
  assert.equal(restrictedDetail.isError, true);
  assert.doesNotMatch(restrictedDetail.content[0]?.text ?? '', new RegExp(restrictedMarker));

  const allowedProgress = await projectProgress({ project_id: allowedProjectId }, context());
  assert.equal(allowedProgress.isError, false, JSON.stringify(allowedProgress));
  assert.equal(payload(allowedProgress).total_tasks, 1);

  const deniedProgress = await projectProgress({ project_id: deniedProjectId }, context());
  assert.equal(deniedProgress.isError, true);
  assert.doesNotMatch(deniedProgress.content[0]?.text ?? '', new RegExp(deniedMarker));

  const workload = await teamWorkload({}, context());
  assert.equal(workload.isError, false, JSON.stringify(workload));
  const rows = payload(workload) as Array<{ user_name: string; total: number }>;
  assert.equal(rows.find((row) => row.user_name === 'MCP Boundary Agent')?.total, 1);
  assert.equal(rows.reduce((sum, row) => sum + row.total, 0), 1);
  assert.doesNotMatch(workload.content[0]?.text ?? '', new RegExp(deniedMarker));
});

test('inner task executors enforce current project scope and denied writes have no side effects', async () => {
  const beforeDenied = await withClient(async (client) => {
    const result = await client.query<{
      title: string;
      task_count: number;
      comment_count: number;
      activity_count: number;
      action_count: number;
      receipt_count: number;
      task_counter: number;
    }>(
      `SELECT
         t.title,
         (SELECT count(*)::int FROM tasks WHERE project_id = $2) AS task_count,
         (SELECT count(*)::int FROM task_comments WHERE task_id = t.id) AS comment_count,
         (SELECT count(*)::int FROM task_activity WHERE task_id = t.id) AS activity_count,
         (SELECT count(*)::int FROM agent_actions WHERE agent_employee_id = $3) AS action_count,
         (SELECT count(*)::int FROM action_receipts ar
            JOIN agent_actions aa ON aa.id = ar.action_id
           WHERE aa.agent_employee_id = $3) AS receipt_count,
         (SELECT task_counter FROM projects WHERE id = $2) AS task_counter
       FROM tasks t
       WHERE t.id = $1`,
      [deniedTaskId, deniedProjectId, scopedEmployeeId],
    );
    return result.rows[0]!;
  });

  const deniedCreate = await executeTaskCreate(
    {
      caller_employee_slug: `scoped-${suffix}`,
      title: `Must not be created ${suffix}`,
      project_id: deniedProjectId,
    },
    context(),
  );
  assert.equal(deniedCreate.isError, true);
  assert.match(deniedCreate.content[0]?.text ?? '', /project not found/);

  const deniedUpdate = await executeTaskUpdate(
    {
      caller_employee_slug: `scoped-${suffix}`,
      task_id: deniedTaskId,
      patch: {
        title: `Must not replace denied task ${suffix}`,
        comment: `Must not comment ${suffix}`,
      },
    },
    context(),
  );
  assert.equal(deniedUpdate.isError, true);
  assert.match(deniedUpdate.content[0]?.text ?? '', /task .* not found/);

  const restrictedUpdate = await executeTaskUpdate(
    {
      caller_employee_slug: `scoped-${suffix}`,
      task_id: restrictedTaskId,
      patch: { title: `Must not replace restricted task ${suffix}` },
    },
    context(),
  );
  assert.equal(restrictedUpdate.isError, true);
  assert.match(restrictedUpdate.content[0]?.text ?? '', /task .* not found/);

  const conservativeCtx: ToolContext = { ...context(), trust_level: 'conservative' };
  const deniedQueuedCreate = await taskCreate(
    {
      caller_employee_slug: `scoped-${suffix}`,
      title: `Must not queue ${suffix}`,
      project_id: deniedProjectId,
    },
    conservativeCtx,
  );
  assert.equal(deniedQueuedCreate.isError, true);
  const deniedQueuedUpdate = await taskUpdate(
    {
      caller_employee_slug: `scoped-${suffix}`,
      task_id: restrictedTaskId,
      patch: { title: `Must not queue restricted update ${suffix}` },
    },
    conservativeCtx,
  );
  assert.equal(deniedQueuedUpdate.isError, true);

  const afterDenied = await withClient(async (client) => {
    const result = await client.query<typeof beforeDenied>(
      `SELECT
         t.title,
         (SELECT count(*)::int FROM tasks WHERE project_id = $2) AS task_count,
         (SELECT count(*)::int FROM task_comments WHERE task_id = t.id) AS comment_count,
         (SELECT count(*)::int FROM task_activity WHERE task_id = t.id) AS activity_count,
         (SELECT count(*)::int FROM agent_actions WHERE agent_employee_id = $3) AS action_count,
         (SELECT count(*)::int FROM action_receipts ar
            JOIN agent_actions aa ON aa.id = ar.action_id
           WHERE aa.agent_employee_id = $3) AS receipt_count,
         (SELECT task_counter FROM projects WHERE id = $2) AS task_counter
       FROM tasks t
       WHERE t.id = $1`,
      [deniedTaskId, deniedProjectId, scopedEmployeeId],
    );
    return result.rows[0]!;
  });
  assert.deepEqual(afterDenied, beforeDenied);

  const fallbackCreate = await executeTaskCreate(
    {
      caller_employee_slug: `scoped-${suffix}`,
      title: `Allowed fallback task ${suffix}`,
    },
    context(),
    { skipReceipt: true },
  );
  assert.equal(fallbackCreate.isError, false, JSON.stringify(fallbackCreate));
  assert.equal(payload(fallbackCreate).project_id, allowedProjectId);

  const allowedUpdate = await executeTaskUpdate(
    {
      caller_employee_slug: `scoped-${suffix}`,
      task_id: allowedTaskId,
      patch: {
        title: `Allowed updated task ${suffix}`,
        comment: `Allowed comment ${suffix}`,
      },
    },
    context(),
    { skipReceipt: true },
  );
  assert.equal(allowedUpdate.isError, false, JSON.stringify(allowedUpdate));

  await withClient(async (client) => {
    const updated = await client.query<{ title: string; comment_count: number }>(
      `SELECT
         t.title,
         (SELECT count(*)::int FROM task_comments WHERE task_id = t.id) AS comment_count
       FROM tasks t
       WHERE t.id = $1`,
      [allowedTaskId],
    );
    assert.equal(updated.rows[0]?.title, `Allowed updated task ${suffix}`);
    assert.equal(updated.rows[0]?.comment_count, 1);

    // Simulate an approval that was queued while this project was allowed.
    // The inner executor must consult current DB state when it eventually runs.
    await client.query(
      `UPDATE agent_employees SET project_ids = ARRAY[$2]::text[] WHERE id = $1`,
      [scopedEmployeeId, deniedProjectId],
    );
  });

  const staleApprovalExecution = await executeTaskUpdate(
    {
      caller_employee_slug: `scoped-${suffix}`,
      task_id: allowedTaskId,
      patch: { title: `Stale approval must not apply ${suffix}` },
    },
    context(),
    { skipReceipt: true },
  );
  assert.equal(staleApprovalExecution.isError, true);
  await withClient(async (client) => {
    const task = await client.query<{ title: string }>(
      `SELECT title FROM tasks WHERE id = $1`,
      [allowedTaskId],
    );
    assert.equal(task.rows[0]?.title, `Allowed updated task ${suffix}`);
    await client.query(
      `UPDATE agent_employees SET project_ids = ARRAY[$2]::text[] WHERE id = $1`,
      [scopedEmployeeId, allowedProjectId],
    );
  });
});

test('explicit create and update reject a soft-deleted project even when employee scope still contains it', async () => {
  await withClient((client) => client.query(
    `UPDATE agent_employees SET project_ids = ARRAY[$2, $3]::text[] WHERE id = $1`,
    [scopedEmployeeId, allowedProjectId, deletedProjectId],
  ));

  const before = await withClient(async (client) => {
    const result = await client.query<{
      task_count: number;
      title: string;
      action_count: number;
      receipt_count: number;
      activity_count: number;
      comment_count: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM tasks WHERE project_id = $1) AS task_count,
         (SELECT title FROM tasks WHERE id = $2) AS title,
         (SELECT count(*)::int FROM agent_actions WHERE agent_employee_id = $3) AS action_count,
         (SELECT count(*)::int FROM action_receipts WHERE employee_id = $3) AS receipt_count,
         (SELECT count(*)::int FROM task_activity WHERE task_id = $2) AS activity_count,
         (SELECT count(*)::int FROM task_comments WHERE task_id = $2) AS comment_count`,
      [deletedProjectId, deletedProjectTaskId, scopedEmployeeId],
    );
    return result.rows[0]!;
  });

  const explicitCreate = await executeTaskCreate(
    {
      caller_employee_slug: `scoped-${suffix}`,
      title: `Must not create in deleted project ${suffix}`,
      project_id: deletedProjectId,
    },
    context(),
  );
  assert.equal(explicitCreate.isError, true);
  assert.match(explicitCreate.content[0]?.text ?? '', /project not found/);

  const explicitUpdate = await executeTaskUpdate(
    {
      caller_employee_slug: `scoped-${suffix}`,
      task_id: deletedProjectTaskId,
      patch: {
        title: `Must not update deleted-project task ${suffix}`,
        comment: `Must not comment on deleted-project task ${suffix}`,
      },
    },
    context(),
  );
  assert.equal(explicitUpdate.isError, true);
  assert.match(explicitUpdate.content[0]?.text ?? '', /task .* not found/);

  const conservativeCtx: ToolContext = { ...context(), trust_level: 'conservative' };
  assert.equal((await taskCreate(
    {
      caller_employee_slug: `scoped-${suffix}`,
      title: `Must not queue create in deleted project ${suffix}`,
      project_id: deletedProjectId,
    },
    conservativeCtx,
  )).isError, true);
  assert.equal((await taskUpdate(
    {
      caller_employee_slug: `scoped-${suffix}`,
      task_id: deletedProjectTaskId,
      patch: { title: `Must not queue deleted-project update ${suffix}` },
    },
    conservativeCtx,
  )).isError, true);

  assert.deepEqual(await withClient(async (client) => {
    const result = await client.query<typeof before>(
      `SELECT
         (SELECT count(*)::int FROM tasks WHERE project_id = $1) AS task_count,
         (SELECT title FROM tasks WHERE id = $2) AS title,
         (SELECT count(*)::int FROM agent_actions WHERE agent_employee_id = $3) AS action_count,
         (SELECT count(*)::int FROM action_receipts WHERE employee_id = $3) AS receipt_count,
         (SELECT count(*)::int FROM task_activity WHERE task_id = $2) AS activity_count,
         (SELECT count(*)::int FROM task_comments WHERE task_id = $2) AS comment_count`,
      [deletedProjectId, deletedProjectTaskId, scopedEmployeeId],
    );
    return result.rows[0]!;
  }), before);

  await withClient((client) => client.query(
    `UPDATE agent_employees SET project_ids = ARRAY[$2]::text[] WHERE id = $1`,
    [scopedEmployeeId, allowedProjectId],
  ));
});
