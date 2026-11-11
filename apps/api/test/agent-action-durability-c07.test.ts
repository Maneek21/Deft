/**
 * Lane W2-a2 — approval execution durability.
 *
 * C07  an approval interrupted after its claim does not stay `executing`
 *      forever: after the lease expires a later approve (or the maintenance
 *      sweep) re-executes an idempotent creation, and marks anything else
 *      failed with a clear message.
 *      Relies on C06 (task creation idempotent per action).
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-action-durability-c07.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import {
  AGENT_ACTION_EXECUTION_LEASE_MS,
  recoverStaleAgentActionExecutions,
} from '../src/lib/agent-action-execution-lease.js';
import {
  durabilityDatabaseUrl,
  setupDurabilityFixture,
  type DurabilityFixture,
} from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
let f: DurabilityFixture;

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('EX');
});

after(async () => {
  if (f) await f.teardown();
});

function staleStartedAt(): string {
  return new Date(Date.now() - AGENT_ACTION_EXECUTION_LEASE_MS - 60_000).toISOString();
}

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

// ─── C07 ─────────────────────────────────────────────────────────────────────

test('C07: a fresh executing claim still answers 202 and is not taken over', { skip: !canRun }, async () => {
  const actionId = await f.insertAction({
    action: 'create_task',
    params: { title: `c07 fresh ${randomUUID()}`, project_name: await projectName() },
    result: { lifecycle_state: 'executing', started_at: new Date().toISOString() },
    executed: false,
  });
  const response = await f.as(f.requesterId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  assert.equal(response.status, 202);
  assert.equal((await actionRow(actionId)).result.lifecycle_state, 'executing');
});

test('C07: a stale executing task creation is taken over by the next approve and executes once', { skip: !canRun }, async () => {
  const title = `c07 stale create ${randomUUID()}`;
  const actionId = await f.insertAction({
    action: 'create_task',
    params: { title, project_name: await projectName() },
    result: { lifecycle_state: 'executing', started_at: staleStartedAt() },
    executed: false,
  });
  const response = await f.as(f.requesterId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as { success: boolean; result: { task_id: string } };
  assert.equal(body.success, true);
  const row = await actionRow(actionId);
  assert.equal(row.approval_status, 'approved');
  assert.equal(row.result.task_id, body.result.task_id);
  assert.notEqual(row.executed_at, null);
  assert.equal(await tasksTitled(title), 1);
});

test('C07: a stale executing non-idempotent write is marked failed, not re-run, and stops answering 202', { skip: !canRun }, async () => {
  const content = `c07 stale post ${randomUUID()}`;
  const actionId = await f.insertAction({
    action: 'post_message',
    params: { space_id: f.spaceId, content },
    result: { lifecycle_state: 'executing', started_at: staleStartedAt() },
    executed: false,
  });
  const response = await f.as(f.requesterId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  assert.equal(response.status, 409, await response.clone().text());
  const body = await response.json() as { error: string; code: string };
  assert.equal(body.code, 'EXECUTION_INTERRUPTED');
  const row = await actionRow(actionId);
  assert.equal(row.approval_status, 'approved');
  assert.match(row.error ?? '', /interrupted/i);
  assert.notEqual(row.result.lifecycle_state, 'executing');
  const posted = await f.client.query('SELECT count(*)::int AS n FROM messages WHERE org_id = $1 AND content = $2', [f.orgId, content]);
  assert.equal(posted.rows[0].n, 0, 'an interrupted non-idempotent write must not be re-executed');

  const again = await f.as(f.requesterId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  assert.notEqual(again.status, 202);
});

test('C07: the maintenance sweep recovers stale executing rows and leaves fresh ones', { skip: !canRun }, async () => {
  const stalePost = await f.insertAction({
    action: 'post_message',
    params: { space_id: f.spaceId, content: 'sweep post' },
    result: { lifecycle_state: 'executing', started_at: staleStartedAt() },
    executed: false,
  });
  const staleCreate = await f.insertAction({
    action: 'create_task',
    params: { title: `c07 sweep ${randomUUID()}`, project_name: await projectName() },
    result: { lifecycle_state: 'executing', started_at: staleStartedAt() },
    executed: false,
  });
  const fresh = await f.insertAction({
    action: 'post_message',
    params: { space_id: f.spaceId, content: 'fresh post' },
    result: { lifecycle_state: 'executing', started_at: new Date().toISOString() },
    executed: false,
  });

  const recovered = await recoverStaleAgentActionExecutions();
  assert.ok(recovered >= 2);

  const post = await actionRow(stalePost);
  assert.equal(post.approval_status, 'approved');
  assert.match(post.error ?? '', /interrupted/i);
  assert.notEqual(post.executed_at, null);

  const create = await actionRow(staleCreate);
  assert.equal(create.approval_status, 'pending', 'an idempotent creation returns to pending so it can be approved again');
  assert.equal(create.result.retryable, true);
  assert.match(create.error ?? '', /interrupted/i);

  assert.equal((await actionRow(fresh)).result.lifecycle_state, 'executing');
});
