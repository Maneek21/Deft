/**
 * people-graph task-completion expertise signal test.
 *
 * Run: cd apps/api && node --test --import tsx test/people-graph-task-completion.test.ts
 *
 * Covers Task 5.2 of the task-management overhaul:
 *   A task marked `status='done'` with `updated_at > NOW()-INTERVAL '24h'`
 *   contributes `+3 × label_weight` (label_weight defaults to 1) to the
 *   assignee's `expertise_score` on the topic derived from the task's label.
 *
 * Uses the real local Postgres DB. All inserted rows are cleaned up in
 * finally blocks so the test is idempotent across runs.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

// Real user IDs from the test org — must exist in users table (FK constraint)
const USER_A = '329fe0f6-39b3-4f66-8e6d-539ad7f4906a'; // Alex PM

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

let extractExpertise: (orgId: string) => Promise<void>;

before(async () => {
  // FK cluster fix: ensure org + USER_A exist before tasks (assignee_id FK)
  // and projects (lead_id FK) inserts.
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING`,
      [ORG_ID, 'Task Completion Test Org'],
    );
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, $3, false)
       ON CONFLICT (id) DO NOTHING`,
      [USER_A, `tc-${USER_A}@test.local`, 'Alex PM'],
    );
  });

  const mod = await import('../src/services/people-graph.js');
  extractExpertise = mod.extractExpertise;
});

test('task completion with a label contributes +3 to assignee expertise on that topic', async () => {
  const TOPIC = `tc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const taskIds: string[] = [];
  const labelIds: string[] = [];
  let projectId = '';
  let createdProject = false;

  // Resolve (or create) a project for the org
  projectId = await withClient(async (c) => {
    const r = await c.query(
      `SELECT id FROM projects WHERE org_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [ORG_ID],
    );
    if (r.rows.length > 0) return r.rows[0].id as string;
    const ins = await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES (gen_random_uuid()::text, $1, 'Test Project (task-completion)', 'TTC', $2, 0)
       RETURNING id`,
      [ORG_ID, USER_A],
    );
    createdProject = true;
    return ins.rows[0].id as string;
  });

  // Snapshot any prior expertise_score on (USER_A, TOPIC) — should be 0/absent
  // since TOPIC is uniquely randomised, but we read it just to be safe.
  const priorScore = await withClient(async (c) => {
    const r = await c.query(
      `SELECT expertise_score FROM people_expertise
       WHERE org_id = $1 AND user_id = $2 AND topic = $3`,
      [ORG_ID, USER_A, TOPIC],
    );
    return r.rows[0]?.expertise_score ?? 0;
  });

  try {
    await withClient(async (c) => {
      // Seed label with our unique topic name. `labels.id` is a text PK
      // without a default, so we supply a fresh uuid explicitly.
      const lr = await c.query(
        `INSERT INTO labels (id, org_id, name, color)
         VALUES (gen_random_uuid()::text, $1, $2, '#ff0000')
         RETURNING id`,
        [ORG_ID, TOPIC],
      );
      const labelId = lr.rows[0].id as string;
      labelIds.push(labelId);

      // Seed a task: status='done', assignee=USER_A, updated_at=now
      const tr = await c.query(
        `INSERT INTO tasks
           (id, org_id, project_id, number, title, status, priority,
            assignee_id, created_by, is_deleted, updated_at)
         VALUES (gen_random_uuid()::text, $1, $2,
           (SELECT coalesce(max(number), 0) + 1 FROM tasks WHERE project_id = $2),
           $3, 'done', 'p2', $4, $4, false, NOW())
         RETURNING id`,
        [ORG_ID, projectId, `Task-completion expertise test ${TOPIC}`, USER_A],
      );
      const taskId = tr.rows[0].id as string;
      taskIds.push(taskId);

      // Link the task to the label
      await c.query(
        `INSERT INTO task_labels (task_id, label_id) VALUES ($1, $2)`,
        [taskId, labelId],
      );
    });

    await extractExpertise(ORG_ID);

    const row = await withClient(async (c) => {
      const r = await c.query(
        `SELECT expertise_score, topic FROM people_expertise
         WHERE org_id = $1 AND user_id = $2 AND topic = $3`,
        [ORG_ID, USER_A, TOPIC],
      );
      return r.rows[0] as { expertise_score: number; topic: string } | undefined;
    });

    assert.ok(row, `expected people_expertise row for (user=${USER_A}, topic=${TOPIC})`);
    // Expected delta: +3 × 1 (default label_weight). Score should be
    // at least priorScore + 3. (The wiki-authorship pass and message
    // pass cannot touch this synthetic topic.)
    const expectedMin = Number(priorScore) + 3;
    assert.ok(
      row.expertise_score >= expectedMin,
      `expected expertise_score >= ${expectedMin} (prior ${priorScore} + 3), got ${row.expertise_score}`,
    );
  } finally {
    await withClient(async (c) => {
      if (taskIds.length > 0) {
        await c.query(`DELETE FROM task_labels WHERE task_id = ANY($1)`, [taskIds]);
        await c.query(`DELETE FROM tasks WHERE id = ANY($1)`, [taskIds]);
      }
      if (labelIds.length > 0) {
        await c.query(`DELETE FROM labels WHERE id = ANY($1)`, [labelIds]);
      }
      // Clean up the synthetic expertise row we created
      await c.query(
        `DELETE FROM people_expertise
         WHERE org_id = $1 AND user_id = $2 AND topic = $3`,
        [ORG_ID, USER_A, TOPIC],
      );
      if (createdProject) {
        await c.query(
          `DELETE FROM projects WHERE id = $1 AND slug = 'test-task-completion-proj'`,
          [projectId],
        );
      }
    });
  }
});
