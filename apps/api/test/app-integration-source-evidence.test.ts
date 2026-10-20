import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppIntegrationCapturePolicyV2InputSchema } from '../../../packages/app-kit/src/app-integration-source.js';
import { decodeAppSourceCaptureEvidence } from '../src/lib/app-integration-source-evidence.js';
import { appIntegrationSourceDigest, type AppIntegrationSourceSnapshot } from '../src/lib/app-integration-source.js';

const id = '00000000-0000-4000-8000-000000000001';
const body = 'The booking team confirmed this reusable handoff procedure and its delivery requirements.';
const nomination = { schema_version: 'deft.app_capture_nomination.v3', eligible: true, body,
  body_digest: appIntegrationSourceDigest(body), grouping_key: appIntegrationSourceDigest('booking-series'),
  source_title: 'Booking handoff', observed_at: '2026-10-20T11:59:00Z', completeness: { partial: true, attachments_processed: false } };
const snapshot = (value: unknown): AppIntegrationSourceSnapshot => ({
  publication: { observed_at: '2026-10-20T12:00:00Z' }, presentation: { metadata: { capture_nomination: JSON.stringify(value) } },
} as AppIntegrationSourceSnapshot);

test('neutral policy explicitly limits destination/history without accepting source authority or domain rules', () => {
  const policy = { schema_version: 'deft.app_capture_policy.v2', enabled: true,
    destination: { scope: 'user', space_id: null }, history_days: 30, expected_revision: 0 };
  assert.ok(AppIntegrationCapturePolicyV2InputSchema.safeParse(policy).success);
  assert.ok(AppIntegrationCapturePolicyV2InputSchema.safeParse({ ...policy, destination: { scope: 'space', space_id: id } }).success);
  for (const patch of [{ destination: { scope: 'org', space_id: null } }, { destination: { scope: 'user', space_id: id } },
    { owner_user_id: id }, { installation_id: id }, { history_days: 366 }, { expected_revision: -1 }, { eligibility_rules: [] }]) {
    assert.equal(AppIntegrationCapturePolicyV2InputSchema.safeParse({ ...policy, ...patch }).success, false);
  }
});
test('v3 evidence preserves exact source bytes, title, grouping and explicit completeness', () => {
  assert.deepEqual(decodeAppSourceCaptureEvidence(snapshot(nomination)), { eligible: true, body,
    body_digest: nomination.body_digest, grouping_key: nomination.grouping_key,
    source_title: nomination.source_title, observed_at: nomination.observed_at, partial: true, attachments_processed: false });
  assert.deepEqual(decodeAppSourceCaptureEvidence(snapshot({ ...nomination, eligible: false, reason: 'app_policy', body: undefined })), {
    eligible: false, reason: 'app_policy', source_title: nomination.source_title, observed_at: nomination.observed_at,
    partial: true, attachments_processed: false });
});
test('invalid digest, unknown version, future observation, malformed completeness and oversized body fail closed', () => {
  for (const patch of [{ body_digest: appIntegrationSourceDigest('changed') }, { schema_version: 'future' },
    { observed_at: '2026-10-21T00:00:00Z' }, { completeness: { partial: false, attachments_processed: true } }, { body: 'x'.repeat(16001) }]) {
    assert.throws(() => decodeAppSourceCaptureEvidence(snapshot({ ...nomination, ...patch })), /APP_INTEGRATION_CAPTURE_INVALID_NOMINATION/);
  }
  assert.throws(() => decodeAppSourceCaptureEvidence({ publication: {}, presentation: { metadata: { capture_nomination: '{' } } } as AppIntegrationSourceSnapshot), /INVALID_NOMINATION/);
  assert.throws(() => decodeAppSourceCaptureEvidence({ publication: {}, presentation: { metadata: { capture_nomination: ' '.repeat(98305) } } } as AppIntegrationSourceSnapshot), /INVALID_NOMINATION/);
});
test('known v1/v2 evidence remains with its bounded compatibility decoder', () => {
  const old = { schema_version: 'deft.app_capture_nomination.v1', eligible: false, sender: '', received_at: null,
    is_bulk: false, partial: true, attachments_processed: false };
  assert.equal(decodeAppSourceCaptureEvidence(snapshot(old)), null);
  assert.equal(decodeAppSourceCaptureEvidence(snapshot({ ...old, schema_version: 'deft.app_capture_nomination.v2',
    eligible: true, body, body_digest: nomination.body_digest, thread_key: nomination.grouping_key, folders: [] })), null);
});
