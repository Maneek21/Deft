/**
 * Task 3.8 — retrieveContext({ types: ['tasks'] }) integration test.
 *
 * Run: pnpm --filter @deft/api test -- retrieve-context-tasks
 *
 * Covers the end-to-end FTS path (no embeddings — hybrid=false so pgvector is
 * not required for the test to run in BYTEA dev envs): seed a task, call
 * retrieveContext, assert the task comes back with source_type='task' and the
 * expected metadata shape.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { retrieveContext } from '../src/lib/retrieve-context.js';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const USER_ID = `rctasks-test-user-${Date.now()}`;
const USER_EMAIL = `rctasks-test-${Date.now()}@test.local`;
const PROJECT_ID = `rctasks-project-${Date.now()}`;
const TASK_ID = `rctasks-task-${Date.now()}`;

// Unique nonsense term so only our seeded task can match this query and the
// test never collides with existing seed data.
const UNIQUE_TERM = `zxquibbletaskmatch${Date.now()}`;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

before(async () => {
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'RC Tasks Test User', false)
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID, USER_EMAIL],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, USER_ID],
    );
    await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [PROJECT_ID, ORG_ID, `RC Tasks Test Project ${Date.now()}`, `RCT${Date.now() % 100000}`, USER_ID],
    );
    await c.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, description, status, priority, created_by, is_deleted)
       VALUES ($1, $2, $3, 1, $4, $5, 'todo', 'p2', $6, false)`,
      [
        TASK_ID,
        ORG_ID,
        PROJECT_ID,
        `Ship ${UNIQUE_TERM} feature`,
        `This task covers the ${UNIQUE_TERM} rollout plan across engineering and design.`,
        USER_ID,
      ],
    );
  });
});

after(async () => {
  await withClient(async (c) => {
    await c.query(`DELETE FROM tasks WHERE id = $1`, [TASK_ID]);
    await c.query(`DELETE FROM projects WHERE id = $1`, [PROJECT_ID]);
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [USER_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
  });
});

test('retrieveContext({ types: [tasks] }) returns FTS-matched tasks with correct shape', async () => {
  const results = await retrieveContext({
    query: UNIQUE_TERM,
    org_id: ORG_ID,
    user_id: USER_ID,
    types: ['tasks'],
    // Force FTS-only so the test runs in BYTEA dev envs without pgvector.
    hybrid: false,
  });

  assert.ok(results.length >= 1, `Expected >=1 task result for "${UNIQUE_TERM}", got ${results.length}`);

  const hit = results.find((r) => r.source_id === TASK_ID);
  assert.ok(hit, `Expected seeded task ${TASK_ID} in results`);
  assert.strictEqual(hit!.source_type, 'task');
  assert.ok(hit!.title.includes(UNIQUE_TERM), `title should contain unique term: ${hit!.title}`);
  assert.ok(hit!.score >= 0 && hit!.score <= 1, `score out of range: ${hit!.score}`);

  // Metadata shape check — must surface structural fields for downstream callers.
  assert.ok(hit!.metadata, 'metadata should be present');
  assert.strictEqual(hit!.metadata!['status'], 'todo');
  assert.strictEqual(hit!.metadata!['priority'], 'p2');
  assert.strictEqual(hit!.metadata!['project_id'], PROJECT_ID);
});

test('retrieveContext without "tasks" in types excludes task results', async () => {
  const results = await retrieveContext({
    query: UNIQUE_TERM,
    org_id: ORG_ID,
    user_id: USER_ID,
    types: ['wiki', 'memory', 'notes', 'decisions'],
    hybrid: false,
  });

  for (const r of results) {
    assert.notStrictEqual(r.source_type, 'task', `Unexpected task in non-tasks query: ${r.source_id}`);
  }
});
