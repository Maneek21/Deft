/**
 * Task 2.7 — POST /api/tasks/:id/dependencies rejects cycles.
 *
 * Scenario: A blocks B, B blocks C. Attempting to add "C blocks A" would close
 * the loop A -> B -> C -> A, so the handler must return 400 DEPENDENCY_CYCLE
 * and write nothing. Non-cycle inserts still succeed.
 *
 * BFS scope: only edges of type `blocks`/`blocked_by` (these form cycles).
 * `relates_to` and `duplicates` are semantic pointers, not orderings, so they
 * are excluded from the cycle check.
 *
 * Run: cd apps/api && node --test --import tsx test/task-dependency-cycles.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Hono } from 'hono';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const MEMBER_USER_ID = 'test-dep-cycles-member';
const MEMBER_EMAIL = 'dep-cycles-member@test.local';

let testApp: Hono | null = null;
let projectId: string | null = null;
let taskAId: string | null = null;
let taskBId: string | null = null;
let taskCId: string | null = null;
let taskDId: string | null = null;

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
       VALUES ($1, $2, $3, false)
       ON CONFLICT (id) DO NOTHING`,
      [MEMBER_USER_ID, MEMBER_EMAIL, 'Dep Cycles Member'],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, MEMBER_USER_ID],
    );

    const stamp = Date.now();
    const p = await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 0)
       RETURNING id`,
      [ORG_ID, `Dep Cycles ${stamp}`, `DC${stamp % 10000}`, MEMBER_USER_ID],
    );
    projectId = p.rows[0].id as string;

    const mkTask = async (label: string) => {
      const r = await c.query(
        `INSERT INTO tasks
           (id, org_id, project_id, number, title, status, priority, created_by, is_deleted)
         VALUES (gen_random_uuid()::text, $1, $2,
           (SELECT coalesce(max(number), 0) + 1 FROM tasks WHERE project_id = $2),
           $3, 'backlog', 'p2', $4, false)
         RETURNING id`,
        [ORG_ID, projectId, `${label} ${stamp}`, MEMBER_USER_ID],
      );
      return r.rows[0].id as string;
    };

    taskAId = await mkTask('A');
    taskBId = await mkTask('B');
    taskCId = await mkTask('C');
    taskDId = await mkTask('D');
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    const fixtureProjectFilter = `
      SELECT id FROM projects
      WHERE lead_id = $1 AND name LIKE 'Dep Cycles %'
    `;
    const fixtureTaskFilter = `
      SELECT id FROM tasks WHERE project_id IN (${fixtureProjectFilter})
    `;

    await c.query(
      `DELETE FROM task_relationships
       WHERE source_task_id IN (${fixtureTaskFilter})
          OR target_task_id IN (${fixtureTaskFilter})`,
      [MEMBER_USER_ID],
    );
    await c.query(`DELETE FROM task_reactions WHERE task_id IN (${fixtureTaskFilter})`, [MEMBER_USER_ID]);
    await c.query(`DELETE FROM task_labels WHERE task_id IN (${fixtureTaskFilter})`, [MEMBER_USER_ID]);
    await c.query(`DELETE FROM task_comments WHERE task_id IN (${fixtureTaskFilter})`, [MEMBER_USER_ID]);
    await c.query(`DELETE FROM task_activity WHERE task_id IN (${fixtureTaskFilter})`, [MEMBER_USER_ID]);
    await c.query(`DELETE FROM task_watchers WHERE task_id IN (${fixtureTaskFilter})`, [MEMBER_USER_ID]);
    await c.query(`DELETE FROM task_assignees WHERE task_id IN (${fixtureTaskFilter})`, [MEMBER_USER_ID]);
    await c.query(`DELETE FROM tasks WHERE id IN (${fixtureTaskFilter})`, [MEMBER_USER_ID]);
    await c.query(`DELETE FROM projects WHERE id IN (${fixtureProjectFilter})`, [MEMBER_USER_ID]);
    await c.query(
      `DELETE FROM action_receipts
       WHERE action_id IN (
         SELECT id FROM agent_actions WHERE user_id = $1
       )`,
      [MEMBER_USER_ID],
    );
    await c.query(`DELETE FROM agent_actions WHERE user_id = $1`, [MEMBER_USER_ID]);
    await c.query(
      `DELETE FROM people_expertise WHERE user_id = $1`,
      [MEMBER_USER_ID],
    );
    await c.query(
      `DELETE FROM people_influence WHERE user_id = $1`,
      [MEMBER_USER_ID],
    );
    await c.query(
      `DELETE FROM people_patterns WHERE user_id = $1`,
      [MEMBER_USER_ID],
    );
    await c.query(
      `DELETE FROM people_relationships
       WHERE user_a_id = $1 OR user_b_id = $1`,
      [MEMBER_USER_ID],
    );
    await c.query(
      `DELETE FROM people_interactions
       WHERE user_a_id = $1 OR user_b_id = $1`,
      [MEMBER_USER_ID],
    );
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

async function addDep(fromId: string, toId: string, type: string) {
  return app().request(`/api/tasks/${fromId}/dependencies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target_task_id: toId, type }),
  });
}

async function relCount(): Promise<number> {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT count(*)::int AS n
         FROM task_relationships tr
         JOIN tasks t ON t.id = tr.source_task_id
        WHERE t.project_id = $1`,
      [projectId],
    );
    return r.rows[0].n as number;
  });
}

// ─────────────────────────────────────────────────────────────────────────────

test('POST /api/tasks/:id/dependencies rejects direct A->B, B->A cycle with 400 DEPENDENCY_CYCLE', async () => {
  // A blocks B
  const r1 = await addDep(taskAId!, taskBId!, 'blocks');
  assert.equal(r1.status, 201, `seed A->B blocks failed: ${await r1.text()}`);

  // B blocks A — would create 2-cycle
  const r2 = await addDep(taskBId!, taskAId!, 'blocks');
  assert.equal(r2.status, 400);
  const body = (await r2.json()) as any;
  assert.equal(body.code, 'DEPENDENCY_CYCLE');
});

test('POST /api/tasks/:id/dependencies rejects transitive A->B->C->A cycle with 400 DEPENDENCY_CYCLE', async () => {
  // B blocks C (extending chain A->B->C)
  const r1 = await addDep(taskBId!, taskCId!, 'blocks');
  assert.equal(r1.status, 201, `seed B->C blocks failed: ${await r1.text()}`);

  const before = await relCount();

  // C blocks A — closes the loop A->B->C->A
  const r2 = await addDep(taskCId!, taskAId!, 'blocks');
  assert.equal(r2.status, 400);
  const body = (await r2.json()) as any;
  assert.equal(body.code, 'DEPENDENCY_CYCLE');

  // Nothing was written
  const after = await relCount();
  assert.equal(after, before);
});

test('POST /api/tasks/:id/dependencies rejects cycle via blocked_by inverse', async () => {
  // Inverse direction: on task A, "blocked_by: C" is stored as "C blocks A",
  // which also closes the loop A->B->C->A. Must still be detected.
  const r = await addDep(taskAId!, taskCId!, 'blocked_by');
  assert.equal(r.status, 400);
  const body = (await r.json()) as any;
  assert.equal(body.code, 'DEPENDENCY_CYCLE');
});

test('POST /api/tasks/:id/dependencies allows non-cycling edge to new task', async () => {
  // A blocks D — no path back to A, should succeed.
  const r = await addDep(taskAId!, taskDId!, 'blocks');
  assert.equal(r.status, 201, `A->D blocks should have succeeded: ${await r.text()}`);
});

test('POST /api/tasks/:id/dependencies allows relates_to even when it would otherwise cycle', async () => {
  // relates_to is not an ordering; closing a "loop" with it is fine.
  const r = await addDep(taskCId!, taskAId!, 'relates_to');
  assert.equal(r.status, 201, `C relates_to A should have succeeded: ${await r.text()}`);
});
