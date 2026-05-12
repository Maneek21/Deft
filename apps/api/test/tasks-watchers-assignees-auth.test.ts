/**
 * Task 0.1 — Auth + org scoping on GET /api/tasks/:id/watchers and
 * GET /api/tasks/:id/assignees.
 *
 * Run: pnpm --filter @deft/api test -- tasks-watchers-assignees-auth
 *
 * Covers:
 *   1. No auth context -> 401 UNAUTHORIZED
 *   2. User from another org -> 404 NOT_FOUND (task not visible cross-tenant)
 *   3. Legit same-org user -> 200 with data
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const OTHER_ORG_ID = '00000000-0000-0000-0000-000000000bbb';

const MEMBER_USER_ID = 'test-watchers-auth-member';
const MEMBER_EMAIL = 'watchers-auth-member@test.local';
const OUTSIDER_USER_ID = 'test-watchers-auth-outsider';
const OUTSIDER_EMAIL = 'watchers-auth-outsider@test.local';
const WATCHER_USER_ID = 'test-watchers-auth-watcher';
const WATCHER_EMAIL = 'watchers-auth-watcher@test.local';
const ASSIGNEE_USER_ID = 'test-watchers-auth-assignee';
const ASSIGNEE_EMAIL = 'watchers-auth-assignee@test.local';

let testApp: Hono | null = null;
let projectId: string | null = null;
let taskId: string | null = null;
// null -> simulate "no auth" (handler sees undefined user)
type Mode = 'member' | 'outsider' | 'none';
let currentMode: Mode = 'member';

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
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Watchers Member', false)
       ON CONFLICT (id) DO NOTHING`,
      [MEMBER_USER_ID, MEMBER_EMAIL],
    );
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Watchers Outsider', false)
       ON CONFLICT (id) DO NOTHING`,
      [OUTSIDER_USER_ID, OUTSIDER_EMAIL],
    );
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Watchers Watcher', false)
       ON CONFLICT (id) DO NOTHING`,
      [WATCHER_USER_ID, WATCHER_EMAIL],
    );
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Watchers Assignee', false)
       ON CONFLICT (id) DO NOTHING`,
      [ASSIGNEE_USER_ID, ASSIGNEE_EMAIL],
    );
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
        `INSERT INTO projects (org_id, name, prefix, lead_id, task_counter)
         VALUES ($1, 'Watchers Auth Test Project', 'WAT', $2, 0)
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
      [ORG_ID, projectId, `watchers-auth test ${Date.now()}`, ASSIGNEE_USER_ID, MEMBER_USER_ID],
    );
    taskId = t.rows[0].id as string;

    await c.query(
      `INSERT INTO task_watchers (id, task_id, user_id)
       VALUES (gen_random_uuid()::text, $1, $2)
       ON CONFLICT (task_id, user_id) DO NOTHING`,
      [taskId, WATCHER_USER_ID],
    );
    await c.query(
      `INSERT INTO task_assignees (id, task_id, user_id)
       VALUES (gen_random_uuid()::text, $1, $2)
       ON CONFLICT (task_id, user_id) DO NOTHING`,
      [taskId, ASSIGNEE_USER_ID],
    );
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    if (taskId) {
      await c.query(`DELETE FROM task_watchers WHERE task_id = $1`, [taskId]);
      await c.query(`DELETE FROM task_assignees WHERE task_id = $1`, [taskId]);
      await c.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
    }
    await c.query(
      `DELETE FROM org_members WHERE user_id IN ($1, $2, $3, $4)`,
      [MEMBER_USER_ID, OUTSIDER_USER_ID, WATCHER_USER_ID, ASSIGNEE_USER_ID],
    );
    await c.query(
      `DELETE FROM users WHERE id IN ($1, $2, $3, $4)`,
      [MEMBER_USER_ID, OUTSIDER_USER_ID, WATCHER_USER_ID, ASSIGNEE_USER_ID],
    );
  });
}

before(async () => {
  await seedFixtures();

  const { taskRoutes } = await import('../src/routes/tasks.js');
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    if (currentMode === 'member') {
      c.set('user', {
        id: MEMBER_USER_ID,
        email: MEMBER_EMAIL,
        org_id: ORG_ID,
      } as any);
    } else if (currentMode === 'outsider') {
      c.set('user', {
        id: OUTSIDER_USER_ID,
        email: OUTSIDER_EMAIL,
        org_id: OTHER_ORG_ID,
      } as any);
    }
    // 'none' -> do not set user
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

// ─────────────────────────────────────────────────────────────────────────────

test('GET /api/tasks/:id/watchers with no auth returns 401', async () => {
  currentMode = 'none';
  const res = await app().request(`/api/tasks/${taskId}/watchers`, { method: 'GET' });
  assert.equal(res.status, 401);
  const body = (await res.json()) as any;
  assert.equal(body.code, 'UNAUTHORIZED');
});

test('GET /api/tasks/:id/watchers from another org returns 404', async () => {
  currentMode = 'outsider';
  const res = await app().request(`/api/tasks/${taskId}/watchers`, { method: 'GET' });
  assert.equal(res.status, 404);
});

test('GET /api/tasks/:id/watchers from legit same-org user returns 200 with data', async () => {
  currentMode = 'member';
  const res = await app().request(`/api/tasks/${taskId}/watchers`, { method: 'GET' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.ok(Array.isArray(body.watchers), 'expected { watchers: [...] }');
  const match = body.watchers.find((w: any) => w.user_id === WATCHER_USER_ID);
  assert.ok(match, 'seeded watcher should be returned');
});

test('GET /api/tasks/:id/assignees with no auth returns 401', async () => {
  currentMode = 'none';
  const res = await app().request(`/api/tasks/${taskId}/assignees`, { method: 'GET' });
  assert.equal(res.status, 401);
  const body = (await res.json()) as any;
  assert.equal(body.code, 'UNAUTHORIZED');
});

test('GET /api/tasks/:id/assignees from another org returns 404', async () => {
  currentMode = 'outsider';
  const res = await app().request(`/api/tasks/${taskId}/assignees`, { method: 'GET' });
  assert.equal(res.status, 404);
});

test('GET /api/tasks/:id/assignees from legit same-org user returns 200 with data', async () => {
  currentMode = 'member';
  const res = await app().request(`/api/tasks/${taskId}/assignees`, { method: 'GET' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.ok(Array.isArray(body.assignees), 'expected { assignees: [...] }');
  const match = body.assignees.find((a: any) => a.user_id === ASSIGNEE_USER_ID);
  assert.ok(match, 'seeded assignee should be returned');
});
