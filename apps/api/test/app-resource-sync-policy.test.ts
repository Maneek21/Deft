import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  AppResourceSyncConsentRequestSchema, AppResourceSyncConsentActivationSchema,
  assertResourceSyncConsentWindow, hashAppResourceSyncToken,
} from '../src/lib/app-resource-sync-policy.js';
import { hashAppRuntimeToken } from '../src/lib/app-runtime-authority.js';

const request = () => ({ installation_id: randomUUID(), resource_key: 'inbox',
  operator_user_id: randomUUID(), expected_app_version_id: randomUUID(),
  expected_package_digest: `sha256:${'1'.repeat(64)}`,
  expected_grant_snapshot_digest: `sha256:${'2'.repeat(64)}`,
  expected_lifecycle_epoch: 1, expected_grant_epoch: 1,
  consent_expires_at: '2026-10-01T00:00:00.000Z',
  limits: { max_records_per_page: 100, max_page_bytes: 524_288,
    max_retained_records: 100_000, max_retained_bytes: 1_073_741_824,
    min_interval_seconds: 60 } });

test('resource consent cannot supply ownership, provider authority or unbounded capacity', () => {
  assert.ok(AppResourceSyncConsentRequestSchema.parse(request()));
  for (const extra of [{ owner_user_id: randomUUID() }, { visibility: 'organization' },
    { provider_url: 'https://example.test' }, { host_policy: { retry_class: 'safe' } },
    { descriptor: {} }, { reviewed_at: '2026-09-24T00:00:00Z' }]) {
    assert.throws(() => AppResourceSyncConsentRequestSchema.parse({ ...request(), ...extra }));
  }
  for (const extra of [{ max_records_per_page: 101 }, { max_page_bytes: 524_289 },
    { max_retained_records: 100_001 }, { max_retained_bytes: 1_073_741_825 },
    { min_interval_seconds: 59 }, { max_page_bytes: 1.5 }]) {
    const value = request();
    assert.throws(() => AppResourceSyncConsentRequestSchema.parse({ ...value,
      limits: { ...value.limits, ...extra } }));
  }
  assert.throws(() => AppResourceSyncConsentActivationSchema.parse(request()));
  assert.throws(() => AppResourceSyncConsentActivationSchema.parse({ ...request(),
    expected_review_digest: `sha256:${'3'.repeat(64)}`, accept_host_policy: false }));
});

test('resource consent expiry is rechecked at activation using the host clock', () => {
  const preparedAt = new Date('2026-09-24T00:00:00.000Z');
  const expiry = '2026-12-23T00:00:00.000Z';
  assert.equal(assertResourceSyncConsentWindow(expiry, preparedAt).toISOString(), expiry);
  assert.throws(() => assertResourceSyncConsentWindow('2026-12-23T00:00:00.001Z', preparedAt));
  assert.throws(() => assertResourceSyncConsentWindow(expiry, new Date(expiry)));
  assert.throws(() => assertResourceSyncConsentWindow(expiry, new Date('invalid')));
});

test('resource sync credentials never share the v1 action token hash domain', () => {
  const token = 'synthetic-credential-value-for-domain-check';
  assert.match(hashAppResourceSyncToken(token), /^sha256:[a-f0-9]{64}$/u);
  assert.notEqual(hashAppResourceSyncToken(token), hashAppRuntimeToken(token));
});
