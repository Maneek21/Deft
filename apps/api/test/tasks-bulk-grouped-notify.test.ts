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

    for (let i = 1; i <= 4; i++) {
      const t = await c.query(
        `INSERT INTO tasks (id, org_id, project_id, number, title, status, priority, created_by, is_deleted)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'todo', 'p2', $5, false)
         RETURNING id`,
        [ORG_ID, projectId, i, `Bulk task ${i}`, ACTOR_ID],
      );
      taskIds.push(t.rows[0].id as string);
    }
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
    if (taskIds.length) {
      await c.query(`DELETE FROM task_comments WHERE task_id = ANY($1)`, [taskIds]);
      await c.query(`DELETE FROM task_activity WHERE task_id = ANY($1)`, [taskIds]);
      await c.query(`DELETE FROM tasks WHERE id = ANY($1)`, [taskIds]);
    }
    if (projectId) {
      await c.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    }
    await c.query(
      `DELETE FROM notifications WHERE user_id IN ($1, $2)`,
      [ACTOR_ID, ASSIGNEE_ID],
    );
    await c.query(
      `DELETE FROM org_members WHERE user_id IN ($1, $2)`,
      [ACTOR_ID, ASSIGNEE_ID],
    );
    await c.query(`DELETE FROM users WHERE id IN ($1, $2)`, [ACTOR_ID, ASSIGNEE_ID]);
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
