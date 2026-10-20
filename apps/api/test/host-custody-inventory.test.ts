import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listHostCustodyKeyReferences, type HostCustodyInventoryProvider } from '../src/lib/host-custody-inventory.js';
import { assertAppRunReferencedKeysAvailable, AppRunKeyVersionUnavailableError } from '../src/lib/app-run-keyrings.js';

const tx = { execute: async () => { throw new Error('unexpected query'); } };
const org = '00000000-0000-4000-8000-000000000001';
const retained = { purpose: 'run_encryption', key_id: 'retained-v1' } as const;

test('all trusted owners participate with exact org scope; duplicate references retain one identity', async () => {
  const calls: Array<string | undefined> = [];
  const providers: HostCustodyInventoryProvider[] = ['bookings', 'history'].map(id => ({
    id, listReferences: async (receivedTx, orgId) => {
      assert.equal(receivedTx, tx); calls.push(orgId); return [retained];
    },
  }));
  assert.deepEqual(await listHostCustodyKeyReferences(tx, providers, org), [retained]);
  assert.deepEqual(calls, [org, org]);
  calls.length = 0;
  await listHostCustodyKeyReferences(tx, providers);
  assert.deepEqual(calls, [undefined, undefined]);
});

test('provider failure, malformed reference and duplicate registration fail closed', async () => {
  const good: HostCustodyInventoryProvider = { id: 'retained', listReferences: async () => [retained] };
  await assert.rejects(listHostCustodyKeyReferences(tx, [good, { id: 'offline', listReferences: async () => { throw new Error('offline'); } }]), /offline/);
  await assert.rejects(listHostCustodyKeyReferences(tx, [good, good]), /HOST_CUSTODY_PROVIDER_INVALID/);
  await assert.rejects(listHostCustodyKeyReferences(tx, [{ id: 'invalid', listReferences: async () => [{ ...retained, key_id: '' }] }]));
  await assert.rejects(listHostCustodyKeyReferences(tx, [good], 'invalid-org'));
});

test('retained owner references refuse unavailable key versions even when no app is running', async () => {
  const references = await listHostCustodyKeyReferences(tx, [{ id: 'retained', listReferences: async () => [retained] }]);
  assert.throws(() => assertAppRunReferencedKeysAvailable({
    current: () => { throw new Error('unused'); }, read: () => null, keyIds: () => [],
  }, references), AppRunKeyVersionUnavailableError);
});
