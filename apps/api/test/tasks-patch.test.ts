/**
 * Task 0.6 — PATCH /api/tasks/:id must reject project_id change.
 *
 * Design: cross-refs (PREFIX-N) are per-project. Allowing a project_id change
 * would silently break every chat message, comment, wiki citation that
 * references the task by its stable PREFIX-N identity. Simpler and safer to
 * reject: user must delete and recreate in the target project.
 *
 * Covers:
 *   1. PATCH with project_id != current -> 400 PROJECT_CHANGE_UNSUPPORTED
 *      (belt-and-suspenders: explicit 400 branch in handler)
 *   2. PATCH with project_id == current -> not a "project change", should
 *      succeed as a no-op relative to that field (Zod-stripped or ignored).
 *   3. PATCH with other fields alongside project_id != current -> still 400,
 *      nothing gets written.
 *
 * Run: cd apps/api && node --test --import tsx test/tasks-patch.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const MEMBER_USER_ID = 'test-tasks-patch-member';
const MEMBER_EMAIL = 'tasks-patch-member@test.local';

let testApp: Hono | null = null;
let projectAId: string | null = null;
let projectBId: string | null = null;
let taskId: string | null = null;
let sourceSpaceId: string | null = null;
let sourceMessageId: string | null = null;

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
    // FK cluster fix: seed orgs row so task_activity.org_id FK holds when
    // PATCH writes activity log entries on title changes.
    await c.query(
      `INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
      [ORG_ID, 'Tasks Patch Test Org'],
    );
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, $3, false)
       ON CONFLICT (id) DO NOTHING`,
      [MEMBER_USER_ID, MEMBER_EMAIL, 'Tasks Patch Member'],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, MEMBER_USER_ID],
    );

    const stamp = Date.now();
    const pa = await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 0)
       RETURNING id`,
      [ORG_ID, `Patch Test A ${stamp}`, `PTA${stamp % 10000}`, MEMBER_USER_ID],
    );
    projectAId = pa.rows[0].id as string;

    const pb = await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 0)
       RETURNING id`,
      [ORG_ID, `Patch Test B ${stamp}`, `PTB${stamp % 10000}`, MEMBER_USER_ID],
    );
    projectBId = pb.rows[0].id as string;

    const space = await c.query(
      `INSERT INTO spaces (id, org_id, name, type, created_by)
       VALUES (gen_random_uuid()::text, $1, 'tasks-patch-source', 'private', $2)
       RETURNING id`,
      [ORG_ID, MEMBER_USER_ID],
    );
    sourceSpaceId = space.rows[0].id as string;
    await c.query(
      `INSERT INTO space_members (id, space_id, user_id)
       VALUES (gen_random_uuid()::text, $1, $2)
       ON CONFLICT (space_id, user_id) DO NOTHING`,
      [sourceSpaceId, MEMBER_USER_ID],
    );
    const source = await c.query(
      `INSERT INTO messages (id, org_id, space_id, user_id, content)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4)
       RETURNING id`,
      [ORG_ID, sourceSpaceId, MEMBER_USER_ID, '<p>source task message</p>'],
    );
    sourceMessageId = source.rows[0].id as string;

    const t = await c.query(
      `INSERT INTO tasks
         (id, org_id, project_id, number, title, status, priority, assignee_id, created_by, source_message_id, is_deleted)
       VALUES (gen_random_uuid()::text, $1, $2,
         (SELECT coalesce(max(number), 0) + 1 FROM tasks WHERE project_id = $2),
         $3, 'backlog', 'p2', $4, $4, $5, false)
       RETURNING id`,
      [ORG_ID, projectAId, `tasks-patch test ${stamp}`, MEMBER_USER_ID, sourceMessageId],
    );
    taskId = t.rows[0].id as string;
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    if (taskId) {
      await c.query(`DELETE FROM task_activity WHERE task_id = $1`, [taskId]);
      await c.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
    }
    if (sourceMessageId) {
      await c.query(`DELETE FROM messages WHERE id = $1`, [sourceMessageId]);
    }
    if (sourceSpaceId) {
      await c.query(`DELETE FROM space_members WHERE space_id = $1`, [sourceSpaceId]);
      await c.query(`DELETE FROM spaces WHERE id = $1`, [sourceSpaceId]);
    }
    if (projectAId) {
      await c.query(`DELETE FROM tasks WHERE project_id = $1`, [projectAId]);
      await c.query(`DELETE FROM projects WHERE id = $1`, [projectAId]);
    }
    if (projectBId) {
      await c.query(`DELETE FROM tasks WHERE project_id = $1`, [projectBId]);
      await c.query(`DELETE FROM projects WHERE id = $1`, [projectBId]);
    }
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [MEMBER_USER_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [MEMBER_USER_ID]);
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

async function getTaskProjectId(tid: string): Promise<string | null> {
  return withClient(async (c) => {
    const r = await c.query(`SELECT project_id FROM tasks WHERE id = $1`, [tid]);
    return r.rows.length ? (r.rows[0].project_id as string) : null;
  });
}

// ─────────────────────────────────────────────────────────────────────────────

test('GET /api/tasks/:id returns flattened assignee fields for task detail clients', async () => {
  const res = await app().request(`/api/tasks/${taskId}`, { method: 'GET' });
  assert.equal(res.status, 200);
  const body = await res.json() as any;

  assert.equal(body.assignee_id, MEMBER_USER_ID);
  assert.equal(body.assignee_name, 'Tasks Patch Member');
  assert.equal(body.assignee?.id, MEMBER_USER_ID);
  assert.equal(body.assignee?.name, 'Tasks Patch Member');
  assert.equal(body.source_message_id, sourceMessageId);
  assert.equal(body.source_message?.id, sourceMessageId);
  assert.equal(body.source_message?.space_id, sourceSpaceId);
  assert.equal(body.source_message?.space_name, 'tasks-patch-source');
  assert.equal(body.source_message?.author_name, 'Tasks Patch Member');
  assert.equal(body.source_message?.content, '<p>source task message</p>');
});

test('PATCH /api/tasks/:id rejects project_id change with 400 PROJECT_CHANGE_UNSUPPORTED', async () => {
  const res = await app().request(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectBId }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  assert.equal(body.code, 'PROJECT_CHANGE_UNSUPPORTED');

  // And the task was NOT moved
  assert.equal(await getTaskProjectId(taskId!), projectAId);
});

test('PATCH /api/tasks/:id with project_id change AND other fields still rejects and writes nothing', async () => {
  const res = await app().request(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectBId, title: 'should-not-stick' }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  assert.equal(body.code, 'PROJECT_CHANGE_UNSUPPORTED');

  // Neither field should have been written
  await withClient(async (c) => {
    const r = await c.query(`SELECT title, project_id FROM tasks WHERE id = $1`, [taskId]);
    assert.notEqual(r.rows[0].title, 'should-not-stick');
    assert.equal(r.rows[0].project_id, projectAId);
  });
});

test('PATCH /api/tasks/:id with project_id equal to current is ignored, not rejected', async () => {
  // Current project == projectA. Send project_id: projectA with a real title
  // change — the project_id should be a no-op (stripped by Zod) and the title
  // change should go through.
  const newTitle = `tasks-patch unchanged-project ${Date.now()}`;
  const res = await app().request(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: projectAId, title: newTitle }),
  });
  assert.equal(res.status, 200);

  await withClient(async (c) => {
    const r = await c.query(`SELECT title, project_id FROM tasks WHERE id = $1`, [taskId]);
    assert.equal(r.rows[0].title, newTitle);
    assert.equal(r.rows[0].project_id, projectAId);
  });
});
