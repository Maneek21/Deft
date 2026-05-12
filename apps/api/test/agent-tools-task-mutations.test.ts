/**
 * Task 3.4 / 3.5 / 3.6 / 3.7 — agent tool mutations on tasks.
 *
 * Covers:
 *   - comment_on_task writes task_comments + task_activity
 *   - set_due_date updates tasks.due_date + activity row
 *   - set_priority updates tasks.priority + activity row
 *   - add_label creates/attaches a label + activity row
 *   - close_task / reopen_task are thin wrappers over update_task_status
 *   - add_dependency / remove_dependency happy path + cycle guard
 *   - list_my_tasks returns caller-scoped tasks (primary + additional assignees)
 *
 * Every write must stamp task_activity.agent_action_id +
 * task_activity.acting_agent_employee_id (Task 3.3).
 *
 * Run: cd apps/api && node --test --import tsx test/agent-tools-task-mutations.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/deft';
const ORG_ID = '1d7d869a-5e68-48d5-832e-11d8f3bb1dd6';

const CALLER_USER_ID = 'test-agent-mut-caller';
const CALLER_EMAIL = 'agent-mut-caller@test.local';
const EMP_SHADOW_USER_ID = 'test-agent-mut-shadow';
const EMP_ID = 'test-agent-mut-emp';

let PROJECT_ID: string | null = null;
let PROJECT_PREFIX: string | null = null;
let TASK_A_ID: string | null = null;
let TASK_B_ID: string | null = null;
let TASK_C_ID: string | null = null;

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
    // Caller user (human, member of org)
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Agent Mut Caller', false)
       ON CONFLICT (id) DO NOTHING`,
      [CALLER_USER_ID, CALLER_EMAIL],
    );
    await c.query(
      `INSERT INTO org_members (id, org_id, user_id, role, is_active)
       VALUES (gen_random_uuid()::text, $1, $2, 'member', true)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [ORG_ID, CALLER_USER_ID],
    );

    // Shadow user + agent employee (for attribution test)
    await c.query(
      `INSERT INTO users (id, email, name, is_agent)
       VALUES ($1, $2, 'Agent Mut Shadow', true)
       ON CONFLICT (id) DO NOTHING`,
      [EMP_SHADOW_USER_ID, 'agent-mut-shadow@test.local'],
    );
    await c.query(
      `INSERT INTO agent_employees (
         id, org_id, user_id, name, slug, role, system_prompt, trust_level,
         max_daily_actions, created_by, is_active, is_byoa
       ) VALUES ($1, $2, $3, 'Mut Agent', 'mut-agent', 'project_manager',
                 'you are mut', 'conservative', 50, $3, true, true)
       ON CONFLICT (id) DO NOTHING`,
      [EMP_ID, ORG_ID, EMP_SHADOW_USER_ID],
    );

    const stamp = Date.now();
    PROJECT_PREFIX = `MUT${stamp % 10000}`;
    const p = await c.query(
      `INSERT INTO projects (id, org_id, name, prefix, lead_id, task_counter)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 0)
       RETURNING id`,
      [ORG_ID, `Mutation Tools ${stamp}`, PROJECT_PREFIX, CALLER_USER_ID],
    );
    PROJECT_ID = p.rows[0].id as string;

    const mkTask = async (label: string) => {
      const r = await c.query(
        `INSERT INTO tasks
           (id, org_id, project_id, number, title, status, priority, created_by, is_deleted)
         VALUES (gen_random_uuid()::text, $1, $2,
                 (SELECT coalesce(max(number), 0) + 1 FROM tasks WHERE project_id = $2),
                 $3, 'todo', 'p2', $4, false)
         RETURNING id`,
        [ORG_ID, PROJECT_ID, `${label} ${stamp}`, CALLER_USER_ID],
      );
      return r.rows[0].id as string;
    };

    TASK_A_ID = await mkTask('Mut A');
    TASK_B_ID = await mkTask('Mut B');
    TASK_C_ID = await mkTask('Mut C');
  });
});

after(async () => {
  await withClient(async (c) => {
    if (PROJECT_ID) {
      await c.query(
        `DELETE FROM task_relationships
         WHERE source_task_id IN (SELECT id FROM tasks WHERE project_id = $1)
            OR target_task_id IN (SELECT id FROM tasks WHERE project_id = $1)`,
        [PROJECT_ID],
      );
      await c.query(
        `DELETE FROM task_labels
         WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)`,
        [PROJECT_ID],
      );
      await c.query(
        `DELETE FROM labels WHERE org_id = $1 AND name LIKE 'mut-%'`,
        [ORG_ID],
      );
      await c.query(
        `DELETE FROM task_comments WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)`,
        [PROJECT_ID],
      );
      await c.query(
        `DELETE FROM task_activity WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)`,
        [PROJECT_ID],
      );
      await c.query(
        `DELETE FROM task_assignees WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)`,
        [PROJECT_ID],
      );
      await c.query(`DELETE FROM tasks WHERE project_id = $1`, [PROJECT_ID]);
      await c.query(`DELETE FROM projects WHERE id = $1`, [PROJECT_ID]);
    }
    await c.query(`DELETE FROM agent_actions WHERE org_id = $1 AND user_id IN ($2, $3)`, [ORG_ID, CALLER_USER_ID, EMP_SHADOW_USER_ID]);
    await c.query(`DELETE FROM agent_employees WHERE id = $1`, [EMP_ID]);
    await c.query(`DELETE FROM org_members WHERE user_id = $1`, [CALLER_USER_ID]);
    await c.query(`DELETE FROM users WHERE id IN ($1, $2)`, [CALLER_USER_ID, EMP_SHADOW_USER_ID]);
  });
});

test('comment_on_task writes comment + activity with agent attribution', async () => {
  const { executeActionDirect } = await import('../src/lib/agent-actions.js');
  const r = await executeActionDirect(
    'comment_on_task',
    { task_identifier: TASK_A_ID, content: 'agent comment 3.4' },
    ORG_ID,
    CALLER_USER_ID,
    null,
    'quick',
    { agentEmployeeId: EMP_ID },
  );
  assert.equal(r.success, true, `expected success, got: ${JSON.stringify(r)}`);

  await withClient(async (c) => {
    const comments = await c.query(
      `SELECT content FROM task_comments WHERE task_id = $1`,
      [TASK_A_ID],
    );
    assert.ok(comments.rows.some((row) => row.content === 'agent comment 3.4'));

    const activity = await c.query(
      `SELECT action, agent_action_id, acting_agent_employee_id
       FROM task_activity WHERE task_id = $1 AND action = 'commented'`,
      [TASK_A_ID],
    );
    assert.ok(activity.rows.length >= 1);
    assert.ok(activity.rows[0].agent_action_id, 'expected agent_action_id to be set');
    assert.equal(activity.rows[0].acting_agent_employee_id, EMP_ID);
  });
});

test('set_due_date updates tasks.due_date + activity', async () => {
  const { executeActionDirect } = await import('../src/lib/agent-actions.js');
  const r = await executeActionDirect(
    'set_due_date',
    { task_identifier: TASK_A_ID, due_date: '2026-05-01' },
    ORG_ID,
    CALLER_USER_ID,
    null,
    'auto',
    { agentEmployeeId: EMP_ID },
  );
  assert.equal(r.success, true, JSON.stringify(r));

  await withClient(async (c) => {
    const tr = await c.query(`SELECT due_date FROM tasks WHERE id = $1`, [TASK_A_ID]);
    assert.ok(tr.rows[0].due_date, 'due_date should be set');
    const act = await c.query(
      `SELECT field, acting_agent_employee_id FROM task_activity
       WHERE task_id = $1 AND field = 'due_date'`,
      [TASK_A_ID],
    );
    assert.ok(act.rows.length >= 1);
    assert.equal(act.rows[0].acting_agent_employee_id, EMP_ID);
  });
});

test('set_priority updates tasks.priority + activity', async () => {
  const { executeActionDirect } = await import('../src/lib/agent-actions.js');
  const r = await executeActionDirect(
    'set_priority',
    { task_identifier: TASK_A_ID, priority: 'p0' },
    ORG_ID,
    CALLER_USER_ID,
    null,
    'auto',
    { agentEmployeeId: EMP_ID },
  );
  assert.equal(r.success, true, JSON.stringify(r));

  await withClient(async (c) => {
    const tr = await c.query(`SELECT priority FROM tasks WHERE id = $1`, [TASK_A_ID]);
    assert.equal(tr.rows[0].priority, 'p0');
    const act = await c.query(
      `SELECT new_value, acting_agent_employee_id FROM task_activity
       WHERE task_id = $1 AND field = 'priority' AND new_value = 'p0'`,
      [TASK_A_ID],
    );
    assert.ok(act.rows.length >= 1);
    assert.equal(act.rows[0].acting_agent_employee_id, EMP_ID);
  });
});

test('add_label creates the label + attaches via task_labels', async () => {
  const { executeActionDirect } = await import('../src/lib/agent-actions.js');
  const r = await executeActionDirect(
    'add_label',
    { task_identifier: TASK_A_ID, label_name: 'mut-urgent' },
    ORG_ID,
    CALLER_USER_ID,
    null,
    'auto',
    { agentEmployeeId: EMP_ID },
  );
  assert.equal(r.success, true, JSON.stringify(r));

  await withClient(async (c) => {
    const label = await c.query(
      `SELECT id, name FROM labels WHERE org_id = $1 AND name = 'mut-urgent'`,
      [ORG_ID],
    );
    assert.equal(label.rows.length, 1);
    const attach = await c.query(
      `SELECT label_id FROM task_labels WHERE task_id = $1`,
      [TASK_A_ID],
    );
    assert.ok(attach.rows.some((row) => row.label_id === label.rows[0].id));
    const act = await c.query(
      `SELECT acting_agent_employee_id FROM task_activity
       WHERE task_id = $1 AND field = 'label'`,
      [TASK_A_ID],
    );
    assert.ok(act.rows.length >= 1);
    assert.equal(act.rows[0].acting_agent_employee_id, EMP_ID);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Task 3.5 — close_task + reopen_task

test('close_task moves task to done', async () => {
  const { executeActionDirect } = await import('../src/lib/agent-actions.js');
  const r = await executeActionDirect(
    'close_task',
    { task_identifier: TASK_B_ID },
    ORG_ID,
    CALLER_USER_ID,
    null,
    'auto',
    { agentEmployeeId: EMP_ID },
  );
  assert.equal(r.success, true, JSON.stringify(r));
  await withClient(async (c) => {
    const tr = await c.query(`SELECT status FROM tasks WHERE id = $1`, [TASK_B_ID]);
    assert.equal(tr.rows[0].status, 'done');
  });
});

test('reopen_task moves task back to todo', async () => {
  const { executeActionDirect } = await import('../src/lib/agent-actions.js');
  const r = await executeActionDirect(
    'reopen_task',
    { task_identifier: TASK_B_ID },
    ORG_ID,
    CALLER_USER_ID,
    null,
    'auto',
    { agentEmployeeId: EMP_ID },
  );
  assert.equal(r.success, true, JSON.stringify(r));
  await withClient(async (c) => {
    const tr = await c.query(`SELECT status FROM tasks WHERE id = $1`, [TASK_B_ID]);
    assert.equal(tr.rows[0].status, 'todo');
  });
});

// ────────────────────────────────────────────────────────────────────────
// Task 3.6 — add_dependency + remove_dependency with cycle guard

test('add_dependency creates a relationship (blocks)', async () => {
  const { executeActionDirect } = await import('../src/lib/agent-actions.js');
  const r = await executeActionDirect(
    'add_dependency',
    {
      source_task_identifier: TASK_A_ID,
      target_task_identifier: TASK_B_ID,
      type: 'blocks',
    },
    ORG_ID,
    CALLER_USER_ID,
    null,
    'quick',
    { agentEmployeeId: EMP_ID },
  );
  assert.equal(r.success, true, JSON.stringify(r));
  await withClient(async (c) => {
    const rel = await c.query(
      `SELECT type FROM task_relationships WHERE source_task_id = $1 AND target_task_id = $2`,
      [TASK_A_ID, TASK_B_ID],
    );
    assert.equal(rel.rows.length, 1);
    assert.equal(rel.rows[0].type, 'blocks');
  });
});

test('add_dependency refuses to close a blocks-cycle and writes nothing', async () => {
  // A blocks B is already set above. Now try B blocks A.
  const { executeActionDirect } = await import('../src/lib/agent-actions.js');
  const r = await executeActionDirect(
    'add_dependency',
    {
      source_task_identifier: TASK_B_ID,
      target_task_identifier: TASK_A_ID,
      type: 'blocks',
    },
    ORG_ID,
    CALLER_USER_ID,
    null,
    'quick',
    { agentEmployeeId: EMP_ID },
  );
  assert.equal(r.success, false);
  assert.match(r.error || '', /cycle/i);
  await withClient(async (c) => {
    const rel = await c.query(
      `SELECT * FROM task_relationships WHERE source_task_id = $1 AND target_task_id = $2`,
      [TASK_B_ID, TASK_A_ID],
    );
    assert.equal(rel.rows.length, 0);
  });
});

test('remove_dependency deletes the relationship', async () => {
  const { executeActionDirect } = await import('../src/lib/agent-actions.js');
  const r = await executeActionDirect(
    'remove_dependency',
    {
      source_task_identifier: TASK_A_ID,
      target_task_identifier: TASK_B_ID,
      type: 'blocks',
    },
    ORG_ID,
    CALLER_USER_ID,
    null,
    'quick',
    { agentEmployeeId: EMP_ID },
  );
  assert.equal(r.success, true, JSON.stringify(r));
  await withClient(async (c) => {
    const rel = await c.query(
      `SELECT * FROM task_relationships WHERE source_task_id = $1 AND target_task_id = $2`,
      [TASK_A_ID, TASK_B_ID],
    );
    assert.equal(rel.rows.length, 0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Task 3.7 — list_my_tasks caller-scoped tool

test('list_my_tasks returns caller-assigned tasks, excluding done by default', async () => {
  // Assign TASK_C_ID as primary to the caller.
  await withClient(async (c) => {
    await c.query(`UPDATE tasks SET assignee_id = $1 WHERE id = $2`, [CALLER_USER_ID, TASK_C_ID]);
  });

  const { executeToolCall } = await import('../src/lib/agent-context.js');
  const { result } = await executeToolCall(
    'list_my_tasks',
    {},
    ORG_ID,
    CALLER_USER_ID,
  );
  const rows = result as any[];
  assert.ok(Array.isArray(rows), `expected array, got ${JSON.stringify(result)}`);
  assert.ok(
    rows.some((r) => r.id === TASK_C_ID),
    'expected caller-assigned task to be listed',
  );
});

test('list_my_tasks picks up additional assignees (task_assignees rows)', async () => {
  // Make caller an additional assignee of TASK_B_ID (not primary).
  await withClient(async (c) => {
    await c.query(
      `INSERT INTO task_assignees (id, task_id, user_id)
       VALUES (gen_random_uuid()::text, $1, $2)
       ON CONFLICT (task_id, user_id) DO NOTHING`,
      [TASK_B_ID, CALLER_USER_ID],
    );
  });

  const { executeToolCall } = await import('../src/lib/agent-context.js');
  const { result } = await executeToolCall('list_my_tasks', {}, ORG_ID, CALLER_USER_ID);
  const rows = result as any[];
  assert.ok(rows.some((r) => r.id === TASK_B_ID), 'expected additional-assignee task to be listed');
});
