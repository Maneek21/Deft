/**
 * Final executeToolCall project/read-boundary regression coverage.
 *
 * Run: pnpm --filter @deft/api exec tsx --test test/agent-context-project-scope.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { executeToolCall } from '../src/lib/agent-context.js';
import { velocityCalculator } from '../src/services/team-analytics.js';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let orgId = '';
let ownerUserId = '';
let shadowUserId = '';
let deletedProjectActorUserId = '';
let scopedEmployeeId = '';
let nullScopeEmployeeId = '';
let emptyScopeEmployeeId = '';
let allowedProjectId = '';
let deniedProjectId = '';
let deletedProjectId = '';
let allowedProjectName = '';
let deniedProjectName = '';
let deletedProjectName = '';
let allowedTaskId = '';
let deniedTaskId = '';

const allowedMarker = `ALLOWED-TASK-${suffix}`;
const allowedPeerMarker = `ALLOWED-PEER-${suffix}`;
const deniedMarker = `DENIED-PROJECT-SECRET-${suffix}`;
const restrictedMarker = `RESTRICTED-TASK-SECRET-${suffix}`;
const deletedMarker = `DELETED-TASK-SECRET-${suffix}`;
const deletedProjectMarker = `DELETED-PROJECT-TASK-SECRET-${suffix}`;
const deletedProjectActorName = `Deleted Project Actor ${suffix}`;

async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function call(
  toolName: string,
  params: Record<string, unknown>,
  options: { userId?: string; employeeId?: string | undefined } = {},
) {
  return executeToolCall(
    toolName,
    params,
    orgId,
    options.userId ?? shadowUserId,
    undefined,
    options.employeeId,
  );
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

function assertNoSecrets(value: unknown): void {
  const text = serialized(value);
  assert.doesNotMatch(text, new RegExp(deniedMarker));
  assert.doesNotMatch(text, new RegExp(restrictedMarker));
  assert.doesNotMatch(text, new RegExp(deletedMarker));
  assert.doesNotMatch(text, new RegExp(deletedProjectMarker));
}

before(async () => {
  await withClient(async (client) => {
    const org = await client.query<{ id: string }>(
      `INSERT INTO orgs (id, name, slug)
       VALUES (gen_random_uuid()::text, $1, $2)
       RETURNING id`,
      [`Agent context project scope ${suffix}`, `agent-context-scope-${suffix}`],
    );
    orgId = org.rows[0]!.id;

    const users = await client.query<{ id: string; kind: string; name: string }>(
      `INSERT INTO users (id, email, name, kind, is_agent, email_verified)
       VALUES
         (gen_random_uuid()::text, $1, 'Scope Owner', 'human', false, true),
         (gen_random_uuid()::text, $2, 'Scope Employee', 'agent', true, true),
         (gen_random_uuid()::text, $3, $4, 'human', false, true)
       RETURNING id, kind, name`,
      [
        `scope-owner-${suffix}@test.local`,
        `scope-agent-${suffix}@test.local`,
        `deleted-project-actor-${suffix}@test.local`,
        deletedProjectActorName,
      ],
    );
    ownerUserId = users.rows.find((row) => row.name === 'Scope Owner')!.id;
    shadowUserId = users.rows.find((row) => row.kind === 'agent')!.id;
    deletedProjectActorUserId = users.rows.find((row) => row.name === deletedProjectActorName)!.id;

    await client.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES
         (gen_random_uuid()::text, $1, $2, 'owner', true),
         (gen_random_uuid()::text, $1, $3, 'admin', true),
         (gen_random_uuid()::text, $1, $4, 'member', true)`,
      [orgId, ownerUserId, shadowUserId, deletedProjectActorUserId],
    );

    allowedProjectName = `Allowed project ${suffix}`;
    deniedProjectName = `Denied project ${suffix}`;
    deletedProjectName = `Soft-deleted project ${suffix}`;
    const allowedPrefix = `A${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const deniedPrefix = `D${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const projectRows = await client.query<{ id: string; name: string }>(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES
         (gen_random_uuid()::text, $1, $2, $3, $4, 4),
         (gen_random_uuid()::text, $1, $5, $6, $4, 1)
       RETURNING id, name`,
      [
        orgId,
        allowedProjectName,
        allowedPrefix,
        ownerUserId,
        deniedProjectName,
        deniedPrefix,
      ],
    );
    allowedProjectId = projectRows.rows.find((row) => row.name === allowedProjectName)!.id;
    deniedProjectId = projectRows.rows.find((row) => row.name === deniedProjectName)!.id;

    const deletedProject = await client.query<{ id: string }>(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter, is_deleted)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 1, true)
       RETURNING id`,
      [
        orgId,
        deletedProjectName,
        `X${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
        ownerUserId,
      ],
    );
    deletedProjectId = deletedProject.rows[0]!.id;

    const taskRows = await client.query<{ id: string; title: string }>(
      `INSERT INTO tasks (
         id, org_id, project_id, number, title, status, priority,
         assignee_id, created_by, metadata, is_deleted
       ) VALUES
         (gen_random_uuid()::text, $1, $2, 1, $3, 'todo', 'p2', $4, $5, NULL, false),
         (gen_random_uuid()::text, $1, $2, 2, $6, 'todo', 'p2', $4, $5, NULL, false),
         (gen_random_uuid()::text, $1, $7, 1, $8, 'todo', 'p2', $4, $5, NULL, false),
         (gen_random_uuid()::text, $1, $2, 3, $9, 'todo', 'p2', $5, $5, '{"visibility":"restricted"}'::jsonb, false),
         (gen_random_uuid()::text, $1, $2, 4, $10, 'todo', 'p2', $4, $5, NULL, true)
       RETURNING id, title`,
      [
        orgId,
        allowedProjectId,
        allowedMarker,
        shadowUserId,
        ownerUserId,
        allowedPeerMarker,
        deniedProjectId,
        deniedMarker,
        restrictedMarker,
        deletedMarker,
      ],
    );
    allowedTaskId = taskRows.rows.find((row) => row.title === allowedMarker)!.id;
    const allowedPeerTaskId = taskRows.rows.find((row) => row.title === allowedPeerMarker)!.id;
    deniedTaskId = taskRows.rows.find((row) => row.title === deniedMarker)!.id;
    const restrictedTaskId = taskRows.rows.find((row) => row.title === restrictedMarker)!.id;

    const deletedProjectTask = await client.query<{ id: string }>(
      `INSERT INTO tasks (
         id, org_id, project_id, number, title, status, priority,
         assignee_id, created_by, metadata, is_deleted
       ) VALUES (
         gen_random_uuid()::text, $1, $2, 1, $3, 'done', 'p0', $4, $5, NULL, false
       ) RETURNING id`,
      [
        orgId,
        deletedProjectId,
        deletedProjectMarker,
        shadowUserId,
        deletedProjectActorUserId,
      ],
    );

    await client.query(
      `INSERT INTO task_relationships (id, source_task_id, target_task_id, type)
       VALUES
         (gen_random_uuid()::text, $1, $2, 'blocks'),
         (gen_random_uuid()::text, $1, $3, 'blocks'),
         (gen_random_uuid()::text, $1, $4, 'relates_to'),
         (gen_random_uuid()::text, $3, $2, 'blocks')`,
      [allowedTaskId, allowedPeerTaskId, deniedTaskId, restrictedTaskId],
    );

    await client.query(
      `INSERT INTO task_activity (
         id, org_id, task_id, user_id, action, field, old_value, new_value, created_at
       ) VALUES
         (gen_random_uuid()::text, $1, $2, $3, 'commented', NULL, NULL, $4, now() - interval '1 day'),
         (gen_random_uuid()::text, $1, $5, $3, 'commented', NULL, NULL, $6, now() - interval '1 day'),
         (gen_random_uuid()::text, $1, $7, $3, 'commented', NULL, NULL, $8, now() - interval '1 day'),
         (gen_random_uuid()::text, $1, $2, $3, 'status_changed', 'status', 'in_progress', 'done', now() - interval '1 day'),
         (gen_random_uuid()::text, $1, $7, $9, 'status_changed', 'status', 'in_progress', 'done', now() - interval '1 day'),
         (gen_random_uuid()::text, $1, $10, $11, 'status_changed', 'status', 'in_progress', 'done', now() - interval '1 day')`,
      [
        orgId,
        allowedTaskId,
        shadowUserId,
        allowedMarker,
        deniedTaskId,
        deniedMarker,
        restrictedTaskId,
        restrictedMarker,
        ownerUserId,
        deletedProjectTask.rows[0]!.id,
        deletedProjectActorUserId,
      ],
    );

    const employees = await client.query<{ id: string; slug: string }>(
      `INSERT INTO agent_employees (
         id, org_id, user_id, name, slug, role, system_prompt, project_ids,
         trust_level, max_daily_actions, created_by, is_active, is_byoa
       ) VALUES
         (gen_random_uuid()::text, $1, $2, 'Scoped employee', $3, 'project_manager', 'test', ARRAY[$4]::text[], 'standard', 50, $5, true, true),
         (gen_random_uuid()::text, $1, $2, 'Null employee', $6, 'project_manager', 'test', NULL, 'standard', 50, $5, true, true),
         (gen_random_uuid()::text, $1, $2, 'Empty employee', $7, 'project_manager', 'test', ARRAY[]::text[], 'standard', 50, $5, true, true)
       RETURNING id, slug`,
      [
        orgId,
        shadowUserId,
        `scoped-${suffix}`,
        allowedProjectId,
        ownerUserId,
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
      `DELETE FROM task_relationships
       WHERE source_task_id IN (SELECT id FROM tasks WHERE org_id = $1)
          OR target_task_id IN (SELECT id FROM tasks WHERE org_id = $1)`,
      [orgId],
    );
    await client.query(`DELETE FROM task_activity WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM tasks WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM agent_employees WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM projects WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM org_members WHERE org_id = $1`, [orgId]);
    await client.query(`DELETE FROM users WHERE id IN ($1, $2, $3)`, [
      ownerUserId,
      shadowUserId,
      deletedProjectActorUserId,
    ]);
    await client.query(`DELETE FROM orgs WHERE id = $1`, [orgId]);
  });
});

test('executeToolCall final task/project reads enforce live employee project and visibility scope', async () => {
  const options = { employeeId: scopedEmployeeId };

  const search = await call('search_tasks', {}, options);
  assert.match(serialized(search), new RegExp(allowedMarker));
  assertNoSecrets(search);

  const mine = await call('list_my_tasks', {}, options);
  assert.match(serialized(mine), new RegExp(allowedMarker));
  assertNoSecrets(mine);

  const allowedDetail = await call('get_task_detail', { task_identifier: allowedTaskId }, options);
  assert.equal(allowedDetail.result.id, allowedTaskId);
  assertNoSecrets(allowedDetail);
  const deniedDetail = await call('get_task_detail', { task_identifier: deniedTaskId }, options);
  assert.deepEqual(deniedDetail.result, { error: 'Task not found' });

  const workload = await call('get_team_workload', {}, options);
  assertNoSecrets(workload);
  const shadowWorkload = (workload.result as Array<{ user_name: string; total: number }>)
    .find((row) => row.user_name === 'Scope Employee');
  assert.equal(shadowWorkload?.total, 2);
  assert.equal(
    (workload.result as Array<{ user_name: string }>).some((row) => row.user_name === 'Scope Owner'),
    false,
  );

  const projects = await call('list_projects', { include_archived: true }, options);
  assert.deepEqual(
    (projects.result as Array<{ id: string }>).map((project) => project.id),
    [allowedProjectId],
  );

  const progress = await call('get_project_progress', { project_id: allowedProjectId }, options);
  assert.equal(progress.result.total_tasks, 2);
  assertNoSecrets(progress);
  const deniedProgress = await call('get_project_progress', { project_id: deniedProjectId }, options);
  assert.match(String(deniedProgress.result.error), /not found/i);
  assertNoSecrets(deniedProgress);

  const dependencies = await call('get_task_dependencies', { task_identifier: allowedTaskId }, options);
  assert.match(serialized(dependencies), new RegExp(allowedPeerMarker));
  assertNoSecrets(dependencies);
  const deniedDependencies = await call('get_task_dependencies', { task_identifier: deniedTaskId }, options);
  assert.deepEqual(deniedDependencies.result, { blocks: [], blocked_by: [], relates_to: [] });
});

test('task-derived aggregates cannot infer denied, restricted, or deleted task data', async () => {
  const options = { employeeId: scopedEmployeeId };

  const stats = await call('get_workspace_stats', { time_range: '30d', metric: 'all' }, options);
  assert.equal(stats.result.tasks_created, 2);
  assert.deepEqual(stats.result.tasks_by_status, { todo: 2 });
  assertNoSecrets(stats);

  const activity = await call('get_user_activity', { user_name: 'Scope Employee', days: 7 }, options);
  assert.match(serialized(activity), new RegExp(allowedMarker));
  assert.equal(activity.result.current_tasks.todo, 2);
  assertNoSecrets(activity);

  const health = await call('get_team_health', {}, options);
  const cards = health.result.cards as Array<{ name: string; active_tasks: number }>;
  assert.equal(cards.find((card) => card.name === 'Scope Employee')?.active_tasks, 2);
  assert.equal(cards.find((card) => card.name === 'Scope Owner')?.active_tasks, 0);
  assertNoSecrets(health);

  const performanceWithoutProject = await call('get_team_performance', {}, options);
  assert.match(String(performanceWithoutProject.result.error), /project_name/i);
  const performanceDenied = await call(
    'get_team_performance',
    { project_name: deniedProjectName },
    options,
  );
  assert.match(String(performanceDenied.result.error), /project scope/i);
  const performanceAllowed = await call(
    'get_team_performance',
    { project_name: allowedProjectName },
    options,
  );
  assert.ok(Array.isArray(performanceAllowed.result.weeks));

  const workloadBalance = await call('get_workload_balance', {}, options);
  assert.match(String(workloadBalance.result.error), /project-scoped/i);
  const prep = await call('prep_oneone', { person: 'Scope Owner' }, options);
  assert.match(String(prep.result.error), /project-scoped/i);
});

test('project velocity excludes restricted task completions and their actors', async () => {
  const performance = await call(
    'get_team_performance',
    { project_name: allowedProjectName },
    { employeeId: scopedEmployeeId },
  );
  const weeks = performance.result.weeks as Array<{
    completed: number;
    per_person: Record<string, number>;
  }>;

  assert.equal(weeks.reduce((sum, week) => sum + week.completed, 0), 1);
  assert.equal(
    weeks.reduce((sum, week) => sum + (week.per_person['Scope Employee'] ?? 0), 0),
    1,
  );
  assert.equal(
    weeks.some((week) => Object.hasOwn(week.per_person, 'Scope Owner')),
    false,
  );
});

test('deleted projects are absent from unrestricted and project-specific velocity', async () => {
  for (const employeeId of [nullScopeEmployeeId, emptyScopeEmployeeId]) {
    const unrestricted = await call('get_team_performance', {}, { employeeId });
    const unrestrictedWeeks = unrestricted.result.weeks as Array<{
      completed: number;
      per_person: Record<string, number>;
    }>;
    assert.equal(unrestrictedWeeks.reduce((sum, week) => sum + week.completed, 0), 1);
    assert.equal(unrestrictedWeeks.some((week) => deletedProjectActorName in week.per_person), false);

    const projectSpecific = await call(
      'get_team_performance',
      { project_name: allowedProjectName },
      { employeeId },
    );
    assert.equal(
      (projectSpecific.result.weeks as Array<{ completed: number }>)
        .reduce((sum, week) => sum + week.completed, 0),
      1,
    );
    assertNoSecrets(projectSpecific);

    const deletedProject = await call(
      'get_team_performance',
      { project_name: deletedProjectName },
      { employeeId },
    );
    assert.match(String(deletedProject.result.error), /not found/i);
    assertNoSecrets(deletedProject);
  }

  const directOrgVelocity = await velocityCalculator(orgId);
  assert.equal(directOrgVelocity.weeks.reduce((sum, week) => sum + week.completed, 0), 2);
  assert.equal(
    directOrgVelocity.weeks.some((week) => deletedProjectActorName in week.per_person),
    false,
  );
  const directDeletedProjectVelocity = await velocityCalculator(orgId, deletedProjectId);
  assert.equal(
    directDeletedProjectVelocity.weeks.reduce((sum, week) => sum + week.completed, 0),
    0,
  );
  assert.equal(
    directDeletedProjectVelocity.weeks.some((week) => deletedProjectActorName in week.per_person),
    false,
  );
});

test('NULL and [] employee scopes stay project-unrestricted and human calls stay unscoped', async () => {
  for (const employeeId of [nullScopeEmployeeId, emptyScopeEmployeeId]) {
    const search = await call('search_tasks', {}, { employeeId });
    assert.match(serialized(search), new RegExp(allowedMarker));
    assert.match(serialized(search), new RegExp(deniedMarker));
    assert.doesNotMatch(serialized(search), new RegExp(restrictedMarker));

    const projects = await call('list_projects', { include_archived: true }, { employeeId });
    const ids = (projects.result as Array<{ id: string }>).map((project) => project.id);
    assert.ok(ids.includes(allowedProjectId));
    assert.ok(ids.includes(deniedProjectId));
    assert.equal(ids.includes(deletedProjectId), false);

    const detail = await call('get_task_detail', { task_identifier: deniedTaskId }, { employeeId });
    assert.equal(detail.result.id, deniedTaskId);
  }

  const humanSearch = await call('search_tasks', {}, { userId: ownerUserId });
  assert.match(serialized(humanSearch), new RegExp(allowedMarker));
  assert.match(serialized(humanSearch), new RegExp(deniedMarker));
  assert.match(serialized(humanSearch), new RegExp(restrictedMarker));
  assert.doesNotMatch(serialized(humanSearch), new RegExp(deletedMarker));

  const humanProjects = await call(
    'list_projects',
    { include_archived: true },
    { userId: ownerUserId },
  );
  const humanProjectIds = (humanProjects.result as Array<{ id: string }>).map((project) => project.id);
  assert.ok(humanProjectIds.includes(allowedProjectId));
  assert.ok(humanProjectIds.includes(deniedProjectId));
  assert.equal(humanProjectIds.includes(deletedProjectId), false);
});
