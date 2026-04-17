/**
 * Task 5.7 — workflows executor (basic trigger -> action)
 *
 * End-to-end:
 *   1. Create workflow "when status -> done, add label 'shipped'"
 *   2. Invoke handleWorkflowExecute directly with the new task_id
 *   3. Assert the task has the 'shipped' label attached and a
 *      workflow_runs row was written with status='success'.
 *
 * Invoking the handler directly (rather than going through the
 * BullMQ queue poller) keeps this focused: the status-change enqueue
 * path is covered by typecheck + schema contracts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/cairn';

const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';
const USER_ID = 'test-wf-exec-user';
const USER_EMAIL = 'wf-exec@test.local';

function randomLetters(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return s;
}

let projectPrefix: string | null = null;
let projectId: string | null = null;
let taskId: string | null = null;
let ruleId: string | null = null;
let labelId: string | null = null;

async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATABASE_URL });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

before(async () => {
  projectPrefix = `WFEXEC${randomLetters(4)}`;
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'WF Exec User', false)
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
      [ORG_ID, `WF Exec ${projectPrefix}`, projectPrefix, USER_ID],
    );
    projectId = p.rows[0].id as string;

    const t = await c.query(
      `INSERT INTO tasks (id, org_id, project_id, number, title, status, priority, created_by, is_deleted)
       VALUES (gen_random_uuid()::text, $1, $2, 1, 'wf-exec target', 'in_review', 'p2', $3, false)
       RETURNING id`,
      [ORG_ID, projectId, USER_ID],
    );
    taskId = t.rows[0].id as string;

    const l = await c.query(
      `INSERT INTO labels (id, org_id, name, color)
       VALUES (gen_random_uuid()::text, $1, 'shipped', '#22c55e')
       RETURNING id`,
      [ORG_ID],
    );
    labelId = l.rows[0].id as string;

    const r = await c.query(
      `INSERT INTO workflow_rules
         (id, org_id, name, trigger_type, trigger_config, action_type, action_config, created_by, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'task.status_changed', $3, 'add_label', $4, $5, true)
       RETURNING id`,
      [
        ORG_ID,
        `ship-on-done-${projectPrefix}`,
        JSON.stringify({ to_status: 'done' }),
        JSON.stringify({ kind: 'add_label', label_id: labelId }),
        USER_ID,
      ],
    );
    ruleId = r.rows[0].id as string;
  });
});

after(async () => {
  await withClient(async (c) => {
    if (ruleId) {
      await c.query(`DELETE FROM workflow_runs WHERE rule_id = $1`, [ruleId]);
      await c.query(`DELETE FROM workflow_rules WHERE id = $1`, [ruleId]);
    }
    if (taskId) {
      await c.query(`DELETE FROM task_labels WHERE task_id = $1`, [taskId]);
      await c.query(`DELETE FROM task_comments WHERE task_id = $1`, [taskId]);
      await c.query(`DELETE FROM task_activity WHERE task_id = $1`, [taskId]);
      await c.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
    }
    if (labelId) await c.query(`DELETE FROM labels WHERE id = $1`, [labelId]);
    if (projectId) await c.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [USER_ID]);
    await c.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
  });
});

test('executor applies add_label and writes a successful workflow_runs row', async () => {
  const { handleWorkflowExecute } = await import('../src/workers/handlers/workflow-execute.js');

  await handleWorkflowExecute({
    id: 'test-job-wf-1',
    name: 'workflow-execute',
    data: {
      workflow_id: ruleId!,
      task_id: taskId!,
      actor_user_id: USER_ID,
    },
  });

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT label_id FROM task_labels WHERE task_id = $1`,
      [taskId],
    );
    assert.equal(r.rows.length, 1, 'exactly one task_labels row');
    assert.equal(r.rows[0].label_id, labelId);

    const runs = await c.query(
      `SELECT status, result FROM workflow_runs WHERE rule_id = $1`,
      [ruleId],
    );
    assert.equal(runs.rows.length, 1, 'workflow_runs row written');
    assert.equal(runs.rows[0].status, 'success');
    assert.equal(runs.rows[0].result.task_id, taskId);
    assert.equal(runs.rows[0].result.actions.length, 1);
    assert.equal(runs.rows[0].result.actions[0].kind, 'add_label');
    assert.equal(runs.rows[0].result.actions[0].ok, true);
  });
});

test('executor is idempotent — second run does not duplicate the label', async () => {
  const { handleWorkflowExecute } = await import('../src/workers/handlers/workflow-execute.js');

  await handleWorkflowExecute({
    id: 'test-job-wf-2',
    name: 'workflow-execute',
    data: {
      workflow_id: ruleId!,
      task_id: taskId!,
      actor_user_id: USER_ID,
    },
  });

  await withClient(async (c) => {
    const r = await c.query(
      `SELECT label_id FROM task_labels WHERE task_id = $1`,
      [taskId],
    );
    assert.equal(r.rows.length, 1, 'label still attached once after re-run');

    const runs = await c.query(
      `SELECT COUNT(*)::int AS n FROM workflow_runs WHERE rule_id = $1`,
      [ruleId],
    );
    // 2 runs total — one per invocation
    assert.equal(runs.rows[0].n, 2);
  });
});

test('executor validates label org scope — cross-org label_id fails gracefully', async () => {
  const { handleWorkflowExecute } = await import('../src/workers/handlers/workflow-execute.js');

  // Temporarily point the rule at a bogus label_id to simulate a
  // cross-org / missing label situation and ensure the run is flagged
  // failed rather than crashing the worker.
  const bogusLabelId = '00000000-0000-0000-0000-000000000000';
  await withClient(async (c) => {
    await c.query(
      `UPDATE workflow_rules SET action_config = $1 WHERE id = $2`,
      [JSON.stringify({ kind: 'add_label', label_id: bogusLabelId }), ruleId],
    );
  });

  await handleWorkflowExecute({
    id: 'test-job-wf-3',
    name: 'workflow-execute',
    data: {
      workflow_id: ruleId!,
      task_id: taskId!,
      actor_user_id: USER_ID,
    },
  });

  await withClient(async (c) => {
    const runs = await c.query(
      `SELECT status, result FROM workflow_runs WHERE rule_id = $1 ORDER BY executed_at DESC LIMIT 1`,
      [ruleId],
    );
    assert.equal(runs.rows[0].status, 'failed');
    assert.equal(runs.rows[0].result.actions[0].ok, false);
    assert.match(runs.rows[0].result.actions[0].error, /label not in org/);
  });
});
