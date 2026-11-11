/**
 * Lane W2-a2 — C08: undo refuses action types it has no reversal for,
 * instead of reporting success without changing anything.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-action-durability-c08.test.ts
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
  f = await setupDurabilityFixture('UE');
});

after(async () => {
  if (f) await f.teardown();
});

function undo(actionId: string) {
  return f.as(f.requesterId, `/api/agent/actions/${actionId}/undo`, { method: 'POST' });
}

async function undoneAt(actionId: string) {
  const rows = await f.client.query('SELECT undone_at FROM agent_actions WHERE id = $1', [actionId]);
  return rows.rows[0]?.undone_at ?? null;
}

test('C08: undo of an action type without a reversal is refused and nothing is stamped', { skip: !canRun }, async () => {
  const taskId = await f.insertTask({ title: 'c08 due' });
  const actionId = await f.insertAction({
    action: 'set_due_date',
    params: { task_identifier: taskId, due_date: '2026-12-01' },
    result: { task_id: taskId },
    beforeState: { due_date: null },
    afterState: { due_date: '2026-12-01' },
  });
  const response = await undo(actionId);
  assert.equal(response.status, 400, await response.clone().text());
  const body = await response.json() as { code: string; error: string };
  assert.equal(body.code, 'UNDO_UNSUPPORTED');
  assert.equal(await undoneAt(actionId), null);
});

test('C08: close_task is undone through its status reversal', { skip: !canRun }, async () => {
  const taskId = await f.insertTask({ title: 'c08 close', status: 'done' });
  const actionId = await f.insertAction({
    action: 'close_task',
    params: { task_identifier: taskId },
    result: { task_id: taskId },
    beforeState: { status: 'in_review', task_id: taskId },
    afterState: { status: 'done', task_id: taskId },
  });
  const response = await undo(actionId);
  assert.equal(response.status, 200, await response.clone().text());
  const task = await f.client.query('SELECT status FROM tasks WHERE id = $1', [taskId]);
  assert.equal(task.rows[0].status, 'in_review');
  assert.notEqual(await undoneAt(actionId), null);
});

test('C08: undo of an action that did not run is refused', { skip: !canRun }, async () => {
  const messageId = await f.insertMessage('c08 never ran');
  const pending = await f.insertAction({
    action: 'post_message',
    params: { space_id: f.spaceId, content: 'x' },
    result: { message_id: messageId },
    status: 'pending',
    executed: false,
  });
  const failed = await f.insertAction({
    action: 'post_message',
    params: { space_id: f.spaceId, content: 'x' },
    result: { message_id: messageId },
    error: 'Action failed',
  });
  for (const actionId of [pending, failed]) {
    const response = await undo(actionId);
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal(((await response.json()) as { code: string }).code, 'UNDO_NOT_APPLICABLE');
    assert.equal(await undoneAt(actionId), null);
  }
  const message = await f.client.query('SELECT is_deleted FROM messages WHERE id = $1', [messageId]);
  assert.equal(message.rows[0].is_deleted, false);
});
