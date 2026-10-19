import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { compatibleOwnerRecoverySnapshot } from '../src/lib/app-owner-recovery-targets.js';
import { OwnerConnectionAdmissionSnapshotSchema } from '../src/lib/app-owner-connection-contract.js';

test('compatible saved-account discovery ignores only version pins and keeps every scope field exact', () => {
  const digest = 'sha256:' + 'a'.repeat(64);
  const current = OwnerConnectionAdmissionSnapshotSchema.parse({ schema_version: 'deft.owner_connection_admission.v1',
    org_id: randomUUID(), installation_id: randomUUID(), app_version_id: randomUUID(), grant_snapshot_id: randomUUID(),
    package_digest: digest, grant_snapshot_digest: digest, lifecycle_epoch: 2, grant_epoch: 2, operator_user_id: randomUUID(),
    policy: { key: 'mailbox', resource_key: 'inbox', action_keys: ['send_message'], max_consent_seconds: 86400 },
    policy_digest: digest, resource_descriptor_digest: digest, actions: [{ action_key: 'send_message', contract_digest: digest }],
    limits: { max_records_per_page: 25, max_page_bytes: 65536, max_retained_records: 1000, max_retained_bytes: 1048576, min_interval_seconds: 300 } });
  const previous = { ...structuredClone(current), app_version_id: randomUUID(), grant_snapshot_id: randomUUID(),
    package_digest: 'sha256:' + 'b'.repeat(64), grant_snapshot_digest: 'sha256:' + 'c'.repeat(64), lifecycle_epoch: 1, grant_epoch: 1 };
  assert.equal(compatibleOwnerRecoverySnapshot(current, previous), true);
  for (const field of ['org_id', 'installation_id', 'operator_user_id', 'policy_digest', 'resource_descriptor_digest'] as const)
    assert.equal(compatibleOwnerRecoverySnapshot(current, { ...previous, [field]: 'different' }), false, field);
  assert.equal(compatibleOwnerRecoverySnapshot(current, { ...previous, policy: { ...previous.policy, resource_key: 'other' } }), false);
  assert.equal(compatibleOwnerRecoverySnapshot(current, { ...previous, actions: [] }), false);
  assert.equal(compatibleOwnerRecoverySnapshot(current, { ...previous, limits: { ...previous.limits, max_retained_records: 999 } }), false);
  assert.equal(compatibleOwnerRecoverySnapshot(current, { ...previous, connection_profile_digest: digest }), false);
  assert.equal(compatibleOwnerRecoverySnapshot(current, { ...previous, connection_transport_digest: digest }), false);
});
