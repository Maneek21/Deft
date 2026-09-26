import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { framePublicHmacClaim, signPublicHmacClaim } from '../src/public-hmac.js';

const input = { slug: 'a'.repeat(43), endpoint_epoch: 2, key_id: 'key-v1', timestamp: '1800000000',
  nonce: '01'.repeat(32), body: new TextEncoder().encode('{ "value":"é" }\n') };
test('public HMAC v1 external signer frames original UTF8 bytes and every authority pin unambiguously', async () => {
  const frame = framePublicHmacClaim(input); const fields: string[] = []; let offset = 0;
  const bytes = Buffer.from(frame);
  while (offset < bytes.length) { const length = bytes.readUInt32BE(offset); offset += 4;
    fields.push(bytes.subarray(offset, offset + length).toString('utf8')); offset += length; }
  assert.deepEqual(fields, ['deft.app_public_hmac.v1', 'POST', `/api/public/apps/${input.slug}/claims`,
    '2', 'key-v1', '1800000000', input.nonce, '{ "value":"é" }\n']);
  const secret = new Uint8Array(32).fill(7);
  const headers = await signPublicHmacClaim(secret, input);
  assert.equal(headers['x-deft-public-signature'], `sha256=${createHmac('sha256', secret).update(frame).digest('hex')}`);
  for (const altered of [{ ...input, endpoint_epoch: 3 }, { ...input, key_id: 'key-v2' },
    { ...input, slug: 'b'.repeat(43) }, { ...input, timestamp: '1800000001' },
    { ...input, nonce: '02'.repeat(32) }, { ...input, body: new TextEncoder().encode('{"value":"é"}') }]) {
    assert.notEqual((await signPublicHmacClaim(secret, altered))['x-deft-public-signature'], headers['x-deft-public-signature']);
  }
});
test('public HMAC signer rejects noncanonical timestamp nonce key epoch and overlarge raw body', () => {
  for (const altered of [{ ...input, timestamp: '01800000000' }, { ...input, timestamp: '+1800000000' },
    { ...input, nonce: 'AB'.repeat(32) }, { ...input, nonce: '01'.repeat(31) },
    { ...input, key_id: 'key/v1' }, { ...input, endpoint_epoch: 0 },
    { ...input, body: new Uint8Array(8193) }]) assert.throws(() => framePublicHmacClaim(altered));
});
