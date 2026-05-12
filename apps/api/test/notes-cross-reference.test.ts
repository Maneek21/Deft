/**
 * Task 5.1 — notes cross-reference worker
 *
 * Covers:
 *   1. A note containing PREFIX-N creates a cross_references row with
 *      source_type='note' pointing at the task.
 *   2. A task_comments row is written crediting the note by title
 *      ("Referenced in note ...").
 *   3. The handler is idempotent — same (note, task) pair does not
 *      insert a second row or duplicate comment.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const USER_ID = 'test-notes-xref-user';
const USER_EMAIL = 'notes-xref@test.local';

function randomLetters(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return s;
}

let projectPrefix: string | null = null;
let projectId: string | null = null;
let taskId: string | null = null;
let noteId: string | null = null;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

before(async () => {
  projectPrefix = `NXREF${randomLetters(4)}`;
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Notes Xref User', false)
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID, USER_EMAIL],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, USER_ID],
    );

    const p = await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 0)
       RETURNING id`,
      [ORG_ID, `Notes Xref ${projectPrefix}`, projectPrefix, USER_ID],
    );
    projectId = p.rows[0].id as string;

    const t = await c.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, status, priority, created_by, is_deleted)
       VALUES (gen_random_uuid()::text, $1, $2, 7, 'Cross-ref target', 'todo', 'p2', $3, false)
       RETURNING id`,
      [ORG_ID, projectId, USER_ID],
    );
    taskId = t.rows[0].id as string;

    const n = await c.query(
      `INSERT INTO notes (id, org_id, user_id, title, content, visibility, is_template, is_deleted, is_pinned)
       VALUES (gen_random_uuid()::text, $1, $2, 'Design doc', $3, 'private', false, false, false)
       RETURNING id`,
      [ORG_ID, USER_ID, `<p>see ${projectPrefix}-7 for context</p>`],
    );
    noteId = n.rows[0].id as string;
  });
});

after(async () => {
  await withClient(async (c) => {
    if (taskId) {
      await c.query(`DELETE FROM task_comments WHERE task_id = $1`, [taskId]);
      await c.query(`DELETE FROM task_activity WHERE task_id = $1`, [taskId]);
    }
    if (noteId) {
      await c.query(
        `DELETE FROM cross_references WHERE source_type = 'note' AND source_id = $1`,
        [noteId],
      );
      await c.query(`DELETE FROM notes WHERE id = $1`, [noteId]);
    }
    if (taskId) await c.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
    if (projectId) await c.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [USER_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
  });
});

test('cross-reference worker resolves PREFIX-N from a note and writes xref + comment', async () => {
  const { handleCrossReference } = await import('../src/workers/handlers/cross-reference.js');

  await handleCrossReference({
    id: 'test-job-1',
    name: 'cross-reference',
    data: {
      sourceType: 'note',
      sourceId: noteId!,
      content: `<p>see ${projectPrefix}-7 for context</p>`,
      orgId: ORG_ID,
      userId: USER_ID,
    },
  });

  await withClient(async (c) => {
    const refs = await c.query(
      `SELECT source_type, source_id, target_type, target_id
       FROM cross_references
       WHERE source_type = 'note' AND source_id = $1 AND target_id = $2`,
      [noteId, taskId],
    );
    assert.equal(refs.rows.length, 1, 'expected exactly 1 xref row');
    assert.equal(refs.rows[0].target_type, 'task');

    const comments = await c.query(
      `SELECT content FROM task_comments WHERE task_id = $1`,
      [taskId],
    );
    assert.equal(comments.rows.length, 1, 'expected exactly 1 task comment');
    assert.ok(
      /Referenced in note "Design doc"/.test(comments.rows[0].content),
      `comment should credit note title, got: ${comments.rows[0].content}`,
    );
  });
});

test('cross-reference worker is idempotent — second call adds no new rows', async () => {
  const { handleCrossReference } = await import('../src/workers/handlers/cross-reference.js');

  await handleCrossReference({
    id: 'test-job-2',
    name: 'cross-reference',
    data: {
      sourceType: 'note',
      sourceId: noteId!,
      content: `<p>see ${projectPrefix}-7 again</p>`,
      orgId: ORG_ID,
      userId: USER_ID,
    },
  });

  await withClient(async (c) => {
    const refs = await c.query(
      `SELECT id FROM cross_references WHERE source_type='note' AND source_id=$1`,
      [noteId],
    );
    assert.equal(refs.rows.length, 1, 'xref should remain 1 after re-run');

    const comments = await c.query(
      `SELECT id FROM task_comments WHERE task_id = $1`,
      [taskId],
    );
    assert.equal(comments.rows.length, 1, 'comment should remain 1 after re-run');
  });
});
