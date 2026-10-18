import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { parseEnvironmentAppRunKeyrings, AppRunKeyVersionUnavailableError } from '../src/lib/app-run-keyrings.js';
import { AppRunSecretService } from '../src/lib/app-run-secrets.js';
import { AppResourceSyncSecretService } from '../src/lib/app-resource-sync-secrets.js';

const key = (byte: number) => Buffer.alloc(32, byte).toString('base64');
function keyring(rotated = false, retainOld = true) {
  return parseEnvironmentAppRunKeyrings(JSON.stringify({ schema_version: 'deft.app_run_keyring.v1',
    run_encryption: { current: rotated ? 'e2' : 'e1', keys: {
      ...(retainOld ? { e1: key(1) } : {}), ...(rotated ? { e2: key(4) } : {}),
    } },
    receipt_signing: { current: 's1', keys: { s1: key(2) } },
    fingerprint: { current: rotated ? 'f2' : 'f1', keys: {
      ...(retainOld ? { f1: key(3) } : {}), ...(rotated ? { f2: key(5) } : {}),
    } },
  }));
}
const base = { org_id: randomUUID(), resource_binding_id: randomUUID(), checkpoint_id: randomUUID() };
const projection = { ...base, payload_kind: 'projection' as const, generation: 1,
  projection_id: randomUUID(), slot: 'record' as const };
const cursorContext = { ...base, payload_kind: 'cursor' as const, generation: 1, cursor_sequence: 0 };

test('sync encrypted records reject tenant, binding, checkpoint, generation and record substitution', (t) => {
  const keys = keyring(); t.after(() => keys.destroy());
  const service = new AppResourceSyncSecretService(keys);
  const value = { provider_id: 'mail-1', revision: 'r1', data: { subject: 'Private subject', body: 'Private body' } };
  const envelope = service.sealJson(value, projection);
  assert.deepEqual(service.openJson(envelope, projection), value);
  assert.notEqual(service.sealJson(value, projection).nonce_b64, envelope.nonce_b64);
  assert.ok(!JSON.stringify(envelope).includes('Private'));
  for (const field of ['org_id', 'resource_binding_id', 'checkpoint_id', 'projection_id'] as const) {
    assert.throws(() => service.openJson(envelope, { ...projection, [field]: randomUUID() }));
  }
  assert.throws(() => service.openJson(envelope, { ...projection, generation: 2 }));
  assert.throws(() => service.openJson(envelope, { ...projection, slot: 'provider_id' }));
  const idContext = { ...projection, slot: 'provider_id' as const };
  const encryptedId = service.sealJson('mail-1', idContext);
  assert.equal(service.openJson(encryptedId, idContext), 'mail-1');
  assert.throws(() => service.openJson(encryptedId, projection));
  assert.throws(() => service.sealJson({ provider_id: 'mail-1' }, idContext));
  assert.throws(() => service.openJson(envelope, cursorContext));
  const changed = Buffer.from(envelope.ciphertext_b64, 'base64'); changed[0] = changed[0]! ^ 1;
  assert.throws(() => service.openJson({ ...envelope, ciphertext_b64: changed.toString('base64') }, projection));
  assert.throws(() => service.openJson({ ...envelope, owner_id: randomUUID() }, projection));
});

test('sync cursor authentication includes sequence and enforces raw UTF-8 and JSON ceilings', (t) => {
  const keys = keyring(); t.after(() => keys.destroy());
  const service = new AppResourceSyncSecretService(keys);
  for (const value of [null, '🙂'.repeat(512), '"'.repeat(2048)]) {
    const envelope = service.sealJson(value, cursorContext);
    assert.equal(service.openJson(envelope, cursorContext), value);
    assert.throws(() => service.openJson(envelope, { ...cursorContext, cursor_sequence: 1 }));
  }
  for (const value of ['', '🙂'.repeat(513), '\ud800', 'line\n', { cursor: 'nested' }]) {
    assert.throws(() => service.sealJson(value, cursorContext));
  }
  assert.doesNotThrow(() => service.sealJson('x'.repeat(524286), projection));
  assert.throws(() => service.sealJson('x'.repeat(524287), projection));
});

test('sync secrets and fingerprints are domain separated from existing Run data', (t) => {
  const keys = keyring(); t.after(() => keys.destroy());
  const service = new AppResourceSyncSecretService(keys);
  const runs = new AppRunSecretService(keys);
  const runContext = { org_id: base.org_id, run_id: base.checkpoint_id, payload_kind: 'input' as const };
  assert.throws(() => runs.openJson(service.sealJson('cursor-1', cursorContext), runContext));
  assert.throws(() => service.openJson(runs.sealJson('cursor-1', runContext), cursorContext));
  const locator = service.locator('mail-1', base);
  assert.notEqual(locator.fingerprint, runs.fingerprintJson('input', [base, 'mail-1']).fingerprint);
  assert.notEqual(locator.fingerprint, service.cursorFingerprint('mail-1', cursorContext).fingerprint);
  assert.notEqual(locator.fingerprint, service.locator('mail-1', { ...base, org_id: randomUUID() }).fingerprint);
  assert.notEqual(locator.fingerprint, service.locator('mail-1', { ...base, resource_binding_id: randomUUID() }).fingerprint);
  assert.notEqual(locator.fingerprint, service.locator('mail-1', { ...base, checkpoint_id: randomUUID() }).fingerprint);
  assert.notEqual(service.cursorFingerprint(null, cursorContext).fingerprint,
    service.cursorFingerprint(null, { ...cursorContext, cursor_sequence: 1 }).fingerprint);
});

test('sync retained-key rotation preserves locator discovery and refuses missing prior key versions', (t) => {
  const oldKeys = keyring(); const newKeys = keyring(true); const retiredKeys = keyring(true, false);
  t.after(() => { oldKeys.destroy(); newKeys.destroy(); retiredKeys.destroy(); });
  const oldService = new AppResourceSyncSecretService(oldKeys);
  const next = new AppResourceSyncSecretService(newKeys);
  const retired = new AppResourceSyncSecretService(retiredKeys);
  const oldLocator = oldService.locator('mail-1', base);
  const candidates = next.locatorCandidates('mail-1', base, [oldLocator.key_version]);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.find((item) => item.key_version === 'f1'), oldLocator);
  assert.deepEqual(candidates.find((item) => item.key_version === 'f2'), next.locator('mail-1', base));
  assert.notEqual(next.locator('mail-1', base).fingerprint, next.locator('mail-2', base).fingerprint);
  assert.deepEqual(next.cursorFingerprint('cursor-1', cursorContext, 'f1'),
    oldService.cursorFingerprint('cursor-1', cursorContext));
  const sealed = oldService.sealJson({ data: 'original' }, projection);
  assert.deepEqual(next.openJson(sealed, projection), { data: 'original' });
  assert.throws(() => retired.openJson(sealed, projection), AppRunKeyVersionUnavailableError);
  assert.throws(() => retired.locatorCandidates('mail-1', base, ['f1']), AppRunKeyVersionUnavailableError);
  assert.throws(() => next.locatorCandidates('mail-1', base, ['unknown']), AppRunKeyVersionUnavailableError);
  assert.throws(() => retired.cursorFingerprint(null, cursorContext, 'f1'), AppRunKeyVersionUnavailableError);
});
