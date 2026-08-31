import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

import { APP_RUN_CONTRACT_VERSIONS } from '@deft/shared';

import { parseEnvironmentAppRunKeyrings } from '../src/lib/app-run-keyrings.js';
import { AppRunPreparedInputService } from '../src/lib/app-run-prepared-input.js';
import { AppRunSecretService } from '../src/lib/app-run-secrets.js';

function key(byte: number): string {
  return Buffer.alloc(32, byte).toString('base64');
}

function createSecrets(): Readonly<{
  provider: ReturnType<typeof parseEnvironmentAppRunKeyrings>;
  service: AppRunSecretService;
}> {
  const provider = parseEnvironmentAppRunKeyrings(JSON.stringify({
    schema_version: APP_RUN_CONTRACT_VERSIONS.keyring,
    run_encryption: { current: 'enc-v1', keys: { 'enc-v1': key(1) } },
    receipt_signing: { current: 'sig-v1', keys: { 'sig-v1': key(2) } },
    fingerprint: { current: 'fp-v1', keys: { 'fp-v1': key(3) } },
  }));
  return { provider, service: new AppRunSecretService(provider) };
}

const bindingIdentity = {
  app_installation_id: 'installation-1',
  app_version_id: 'version-1',
  grant_snapshot_id: 'grant-snapshot-1',
  binding_id: 'binding-1',
  binding_digest: `sha256:${'a'.repeat(64)}`,
} as const;

describe('App Run prepared input', () => {
  test('protects provider input without exposing plaintext and preserves replay and binding identity', () => {
    const { provider, service: secrets } = createSecrets();
    const preparedInputs = new AppRunPreparedInputService(secrets);
    const idempotencyKey = 'idem-customer-42-send-7';
    const replayIdentity = `sha256:${createHash('sha256').update(idempotencyKey).digest('hex')}`;
    const providerInput = {
      recipient: 'private-recipient@example.test',
      subject: 'Private quarterly subject',
      body: 'Private prepared message body',
    };

    try {
      const candidate = preparedInputs.protect({
        org_id: 'org-1',
        replay_identity: replayIdentity,
        binding_identity: bindingIdentity,
        provider_input: providerInput,
      });
      const opened = preparedInputs.open('org-1', candidate);

      assert.deepEqual(opened, {
        schema_version: candidate.schema_version,
        expires_at: candidate.expires_at,
        replay_identity: replayIdentity,
        binding_identity: bindingIdentity,
        provider_input: providerInput,
      });

      const ciphertextSerialization = JSON.stringify(candidate.sealed_payload);
      const candidateSerialization = JSON.stringify(candidate);
      for (const plaintext of [
        providerInput.recipient,
        providerInput.subject,
        providerInput.body,
        idempotencyKey,
      ]) {
        assert.doesNotMatch(ciphertextSerialization, new RegExp(plaintext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.doesNotMatch(candidateSerialization, new RegExp(plaintext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
    } finally {
      provider.destroy();
    }
  });

  test('rejects a tampered candidate identity and a different organization', () => {
    const { provider, service: secrets } = createSecrets();
    const preparedInputs = new AppRunPreparedInputService(secrets);

    try {
      const candidate = preparedInputs.protect({
        org_id: 'org-1',
        replay_identity: `sha256:${'b'.repeat(64)}`,
        binding_identity: bindingIdentity,
        provider_input: { body: 'authenticated input' },
      });

      assert.throws(() => preparedInputs.open('org-1', {
        ...candidate,
        candidate_id: 'different-candidate-id',
      }));
      assert.throws(() => preparedInputs.open('org-1', {
        ...candidate,
        expires_at: new Date(Date.parse(candidate.expires_at) + 60_000).toISOString(),
      }), /APP_RUN_PREPARED_INPUT_INVALID/);
      assert.throws(() => preparedInputs.open('org-2', candidate));
    } finally {
      provider.destroy();
    }
  });

  test('rejects a candidate once the injected clock reaches its expiry', () => {
    const { provider, service: secrets } = createSecrets();
    let now = new Date('2026-08-31T12:00:00.000Z');
    const preparedInputs = new AppRunPreparedInputService(secrets, () => now);

    try {
      const candidate = preparedInputs.protect({
        org_id: 'org-1',
        replay_identity: `sha256:${'c'.repeat(64)}`,
        binding_identity: bindingIdentity,
        provider_input: { body: 'short-lived input' },
      });
      assert.doesNotThrow(() => preparedInputs.open('org-1', candidate));

      now = new Date(candidate.expires_at);
      assert.throws(
        () => preparedInputs.open('org-1', candidate),
        /APP_RUN_PREPARED_INPUT_INVALID/,
      );
    } finally {
      provider.destroy();
    }
  });
});
