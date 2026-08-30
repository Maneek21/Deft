import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, test } from 'node:test';

import { APP_RUN_CONTRACT_VERSIONS, APP_RUN_LIMITS } from '@deft/shared';

import {
  AppRunKeyringConfigError,
  AppRunKeyVersionUnavailableError,
  assertAppRunReferencedKeysAvailable,
  parseEnvironmentAppRunKeyrings,
  validateAppRunKeyringEnvironment,
} from '../src/lib/app-run-keyrings.js';
import { AppRunSecretService } from '../src/lib/app-run-secrets.js';

function key(byte: number): string {
  return Buffer.alloc(32, byte).toString('base64');
}

function config(options: {
  encryptionCurrent?: string;
  encryptionKeys?: Record<string, string>;
  signingKeys?: Record<string, string>;
  fingerprintKeys?: Record<string, string>;
} = {}): string {
  return JSON.stringify({
    schema_version: APP_RUN_CONTRACT_VERSIONS.keyring,
    run_encryption: {
      current: options.encryptionCurrent ?? 'enc-v1',
      keys: options.encryptionKeys ?? { 'enc-v1': key(1) },
    },
    receipt_signing: {
      current: 'sig-v1',
      keys: options.signingKeys ?? { 'sig-v1': key(2) },
    },
    fingerprint: {
      current: 'fp-v1',
      keys: options.fingerprintKeys ?? { 'fp-v1': key(3) },
    },
  });
}

const inputContext = {
  org_id: 'org-1',
  run_id: 'run-1',
  payload_kind: 'input' as const,
};

describe('App Run keyring configuration', () => {
  test('is ignored while disabled and required while enabled', () => {
    assert.doesNotThrow(() => validateAppRunKeyringEnvironment(false, undefined));
    assert.throws(
      () => validateAppRunKeyringEnvironment(true, undefined),
      AppRunKeyringConfigError,
    );
    assert.doesNotThrow(() => validateAppRunKeyringEnvironment(true, config()));
  });

  test('rejects malformed, non-random-width, missing-current, duplicate, and cross-purpose key material', () => {
    assert.throws(() => parseEnvironmentAppRunKeyrings('{'), AppRunKeyringConfigError);
    assert.throws(() => parseEnvironmentAppRunKeyrings(config({
      encryptionKeys: { 'enc-v1': Buffer.alloc(31, 1).toString('base64') },
    })), AppRunKeyringConfigError);
    assert.throws(() => parseEnvironmentAppRunKeyrings(config({
      encryptionCurrent: 'missing',
    })), AppRunKeyringConfigError);
    assert.throws(() => parseEnvironmentAppRunKeyrings(config({
      encryptionKeys: { 'enc-v1': key(1), 'enc-v2': key(1) },
    })), AppRunKeyringConfigError);
    assert.throws(() => parseEnvironmentAppRunKeyrings(config({
      signingKeys: { 'sig-v1': key(1) },
    })), AppRunKeyringConfigError);
  });

  test('refuses key retirement while retained references need the removed version', () => {
    const provider = parseEnvironmentAppRunKeyrings(config());
    assert.doesNotThrow(() => assertAppRunReferencedKeysAvailable(provider, [
      { purpose: 'run_encryption', key_id: 'enc-v1' },
      { purpose: 'receipt_signing', key_id: 'sig-v1' },
      { purpose: 'fingerprint', key_id: 'fp-v1' },
    ]));
    assert.throws(() => assertAppRunReferencedKeysAvailable(provider, [
      { purpose: 'run_encryption', key_id: 'removed' },
    ]), AppRunKeyVersionUnavailableError);
    provider.destroy();
  });
});

