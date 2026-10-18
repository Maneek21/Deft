import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAttachmentConsentPolicy, AppAttachmentConsentRequestSchema, hashAppAttachmentSessionToken } from '../src/lib/app-attachment-policy.js';
import { AppResourceSyncConsentRequestSchema, hashAppResourceSyncToken } from '../src/lib/app-resource-sync-policy.js';
import { createAttachmentSyncDiscoverySnapshot } from '../src/lib/app-attachment-sync-discovery.js';
import { createResourceSyncDiscoverySnapshot } from '../src/lib/app-resource-sync-discovery.js';

const policy = { max_attachment_bytes: 2_097_152, max_attachments_per_record: 8,
  max_attachments_per_run: 32, max_attachment_bytes_per_run: 8_388_608,
  retention_days: 7, allowed_media_types: ['text/csv'] as ['text/csv'] };
const descriptor = { schema_version: 'deft.app_sync_descriptor.v2' as const,
  key: 'inbox', runtime_requirement_key: 'mail', resource_type: 'email_message',
  requested_visibility: 'user_private' as const, record_schema: { type: 'object' as const,
    properties: { subject: { type: 'string' as const, maxLength: 200 } }, required: ['subject'], additionalProperties: false as const },
  label_field: 'subject', attachments: policy };
test('attachment consent is a strict separate envelope with owner-narrowed policy and channel3 token domain', () => {
  const selected = { ...policy, max_attachment_bytes: 1000, retention_days: 1 };
  assert.deepEqual(parseAttachmentConsentPolicy(policy, selected), selected);
  assert.throws(() => parseAttachmentConsentPolicy(policy, { ...selected, retention_days: 8 }));
  assert.throws(() => parseAttachmentConsentPolicy(policy, { ...selected, allowed_media_types: ['image/png'] }));
  assert.throws(() => parseAttachmentConsentPolicy(policy, { ...selected, provider_url: 'https://invalid.example' }));
  const old = { installation_id: crypto.randomUUID(), resource_key: 'inbox', operator_user_id: crypto.randomUUID(),
    expected_app_version_id: crypto.randomUUID(), expected_package_digest: 'sha256:' + '1'.repeat(64),
    expected_grant_snapshot_digest: 'sha256:' + '2'.repeat(64), expected_lifecycle_epoch: 1, expected_grant_epoch: 1,
    consent_expires_at: new Date(Date.now() + 60000).toISOString(), limits: { max_records_per_page: 100,
      max_page_bytes: 524288, max_retained_records: 10000, max_retained_bytes: 104857600, min_interval_seconds: 300 } };
  assert.deepEqual(AppResourceSyncConsentRequestSchema.parse(old), old);
  const next = { ...old, schema_version: 'deft.app_attachment_consent_request.v1', attachment_policy: selected };
  assert.deepEqual(AppAttachmentConsentRequestSchema.parse(next), next);
  assert.throws(() => AppResourceSyncConsentRequestSchema.parse(next));
  assert.throws(() => AppAttachmentConsentRequestSchema.parse(old));
  assert.notEqual(hashAppAttachmentSessionToken('same-secret'), hashAppResourceSyncToken('same-secret'));
});
test('channel3 discovery is independently hashed and closed while channel2 snapshot stays separate', async () => {
  const org_id = crypto.randomUUID(), registration_id = crypto.randomUUID(), captured_at = new Date('2026-09-27T00:00:00Z');
  const next = await createAttachmentSyncDiscoverySnapshot({ org_id, registration_id, captured_at, descriptor });
  assert.equal(next.adapter_contract_version, 'deft.app_runtime_channel.v3');
  assert.match(JSON.stringify(next.operations[0]?.input_schema), /deft\.app_sync_request\.v2/u);
  const { attachments: _attachment, ...legacy } = descriptor;
  const old = await createResourceSyncDiscoverySnapshot({ org_id, registration_id, captured_at,
    descriptor: { ...legacy, schema_version: 'deft.app_sync_descriptor.v1' } });
  assert.equal(old.adapter_contract_version, 'deft.app_runtime_channel.v2');
  assert.notEqual(next.snapshot_digest, old.snapshot_digest);
});
