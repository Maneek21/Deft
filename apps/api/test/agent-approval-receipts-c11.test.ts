/**
 * Lane W2 approval recovery — C11.
 *
 * Every native write that runs after a manual web approval gets a signed
 * receipt, not only the task-creation and module families.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-approval-receipts-c11.test.ts
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
  f = await setupDurabilityFixture('RT');
});

after(async () => {
  if (f) await f.teardown();
});

test('C11: approving a task status change issues one signed receipt naming the approver', { skip: !canRun }, async () => {
  const taskId = randomUUID();
  const number = (await f.client.query(
    'SELECT COALESCE(max(number), 0) + 1 AS n FROM tasks WHERE project_id = $1', [f.projectId])).rows[0].n as number;
  await f.client.query(
    `INSERT INTO tasks (id, org_id, project_id, number, title, status, priority, created_by)
     VALUES ($1, $2, $3, $4, $5, 'todo', 'p2', $6)`,
    [taskId, f.orgId, f.projectId, number, `c11 ${randomUUID()}`, f.requesterId],
  );
  const actionId = await f.insertAction({
    action: 'update_task_status',
    params: { task_identifier: `${f.prefix}-${number}`, new_status: 'done' },
    status: 'pending',
    executed: false,
  });
  const response = await f.as(f.requesterId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  assert.equal(response.status, 200, await response.clone().text());
  const receipts = await f.client.query(
    'SELECT decision, approver_id, decision_reason FROM action_receipts WHERE action_id = $1', [actionId]);
  assert.equal(receipts.rows.length, 1);
  assert.equal(receipts.rows[0].decision, 'approved');
  assert.equal(receipts.rows[0].approver_id, f.requesterId);
  assert.equal(receipts.rows[0].decision_reason, null);

  const retry = await f.as(f.requesterId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  assert.equal(retry.status, 200, await retry.clone().text());
  const after = await f.client.query('SELECT count(*)::int AS n FROM action_receipts WHERE action_id = $1', [actionId]);
  assert.equal(after.rows[0].n, 1);
});
