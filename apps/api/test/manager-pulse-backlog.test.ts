/**
 * Task 5.4 — Manager pulse active-task count excludes backlog.
 *
 * Before this fix the query used `status NOT IN ('done', 'cancelled')`, which
 * counted every backlog task as "active" and inflated the manager pulse health
 * card. The corrected query uses `status IN ('todo', 'in_progress', 'in_review')`
 * — i.e. only in-flight work.
 *
 * Run: cd apps/api && node --test --import tsx test/manager-pulse-backlog.test.ts
 *
 * Seeds 2 backlog + 2 in_progress tasks for a single assignee in a throwaway
 * org, calls generateManagerPulse as a separate manager user, and asserts the
 * assignee's health card reports activeTasks === 2 (not 4).
 *
 * Uses the real local Postgres DB. ANTHROPIC_API_KEY is blanked before the
 * call so the LLM summary step falls back to buildFallbackSummary and we don't
 * depend on external services or burn credits during tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';

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
  managerId: string;
  assigneeId: string;
  projectId: string;
  taskIds: string[];
}

async function seedFixture(c: pg.Client): Promise<Fixture> {
  const orgId = uniqueId('org-pulse');
  const managerId = uniqueId('mgr');
  const assigneeId = uniqueId('assignee');
  const projectId = uniqueId('proj-pulse');

  await c.query(
    `INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`,
    [orgId, `Pulse Backlog Test ${orgId}`, orgId],
  );

  for (const uid of [managerId, assigneeId]) {
    await c.query(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`,
      [uid, `${uid}@test.local`, uid],
    );
  }

  await c.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active)
     VALUES ($1, $2, $3, 'admin', true)`,
    [uniqueId('om-mgr'), orgId, managerId],
  );
  await c.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active)
     VALUES ($1, $2, $3, 'member', true)`,
    [uniqueId('om-assignee'), orgId, assigneeId],
  );

  await c.query(
    `INSERT INTO projects (id, org_id, name, prefix)
     VALUES ($1, $2, $3, $4)`,
    [projectId, orgId, 'Pulse Backlog Project', 'PBP'],
  );

  const taskIds: string[] = [];

  // 2 backlog tasks — these should NOT be counted as active after the fix.
  for (let i = 0; i < 2; i++) {
    const tid = uniqueId('task-backlog');
    taskIds.push(tid);
    await c.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, status, assignee_id, created_by, is_deleted)
       VALUES ($1, $2, $3, $4, $5, 'backlog', $6, $7, false)`,
      [tid, orgId, projectId, i + 1, `Backlog task ${i}`, assigneeId, managerId],
    );
  }

  // 2 in_progress tasks — these SHOULD be counted as active.
  for (let i = 0; i < 2; i++) {
    const tid = uniqueId('task-inprogress');
    taskIds.push(tid);
    await c.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, status, assignee_id, created_by, is_deleted)
       VALUES ($1, $2, $3, $4, $5, 'in_progress', $6, $7, false)`,
      [tid, orgId, projectId, i + 3, `In-progress task ${i}`, assigneeId, managerId],
    );
  }

  return { orgId, managerId, assigneeId, projectId, taskIds };
}

async function teardownFixture(c: pg.Client, f: Fixture): Promise<void> {
  // FK-safe teardown order.
  await c.query(`DELETE FROM team_health_snapshots WHERE org_id = $1`, [f.orgId]);
  await c.query(`DELETE FROM agent_nudges WHERE org_id = $1`, [f.orgId]);
  await c.query(`DELETE FROM people_patterns WHERE org_id = $1`, [f.orgId]);
  await c.query(`DELETE FROM manager_settings WHERE org_id = $1`, [f.orgId]);
  await c.query(`DELETE FROM tasks WHERE org_id = $1`, [f.orgId]);
  await c.query(`DELETE FROM projects WHERE org_id = $1`, [f.orgId]);
  await c.query(`DELETE FROM org_members WHERE org_id = $1`, [f.orgId]);
  await c.query(`DELETE FROM users WHERE id = $1`, [f.managerId]);
  await c.query(`DELETE FROM users WHERE id = $1`, [f.assigneeId]);
  await c.query(`DELETE FROM orgs WHERE id = $1`, [f.orgId]);
}

test('manager pulse excludes backlog tasks from active-task count', async () => {
  // Import the service + env lazily so we can blank the API key before the
  // LLM call happens inside generateManagerPulse (forces the fallback path).
  const { env } = await import('../src/lib/env.js');
  const originalKey = env.ANTHROPIC_API_KEY;
  env.ANTHROPIC_API_KEY = '';

  const { generateManagerPulse } = await import('../src/services/manager-pulse.js');

  try {
    await withClient(async (c) => {
      const f = await seedFixture(c);
      try {
        const pulse = await generateManagerPulse(f.managerId, f.orgId);

        const card = pulse.healthCards.find((hc) => hc.userId === f.assigneeId);
        assert.ok(card, 'assignee should have a health card');
        assert.equal(
          card!.activeTasks,
          2,
          `activeTasks should be 2 (in_progress only), got ${card!.activeTasks}. ` +
            'If this is 4, the query is still counting backlog tasks as active.',
        );
      } finally {
        await teardownFixture(c, f);
      }
    });
  } finally {
    env.ANTHROPIC_API_KEY = originalKey;
  }
});
