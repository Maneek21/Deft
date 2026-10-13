import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { OwnerConnectionAdmissionReferenceSchema, OwnerConnectionResourceRequestSchema,
  OwnerConnectionActionRequestSchema, ownerConnectionLimitsWithin, assertLegacyOwnerConnectionPolicy,
  assertLegacyOwnerConnectionResourcePolicies } from '../src/lib/app-owner-connection-contract.js';

const reference = { admission_id: randomUUID(), admission_digest: `sha256:${'a'.repeat(64)}` };
const ceiling = { max_records_per_page: 50, max_page_bytes: 100000, max_retained_records: 1000,
  max_retained_bytes: 1000000, min_interval_seconds: 300 };
const resource = { ...reference, target_key: 'personal', consent_expires_at: '2026-10-01T00:00:00.000Z', limits: ceiling,
  attachment_policy: { max_attachment_bytes: 1000, max_attachments_per_record: 1, max_attachments_per_run: 1,
    max_attachment_bytes_per_run: 1000, retention_days: 1, allowed_media_types: ['application/pdf'] } };

test('E1 profile requests cannot be admitted or resolved through the legacy owner connection policy guard', () => {
  const legacy = { key: 'mailbox', resource_key: 'messages', action_keys: ['send_message'], max_consent_seconds: 86400 };
  assert.doesNotThrow(() => assertLegacyOwnerConnectionPolicy(legacy));
  assert.throws(() => assertLegacyOwnerConnectionPolicy({ ...legacy, provider_profile_key: 'google_mail', runtime_requirement_key: 'inbox' }),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'APP_CONNECTION_PROFILE_UNAVAILABLE'
      && 'status' in error && error.status === 409));
});

test('manual legacy connection projections reject matching external profiles while unrelated resources and retained cleanup remain usable', () => {
  const legacy = { key: 'mailbox', resource_key: 'messages', action_keys: ['send_message'], max_consent_seconds: 86400 };
  const external = { ...legacy, provider_profile_key: 'google_mail', runtime_requirement_key: 'inbox' };
  assert.doesNotThrow(() => assertLegacyOwnerConnectionResourcePolicies(undefined, 'messages'));
  assert.doesNotThrow(() => assertLegacyOwnerConnectionResourcePolicies([legacy], 'messages'));
  assert.doesNotThrow(() => assertLegacyOwnerConnectionResourcePolicies([external], 'contacts'));
  assert.throws(() => assertLegacyOwnerConnectionResourcePolicies([legacy, external], 'messages'),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'APP_CONNECTION_PROFILE_UNAVAILABLE'));
  // The shared production helper also protects manual bindings with no owner
  // admission row. Confirm the actual private projection calls it, while the
  // retained status/disconnect entrance remains ahead of the projection.
  const source = readFileSync(new URL('../src/lib/app-experience-exposure.ts', import.meta.url), 'utf8');
  const projection = source.slice(source.indexOf('private async connectionProjection('), source.indexOf('async connectionCleanup('));
  assert.ok(projection.includes('assertLegacyOwnerConnectionResourcePolicies(context.verified.manifest.owner_connections, pins.resource_key)'));
  const setup = source.slice(source.indexOf('async connectionSetup('), source.indexOf('private async connectionProjection('));
  assert.ok(setup.includes('return this.connectionCleanup('));
  assert.ok(setup.indexOf('return this.connectionCleanup(') < setup.indexOf('this.connectionProjection('));
});

test('owner resource requests cannot nominate another owner, operator, code, reviewer, or resource', () => {
  assert.ok(OwnerConnectionResourceRequestSchema.safeParse(resource).success);
  for (const key of ['owner_user_id', 'operator_user_id', 'reviewed_by_user_id', 'resource_key', 'installation_id', 'code'])
    assert.equal(OwnerConnectionResourceRequestSchema.safeParse({ ...resource, [key]: randomUUID() }).success, false, key);
});
test('owner action requests accept only admission plus exact private resource anchor and reviewed action', () => {
  const action = { ...reference, owner_resource_binding_id: randomUUID(), action_key: 'send_message' };
  assert.ok(OwnerConnectionActionRequestSchema.safeParse(action).success);
  for (const key of ['owner_user_id', 'operator_user_id', 'registration_id', 'input', 'provider_instance_id'])
    assert.equal(OwnerConnectionActionRequestSchema.safeParse({ ...action, [key]: randomUUID() }).success, false, key);
});
test('admission references must be exact pairs and cannot carry legacy registration authority', () => {
  assert.ok(OwnerConnectionAdmissionReferenceSchema.safeParse(reference).success);
  for (const value of [{ admission_id: reference.admission_id }, { admission_digest: reference.admission_digest },
    { ...reference, admission_digest: 'a'.repeat(64) }, { ...reference, runtime_registration_id: randomUUID() }])
    assert.equal(OwnerConnectionAdmissionReferenceSchema.safeParse(value).success, false);
});
test('owner-selected ceilings permit reductions and slower polling, and reject each authority increase', () => {
  assert.equal(ownerConnectionLimitsWithin({ ...ceiling, max_records_per_page: 1, min_interval_seconds: 600 }, ceiling), true);
  for (const key of ['max_records_per_page', 'max_page_bytes', 'max_retained_records', 'max_retained_bytes'] as const)
    assert.equal(ownerConnectionLimitsWithin({ ...ceiling, [key]: ceiling[key] + 1 }, ceiling), false, key);
  assert.equal(ownerConnectionLimitsWithin({ ...ceiling, min_interval_seconds: 299 }, ceiling), false);
});
test('attachment policy and draft target remain bounded strict reviewed data', () => {
  assert.equal(OwnerConnectionResourceRequestSchema.safeParse({ ...resource, target_key: '../other' }).success, false);
  assert.equal(OwnerConnectionResourceRequestSchema.safeParse({ ...resource, attachment_policy: { ...resource.attachment_policy,
    max_attachment_bytes: 2097153 } }).success, false);
  assert.equal(OwnerConnectionResourceRequestSchema.safeParse({ ...resource, attachment_policy: { ...resource.attachment_policy,
    provider_url: 'https://example.invalid/file' } }).success, false);
});
