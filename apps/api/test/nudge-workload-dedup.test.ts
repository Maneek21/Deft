/**
 * nudge-check workload-imbalance dedup — per-admin dedup tests.
 *
 * Run: cd apps/api && node --test --import tsx test/nudge-workload-dedup.test.ts
 *
 * Covers:
 *   1. With 2 admins + 1 overloaded user, both admins receive one notification
 *      on the first pass; metadata carries overloaded_user_id + admin_user_id.
 *   2. Running checkWorkloadImbalance a second time inside the 7d window
 *      creates NO new notifications (dedup holds per admin).
 *   3. A pre-existing notification to admin A (but not B) only suppresses
 *      admin A on the next pass; admin B still gets a fresh notification.
 *
 * Uses the real local Postgres DB. Seeds a throwaway org + users + projects +
 * tasks and cleans up in finally blocks so the test is idempotent and does
 * not leak fixtures across runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

// Unique org id per test run so parallel CI invocations don't collide and so
// the admin/overloaded-user fixtures never collide with the real seed org.
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
  adminA: string;
  adminB: string;
  overloaded: string;
  lightUsers: string[];
  projectId: string;
  taskIds: string[];
}

/**
 * Seed an org with:
 *   - 2 admins
 *   - 1 heavily-loaded assignee (overloaded)
 *   - 3 lightly-loaded assignees (one task each)
 * Workload: overloaded = 10, light = 1 each → avg = 14/4 = 3.5, overloaded
 * passes the "count >= 3*avg && count >= 3" threshold (10 >= 10.5 fails;
 * bump overloaded to 15 so 15 >= 10.5).
 */
