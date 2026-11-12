/**
 * burnout-detector service unit tests — task overload signal.
 *
 * Run: cd apps/api && node --test --import tsx test/burnout-task-overload.test.ts
 *
 * Covers:
 *   1. detectTaskOverload returns detected:true when user has 16 active tasks
 *      (status in todo/in_progress/in_review) due within the next 14 days
 *   2. detectTaskOverload returns detected:false when user has 10 such tasks
 *      (below the > 15 threshold)
 *   3. detectTaskOverload counts tasks where the user is an additional
 *      assignee (via task_assignees) in addition to the primary assignee
 *
 * Uses the real local Postgres DB. The file creates its own org, users and
 * project, so it neither reads nor depends on rows other test files create.
 * Tasks are cleaned up per test; the org, users and project in `after`.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

// Fresh ids per run: this file owns its org, users and project outright.
const ORG_ID = randomUUID();
const USER_A = randomUUID(); // primary assignee
const USER_B = randomUUID(); // under-threshold
const USER_C = randomUUID(); // additional-assignee test
const PROJECT_ID = randomUUID();

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/**
 * Allocate N unique task numbers inside the given project by bumping
 * task_counter atomically. Returns the first number; caller takes
 * [base .. base + count - 1].
 */
async function allocateTaskNumbers(
  c: pg.Client,
  projectId: string,
  count: number,
): Promise<number> {
  const r = await c.query(
    `UPDATE projects SET task_counter = task_counter + $1
     WHERE id = $2
     RETURNING task_counter`,
    [count, projectId],
  );
  const newCounter = Number(r.rows[0].task_counter);
  return newCounter - count + 1;
}

/**
 * Insert an active task due within 14 days assigned to `primaryAssigneeId`.
 * Returns the task id.
 */
