import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { parseEnvironmentAppRunKeyrings } from '../src/lib/app-run-keyrings.js';
import { sealExposureToken } from '../src/lib/app-experience-exposure-contract.js';
import { HistoricalCreatePolicySchema, PublicCancellationReviewTokenSchema,
  sealPublicCancellationReview, openPublicCancellationReview } from '../src/lib/app-public-cancellation-contract.js';

const digest = `sha256:${'a'.repeat(64)}`;
test('public cancellation owner review token retains key versions across instances and rejects tampering or another audience', () => {
  const rings = Object.fromEntries(['run_encryption', 'receipt_signing', 'fingerprint'].map(purpose =>
    [purpose, { old: randomBytes(32).toString('base64'), fresh: randomBytes(32).toString('base64') }]));
  const keys = (current: string) => parseEnvironmentAppRunKeyrings(JSON.stringify({
    schema_version: 'deft.app_run_keyring.v1', ...Object.fromEntries(['run_encryption', 'receipt_signing', 'fingerprint']
      .map(purpose => [purpose, { current, keys: rings[purpose] }])),
  }));
  const snapshot = PublicCancellationReviewTokenSchema.parse({
    schema_version: 'deft.app_public_cancellation_owner_review_token.v1',
    org_id: randomUUID(), cancellation_id: randomUUID(), original_run_id: randomUUID(), owner_user_id: randomUUID(),
    native_binding_id: randomUUID(), consent_digest: digest, proposal_digest: digest,
    app_version_id: randomUUID(), grant_snapshot_id: randomUUID(), input_digest: digest,
    output_digest: digest, session_scope_digest: digest,
    issued_at: '2026-09-27T00:00:00.000Z', expires_at: '2026-09-27T00:05:00.000Z',
  });
  const token = sealPublicCancellationReview(keys('old'), snapshot);
  assert.deepEqual(openPublicCancellationReview(keys('fresh'), token), snapshot);
  assert.throws(() => openPublicCancellationReview(keys('fresh'), sealExposureToken(keys('old'), 'review', snapshot)));
  const [payload, mac] = token.split('.');
  assert.throws(() => openPublicCancellationReview(keys('fresh'), `${payload}.${mac![0] === 'A' ? 'B' : 'A'}${mac!.slice(1)}`));
  assert.throws(() => openPublicCancellationReview(keys('fresh'), `${Buffer.from(JSON.stringify({
    key_version: 'old', value: { ...snapshot, owner_user_id: randomUUID() },
  })).toString('base64url')}.${mac}`));
  assert.throws(() => PublicCancellationReviewTokenSchema.parse({ ...snapshot, expires_at: '2026-09-27T00:05:00.001Z' }));
});
test('historical Calendar-create consent has exactly bounded unique version and grant pins', () => {
  const pin = () => ({ app_version_id: randomUUID(), package_digest: digest,
    grant_snapshot_id: randomUUID(), grant_snapshot_digest: digest });
  const creates = Array.from({ length: 16 }, pin);
  assert.equal(HistoricalCreatePolicySchema.parse({ schema_version: 'deft.app_native_historical_create_policy.v1', creates }).creates.length, 16);
  assert.throws(() => HistoricalCreatePolicySchema.parse({ schema_version: 'deft.app_native_historical_create_policy.v1', creates: [...creates, pin()] }));
  assert.throws(() => HistoricalCreatePolicySchema.parse({ schema_version: 'deft.app_native_historical_create_policy.v1', creates: [creates[0], creates[0]] }));
});
