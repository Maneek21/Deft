/**
 * The verifying side of `deft-seat-v1`: agrees with every published test
 * vector and refuses, never throws, on anything else.
 *
 * Run: pnpm --filter @deft/api test test/seat-statement.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPrivateKey, sign } from 'node:crypto';
import { test } from 'node:test';
import { verifySeatStatement } from '../src/lib/seat-statement.js';

type Vector = {
  name: string;
  token: string;
  public_keys: string[];
  expected_cell_id: string;
  now: number;
  version_floor: number;
  max_clock_skew_seconds: number;
  expect: unknown;
};

const vectors = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/seat-statement-v1.json'), 'utf8')) as {
  format: string;
  keys: { signing: { private_key: string; public_key: string } };
  cases: Vector[];
};

test('the fixture is the deft-seat-v1 vector file with 51 cases', () => {
  assert.equal(vectors.format, 'deft-seat-v1');
  assert.equal(vectors.cases.length, 51);
});

for (const vector of vectors.cases) {
  test(`vector ${vector.name}`, () => {
    const result = verifySeatStatement({
      token: vector.token,
      publicKeys: vector.public_keys,
      expectedCellId: vector.expected_cell_id,
      nowSeconds: vector.now,
      versionFloor: vector.version_floor,
      maxClockSkewSeconds: vector.max_clock_skew_seconds,
    });
    assert.deepEqual(result, vector.expect);
  });
}

const PKCS8_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex');
const key = createPrivateKey({
  key: Buffer.concat([PKCS8_HEADER, Buffer.from(vectors.keys.signing.private_key, 'base64url')]),
  format: 'der',
  type: 'pkcs8',
});
const publicKey = vectors.keys.signing.public_key;

function signPayload(payload: string): string {
  const input = `deft-seat-v1.${Buffer.from(payload, 'ascii').toString('base64url')}`;
  return `${input}.${sign(null, Buffer.from(input, 'ascii'), key).toString('base64url')}`;
}

const good = (overrides: Partial<Record<'cell_id' | 'seats' | 'version' | 'issued_at' | 'expires_at', string | number>> = {}) => {
  const s = { cell_id: 'cell-a', seats: 12, version: 4, issued_at: 1_800_000_000, expires_at: 1_800_086_400, ...overrides };
  return signPayload(`{"cell_id":"${s.cell_id}","seats":${s.seats},"version":${s.version},"issued_at":${s.issued_at},"expires_at":${s.expires_at}}`);
};
const base = { publicKeys: [publicKey], expectedCellId: 'cell-a', nowSeconds: 1_800_000_100, versionFloor: 0 };

test('each refusal reason, from statements signed here', () => {
  assert.deepEqual(verifySeatStatement({ ...base, token: good() }), {
    ok: true,
    statement: { cell_id: 'cell-a', seats: 12, version: 4, issued_at: 1_800_000_000, expires_at: 1_800_086_400 },
  });
  const token = good();
  const flipped = `${token.slice(0, -2)}${token.endsWith('AA') ? 'AQ' : 'AA'}`;
  assert.equal(verifySeatStatement({ ...base, token: flipped }).ok, false);
  assert.deepEqual(verifySeatStatement({ ...base, token: good(), publicKeys: ['Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc'] }), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifySeatStatement({ ...base, token: good({ cell_id: 'cell-b' }) }), { ok: false, reason: 'wrong_cell' });
  assert.deepEqual(verifySeatStatement({ ...base, token: good({ issued_at: 1_800_001_000, expires_at: 1_800_090_000 }) }), { ok: false, reason: 'not_yet_valid' });
  assert.deepEqual(verifySeatStatement({ ...base, nowSeconds: 1_800_086_400, token: good() }), { ok: false, reason: 'expired' });
  assert.deepEqual(verifySeatStatement({ ...base, versionFloor: 5, token: good() }), { ok: false, reason: 'stale_version' });
  assert.equal(verifySeatStatement({ ...base, versionFloor: 4, token: good() }).ok, true, 'a version equal to the floor is accepted');
  // Good signature, wrong form.
  assert.deepEqual(verifySeatStatement({ ...base, token: signPayload('{"cell_id":"cell-a","seats":12,"version":4,"issued_at":1800000000,"expires_at":1800086400,"x":1}') }), { ok: false, reason: 'malformed' });
  assert.deepEqual(verifySeatStatement({ ...base, token: signPayload('{"seats":12,"cell_id":"cell-a","version":4,"issued_at":1800000000,"expires_at":1800086400}') }), { ok: false, reason: 'malformed' });
  assert.deepEqual(verifySeatStatement({ ...base, token: good({ seats: '12.0' }) }), { ok: false, reason: 'malformed' });
});

test('anything at all is refused without throwing', () => {
  const odd: unknown[] = [undefined, null, 42, {}, [], '', 'deft-seat-v1', 'deft-seat-v1..', 'a.b.c', 'deft-seat-v1.e30=.AA', 'x'.repeat(5000), `${good()}.extra`, `${good()} `];
  for (const token of odd) {
    const result = verifySeatStatement({ ...base, token });
    assert.equal(result.ok, false);
  }
  assert.deepEqual(verifySeatStatement({ ...base, token: good(), publicKeys: [] }), { ok: false, reason: 'verifier_misconfigured' });
  assert.deepEqual(verifySeatStatement({ ...base, token: good(), publicKeys: ['not-a-key'] }), { ok: false, reason: 'verifier_misconfigured' });
  assert.deepEqual(verifySeatStatement({ ...base, token: good(), expectedCellId: '' }), { ok: false, reason: 'verifier_misconfigured' });
  assert.deepEqual(verifySeatStatement({ ...base, token: good(), nowSeconds: Number.NaN }), { ok: false, reason: 'verifier_misconfigured' });
  assert.equal(verifySeatStatement(null as never).ok, false);
});
