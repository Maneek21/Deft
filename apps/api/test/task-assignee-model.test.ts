/**
 * Task 0.3 — Primary vs. additional assignee rules.
 *
 * Design: tasks.assignee_id is the single PRIMARY assignee (or null).
 * taskAssignees is strictly for ADDITIONAL (non-primary) assignees.
 * The two must never duplicate the same user.
 *
 * Covers:
 *   1. POST /api/tasks/:id/assignees with a user_id == primary -> 409 ALREADY_PRIMARY_ASSIGNEE
 *   2. POST /api/tasks/:id/assignees with a fresh user_id -> 200 success, row inserted
 *   3. DELETE /api/tasks/:id/assignees/:userId on additional -> 200 success, row gone
 *   4. DELETE /api/tasks/:id/assignees/:userId on the primary -> 404 NOT_FOUND (primary is not in table)
 *   5. PATCH /api/tasks/:id with assignee_id = existing additional -> row removed from taskAssignees (no dup)
 *
 * Run: cd apps/api && node --test --import tsx test/task-assignee-model.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const MEMBER_USER_ID = 'test-assignee-model-member';
const MEMBER_EMAIL = 'assignee-model-member@test.local';
const PRIMARY_USER_ID = 'test-assignee-model-primary';
const PRIMARY_EMAIL = 'assignee-model-primary@test.local';
const EXTRA_USER_ID = 'test-assignee-model-extra';
const EXTRA_EMAIL = 'assignee-model-extra@test.local';
const PROMOTE_USER_ID = 'test-assignee-model-promote';
const PROMOTE_EMAIL = 'assignee-model-promote@test.local';

let testApp: Hono | null = null;
let projectId: string | null = null;
let taskId: string | null = null;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function seedFixtures() {
  await withClient(async (c) => {
    for (const [id, email, name] of [
      [MEMBER_USER_ID, MEMBER_EMAIL, 'Assignee Member'],
      [PRIMARY_USER_ID, PRIMARY_EMAIL, 'Assignee Primary'],
      [EXTRA_USER_ID, EXTRA_EMAIL, 'Assignee Extra'],
      [PROMOTE_USER_ID, PROMOTE_EMAIL, 'Assignee Promote'],
    ]) {
      await c.query(
        `INSERT INTO users (id, email, name, is_agent)
         VALUES ($1, $2, $3, false)
         ON CONFLICT (id) DO NOTHING`,
        [id, email, name],
      );
    }
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, MEMBER_USER_ID],
    );

    const proj = await c.query(
      `SELECT id FROM projects WHERE org_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [ORG_ID],
    );
    if (proj.rows.length > 0) {
      projectId = proj.rows[0].id as string;
    } else {
      const r = await c.query(
        `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
         VALUES (gen_random_uuid()::text, $1, 'Assignee Model Test Project', 'AMT', $2, 0)
         RETURNING id`,
        [ORG_ID, MEMBER_USER_ID],
      );
      projectId = r.rows[0].id as string;
    }

    const t = await c.query(
      `INSERT INTO tasks
         (id, org_id, project_id, number, title, status, priority, assignee_id, created_by, is_deleted)
       VALUES (gen_random_uuid()::text, $1, $2,
         (SELECT coalesce(max(number), 0) + 1 FROM tasks WHERE project_id = $2),
         $3, 'backlog', 'p2', $4, $5, false)
       RETURNING id`,
      [ORG_ID, projectId, `assignee-model test ${Date.now()}`, PRIMARY_USER_ID, MEMBER_USER_ID],
    );
    taskId = t.rows[0].id as string;
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    if (taskId) {
      await c.query(`DELETE FROM task_assignees WHERE task_id = $1`, [taskId]);
      await c.query(`DELETE FROM task_activity WHERE task_id = $1`, [taskId]);
      await c.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
    }
    await c.query(
      `DELETE FROM notifications WHERE user_id IN ($1, $2, $3, $4)`,
      [MEMBER_USER_ID, PRIMARY_USER_ID, EXTRA_USER_ID, PROMOTE_USER_ID],
    );
    await c.query(
      `DELETE FROM org_members WHERE user_id IN ($1, $2, $3, $4)`,
      [MEMBER_USER_ID, PRIMARY_USER_ID, EXTRA_USER_ID, PROMOTE_USER_ID],
    );
    await c.query(
      `DELETE FROM users WHERE id IN ($1, $2, $3, $4)`,
      [MEMBER_USER_ID, PRIMARY_USER_ID, EXTRA_USER_ID, PROMOTE_USER_ID],
    );
  });
}

before(async () => {
  await seedFixtures();

  const { taskRoutes } = await import('../src/routes/tasks.js');
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    c.set('user', {
      id: MEMBER_USER_ID,
      email: MEMBER_EMAIL,
      org_id: ORG_ID,
    } as any);
    await next();
  });
  testApp.route('/api/tasks', taskRoutes);
});

after(async () => {
  await teardownFixtures();
});

function app(): Hono {
  if (!testApp) throw new Error('test app not initialized');
  return testApp;
}

// Helper: count assignees rows for a task+user
async function countAssignee(tid: string, uid: string): Promise<number> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT count(*)::int AS n FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
      [tid, uid],
    );
    return r.rows[0].n as number;
  });
}

// ─────────────────────────────────────────────────────────────────────────────

test('POST /api/tasks/:id/assignees rejects when user_id equals primary assignee', async () => {
  const res = await app().request(`/api/tasks/${taskId}/assignees`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: PRIMARY_USER_ID }),
  });
  assert.equal(res.status, 409);
  const body = (await res.json()) as any;
  assert.equal(body.code, 'ALREADY_PRIMARY_ASSIGNEE');
  // And nothing was inserted
  assert.equal(await countAssignee(taskId!, PRIMARY_USER_ID), 0);
});

test('POST /api/tasks/:id/assignees accepts a fresh additional assignee', async () => {
  const res = await app().request(`/api/tasks/${taskId}/assignees`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user_id: EXTRA_USER_ID }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.success, true);
  assert.equal(await countAssignee(taskId!, EXTRA_USER_ID), 1);
});

test('DELETE /api/tasks/:id/assignees/:userId removes an additional assignee', async () => {
  // Ensure the extra is there first
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO task_assignees (id, task_id, user_id)
       VALUES (gen_random_uuid()::text, $1, $2)
       ON CONFLICT (task_id, user_id) DO NOTHING`,
      [taskId, EXTRA_USER_ID],
    );
  });
  assert.equal(await countAssignee(taskId!, EXTRA_USER_ID), 1);

  const res = await app().request(`/api/tasks/${taskId}/assignees/${EXTRA_USER_ID}`, {
    method: 'DELETE',
  });
  assert.equal(res.status, 200);
  assert.equal(await countAssignee(taskId!, EXTRA_USER_ID), 0);
});

test('DELETE /api/tasks/:id/assignees/:userId returns 404 when user is the primary (not in table)', async () => {
  // Sanity: primary is NOT in task_assignees
  assert.equal(await countAssignee(taskId!, PRIMARY_USER_ID), 0);
  const res = await app().request(`/api/tasks/${taskId}/assignees/${PRIMARY_USER_ID}`, {
    method: 'DELETE',
  });
  assert.equal(res.status, 404);
  const body = (await res.json()) as any;
  assert.equal(body.code, 'NOT_FOUND');
});

test('PATCH /api/tasks/:id with assignee_id set to an existing additional removes the duplicate row', async () => {
  // Add PROMOTE_USER as an additional assignee first
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO task_assignees (id, task_id, user_id)
       VALUES (gen_random_uuid()::text, $1, $2)
       ON CONFLICT (task_id, user_id) DO NOTHING`,
      [taskId, PROMOTE_USER_ID],
    );
  });
  assert.equal(await countAssignee(taskId!, PROMOTE_USER_ID), 1);

  // Promote them to primary via PATCH
  const res = await app().request(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assignee_id: PROMOTE_USER_ID }),
  });
  assert.equal(res.status, 200);

  // They should now be the primary and NOT in task_assignees
  assert.equal(await countAssignee(taskId!, PROMOTE_USER_ID), 0);
  await withClient(async (c) => {
    const r = await c.query(`SELECT assignee_id FROM tasks WHERE id = $1`, [taskId]);
    assert.equal(r.rows[0].assignee_id, PROMOTE_USER_ID);
  });
});
