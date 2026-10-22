import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { randomUUID } from 'node:crypto';

let transactions = 0;
mock.module(new URL('../src/lib/db.ts', import.meta.url).href, { namedExports: { db: {
  transaction: async (work: any) => { transactions++; const query: any = { from: () => query, where: () => query,
    for: () => Promise.resolve([]) }; return work({ select: () => query }); },
} } });
const { appDataConsentConnections } = await import('../src/lib/app-data-consent-repair.js');

test('a fresh connected session without a repair lineage needs no empty database transaction', async () => {
  const session = { session_id: randomUUID(), state: 'connected', account: { account_ref: randomUUID() }, runtime_session_ref: 'runtime',
    scope: { org_id: randomUUID(), owner_user_id: randomUUID() } };
  transactions = 0;
  assert.deepEqual(await appDataConsentConnections(session as never), [session]);
  assert.equal(transactions, 0, 'the no-lineage branch must not issue BEGIN/COMMIT without a row read');
  for (const change of [{ state: 'disconnected' }, { account: null }, { runtime_session_ref: null }])
    await assert.rejects(appDataConsentConnections({ ...session, ...change } as never));
  assert.equal(transactions, 0);
  await assert.rejects(appDataConsentConnections({ ...session, credential_repair: { source: { session_id: randomUUID() } } } as never));
  assert.equal(transactions, 1, 'a repair still reads and validates the complete current lineage transaction');
});