async function seedFixture(c: pg.Client): Promise<Fixture> {
  const orgId = uniqueId('org-workload');
  const adminA = uniqueId('admin-a');
  const adminB = uniqueId('admin-b');
  const overloaded = uniqueId('overloaded');
  const lightUsers = [uniqueId('light-1'), uniqueId('light-2'), uniqueId('light-3')];
  const projectId = uniqueId('proj');

  // Org row (orgs table)
  await c.query(
    `INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`,
    [orgId, `Workload Test ${orgId}`, orgId],
  );

  const allUsers = [adminA, adminB, overloaded, ...lightUsers];
  for (const uid of allUsers) {
    await c.query(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`,
      [uid, `${uid}@test.local`, uid],
    );
  }

  // Org memberships. Admins get role=admin, the rest get role=member.
  await c.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active)
     VALUES ($1, $2, $3, 'admin', true)`,
    [uniqueId('om-a'), orgId, adminA],
  );
  await c.query(
    `INSERT INTO org_members (id, org_id, user_id, role, is_active)
     VALUES ($1, $2, $3, 'admin', true)`,
    [uniqueId('om-b'), orgId, adminB],
  );
  for (const uid of [overloaded, ...lightUsers]) {
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES ($1, $2, $3, 'member', true)`,
      [uniqueId('om'), orgId, uid],
    );
  }

  // Project
  await c.query(
    `INSERT INTO projects (id, org_id, name, prefix)
     VALUES ($1, $2, $3, $4)`,
    [projectId, orgId, `Workload Project`, 'WL'],
  );

  // Tasks: 15 for overloaded, 1 each for lightUsers. Workload avg = (15+3)/4 = 4.5
  // overloaded.count=15 >= 4.5*3=13.5 AND >= 3 → triggers.
  const taskIds: string[] = [];
  for (let i = 0; i < 15; i++) {
    const tid = uniqueId('task-over');
    taskIds.push(tid);
    await c.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, status, assignee_id, created_by, is_deleted)
       VALUES ($1, $2, $3, $4, $5, 'in_progress', $6, $7, false)`,
      [tid, orgId, projectId, i + 1, `Overloaded task ${i}`, overloaded, adminA],
    );
  }
  for (let i = 0; i < lightUsers.length; i++) {
    const tid = uniqueId('task-light');
    taskIds.push(tid);
    await c.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, status, assignee_id, created_by, is_deleted)
       VALUES ($1, $2, $3, $4, $5, 'todo', $6, $7, false)`,
      [tid, orgId, projectId, 16 + i, `Light task ${i}`, lightUsers[i], adminA],
    );
  }

  return { orgId, adminA, adminB, overloaded, lightUsers, projectId, taskIds };
}

async function teardownFixture(c: pg.Client, f: Fixture): Promise<void> {
  // Order matters due to FKs. Delete child rows first.
  await c.query(`DELETE FROM agent_nudges WHERE org_id = $1`, [f.orgId]);
  await c.query(`DELETE FROM notifications WHERE org_id = $1`, [f.orgId]);
  await c.query(`DELETE FROM tasks WHERE org_id = $1`, [f.orgId]);
  await c.query(`DELETE FROM projects WHERE org_id = $1`, [f.orgId]);
  await c.query(`DELETE FROM org_members WHERE org_id = $1`, [f.orgId]);
  const allUsers = [f.adminA, f.adminB, f.overloaded, ...f.lightUsers];
  for (const uid of allUsers) {
    await c.query(`DELETE FROM users WHERE id = $1`, [uid]);
  }
  await c.query(`DELETE FROM orgs WHERE id = $1`, [f.orgId]);
}

async function countNotifications(
  c: pg.Client,
  orgId: string,
  adminId: string,
  overloadedId: string,
): Promise<number> {
  const r = await c.query(
    `SELECT COUNT(*)::int AS n
       FROM notifications
      WHERE org_id = $1
        AND user_id = $2
        AND metadata->>'nudge_type' = 'workload_imbalance'
        AND metadata->>'overloaded_user_id' = $3
        AND metadata->>'admin_user_id' = $2`,
    [orgId, adminId, overloadedId],
  );
  return r.rows[0].n as number;
}

test('workload dedup: 2 admins both receive a notification about the same overloaded user', async () => {
  const { checkWorkloadImbalance } = await import('../src/workers/handlers/nudge-check.js');

  await withClient(async (c) => {
    const f = await seedFixture(c);
    try {
      await checkWorkloadImbalance();

      // Both admins should have exactly one notification about the overloaded user.
      const nA = await countNotifications(c, f.orgId, f.adminA, f.overloaded);
      const nB = await countNotifications(c, f.orgId, f.adminB, f.overloaded);
      assert.equal(nA, 1, 'admin A should receive exactly 1 workload notification');
      assert.equal(nB, 1, 'admin B should receive exactly 1 workload notification');

      // Metadata shape check: admin_user_id must be set for each.
      const meta = await c.query(
        `SELECT user_id, metadata
           FROM notifications
          WHERE org_id = $1
            AND metadata->>'nudge_type' = 'workload_imbalance'
          ORDER BY user_id`,
        [f.orgId],
      );
      assert.equal(meta.rows.length, 2, 'should be exactly 2 notifications (one per admin)');
      for (const row of meta.rows) {
        assert.equal(row.metadata.overloaded_user_id, f.overloaded);
        assert.equal(row.metadata.admin_user_id, row.user_id);
        assert.equal(row.metadata.nudge_type, 'workload_imbalance');
      }
    } finally {
      await teardownFixture(c, f);
    }
  });
});

test('workload dedup: second pass within 7d creates no new notifications for either admin', async () => {
  const { checkWorkloadImbalance } = await import('../src/workers/handlers/nudge-check.js');

  await withClient(async (c) => {
    const f = await seedFixture(c);
    try {
      await checkWorkloadImbalance();
      await checkWorkloadImbalance(); // second pass — everything should dedup

      const nA = await countNotifications(c, f.orgId, f.adminA, f.overloaded);
      const nB = await countNotifications(c, f.orgId, f.adminB, f.overloaded);
      assert.equal(nA, 1, 'admin A still has exactly 1 notification after second pass');
      assert.equal(nB, 1, 'admin B still has exactly 1 notification after second pass');
    } finally {
      await teardownFixture(c, f);
    }
  });
});

test('workload dedup: existing notification to admin A only suppresses admin A — admin B still gets one', async () => {
  const { checkWorkloadImbalance } = await import('../src/workers/handlers/nudge-check.js');

  await withClient(async (c) => {
    const f = await seedFixture(c);
    try {
      // Pre-seed a notification to admin A about the overloaded user (2 days ago).
      const existingId = uniqueId('notif');
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      await c.query(
        `INSERT INTO notifications (id, org_id, user_id, type, title, body, link, metadata, created_at)
         VALUES ($1, $2, $3, 'agent_suggestion', 'Workload Imbalance', 'preseed', '/tasks', $4::jsonb, $5)`,
        [
          existingId,
          f.orgId,
          f.adminA,
          JSON.stringify({
            nudge_type: 'workload_imbalance',
            overloaded_user_id: f.overloaded,
            admin_user_id: f.adminA,
          }),
          twoDaysAgo,
        ],
      );

      await checkWorkloadImbalance();

      const nA = await countNotifications(c, f.orgId, f.adminA, f.overloaded);
      const nB = await countNotifications(c, f.orgId, f.adminB, f.overloaded);
      assert.equal(nA, 1, 'admin A still has exactly 1 notification (the pre-seeded one)');
      assert.equal(nB, 1, 'admin B gets a fresh notification despite admin A being suppressed');
    } finally {
      await teardownFixture(c, f);
    }
  });
});
