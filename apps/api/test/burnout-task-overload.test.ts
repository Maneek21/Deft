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
 * Uses the real local Postgres DB. All inserted rows are cleaned up in
 * finally blocks.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

// Real user IDs from the test org — must exist in users table (FK constraints)
const USER_A = '329fe0f6-39b3-4f66-8e6d-539ad7f4906a'; // Alex PM — primary assignee
const USER_B = '07308d0d-199a-479d-a2e3-fefdf7cdbac9'; // Priya — under-threshold
const USER_C = 'd3e6d84d-f5da-4172-825a-964d951bb649'; // Rahul — additional-assignee test

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
 * Pick (or require) a project in the test org to anchor the seeded tasks.
 */
async function getProjectId(c: pg.Client): Promise<string> {
  const r = await c.query(
    `SELECT id FROM projects WHERE org_id = $1 AND is_archived = false ORDER BY created_at ASC LIMIT 1`,
    [ORG_ID],
  );
  if (r.rows.length === 0) {
    throw new Error(`No project found in test org ${ORG_ID} — cannot seed tasks.`);
  }
  return r.rows[0].id as string;
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
  const mod = await import('../src/services/burnout-detector.js');
  detectTaskOverload = mod.detectTaskOverload;
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test('1. detectTaskOverload: detected:true when user has 16 active tasks due within 14 days', async () => {
  const ids: string[] = [];

  await withClient(async (c) => {
    const projectId = await getProjectId(c);
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
    assert.ok(
      signal.detail.active_due_soon_count >= 16,
      `active_due_soon_count should be >= 16, got ${signal.detail.active_due_soon_count}`,
    );
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
    const projectId = await getProjectId(c);
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
    const projectId = await getProjectId(c);
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
    assert.ok(
      signal.detail.active_due_soon_count >= 16,
      `active_due_soon_count should be >= 16, got ${signal.detail.active_due_soon_count}`,
    );
  } finally {
    await withClient(async (c) => {
      for (const id of ids) {
        await c.query(`DELETE FROM task_assignees WHERE task_id = $1`, [id]);
        await c.query(`DELETE FROM tasks WHERE id = $1`, [id]);
      }
    });
  }
});
