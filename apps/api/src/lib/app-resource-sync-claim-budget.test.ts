import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { resourceSyncClaimContext } from './app-resource-sync-claim-budget.js';
import type { createBoundedAppRunDatabase } from './app-run-bounded-db.js';

test('claim deadline rejects delayed pool acquisition before transaction work', async () => {
  let writes = 0;
  const database = { async transaction(work: (tx: never) => Promise<unknown>) {
    await delay(25); return work(undefined as never);
  } } as unknown as Pick<ReturnType<typeof createBoundedAppRunDatabase>, 'transaction'>;
  const context = resourceSyncClaimContext(database, { deadline: performance.now() + 5 });
  await assert.rejects(context.transaction(async () => { writes++; }), /TIMEOUT/);
  assert.equal(writes, 0);
});

test('claim deadline rejects delayed publication even when a database callback ignores its signal', async () => {
  let commits = 0;
  const database = { async transaction(work: (tx: never) => Promise<unknown>) {
    const value = await work(undefined as never); commits++; return value;
  } } as unknown as Pick<ReturnType<typeof createBoundedAppRunDatabase>, 'transaction'>;
  const context = resourceSyncClaimContext(database, { deadline: performance.now() + 5 });
  await assert.rejects(context.transaction(async () => { await delay(25); return { claim: 'late' }; }), /TIMEOUT/);
  assert.equal(commits, 0);
});

test('claim request abort remains closed before any transaction', async () => {
  const controller = new AbortController(); controller.abort();
  assert.throws(() => resourceSyncClaimContext({ transaction: async () => { throw Error('unexpected'); } }, { signal: controller.signal }));
});
