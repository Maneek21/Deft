import assert from 'node:assert/strict';
import test from 'node:test';
import { AppAttachmentSecretService } from '../src/lib/app-attachment-secrets.js';
import { appAttachmentClaimMatches, appAttachmentStageExpiresAt } from '../src/lib/app-attachment-policy.js';
import { parseEnvironmentAppRunKeyrings, AppRunKeyVersionUnavailableError } from '../src/lib/app-run-keyrings.js';

const key = (byte: number) => Buffer.alloc(32, byte).toString('base64');
function keys(rotated = false, retain = true) {
  return parseEnvironmentAppRunKeyrings(JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: { current: rotated ? 'e2' : 'e1', keys: { ...(retain ? { e1: key(1) } : {}), ...(rotated ? { e2: key(4) } : {}) } },
    receipt_signing: { current: 's1', keys: { s1: key(2) } },
    fingerprint: { current: rotated ? 'f2' : 'f1', keys: { ...(retain ? { f1: key(3) } : {}), ...(rotated ? { f2: key(5) } : {}) } },
  }));
}
const context = { org_id: crypto.randomUUID(), staging_id: crypto.randomUUID(), resource_binding_id: crypto.randomUUID(),
  checkpoint_id: crypto.randomUUID(), generation: 1, run_id: crypto.randomUUID(), attempt_id: crypto.randomUUID(),
  claim_token:crypto.randomUUID(),reservation_sequence:1,
  fingerprint_key_version: 'f1', parent_locator_hmac: '1'.repeat(64), parent_revision_hmac: '2'.repeat(64), attachment_key_hmac: '3'.repeat(64) };
const scope = { org_id: context.org_id, resource_binding_id: context.resource_binding_id, checkpoint_id: context.checkpoint_id };

test('binary and quarantine metadata authenticate every retained stage/parent tuple and separate payload domains', t => {
  const ring = keys(); t.after(() => ring.destroy());
  const service = new AppAttachmentSecretService(ring); const bytes = Buffer.from('secret attachment');
  const encrypted = service.sealBinary(bytes, context);
  assert.deepEqual(service.openBinary(encrypted, context), bytes);
  assert.ok(!encrypted.ciphertext.includes(bytes));
  const metadata = { filename: 'Literal <script>☃.csv', parent_resource_id: 'mail:1', parent_revision: 'r1' };
  const sealedMetadata = service.sealMetadata(metadata, context);
  assert.deepEqual(service.openMetadata(sealedMetadata, context), metadata);
  assert.throws(() => service.openMetadata(encrypted, context));
  assert.throws(() => service.openBinary(sealedMetadata, context));
  for (const name of ['org_id', 'staging_id', 'resource_binding_id', 'checkpoint_id', 'run_id', 'attempt_id','claim_token'] as const) {
    assert.throws(() => service.openBinary(encrypted, { ...context, [name]: crypto.randomUUID() }));
  }
  for (const name of ['parent_locator_hmac', 'parent_revision_hmac', 'attachment_key_hmac'] as const) {
    assert.throws(() => service.openBinary(encrypted, { ...context, [name]: '4'.repeat(64) }));
  }
  assert.throws(() => service.openBinary(encrypted, { ...context, generation: 2 }));
  assert.throws(() => service.openBinary(encrypted, { ...context, reservation_sequence:2 }));
  const changed = Buffer.from(encrypted.ciphertext); changed[0] ^= 1;
  assert.throws(() => service.openBinary({ ...encrypted, ciphertext: changed }, context));
  assert.throws(() => service.sealBinary(new Uint8Array(2_097_153), context));
});

test('retained encryption/fingerprint key rotation preserves original bytes and denies absent key versions', t => {
  const old = keys(), rotated = keys(true), missing = keys(true, false);
  t.after(() => { old.destroy(); rotated.destroy(); missing.destroy(); });
  const first = new AppAttachmentSecretService(old), next = new AppAttachmentSecretService(rotated), denied = new AppAttachmentSecretService(missing);
  const bytes = Buffer.from('original'); const sealed = first.sealBinary(bytes, context);
  assert.deepEqual(next.openBinary(sealed, context), bytes);
  assert.throws(() => denied.openBinary(sealed, context), AppRunKeyVersionUnavailableError);
  assert.deepEqual(next.fingerprint('content', bytes, scope, 'f1'), first.fingerprint('content', bytes, scope));
  assert.notEqual(first.fingerprint('content', bytes, scope).fingerprint, first.fingerprint('parent_body', bytes, scope).fingerprint);
  assert.notEqual(first.fingerprint('content', bytes, scope).fingerprint,
    first.fingerprint('content', bytes, { ...scope, org_id: crypto.randomUUID() }).fingerprint);
  assert.throws(() => denied.fingerprint('content', bytes, scope, 'f1'), AppRunKeyVersionUnavailableError);
});

test('fixed stage retention survives renewed same-claim lease without changing sequence or admitting a replacement claim', () => {
  const now = new Date('2026-09-27T00:00:00Z');
  const expiry = appAttachmentStageExpiresAt(now, new Date(now.getTime() + 7200_000), new Date(now.getTime() + 3600_000));
  assert.equal(expiry.getTime(), now.getTime() + 3600_000);
  const claim = { run_id: context.run_id, attempt_id: context.attempt_id, claim_token: crypto.randomUUID(), sequence: 7 };
  const current = { run_id: claim.run_id, id: claim.attempt_id, claim_token: claim.claim_token, runtime_sequence: 7,
    state: 'provider_call_started', lease_expires_at: new Date(now.getTime() + 60_000) };
  assert.equal(appAttachmentClaimMatches(claim, current, new Date(now.getTime() + 30_000)), true);
  assert.equal(appAttachmentClaimMatches(claim, { ...current, lease_expires_at: new Date(now.getTime() + 90_000) }, new Date(now.getTime() + 70_000)), true);
  assert.equal(appAttachmentClaimMatches(claim, { ...current, claim_token: crypto.randomUUID() }, now), false);
  assert.equal(appAttachmentClaimMatches({ ...claim, sequence: 8 }, current, now), false);
});