async function seedActiveDueSoonTask(
  c: pg.Client,
  projectId: string,
  primaryAssigneeId: string,
  createdBy: string,
  number: number,
  status: 'todo' | 'in_progress' | 'in_review',
): Promise<string> {
  // Due date in 7 days — comfortably within the 14-day window.
  const due = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const r = await c.query(
    `INSERT INTO tasks (id, org_id, project_id, number, title, status, assignee_id, created_by, due_date)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [ORG_ID, projectId, number, `Burnout task-overload test ${number}`, status, primaryAssigneeId, createdBy, due.toISOString()],
  );
  return r.rows[0].id as string;
}

/**
 * Insert an active task with a different primary assignee, then add
 * `additionalUserId` as an additional assignee via task_assignees.
 * Returns the task id.
 */
async function seedTaskWithAdditionalAssignee(
  c: pg.Client,
  projectId: string,
  primaryAssigneeId: string,
  additionalUserId: string,
  createdBy: string,
  number: number,
): Promise<string> {
  const due = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
  const r = await c.query(
    `INSERT INTO tasks (id, org_id, project_id, number, title, status, assignee_id, created_by, due_date)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'todo', $5, $6, $7)
     RETURNING id`,
    [ORG_ID, projectId, number, `Burnout additional-assignee test ${number}`, primaryAssigneeId, createdBy, due.toISOString()],
  );
  const taskId = r.rows[0].id as string;
  await c.query(
    `INSERT INTO task_assignees (id, task_id, user_id) VALUES (gen_random_uuid()::text, $1, $2)`,
    [taskId, additionalUserId],
  );
  return taskId;
}

// ─── Service import ───────────────────────────────────────────────────────────

let detectTaskOverload: (userId: string, orgId: string) => Promise<{
  name: string;
  weight: number;
  detected: boolean;
  detail: { active_due_soon_count: number; threshold: number };
}>;

before(async () => {
  // Create everything the tests need here: an org of its own, three users
  // and one project. Nothing is borrowed from fixtures or other test files.
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`,
      [ORG_ID, 'Burnout Task Overload Test Org', `burnout-overload-${ORG_ID}`],
    );
    for (const [uid, name] of [
      [USER_A, 'Alex PM'],
      [USER_B, 'Priya'],
      [USER_C, 'Rahul'],
    ] as const) {
      await c.query(
        `INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, $3, false)`,
        [uid, `burnout-${uid}@test.local`, name],
      );
    }
    await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES ($1, $2, 'Burnout Task Overload Test Project', 'BTO', $3, 0)`,
      [PROJECT_ID, ORG_ID, USER_A],
    );
  });

  const mod = await import('../src/services/burnout-detector.js');
  detectTaskOverload = mod.detectTaskOverload;
});

after(async () => {
  await withClient(async (c) => {
    await c.query(
      `DELETE FROM task_assignees WHERE task_id IN (SELECT id FROM tasks WHERE org_id = $1)`,
      [ORG_ID],
    );
    await c.query(`DELETE FROM tasks WHERE org_id = $1`, [ORG_ID]);
    await c.query(`DELETE FROM projects WHERE id = $1`, [PROJECT_ID]);
    await c.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER_A, USER_B, USER_C]]);
    await c.query(`DELETE FROM orgs WHERE id = $1`, [ORG_ID]);
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test('1. detectTaskOverload: detected:true when user has 16 active tasks due within 14 days', async () => {
  const ids: string[] = [];

  await withClient(async (c) => {
    const projectId = PROJECT_ID;
    const baseNumber = await allocateTaskNumbers(c, projectId, 16);

    const statuses: Array<'todo' | 'in_progress' | 'in_review'> = ['todo', 'in_progress', 'in_review'];
    for (let i = 0; i < 16; i++) {
      const status = statuses[i % statuses.length]!;
      ids.push(await seedActiveDueSoonTask(c, projectId, USER_A, USER_A, baseNumber + i, status));
    }
  });

  try {
    const signal = await detectTaskOverload(USER_A, ORG_ID);

    assert.equal(signal.name, 'task_overload', 'signal name should be task_overload');
    assert.equal(signal.weight, 0.10, 'signal weight should be 0.10');
    assert.equal(signal.detected, true, 'should be detected: 16 active-due-soon tasks > threshold 15');
    // The org is private to this file, so the count is exact.
    assert.equal(signal.detail.active_due_soon_count, 16, 'active_due_soon_count should be 16');
    assert.equal(signal.detail.threshold, 15, 'threshold should be 15');
  } finally {
    await withClient(async (c) => {
      for (const id of ids) {
        await c.query(`DELETE FROM task_assignees WHERE task_id = $1`, [id]);
        await c.query(`DELETE FROM tasks WHERE id = $1`, [id]);
      }
    });
  }
});

test('2. detectTaskOverload: detected:false when user has 10 active-due-soon tasks (below threshold)', async () => {
  const ids: string[] = [];

  await withClient(async (c) => {
    const projectId = PROJECT_ID;
    const baseNumber = await allocateTaskNumbers(c, projectId, 10);

    for (let i = 0; i < 10; i++) {
      ids.push(await seedActiveDueSoonTask(c, projectId, USER_B, USER_B, baseNumber + i, 'todo'));
    }
  });

  try {
    const signal = await detectTaskOverload(USER_B, ORG_ID);

    assert.equal(signal.name, 'task_overload');
    assert.equal(signal.weight, 0.10);
    assert.equal(
      signal.detected,
      false,
      `should not be detected: 10 tasks is below the > 15 threshold (got count=${signal.detail.active_due_soon_count})`,
    );
    assert.equal(signal.detail.active_due_soon_count, 10, 'active_due_soon_count should be 10');
    assert.equal(signal.detail.threshold, 15);
  } finally {
    await withClient(async (c) => {
      for (const id of ids) {
        await c.query(`DELETE FROM task_assignees WHERE task_id = $1`, [id]);
        await c.query(`DELETE FROM tasks WHERE id = $1`, [id]);
      }
    });
  }
});

test('3. detectTaskOverload: counts tasks where user is an additional assignee (task_assignees)', async () => {
  const ids: string[] = [];

  await withClient(async (c) => {
    const projectId = PROJECT_ID;
    // 16 tasks where USER_A is primary and USER_C is added via task_assignees.
    const baseNumber = await allocateTaskNumbers(c, projectId, 16);
    for (let i = 0; i < 16; i++) {
      ids.push(
        await seedTaskWithAdditionalAssignee(c, projectId, USER_A, USER_C, USER_A, baseNumber + i),
      );
    }
  });

  try {
    const signal = await detectTaskOverload(USER_C, ORG_ID);

    assert.equal(signal.name, 'task_overload');
    assert.equal(
      signal.detected,
      true,
      `should be detected via additional-assignee join (got count=${signal.detail.active_due_soon_count})`,
    );
    // The org is private to this file, so the count is exact.
    assert.equal(signal.detail.active_due_soon_count, 16, 'active_due_soon_count should be 16');
  } finally {
    await withClient(async (c) => {
      for (const id of ids) {
        await c.query(`DELETE FROM task_assignees WHERE task_id = $1`, [id]);
        await c.query(`DELETE FROM tasks WHERE id = $1`, [id]);
      }
    });
  }
});
