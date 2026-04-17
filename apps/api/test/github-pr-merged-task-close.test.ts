/**
 * Task 5.6 — PR merged closes linked tasks.
 *
 * Covers closeTasksForMergedPR (apps/api/src/workers/github-sync.ts):
 *   1. Parses PREFIX-N refs from title + body, honors multiple refs
 *   2. Closes tasks whose status is in (todo, in_progress, in_review)
 *   3. Leaves tasks already `done` or `cancelled` untouched
 *   4. Writes a task_comments row: "Closed by merging PR #<n>: <title>\n\n<url>"
 *   5. Writes a task_activity row (field=status, old_value=<prev>, new_value=done)
 *   6. Is idempotent — second call on same PR makes no further writes
 *   7. parseTaskRefs ignores hyphenless identifiers and dedupes repeats
 *
 * Run: cd apps/api && node --test --import tsx test/github-pr-merged-task-close.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const ACTOR_USER_ID = 'test-gh-pr-close-agent';
const ACTOR_EMAIL = 'gh-pr-close-agent@test.local';

// NOTE: TASK_REF_REGEX (/\b([A-Z]+)-(\d+)\b/) requires a letters-only prefix.
// We pick a random 8-letter token per run to avoid collisions across repeat
// runs without introducing digits (which would break the regex).
const PROJECT_PREFIX_BASE = 'GHPRCLOSE';
function randomLetterSuffix(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return s;
}
let projectPrefix: string | null = null;
let projectId: string | null = null;

// Task IDs under test
let taskOpenId: string | null = null; // status=todo, number=42 — should close
let taskInProgressId: string | null = null; // in_progress, 43 — should close
let taskInReviewId: string | null = null; // in_review, 44 — should close
let taskDoneId: string | null = null; // done, 45 — must NOT touch
let taskCancelledId: string | null = null; // cancelled, 46 — must NOT touch
let taskOtherOrgPrefixId: string | null = null; // different prefix, 42 — must NOT touch

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
  projectPrefix = `${PROJECT_PREFIX_BASE}${randomLetterSuffix(4)}`;
  await withClient(async (c) => {
    // is_agent user — primary actor pick; also an active org member so pickActorUserId selects it.
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (id) DO NOTHING`,
      [ACTOR_USER_ID, ACTOR_EMAIL, 'GH PR Close Actor'],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, ACTOR_USER_ID],
    );

    const p = await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 0)
       RETURNING id`,
      [ORG_ID, `PR Close Project ${projectPrefix}`, projectPrefix, ACTOR_USER_ID],
    );
    projectId = p.rows[0].id as string;

    async function insertTask(number: number, status: string): Promise<string> {
      const r = await c.query(
        `INSERT INTO tasks
           (id, org_id, project_id, number, title, status, priority, created_by, is_deleted)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 'p2', $6, false)
         RETURNING id`,
        [ORG_ID, projectId, number, `PR close task #${number}`, status, ACTOR_USER_ID],
      );
      return r.rows[0].id as string;
    }

    taskOpenId = await insertTask(42, 'todo');
    taskInProgressId = await insertTask(43, 'in_progress');
    taskInReviewId = await insertTask(44, 'in_review');
    taskDoneId = await insertTask(45, 'done');
    taskCancelledId = await insertTask(46, 'cancelled');

    // Create a second project with a different prefix to prove we match on (prefix, number),
    // not just number. `OTHER-42` must NOT close.
    const otherPrefix = `${projectPrefix}X`;
    const p2 = await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 0)
       RETURNING id`,
      [ORG_ID, `PR Close Other ${otherPrefix}`, otherPrefix, ACTOR_USER_ID],
    );
    const other = await c.query(
      `INSERT INTO tasks
         (id, org_id, project_id, number, title, status, priority, created_by, is_deleted)
       VALUES (gen_random_uuid()::text, $1, $2, 42, 'Other-prefix task 42', 'todo', 'p2', $3, false)
       RETURNING id`,
      [ORG_ID, p2.rows[0].id, ACTOR_USER_ID],
    );
    taskOtherOrgPrefixId = other.rows[0].id as string;
  });
}

async function teardownFixtures() {
  await withClient(async (c) => {
    const ids = [
      taskOpenId,
      taskInProgressId,
      taskInReviewId,
      taskDoneId,
      taskCancelledId,
      taskOtherOrgPrefixId,
    ].filter(Boolean) as string[];
    if (ids.length) {
      await c.query(`DELETE FROM task_comments WHERE task_id = ANY($1)`, [ids]);
      await c.query(`DELETE FROM task_activity WHERE task_id = ANY($1)`, [ids]);
      await c.query(`DELETE FROM tasks WHERE id = ANY($1)`, [ids]);
    }
    // Delete both projects we may have created.
    if (projectPrefix) {
      await c.query(
        `DELETE FROM projects WHERE org_id = $1 AND (prefix = $2 OR prefix = $3)`,
        [ORG_ID, projectPrefix, `${projectPrefix}X`],
      );
    }
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [ACTOR_USER_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [ACTOR_USER_ID]);
  });
}

before(async () => {
  await seedFixtures();
});

after(async () => {
  await teardownFixtures();
});

// ─────────────────────────────────────────────────────────────────────────────

test('parseTaskRefs extracts PREFIX-N, dedupes, ignores unrelated tokens', async () => {
  const { parseTaskRefs } = await import('../src/workers/github-sync.js');
  const refs = parseTaskRefs(
    'fix: resolve DEFT-42 bug, also fixes DEFT-43 and DEFT-42 (again). lower-case-skip notAref-1. Closes ENG-7.',
  );
  // Expect DEFT-42 once, DEFT-43 once, ENG-7 once. "lower-case-skip" should not match.
  const seen = refs.map((r) => `${r.prefix}-${r.number}`);
  assert.ok(seen.includes('DEFT-42'));
  assert.ok(seen.includes('DEFT-43'));
  assert.ok(seen.includes('ENG-7'));
  // dedup
  assert.equal(seen.filter((k) => k === 'DEFT-42').length, 1);
});

test('closeTasksForMergedPR closes closable statuses, skips done/cancelled, writes activity + comment', async () => {
  const { closeTasksForMergedPR } = await import('../src/workers/github-sync.js');

  const title = `fix: resolve ${projectPrefix}-42 and ${projectPrefix}-43 and ${projectPrefix}-44 bugs`;
  // Body references same-project 45/46 (should be skipped — already done/cancelled)
  // and NONEXISTENTABCDEF-999 (a prefix that doesn't exist in any project → must be a no-op).
  // Intentionally does NOT reference ${projectPrefix}X-42, so the other-prefix task
  // must stay in its original status (proves we match on the specific (prefix, number)).
  const body = `Also closes ${projectPrefix}-45 (already done) and ${projectPrefix}-46 (cancelled) and NONEXISTENTABCDEF-999 (unknown project).`;
  const url = 'https://github.com/example/repo/pull/99';

  const result = await closeTasksForMergedPR({
    org_id: ORG_ID,
    pr_number: 99,
    title,
    body,
    url,
  });

  // 3 tasks (todo, in_progress, in_review) should have closed.
  assert.equal(result.closed_task_ids.length, 3, `expected 3 closes, got ${result.closed_task_ids.length}`);
  assert.ok(result.closed_task_ids.includes(taskOpenId!));
  assert.ok(result.closed_task_ids.includes(taskInProgressId!));
  assert.ok(result.closed_task_ids.includes(taskInReviewId!));

  await withClient(async (c) => {
    // Closable tasks moved to done
    for (const id of [taskOpenId!, taskInProgressId!, taskInReviewId!]) {
      const r = await c.query(`SELECT status FROM tasks WHERE id = $1`, [id]);
      assert.equal(r.rows[0].status, 'done');
    }

    // Done + cancelled untouched
    const rd = await c.query(`SELECT status FROM tasks WHERE id = $1`, [taskDoneId]);
    assert.equal(rd.rows[0].status, 'done');
    const rc = await c.query(`SELECT status FROM tasks WHERE id = $1`, [taskCancelledId]);
    assert.equal(rc.rows[0].status, 'cancelled');

    // Different-prefix task untouched (prove we match on prefix, not just number)
    const rx = await c.query(`SELECT status FROM tasks WHERE id = $1`, [taskOtherOrgPrefixId]);
    assert.equal(rx.rows[0].status, 'todo');

    // task_activity row written for the open task
    const act = await c.query(
      `SELECT action, field, old_value, new_value, user_id FROM task_activity
       WHERE task_id = $1 AND field = 'status' AND new_value = 'done'`,
      [taskOpenId],
    );
    assert.equal(act.rows.length, 1);
    assert.equal(act.rows[0].action, 'status_changed');
    assert.equal(act.rows[0].old_value, 'todo');
    // user_id must be an is_agent user in the org (pickActorUserId preference).
    // We don't pin to our seeded ACTOR_USER_ID because the test org may already
    // have other is_agent shadow users and the picker may deterministically
    // select a different one — the contract is "an agent user", not "ours".
    const authorId = act.rows[0].user_id as string;
    const authorRow = await c.query(`SELECT is_agent FROM users WHERE id = $1`, [authorId]);
    assert.equal(authorRow.rows.length, 1);
    assert.equal(authorRow.rows[0].is_agent, true, 'activity author should be an agent user');

    // task_comments row written for the open task, with the expected shape
    const cm = await c.query(
      `SELECT content, user_id FROM task_comments WHERE task_id = $1`,
      [taskOpenId],
    );
    assert.equal(cm.rows.length, 1);
    const content = cm.rows[0].content as string;
    assert.ok(content.startsWith('Closed by merging PR #99:'), `got: ${content}`);
    assert.ok(content.includes(url), `expected url in comment body: ${content}`);
    // Comment author must be the same agent user as the activity author.
    assert.equal(cm.rows[0].user_id, authorId);
  });
});

test('closeTasksForMergedPR is idempotent — second run does not double-write', async () => {
  const { closeTasksForMergedPR } = await import('../src/workers/github-sync.js');

  // Count comments + activity for taskOpenId pre-call (should be 1 each from the
  // previous test — we intentionally build on that state to check idempotency).
  const before = await withClient(async (c) => {
    const cm = await c.query(`SELECT count(*)::int AS n FROM task_comments WHERE task_id = $1`, [taskOpenId]);
    const act = await c.query(
      `SELECT count(*)::int AS n FROM task_activity
       WHERE task_id = $1 AND field = 'status' AND new_value = 'done'`,
      [taskOpenId],
    );
    return { comments: cm.rows[0].n as number, activity: act.rows[0].n as number };
  });

  const result = await closeTasksForMergedPR({
    org_id: ORG_ID,
    pr_number: 99,
    title: `fix: resolve ${projectPrefix}-42 bug (again)`,
    body: null,
    url: 'https://github.com/example/repo/pull/99',
  });
  assert.equal(result.closed_task_ids.length, 0, 'already-done tasks must not re-close');

  const after = await withClient(async (c) => {
    const cm = await c.query(`SELECT count(*)::int AS n FROM task_comments WHERE task_id = $1`, [taskOpenId]);
    const act = await c.query(
      `SELECT count(*)::int AS n FROM task_activity
       WHERE task_id = $1 AND field = 'status' AND new_value = 'done'`,
      [taskOpenId],
    );
    return { comments: cm.rows[0].n as number, activity: act.rows[0].n as number };
  });

  assert.equal(after.comments, before.comments, 'comment count should not grow on re-run');
  assert.equal(after.activity, before.activity, 'activity count should not grow on re-run');
});

test('closeTasksForMergedPR with no PREFIX-N refs is a no-op', async () => {
  const { closeTasksForMergedPR } = await import('../src/workers/github-sync.js');
  const result = await closeTasksForMergedPR({
    org_id: ORG_ID,
    pr_number: 100,
    title: 'chore: bump dependencies',
    body: 'no refs here',
    url: null,
  });
  assert.equal(result.closed_task_ids.length, 0);
  assert.equal(result.matched_refs.length, 0);
});
