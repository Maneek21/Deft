/**
 * Lane W2-a2 — C10: undoing a task creation also removes the subtasks the
 * action created, in the same org.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-action-durability-c10.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  f = await setupDurabilityFixture('UT');
});

after(async () => {
  if (f) await f.teardown();
});

test('C10: undoing create_task soft-deletes the parent and the subtasks it created', { skip: !canRun }, async () => {
  const parentId = await f.insertTask({ title: 'c10 parent' });
  const childA = await f.insertTask({ title: 'c10 child a', parentId });
  const childB = await f.insertTask({ title: 'c10 child b', parentId });
  // A subtask a human added later is not part of the action and stays.
  const laterChild = await f.insertTask({ title: 'c10 later child', parentId });
  // A forged id outside the parent is never touched.
  const unrelated = await f.insertTask({ title: 'c10 unrelated' });
  const actionId = await f.insertAction({
    action: 'create_task',
    params: { title: 'c10 parent' },
    result: {
      task_id: parentId,
      subtasks: [{ id: childA, task_id: childA }, { id: childB, task_id: childB }, { id: unrelated }, { id: randomUUID() }],
    },
    afterState: { id: parentId, status: 'todo' },
  });

  const response = await f.as(f.requesterId, `/api/agent/actions/${actionId}/undo`, { method: 'POST' });
  assert.equal(response.status, 200, await response.clone().text());
  const rows = await f.client.query('SELECT id, is_deleted FROM tasks WHERE id = ANY($1::text[])',
    [[parentId, childA, childB, laterChild, unrelated]]);
  const deleted = new Map(rows.rows.map((row) => [row.id as string, row.is_deleted as boolean]));
  assert.equal(deleted.get(parentId), true);
  assert.equal(deleted.get(childA), true);
  assert.equal(deleted.get(childB), true);
  assert.equal(deleted.get(laterChild), false);
  assert.equal(deleted.get(unrelated), false);
});
