import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCurrentUpgradeRowPins } from '../src/lib/app-upgrade-row-pins.js';
import { digestAppGrantValue } from '../src/lib/app-grant-service.js';

const rowDigest = (row: unknown) => digestAppGrantValue(JSON.parse(JSON.stringify(row)));

const now = 1000000;
const rows = () => [
  { id: 'second', state: 'active', expires_at: new Date(now + 10000), snapshot: {} },
  { id: 'first', state: 'active', expires_at: new Date(now + 10000), snapshot: {} },
];

test('current unlocked pins batch exact rows and still reject missing, duplicate, stale, revoked and expired evidence', async () => {
  const original = rows(), pins = original.map(row => ({ id: row.id, digest: rowDigest(row) }));
  for (const scenario of ['valid', 'missing', 'duplicate', 'extra', 'changed', 'revoked', 'expired', 'wrong_id', 'duplicate_pin']) {
    const current = rows(), calls: { ids: readonly string[]; share: boolean }[] = [];
    if (scenario === 'missing') current.pop();
    if (scenario === 'duplicate') current[1] = current[0]!;
    if (scenario === 'extra') current.push({ ...current[0]!, id: 'extra' });
    if (scenario === 'changed') current[0]!.snapshot = { changed: true } as {};
    if (scenario === 'revoked') current[0]!.state = 'revoked';
    if (scenario === 'wrong_id') current[0]!.id = 'foreign';
    const nominated = scenario === 'duplicate_pin' ? [pins[0]!, pins[0]!] : pins;
    const read = async (ids: readonly string[], share: boolean) => { calls.push({ ids, share }); return [...current].reverse(); };
    const run = () => assertCurrentUpgradeRowPins({ pins: nominated, issuance: false, id: row => row.id, digest: rowDigest,
      read, denied: () => Error('denied'), now: () => scenario === 'expired' ? now + 10000 : now });
    if (scenario === 'valid') await run(); else await assert.rejects(run(), /denied/, scenario);
    assert.equal(calls.length, scenario === 'duplicate_pin' ? 0 : 1, scenario);
    if (calls.length) assert.deepEqual(calls[0], { ids: pins.map(pin => pin.id), share: false });
  }
});

test('issuance preserves existing per-pin share-lock order and stops at the first changed row', async () => {
  const current = rows(), pins = current.map(row => ({ id: row.id, digest: rowDigest(row) })), calls: unknown[] = [];
  const read = async (ids: readonly string[], share: boolean) => { calls.push({ ids, share }); return current.filter(row => ids.includes(row.id)); };
  const run = () => assertCurrentUpgradeRowPins({ pins, issuance: true, id: row => row.id, digest: rowDigest,
    read, denied: () => Error('denied'), now: () => now });
  await run(); assert.deepEqual(calls, pins.map(pin => ({ ids: [pin.id], share: true })));
  calls.length = 0; current[0]!.state = 'revoked';
  await assert.rejects(run(), /denied/); assert.deepEqual(calls, [{ ids: [pins[0]!.id], share: true }]);
});