describe('App Run Secret Service', () => {
  test('round-trips canonical JSON with randomized 96-bit nonces and an explicit safe projection', () => {
    const provider = parseEnvironmentAppRunKeyrings(config());
    const service = new AppRunSecretService(provider);
    const first = service.sealJson({ z: 1, nested: { b: 2, a: 'same' } }, inputContext);
    const second = service.sealJson({ nested: { a: 'same', b: 2 }, z: 1 }, inputContext);

    assert.notEqual(first.nonce_b64, second.nonce_b64);
    assert.notEqual(first.ciphertext_b64, second.ciphertext_b64);
    assert.deepEqual(service.openJson(first, inputContext), {
      nested: { a: 'same', b: 2 },
      z: 1,
    });
    assert.deepEqual(service.safeProjection(first), {
      schema_version: APP_RUN_CONTRACT_VERSIONS.secret_envelope,
      algorithm: 'aes-256-gcm',
      key_version: 'enc-v1',
      ciphertext_bytes: Buffer.from(first.ciphertext_b64, 'base64').length,
    });
    assert.equal('ciphertext_b64' in service.safeProjection(first), false);
    provider.destroy();
  });

  test('binds ciphertext to tenant, Run, payload kind, and attempt', () => {
    const provider = parseEnvironmentAppRunKeyrings(config());
    const service = new AppRunSecretService(provider);
    const envelope = service.sealJson({ secret: 'value' }, inputContext);
    for (const context of [
      { ...inputContext, org_id: 'other-org' },
      { ...inputContext, run_id: 'other-run' },
      { ...inputContext, payload_kind: 'output' as const, attempt_id: 'attempt-1' },
    ]) {
      assert.throws(() => service.openJson(envelope, context));
    }
    assert.throws(() => service.openJson({
      ...envelope,
      ciphertext_b64: Buffer.from(randomBytes(32)).toString('base64'),
    }, inputContext));
    assert.throws(() => service.openJson({ ...envelope, key_version: 'missing' }, inputContext),
      /APP_RUN_KEY_VERSION_UNAVAILABLE/);
    assert.throws(() => service.openJson({ ...envelope, nonce_b64: 'not-base64' }, inputContext));
    assert.throws(() => service.openJson({
      ...envelope,
      ciphertext_b64: 'A'.repeat(4 * Math.ceil(APP_RUN_LIMITS.output_bytes / 3) + 4),
    }, inputContext));
    provider.destroy();
  });

  test('reads an older encryption key after rotation and writes only with current', () => {
    const oldProvider = parseEnvironmentAppRunKeyrings(config());
    const oldService = new AppRunSecretService(oldProvider);
    const oldEnvelope = oldService.sealJson({ retained: true }, inputContext);
    oldProvider.destroy();

    const rotatedProvider = parseEnvironmentAppRunKeyrings(config({
      encryptionCurrent: 'enc-v2',
      encryptionKeys: { 'enc-v1': key(1), 'enc-v2': key(4) },
    }));
    const rotatedService = new AppRunSecretService(rotatedProvider);
    assert.deepEqual(rotatedService.openJson(oldEnvelope, inputContext), { retained: true });
    assert.equal(rotatedService.sealJson({ next: true }, inputContext).key_version, 'enc-v2');
    rotatedProvider.destroy();
  });

  test('domain-separates input and idempotency fingerprints and supports rotation candidates', () => {
    const provider = parseEnvironmentAppRunKeyrings(config({
      fingerprintKeys: { 'fp-v1': key(3), 'fp-old': key(5) },
    }));
    const service = new AppRunSecretService(provider);
    const input = service.fingerprintText('input', 'low-entropy');
    const replay = service.fingerprintText('idempotency', 'low-entropy');
    assert.notEqual(input.fingerprint, replay.fingerprint);
    assert.deepEqual(
      service.fingerprintTextCandidates('idempotency', 'low-entropy').map((item) => item.key_version),
      ['fp-v1', 'fp-old'],
    );
    assert.doesNotMatch(JSON.stringify(replay), /low-entropy/);
    assert.throws(
      () => service.fingerprintText('idempotency', 'é'.repeat(APP_RUN_LIMITS.idempotency_key_bytes)),
      /exceeds/,
    );
    provider.destroy();
  });

  test('signs safe receipts with a separate key and verifies in constant-shaped failure paths', () => {
    const provider = parseEnvironmentAppRunKeyrings(config());
    const service = new AppRunSecretService(provider);
    const receipt = { run_id: 'run-1', state: 'succeeded', output_envelope_digest: 'sha256:abc' };
    const signed = service.signReceipt(receipt);
    assert.equal(service.verifyReceipt(receipt, signed.key_version, signed.signature_hmac), true);
    assert.equal(service.verifyReceipt({ ...receipt, state: 'failed' }, signed.key_version, signed.signature_hmac), false);
    assert.equal(service.verifyReceipt(receipt, 'missing', signed.signature_hmac), false);
    assert.equal(service.verifyReceipt(receipt, signed.key_version, 'invalid'), false);
    provider.destroy();
  });

  test('zeroes provider-owned material on destroy and fails closed afterwards', () => {
    const provider = parseEnvironmentAppRunKeyrings(config());
    const before = provider.current('run_encryption');
    provider.destroy();
    assert.throws(() => provider.current('run_encryption'), AppRunKeyringConfigError);
    assert.notDeepEqual(before.key, Buffer.alloc(32));
    before.key.fill(0);
  });
});
