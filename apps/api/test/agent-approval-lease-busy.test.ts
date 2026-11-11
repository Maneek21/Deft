/**
 * Lane W2 approval recovery — busy execution-lease pool.
 *
 * When every advisory connection is in use (for example by long plans), an
 * approval answers promptly with the retryable busy reply and changes
 * nothing, and the maintenance sweep skips its run instead of waiting.
 *
 * Run only against a disposable DB:
 *   pnpm --filter @deft/api test test/agent-approval-lease-busy.test.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import { withDbAdvisoryLease } from '../src/lib/db.js';
import { recoverInterruptedApprovals } from '../src/lib/agent-action-execution-lease.js';
import { isApprovalResolverAction } from '../src/lib/agent-approval-resolver.js';
import { APP_DATABASE_POOL_BUDGET } from '../src/lib/app-database-pool-budget.js';
import {
  durabilityDatabaseUrl,
  setupDurabilityFixture,
  type DurabilityFixture,
} from './fixtures/agent-action-durability-fixture.js';

const canRun = Boolean(durabilityDatabaseUrl);
let f: DurabilityFixture;

before(async () => {
  if (!canRun) return;
  f = await setupDurabilityFixture('LB');
});

after(async () => {
  if (f) await f.teardown();
});

/** Occupy every advisory connection until the returned release is called. */
async function occupyAdvisoryPool(): Promise<() => Promise<void>> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holders: Array<Promise<unknown>> = [];
  let started = 0;
  for (let i = 0; i < APP_DATABASE_POOL_BUDGET.advisory; i += 1) {
    holders.push(withDbAdvisoryLease(`lease-busy-holder:${randomUUID()}`, { wait: true }, async () => {
      started += 1;
      await gate;
    }));
  }
  while (started < APP_DATABASE_POOL_BUDGET.advisory) await new Promise((resolve) => setTimeout(resolve, 10));
  return async () => { release(); await Promise.all(holders); };
}

function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} did not return within ${ms}ms`)), ms)),
  ]);
}

test('lease-busy: an approval returns the busy answer promptly when no advisory connection is free', { skip: !canRun }, async () => {
  const projectName = (await f.client.query('SELECT name FROM projects WHERE id = $1', [f.projectId])).rows[0].name;
  const actionId = await f.insertAction({
    action: 'create_task',
    params: { title: `lease busy ${randomUUID()}`, project_name: projectName },
    status: 'pending',
    executed: false,
  });
  const interrupted = await f.insertAction({
    action: 'update_task_status',
    params: { task_identifier: `${f.prefix}-1`, new_status: 'done' },
    status: 'approved',
    executed: false,
    result: { lifecycle_state: 'executing' },
  });
  await f.client.query(
    "UPDATE agent_actions SET approved_by_user_id = $2, approved_at = now() - interval '1 hour' WHERE id = $1",
    [interrupted, f.requesterId],
  );
  const snapshot = async (id: string) => (await f.client.query(
    'SELECT approval_status, approved_at::text, approved_by_user_id, result, error, executed_at FROM agent_actions WHERE id = $1',
    [id],
  )).rows[0];
  const before = await snapshot(actionId);
  const interruptedBefore = await snapshot(interrupted);

  const releasePool = await occupyAdvisoryPool();
  try {
    const response = await within(
      Promise.resolve(f.as(f.requesterId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' })),
      10_000,
      'the approve request',
    );
    // A retryable refusal, not "executing": the card puts its approve and
    // reject controls back, and nothing was claimed.
    assert.equal(response.status, 503, await response.clone().text());
    assert.equal(response.headers.get('retry-after'), '3');
    const body = await response.json() as { error?: string; code?: string };
    assert.equal(body.code, 'APPROVAL_BUSY');
    assert.equal(typeof body.error, 'string');
    assert.deepEqual(await snapshot(actionId), before);

    const sweep = await within(
      recoverInterruptedApprovals({ isResolverAction: isApprovalResolverAction, batchSize: 100 }),
      5_000,
      'the maintenance sweep',
    );
    assert.equal(sweep.recovered, 0);
    assert.equal(sweep.poolBusy, true);
    assert.deepEqual(await snapshot(interrupted), interruptedBefore);
  } finally {
    await releasePool();
  }

  // A timed-out wait did not keep a connection: the whole pool is usable again.
  const reacquired = await within(occupyAdvisoryPool(), 5_000, 'reacquiring every advisory connection');
  await reacquired();

  // Once the pool frees, the same approval goes through.
  const retried = await f.as(f.requesterId, `/api/agent/actions/${actionId}/approve`, { method: 'POST' });
  assert.equal(retried.status, 200, await retried.clone().text());
  assert.equal((await snapshot(actionId)).approval_status, 'approved');
});
