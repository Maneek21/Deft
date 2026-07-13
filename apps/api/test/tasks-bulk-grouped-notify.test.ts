/**
 * Task 5.5 — bulk ops: batched socket + grouped notifications
 *
 * The socket emission collapse (N task:updated → 1 task:bulk_updated)
 * is a straightforward local refactor; this suite covers the
 * user-observable side effect: the grouped notification row.
 *
 * Covers:
 *   1. PATCH /api/tasks/bulk assigning ≥3 tasks to the same user
 *      creates exactly ONE notification row with title
 *      "You were assigned N tasks" and metadata.task_ids == task_ids.
 *   2. Assigning <3 tasks does NOT create a grouped notification.
 *   3. Self-assign skips the grouped notification.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';
import { humanTaskBulkUpdate, humanTaskQuery, humanTaskSavedViewGet } from '../src/lib/mcp-tools/human.js';
import { executeAction } from '../src/lib/agent-actions.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const ACTOR_ID = 'test-bulk-notify-actor';
const ACTOR_EMAIL = 'bulk-notify-actor@test.local';
const ASSIGNEE_ID = 'test-bulk-notify-assignee';
const ASSIGNEE_EMAIL = 'bulk-notify-assignee@test.local';

function randomLetters(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return s;
}

let projectPrefix: string | null = null;
let projectId: string | null = null;
let hiddenProjectId: string | null = null;
let hiddenTaskId: string | null = null;
let labelId: string | null = null;
const taskIds: string[] = [];
let testApp: Hono | null = null;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

before(async () => {
  projectPrefix = `BULKN${randomLetters(4)}`;
  await withClient(async (c) => {
    // FK cluster fix: seed orgs row so task_activity.org_id FK holds.
    await c.query(
      `INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
      [ORG_ID, 'Bulk Grouped Notify Test Org'],
    );
    for (const [uid, email, name] of [
      [ACTOR_ID, ACTOR_EMAIL, 'Bulk Actor'],
      [ASSIGNEE_ID, ASSIGNEE_EMAIL, 'Bulk Assignee'],
    ] as const) {
      await c.query(
        `INSERT INTO users (id, email, name, is_agent)
         VALUES ($1, $2, $3, false) ON CONFLICT (id) DO NOTHING`,
        [uid, email, name],
      );
      await c.query(
        `INSERT INTO org_members (id, org_id, user_id, role, is_active)
         VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [ORG_ID, uid],
      );
    }

    const p = await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 0)
       RETURNING id`,
      [ORG_ID, `Bulk Notify ${projectPrefix}`, projectPrefix, ACTOR_ID],
    );
    projectId = p.rows[0].id as string;

    for (let i = 1; i <= 50; i++) {
      const t = await c.query(
        `INSERT INTO tasks (id, org_id, project_id, number, title, status, priority, created_by, is_deleted)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'todo', 'p2', $5, false)
         RETURNING id`,
        [ORG_ID, projectId, i, `Bulk task ${i}`, ACTOR_ID],
      );
      taskIds.push(t.rows[0].id as string);
    }
    const hiddenProject = await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 0) RETURNING id`,
      [ORG_ID, `Hidden Bulk ${projectPrefix}`, `H${projectPrefix}`, ASSIGNEE_ID],
    );
    hiddenProjectId = hiddenProject.rows[0].id as string;
    const hiddenTask = await c.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, status, priority, created_by, is_deleted, metadata)
       VALUES (gen_random_uuid()::text, $1, $2, 1, 'Hidden bulk task', 'todo', 'p2', $3, false, '{"visibility":"restricted"}'::jsonb)
       RETURNING id`,
      [ORG_ID, hiddenProjectId, ASSIGNEE_ID],
    );
    hiddenTaskId = hiddenTask.rows[0].id as string;
    const label = await c.query(
      `INSERT INTO labels (id, org_id, name, color) VALUES (gen_random_uuid()::text, $1, $2, '#7c3aed') RETURNING id`,
      [ORG_ID, `Bulk label ${projectPrefix}`],
    );
    labelId = label.rows[0].id as string;
  });

  const { taskRoutes } = await import('../src/routes/tasks.js');
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    (c as any).set('user', { id: ACTOR_ID, org_id: ORG_ID });
    await next();
  });
  testApp.route('/api/tasks', taskRoutes);
});

after(async () => {
  await withClient(async (c) => {
    const fixtureProjectFilter = `
      SELECT id FROM projects
      WHERE lead_id = $1 AND name LIKE 'Bulk Notify %'
    `;
    const fixtureTaskFilter = `
      SELECT id FROM tasks WHERE project_id IN (${fixtureProjectFilter})
    `;

    await c.query(`DELETE FROM saved_views WHERE org_id = $1 AND user_id = $2`, [ORG_ID, ACTOR_ID]);
    await c.query(
      `DELETE FROM task_relationships
       WHERE source_task_id IN (${fixtureTaskFilter})
          OR target_task_id IN (${fixtureTaskFilter})`,
      [ACTOR_ID],
    );
    await c.query(`DELETE FROM task_reactions WHERE task_id IN (${fixtureTaskFilter})`, [ACTOR_ID]);
    await c.query(`DELETE FROM task_labels WHERE task_id IN (${fixtureTaskFilter})`, [ACTOR_ID]);
    await c.query(`DELETE FROM task_comments WHERE task_id IN (${fixtureTaskFilter})`, [ACTOR_ID]);
    await c.query(`DELETE FROM task_activity WHERE task_id IN (${fixtureTaskFilter})`, [ACTOR_ID]);
    await c.query(`DELETE FROM task_watchers WHERE task_id IN (${fixtureTaskFilter})`, [ACTOR_ID]);
    await c.query(`DELETE FROM task_assignees WHERE task_id IN (${fixtureTaskFilter})`, [ACTOR_ID]);
    await c.query(`DELETE FROM tasks WHERE id IN (${fixtureTaskFilter})`, [ACTOR_ID]);
    await c.query(`DELETE FROM projects WHERE id IN (${fixtureProjectFilter})`, [ACTOR_ID]);
    if (hiddenTaskId) {
      await c.query(`DELETE FROM task_activity WHERE task_id = $1`, [hiddenTaskId]);
      await c.query(`DELETE FROM tasks WHERE id = $1`, [hiddenTaskId]);
    }
    if (hiddenProjectId) await c.query(`DELETE FROM projects WHERE id = $1`, [hiddenProjectId]);
    if (labelId) await c.query(`DELETE FROM labels WHERE id = $1`, [labelId]);
    await c.query(
      `DELETE FROM notifications WHERE user_id IN ($1, $2)`,
      [ACTOR_ID, ASSIGNEE_ID],
    );
    await c.query(`DELETE FROM oauth_audit_events WHERE org_id = $1 AND user_id = $2`, [ORG_ID, ACTOR_ID]);
    await c.query(`DELETE FROM audit_log WHERE org_id = $1 AND actor_id = $2`, [ORG_ID, ACTOR_ID]);
    await c.query(
      `DELETE FROM action_receipts
       WHERE action_id IN (
         SELECT id FROM agent_actions WHERE org_id = $1 AND user_id IN ($2, $3)
       )`,
      [ORG_ID, ACTOR_ID, ASSIGNEE_ID],
    );
    await c.query(
      `DELETE FROM agent_actions WHERE org_id = $1 AND user_id IN ($2, $3)`,
      [ORG_ID, ACTOR_ID, ASSIGNEE_ID],
    );
    await c.query(
      `DELETE FROM people_expertise WHERE org_id = $1 AND user_id IN ($2, $3)`,
      [ORG_ID, ACTOR_ID, ASSIGNEE_ID],
    );
    await c.query(
      `DELETE FROM people_influence WHERE org_id = $1 AND user_id IN ($2, $3)`,
      [ORG_ID, ACTOR_ID, ASSIGNEE_ID],
    );
    await c.query(
      `DELETE FROM people_patterns WHERE org_id = $1 AND user_id IN ($2, $3)`,
      [ORG_ID, ACTOR_ID, ASSIGNEE_ID],
    );
    await c.query(
      `DELETE FROM people_relationships
       WHERE org_id = $1 AND (user_a_id IN ($2, $3) OR user_b_id IN ($2, $3))`,
      [ORG_ID, ACTOR_ID, ASSIGNEE_ID],
    );
    await c.query(
      `DELETE FROM people_interactions
       WHERE org_id = $1 AND (user_a_id IN ($2, $3) OR user_b_id IN ($2, $3))`,
      [ORG_ID, ACTOR_ID, ASSIGNEE_ID],
    );
    await c.query(
      `DELETE FROM org_members WHERE user_id IN ($1, $2)`,
      [ACTOR_ID, ASSIGNEE_ID],
    );
  });
});

test('bulk assign of 3 tasks writes ONE grouped notification with metadata.task_ids', async () => {
  const ids = taskIds.slice(0, 3);
  await withClient(async (c) => {
    await c.query(`DELETE FROM notifications WHERE user_id = $1`, [ASSIGNEE_ID]);
  });

  const res = await testApp!.request('/api/tasks/bulk', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task_ids: ids, updates: { assignee_id: ASSIGNEE_ID } }),
  });
  assert.equal(res.status, 200);

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT title, type, metadata FROM notifications
       WHERE user_id = $1 AND type = 'task_assigned'
       ORDER BY created_at DESC`,
      [ASSIGNEE_ID],
    );
    assert.equal(r.rows.length, 1, `expected 1 grouped notification, got ${r.rows.length}`);
    assert.equal(r.rows[0].title, 'You were assigned 3 tasks');
    const md = r.rows[0].metadata;
    assert.ok(md && Array.isArray(md.task_ids));
    assert.deepEqual([...md.task_ids].sort(), [...ids].sort());
    assert.equal(md.grouped, true);
    assert.equal(md.kind, 'bulk_assign');
  });
});

test('bulk assign of <3 tasks does NOT write a grouped notification', async () => {
  await withClient(async (c) => {
    await c.query(`DELETE FROM notifications WHERE user_id = $1`, [ASSIGNEE_ID]);
  });
  const ids = taskIds.slice(3, 4);

  const res = await testApp!.request('/api/tasks/bulk', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task_ids: ids, updates: { assignee_id: ASSIGNEE_ID } }),
  });
  assert.equal(res.status, 200);

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT id FROM notifications WHERE user_id = $1 AND type = 'task_assigned'`,
      [ASSIGNEE_ID],
    );
    assert.equal(r.rows.length, 0, 'no grouped notification for <3 tasks');
  });
});

test('bulk self-assign (actor==assignee) skips the notification even at ≥3', async () => {
  await withClient(async (c) => {
    await c.query(`DELETE FROM notifications WHERE user_id = $1`, [ACTOR_ID]);
  });
  const ids = taskIds.slice(0, 3);

  const res = await testApp!.request('/api/tasks/bulk', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task_ids: ids, updates: { assignee_id: ACTOR_ID } }),
  });
  assert.equal(res.status, 200);

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT id FROM notifications WHERE user_id = $1 AND type = 'task_assigned'`,
      [ACTOR_ID],
    );
    assert.equal(r.rows.length, 0, 'self-assign must not notify');
  });
});

test('bulk update handles 1, 10, and 50 tasks and repeats as an idempotent no-op', async () => {
  const one = taskIds.slice(0, 1);
  const dueDate = '2026-08-20T00:00:00.000Z';
  const startDate = '2026-08-18T00:00:00.000Z';
  const body = { task_ids: one, updates: { due_date: dueDate, start_date: startDate, estimation: '2h', add_label_ids: [labelId] } };
  const first = await testApp!.request('/api/tasks/bulk', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json() as any).updated, 1);

  const activityBeforeRepeat = await withClient(async (c) => {
    const row = await c.query(`SELECT count(*)::int AS count FROM task_activity WHERE task_id = $1`, [one[0]]);
    return row.rows[0].count as number;
  });
  const repeat = await testApp!.request('/api/tasks/bulk', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(repeat.status, 200);
  assert.equal((await repeat.json() as any).updated, 0);
  await withClient(async (c) => {
    const task = await c.query(`SELECT to_char(due_date, 'YYYY-MM-DD') AS due_date, to_char(start_date, 'YYYY-MM-DD') AS start_date, estimation FROM tasks WHERE id = $1`, [one[0]]);
    assert.equal(task.rows[0].due_date, '2026-08-20');
    assert.equal(task.rows[0].start_date, '2026-08-18');
    assert.equal(task.rows[0].estimation, '2h');
    const attached = await c.query(`SELECT 1 FROM task_labels WHERE task_id = $1 AND label_id = $2`, [one[0], labelId]);
    assert.equal(attached.rows.length, 1);
    const activity = await c.query(`SELECT count(*)::int AS count FROM task_activity WHERE task_id = $1`, [one[0]]);
    assert.equal(activity.rows[0].count, activityBeforeRepeat);
  });

  const ten = await testApp!.request('/api/tasks/bulk', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task_ids: taskIds.slice(0, 10), updates: { priority: 'p0' } }),
  });
  assert.equal(ten.status, 200);
  assert.equal((await ten.json() as any).updated, 10);

  const fifty = await testApp!.request('/api/tasks/bulk', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task_ids: taskIds, updates: { status: 'in_progress' } }),
  });
  assert.equal(fifty.status, 200);
  assert.equal((await fifty.json() as any).updated, 50);
});

test('mixed visible and inaccessible IDs fail atomically', async () => {
  const visibleId = taskIds[0]!;
  const before = await withClient(async (c) => {
    const row = await c.query(`SELECT priority FROM tasks WHERE id = $1`, [visibleId]);
    return row.rows[0].priority as string;
  });
  const response = await testApp!.request('/api/tasks/bulk', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task_ids: [visibleId, hiddenTaskId], updates: { priority: 'p3' } }),
  });
  assert.equal(response.status, 404);
  await withClient(async (c) => {
    const row = await c.query(`SELECT priority FROM tasks WHERE id = $1`, [visibleId]);
    assert.equal(row.rows[0].priority, before);
  });
});

test('human MCP bulk update shares validation and replays an idempotent result', async () => {
  const ids = taskIds.slice(10, 12);
  const ctx = {
    org_id: ORG_ID,
    user_id: ACTOR_ID,
    role: 'member' as const,
    scopes: ['write:tasks'],
    token_id: 'bulk-test-token',
    client_id: 'bulk-test-client',
  };
  const args = { task_ids: ids, updates: { priority: 'p3' }, idempotency_key: `bulk-priority-p3-${projectPrefix}` };
  const first = await humanTaskBulkUpdate(args, ctx);
  assert.equal(first.isError, false);
  const firstPayload = JSON.parse(first.content[0]!.text);
  assert.equal(firstPayload.updated, 2);
  const activityCount = await withClient(async (c) => {
    const row = await c.query(`SELECT count(*)::int AS count FROM task_activity WHERE task_id = ANY($1::text[]) AND field = 'priority'`, [ids]);
    return row.rows[0].count as number;
  });

  const replay = await humanTaskBulkUpdate(args, ctx);
  assert.deepEqual(replay, first);
  await withClient(async (c) => {
    const row = await c.query(`SELECT count(*)::int AS count FROM task_activity WHERE task_id = ANY($1::text[]) AND field = 'priority'`, [ids]);
    assert.equal(row.rows[0].count, activityCount);
  });
});

test('MCP query and saved-view reads expose compact canonical task state', async () => {
  const ctx = {
    org_id: ORG_ID,
    user_id: ACTOR_ID,
    role: 'member' as const,
    scopes: ['read:tasks'],
    token_id: 'bulk-test-token',
    client_id: 'bulk-test-client',
  };
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO tasks (id, org_id, project_id, parent_task_id, number, title, status, priority, created_by, is_deleted, is_template)
       VALUES
         (gen_random_uuid()::text, $1, $2, $3, 101, 'P3 subtask', 'todo', 'p3', $4, false, false),
         (gen_random_uuid()::text, $1, $2, null, 102, 'P3 template', 'todo', 'p3', $4, false, true)`,
      [ORG_ID, projectId, taskIds[0], ACTOR_ID],
    );
  });
  const queried = await humanTaskQuery({ project_id: projectId!, priorities: ['p3'], sort: { field: 'number', direction: 'asc' }, limit: 20 }, ctx);
  assert.equal(queried.isError, false);
  const queryPayload = JSON.parse(queried.content[0]!.text);
  assert.equal(queryPayload.length, 2);
  assert.deepEqual(queryPayload.map((task: any) => task.task_key), [`${projectPrefix}-11`, `${projectPrefix}-12`]);
  assert.equal('description' in queryPayload[0], false);
  assert.equal(queryPayload.some((task: any) => task.id === hiddenTaskId), false);

  const viewId = await withClient(async (c) => {
    const row = await c.query(
      `INSERT INTO saved_views (id, org_id, project_id, user_id, name, config, is_shared)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'P3 compact view', $4::jsonb, false)
       RETURNING id`,
      [ORG_ID, projectId, ACTOR_ID, JSON.stringify({ filters: { priorities: ['p3'] }, sort: { field: 'number', direction: 'asc' }, columns: ['title', 'priority'] })],
    );
    return row.rows[0].id as string;
  });
  const saved = await humanTaskSavedViewGet({ saved_view_id: viewId }, ctx);
  assert.equal(saved.isError, false);
  const savedPayload = JSON.parse(saved.content[0]!.text);
  assert.equal(savedPayload.read_only, true);
  assert.deepEqual(savedPayload.query_config.columns, ['title', 'priority']);
});

test('Defty bulk execution uses the same service and attributes every task change', async () => {
  const identifiers = [`${projectPrefix}-21`, `${projectPrefix}-22`, `${projectPrefix}-23`];
  const actionId = await withClient(async (c) => {
    const row = await c.query(
      `INSERT INTO agent_actions
        (id, org_id, user_id, source, action, params, approval_tier, approval_status, approved_at)
       VALUES (gen_random_uuid()::text, $1, $2, 'native', 'bulk_update_tasks', $3::jsonb, 'full', 'approved', now())
       RETURNING id`,
      [ORG_ID, ACTOR_ID, JSON.stringify({ task_identifiers: identifiers, updates: { priority: 'p0' } })],
    );
    return row.rows[0].id as string;
  });
  const result = await executeAction(actionId, 'bulk_update_tasks', {
    task_identifiers: identifiers,
    updates: { priority: 'p0' },
  }, ORG_ID, ACTOR_ID);
  assert.equal(result.success, true);
  assert.equal(result.result.updated, 3);
  await withClient(async (c) => {
    const tasks = await c.query(`SELECT priority FROM tasks WHERE id = ANY($1::text[])`, [taskIds.slice(20, 23)]);
    assert.deepEqual(tasks.rows.map((row) => row.priority), ['p0', 'p0', 'p0']);
    const activity = await c.query(
      `SELECT count(*)::int AS count FROM task_activity
       WHERE task_id = ANY($1::text[]) AND agent_action_id = $2 AND field = 'priority'`,
      [taskIds.slice(20, 23), actionId],
    );
    assert.equal(activity.rows[0].count, 3);
  });
});

test('bulk delete is atomic across visibility boundaries and preserves history', async () => {
  const visibleId = taskIds[49]!;
  const rejected = await testApp!.request('/api/tasks/bulk-delete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task_ids: [visibleId, hiddenTaskId] }),
  });
  assert.equal(rejected.status, 404);
  await withClient(async (c) => {
    const row = await c.query(`SELECT is_deleted FROM tasks WHERE id = $1`, [visibleId]);
    assert.equal(row.rows[0].is_deleted, false);
  });

  const deleted = await testApp!.request('/api/tasks/bulk-delete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task_ids: [visibleId] }),
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual((await deleted.json() as any).deleted_ids, [visibleId]);
  await withClient(async (c) => {
    const row = await c.query(`SELECT is_deleted, title FROM tasks WHERE id = $1`, [visibleId]);
    assert.equal(row.rows[0].is_deleted, true);
    assert.equal(row.rows[0].title, 'Bulk task 50');
  });
});
