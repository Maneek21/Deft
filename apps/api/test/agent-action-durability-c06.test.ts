/**
 * Lane W2-a2 — task creation durability.
 *
 * C06  task creation is idempotent per action: a retry of a creation that
 *      already committed returns the existing tasks instead of duplicating.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-action-durability-c06.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { createTaskBundle } from '../src/lib/task-bundle.js';
import {
  durabilityDatabaseUrl,
  setupDurabilityFixture,
  type DurabilityFixture,
} from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
let f: DurabilityFixture;

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('CS');
});

after(async () => {
  if (f) await f.teardown();
});

async function projectName(): Promise<string> {
  const row = await f.client.query('SELECT name FROM projects WHERE id = $1', [f.projectId]);
  return row.rows[0].name as string;
}

async function tasksTitled(title: string): Promise<number> {
  const rows = await f.client.query('SELECT count(*)::int AS n FROM tasks WHERE org_id = $1 AND title = $2', [f.orgId, title]);
  return rows.rows[0].n as number;
}

async function actionRow(id: string) {
  const rows = await f.client.query(
    'SELECT approval_status, result, error, executed_at FROM agent_actions WHERE id = $1',
    [id],
  );
  return rows.rows[0] as { approval_status: string; result: any; error: string | null; executed_at: Date | null };
}

// ─── C06 ─────────────────────────────────────────────────────────────────────

test('C06: createTaskBundle with the same action id returns the committed bundle instead of a duplicate', { skip: !canRun }, async () => {
  const title = `c06 bundle ${randomUUID()}`;
  const actionId = await f.insertAction({
    action: 'create_task', params: { title }, status: 'pending', executed: false,
  });
  const input = {
    orgId: f.orgId,
    projectId: f.projectId,
    projectPrefix: f.prefix,
    createdBy: f.requesterId,
    title,
    actionId,
    subtasks: [{ title: `${title} child` }],
  };
  const first = await createTaskBundle(input);
  // The outcome is recorded on the action inside the bundle transaction.
  const stamped = await actionRow(actionId);
  assert.equal(stamped.result.task_id, first.parent.id);
  assert.notEqual(stamped.executed_at, null);
  const second = await createTaskBundle(input);
  assert.equal(second.parent.id, first.parent.id);
  assert.deepEqual(second.subtasks.map((task) => task.id), first.subtasks.map((task) => task.id));
  assert.equal(second.reused, true);
  assert.equal(first.reused, false);
  assert.equal(await tasksTitled(title), 1);
  assert.equal(await tasksTitled(`${title} child`), 1);
});

test('C06: re-approving a creation whose bundle already committed returns it and creates nothing new', { skip: !canRun }, async () => {
  const title = `c06 retry ${randomUUID()}`;
  // The row is back to pending + retryable, as the route leaves it after a
  // failure reported once the bundle transaction had already committed.
  const actionId = await f.insertAction({
    action: 'create_task',
    params: { title, project_name: await projectName() },
    status: 'pending',
    result: { lifecycle_state: 'failed', retryable: true },
    error: 'post-commit failure',
    executed: false,
  });
  const committed = await createTaskBundle({
    orgId: f.orgId,
    projectId: f.projectId,
    projectPrefix: f.prefix,
    createdBy: f.requesterId,
    title,
    actionId,
  });

  const response = await f.as(f.requesterId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as { result: { task_id: string } };
  assert.equal(body.result.task_id, committed.parent.id);
  assert.equal(await tasksTitled(title), 1);
  const row = await actionRow(actionId);
  assert.equal(row.approval_status, 'approved');
  assert.equal(row.error, null);
});
