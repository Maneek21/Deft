/**
 * Lane W2-a2 — C09: undo never overwrites a later human change, and two
 * undos of the same action cannot both run.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-action-durability-c09.test.ts
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import {
  durabilityDatabaseUrl,
  setupDurabilityFixture,
  type DurabilityFixture,
} from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
let f: DurabilityFixture;

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('UN');
});

after(async () => {
  if (f) await f.teardown();
});

function undo(actionId: string) {
  return f.as(f.requesterId, `/api/agent/actions/${actionId}/undo`, { method: 'POST' });
}

async function taskField(taskId: string, field: 'status' | 'assignee_id') {
  const rows = await f.client.query(`SELECT ${field} AS value FROM tasks WHERE id = $1`, [taskId]);
  return rows.rows[0]?.value ?? null;
}

async function undoneAt(actionId: string) {
  const rows = await f.client.query('SELECT undone_at FROM agent_actions WHERE id = $1', [actionId]);
  return rows.rows[0]?.undone_at ?? null;
}

async function statusAction(taskId: string) {
  return f.insertAction({
    action: 'update_task_status',
    params: { task_identifier: taskId, new_status: 'in_progress' },
    result: { task_id: taskId },
    beforeState: { status: 'todo', task_id: taskId },
    afterState: { status: 'in_progress', task_id: taskId },
  });
}

test('C09: undoing a status change after a human changed the status again is refused and changes nothing', { skip: !canRun }, async () => {
  const taskId = await f.insertTask({ title: 'c09 status', status: 'in_progress' });
  const actionId = await statusAction(taskId);
  await f.client.query("UPDATE tasks SET status = 'done' WHERE id = $1", [taskId]);

  const response = await undo(actionId);
  assert.equal(response.status, 409, await response.clone().text());
  const body = await response.json() as { code: string; error: string };
  assert.equal(body.code, 'UNDO_CONFLICT');
  assert.equal(await taskField(taskId, 'status'), 'done');
  assert.equal(await undoneAt(actionId), null);
});

test('C09: undoing a status change that is still current restores the previous status', { skip: !canRun }, async () => {
  const taskId = await f.insertTask({ title: 'c09 status ok', status: 'in_progress' });
  const actionId = await statusAction(taskId);
  const response = await undo(actionId);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(await taskField(taskId, 'status'), 'todo');
  assert.notEqual(await undoneAt(actionId), null);
});

test('C09: undoing an assignment after a human reassigned the task is refused', { skip: !canRun }, async () => {
  const taskId = await f.insertTask({ title: 'c09 assign', assigneeId: f.requesterId });
  const actionId = await f.insertAction({
    action: 'assign_task',
    params: { task_identifier: taskId },
    result: { task_id: taskId },
    beforeState: { assignee_id: null, task_id: taskId },
    afterState: { assignee_id: f.requesterId, task_id: taskId },
  });
  await f.client.query('UPDATE tasks SET assignee_id = $2 WHERE id = $1', [taskId, f.adminId]);

  const response = await undo(actionId);
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal(await taskField(taskId, 'assignee_id'), f.adminId);
  assert.equal(await undoneAt(actionId), null);
});

test('C09: two concurrent undos of one action apply once', { skip: !canRun }, async () => {
  const taskId = await f.insertTask({ title: 'c09 race', status: 'in_progress' });
  const actionId = await statusAction(taskId);
  const responses = await Promise.all([undo(actionId), undo(actionId), undo(actionId)]);
  const ok = responses.filter((response) => response.status === 200);
  assert.equal(ok.length, 1, `statuses: ${responses.map((response) => response.status).join(',')}`);
  const activity = await f.client.query(
    "SELECT count(*)::int AS n FROM task_activity WHERE task_id = $1 AND action = 'status_changed'",
    [taskId],
  );
  assert.equal(activity.rows[0].n, 1);
  assert.equal(await taskField(taskId, 'status'), 'todo');
});
