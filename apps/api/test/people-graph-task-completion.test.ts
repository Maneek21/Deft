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
 * Uses the real local Postgres DB. The file creates its own org, user and
 * project, so it neither reads nor depends on rows other test files create.
 * Per-test rows are cleaned up in finally blocks; the org, user and project
 * in `after`.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

// Fresh ids per run: this file owns its org, user and project outright.
const ORG_ID = randomUUID();
const USER_A = randomUUID();
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

let extractExpertise: (orgId: string) => Promise<void>;

before(async () => {
  // Create the org, the assignee and the project the task lives in. Nothing
  // is borrowed from fixtures or other test files.
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO orgs (id, name, slug) VALUES ($1, $2, $3)`,
      [ORG_ID, 'Task Completion Test Org', `task-completion-${ORG_ID}`],
    );
    await c.query(
      `INSERT INTO users (id, email, name, is_agent) VALUES ($1, $2, $3, false)`,
      [USER_A, `tc-${USER_A}@test.local`, 'Alex PM'],
    );
    await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES ($1, $2, 'Test Project (task-completion)', 'TTC', $3, 0)`,
      [PROJECT_ID, ORG_ID, USER_A],
    );
  });

  const mod = await import('../src/services/people-graph.js');
  extractExpertise = mod.extractExpertise;
});

after(async () => {
  await withClient(async (c) => {
    await c.query(`DELETE FROM people_expertise WHERE org_id = $1`, [ORG_ID]);
    await c.query(`DELETE FROM projects WHERE id = $1`, [PROJECT_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [USER_A]);
    await c.query(`DELETE FROM orgs WHERE id = $1`, [ORG_ID]);
  });
});

test('task completion with a label contributes +3 to assignee expertise on that topic', async () => {
  const TOPIC = `tc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const taskIds: string[] = [];
  const labelIds: string[] = [];
  const projectId = PROJECT_ID;

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
    // Expected delta: +3 × 1 (default label_weight). The org is private to
    // this file and TOPIC is unique, so the score is exactly prior + 3.
    // (The wiki-authorship pass and message pass cannot touch this topic.)
    const expected = Number(priorScore) + 3;
    assert.equal(
      Number(row.expertise_score),
      expected,
      `expected expertise_score ${expected} (prior ${priorScore} + 3), got ${row.expertise_score}`,
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
    });
  }
});
