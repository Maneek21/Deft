/**
 * Task 3.11 — nudge-check proactive agent comment integration test.
 *
 * Run: pnpm --filter @deft/api test -- nudge-proactive-comment
 *
 * Covers:
 *   1. Seed a stalled in-progress task (updated > 48h ago) + an active
 *      agent employee subscribed to `event:task-stalled`. Run the nudge
 *      handler. Assert a task_comment row was created on the stalled task
 *      with user_id == the employee's shadow user_id and the expected
 *      "In Progress for 48h" body.
 *   2. 7d dedup: running the handler a second time within the window must
 *      NOT create a second proactive comment on the same task.
 *
 * Uses the real local Postgres. Seeds a throwaway org + user + employee +
 * project + task and tears everything down in a finally block so the
 * fixture is idempotent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

interface Fixture {
  orgId: string;
  humanUserId: string;
  agentUserId: string;
  employeeId: string;
  projectId: string;
  taskId: string;
}

async function seedFixture(c: pg.Client): Promise<Fixture> {
  const orgId = uniqueId('org-nudge-pc');
  const humanUserId = uniqueId('user-nudge-pc');
  const agentUserId = uniqueId('agent-user-nudge-pc');
  const employeeId = uniqueId('emp-nudge-pc');
  const projectId = uniqueId('proj-nudge-pc');
  const taskId = uniqueId('task-nudge-pc');

  // Org
  await c.query(
    `INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`,
    [orgId, `Nudge PC Test ${orgId}`, orgId],
  );

  // Human assignee
  await c.query(
    `INSERT INTO users (id, email, name, is_agent)
     VALUES ($1, $2, $3, false)`,
    [humanUserId, `${humanUserId}@test.local`, humanUserId],
  );

  // Agent shadow user (is_agent=true) — this is the proactive comment author
  await c.query(
    `INSERT INTO users (id, email, name, is_agent)
     VALUES ($1, $2, $3, true)`,
    [agentUserId, `${agentUserId}@test.local`, 'Test Agent PM'],
  );

  await c.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active)
     VALUES ($1, $2, $3, 'member', true)`,
    [uniqueId('om'), orgId, humanUserId],
  );

  // Agent employee subscribed to the stalled trigger
  await c.query(
    `INSERT INTO agent_employees
      (id, org_id, user_id, name, slug, role, system_prompt, trust_level,
       is_byoa, is_active, trigger_subscriptions, created_by)
     VALUES ($1, $2, $3, $4, $5, 'project_manager', 'nudge pc test prompt',
       'standard', true, true,
       ARRAY['event:task-stalled', 'event:task-overdue']::text[], $3)`,
    [employeeId, orgId, agentUserId, 'Test Agent PM', uniqueId('agent-pm-slug')],
  );

  // Project
  await c.query(
    `INSERT INTO projects (id, org_id, name, prefix)
     VALUES ($1, $2, $3, $4)`,
    [projectId, orgId, `Nudge PC Project`, 'NP'],
  );

  // Stalled task: in_progress + updated_at set to 72h ago so it trips the
  // "stalled > 48h" window. We stamp both created_at and updated_at to the
  // same old timestamp to keep the row internally consistent.
  const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
  await c.query(
    `INSERT INTO tasks
      (id, org_id, project_id, number, title, status, assignee_id,
       created_by, is_deleted, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'in_progress', $6, $7, false, $8, $8)`,
    [taskId, orgId, projectId, 1, 'Stalled task', humanUserId, humanUserId, seventyTwoHoursAgo],
  );

  return { orgId, humanUserId, agentUserId, employeeId, projectId, taskId };
}

async function teardownFixture(c: pg.Client, f: Fixture): Promise<void> {
  // Child rows first to avoid FK violations.
  await c.query(`DELETE FROM task_comments WHERE org_id = $1`, [f.orgId]);
  await c.query(`DELETE FROM agent_nudges WHERE org_id = $1`, [f.orgId]);
  await c.query(`DELETE FROM notifications WHERE org_id = $1`, [f.orgId]);
  await c.query(`DELETE FROM job_queue WHERE data->>'employee_id' = $1`, [f.employeeId]);
  await c.query(`DELETE FROM tasks WHERE org_id = $1`, [f.orgId]);
  await c.query(`DELETE FROM projects WHERE org_id = $1`, [f.orgId]);
  await c.query(`DELETE FROM agent_employees WHERE org_id = $1`, [f.orgId]);
  await c.query(`DELETE FROM org_members WHERE org_id = $1`, [f.orgId]);
  await c.query(`DELETE FROM users WHERE id = $1`, [f.humanUserId]);
  await c.query(`DELETE FROM users WHERE id = $1`, [f.agentUserId]);
  await c.query(`DELETE FROM orgs WHERE id = $1`, [f.orgId]);
}

async function countProactiveComments(
  c: pg.Client,
  taskId: string,
  agentUserId: string,
): Promise<{ count: number; firstContent: string | null }> {
  const r = await c.query(
    `SELECT content FROM task_comments
      WHERE task_id = $1 AND user_id = $2 AND is_deleted = false
      ORDER BY created_at ASC`,
    [taskId, agentUserId],
  );
  return {
    count: r.rows.length,
    firstContent: r.rows[0]?.content ?? null,
  };
}

test('nudge-check: stalled task with subscribed employee gets a proactive agent comment', async () => {
  const { handleNudgeCheck } = await import('../src/workers/handlers/nudge-check.js');

  await withClient(async (c) => {
    const f = await seedFixture(c);
    try {
      await handleNudgeCheck({ data: {} } as any);

      const { count, firstContent } = await countProactiveComments(
        c,
        f.taskId,
        f.agentUserId,
      );
      assert.equal(count, 1, 'expected exactly one proactive agent comment');
      assert.ok(
        firstContent && firstContent.includes('NP-1'),
        `comment should reference task identifier NP-1, got: ${firstContent}`,
      );
      assert.ok(
        firstContent && firstContent.includes('In Progress for 48h'),
        `comment should mention the 48h stall window, got: ${firstContent}`,
      );
    } finally {
      await teardownFixture(c, f);
    }
  });
});

test('nudge-check: running twice within 7d dedup window creates no duplicate proactive comment', async () => {
  const { handleNudgeCheck } = await import('../src/workers/handlers/nudge-check.js');

  await withClient(async (c) => {
    const f = await seedFixture(c);
    try {
      await handleNudgeCheck({ data: {} } as any);
      await handleNudgeCheck({ data: {} } as any);

      const { count } = await countProactiveComments(c, f.taskId, f.agentUserId);
      assert.equal(
        count,
        1,
        'second handler run within 7d must not insert a second proactive comment',
      );
    } finally {
      await teardownFixture(c, f);
    }
  });
});
