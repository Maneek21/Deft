/**
 * Task 0.4 — Dashboard "My Work" assignee filter.
 *
 * Verifies GET /api/dashboard returns a `my_work` aggregation that only
 * includes tasks where the caller is the primary assignee (or an additional
 * assignee via task_assignees per Phase 0.3).
 *
 * Run: node --test --import tsx test/dashboard-my-work.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const USER_A_ID = 'test-mywork-user-a';
const USER_A_EMAIL = 'mywork-user-a@test.local';
const USER_B_ID = 'test-mywork-user-b';
const USER_B_EMAIL = 'mywork-user-b@test.local';

let testApp: Hono | null = null;
let projectId: string | null = null;
const taskIds: string[] = [];

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
       VALUES ($1, $2, 'My Work User A', false)
       ON CONFLICT (id) DO NOTHING`,
      [USER_A_ID, USER_A_EMAIL],
    );
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'My Work User B', false)
       ON CONFLICT (id) DO NOTHING`,
      [USER_B_ID, USER_B_EMAIL],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, USER_A_ID],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, USER_B_ID],
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
         VALUES ($1, 'My Work Test Project', 'MYW', $2, 0)
         RETURNING id`,
        [ORG_ID, USER_A_ID],
      );
      projectId = r.rows[0].id as string;
    }

    // Seed 3 in_progress tasks for user A
    for (let i = 0; i < 3; i++) {
      const t = await c.query(
        `INSERT INTO tasks
           (id, org_id, project_id, number, title, status, priority, assignee_id, created_by, is_deleted)
         VALUES (gen_random_uuid()::text, $1, $2,
           (SELECT coalesce(max(number), 0) + 1 FROM tasks WHERE project_id = $2),
           $3, 'in_progress', 'p2', $4, $4, false)
         RETURNING id`,
        [ORG_ID, projectId, `my-work A-${i} ${Date.now()}`, USER_A_ID],
      );
      taskIds.push(t.rows[0].id as string);
    }

    // Seed 5 in_progress tasks for user B
    for (let i = 0; i < 5; i++) {
      const t = await c.query(
        `INSERT INTO tasks
           (id, org_id, project_id, number, title, status, priority, assignee_id, created_by, is_deleted)
         VALUES (gen_random_uuid()::text, $1, $2,
           (SELECT coalesce(max(number), 0) + 1 FROM tasks WHERE project_id = $2),
           $3, 'in_progress', 'p2', $4, $4, false)
         RETURNING id`,
        [ORG_ID, projectId, `my-work B-${i} ${Date.now()}`, USER_B_ID],
      );
      taskIds.push(t.rows[0].id as string);
    }
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    if (taskIds.length > 0) {
      await c.query(
        `DELETE FROM task_assignees WHERE task_id = ANY($1::text[])`,
        [taskIds],
      );
      await c.query(
        `DELETE FROM tasks WHERE id = ANY($1::text[])`,
        [taskIds],
      );
    }
    await c.query(
      `DELETE FROM org_members WHERE user_id IN ($1, $2)`,
      [USER_A_ID, USER_B_ID],
    );
    await c.query(
      `DELETE FROM users WHERE id IN ($1, $2)`,
      [USER_A_ID, USER_B_ID],
    );
  });
}

before(async () => {
  await seedFixtures();

  const { dashboardRoutes } = await import('../src/routes/dashboard.js');
  testApp = new Hono();
  testApp.use('*', async (c, next) => {
    c.set('user', {
      id: USER_A_ID,
      email: USER_A_EMAIL,
      org_id: ORG_ID,
    } as any);
    await next();
  });
  testApp.route('/api/dashboard', dashboardRoutes);
});

after(async () => {
  await teardownFixtures();
});

function app(): Hono {
  if (!testApp) throw new Error('test app not initialized');
  return testApp;
}

// ─────────────────────────────────────────────────────────────────────────────

test('GET /api/dashboard returns my_work filtered to caller\'s tasks only', async () => {
  const res = await app().request('/api/dashboard', { method: 'GET' });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;

  assert.ok(Array.isArray(body.my_work), 'expected body.my_work to be an array');

  const seededMyWork = body.my_work.filter((t: any) =>
    taskIds.includes(t.id),
  );
  assert.equal(
    seededMyWork.length,
    3,
    `expected exactly 3 seeded my_work tasks for user A, got ${seededMyWork.length}`,
  );

  for (const t of seededMyWork) {
    assert.equal(
      t.assignee_id,
      USER_A_ID,
      `expected every my_work task to be assigned to user A, got ${t.assignee_id}`,
    );
  }

  // Defense-in-depth: no tasks belonging to user B should leak in.
  const leaked = body.my_work.filter((t: any) => t.assignee_id === USER_B_ID);
  assert.equal(leaked.length, 0, 'user B tasks must not appear in my_work');
});
