import assert from 'node:assert/strict';
import test from 'node:test';
import { ExposureSnapshotSchema } from '../src/lib/app-experience-exposure-contract.js';
import { experienceConsentScope, experienceConsentDigest, ExperienceConsentScopeSchema } from '../src/lib/app-experience-consent-contract.js';

const id = '11111111-1111-4111-8111-111111111111';
const digest = 'sha256:' + 'a'.repeat(64);
const at = '2026-10-09T00:00:00Z';
const snapshot = {
  schema_version: 'deft.experience_resource_exposure.v1', payload_policy_version: 'deft.experience_resource_payload.v1',
  visibility: 'user_private', destination: 'verified_installed_experience_worker',
  org_id: id, owner_user_id: id, owner_label: 'Owner', web_session_id: id, experience_session_id: id,
  installation_id: id, app_version_id: id, app_name: 'Example', app_version: '1.0.0',
  package_digest: digest, manifest_digest: digest, grant_snapshot_id: id, grant_snapshot_digest: digest,
  lifecycle_epoch: 1, grant_epoch: 1, experience_key: 'workspace', experience_label: 'Workspace',
  artifact_digest: digest, bridge_version: 'deft.experience_bridge.v1', renderer_version: 'deft.trusted_renderer.v1',
  resources: [{ resource_key: 'messages', binding_id: id, registration_id: id, runtime_epoch: 1, descriptor_digest: digest,
    resource_type: 'messages', label: 'Messages', allowed_operations: ['list_summary', 'read_one'], allowed_fields: ['subject'], consent_expires_at: at }],
  limits: { items: 10, fields: 32, string_chars: 4096, envelope_bytes: 61440 },
  prepared_at: at, review_expires_at: at, web_access_expires_at: at, expires_at: at,
};

test('renderer capabilities survive signed exposure and durable consent and change the review digest', () => {
  const legacy = ExposureSnapshotSchema.parse(snapshot);
  assert.equal(Object.hasOwn(legacy, 'capabilities'), false);
  const scope = experienceConsentScope(legacy);
  assert.equal(Object.hasOwn(scope, 'capabilities'), false);
  const proposed = ExposureSnapshotSchema.parse({ ...snapshot, renderer_version: 'deft.trusted_renderer.v2', capabilities: ['resource_document.v1'] });
  assert.deepEqual(proposed.capabilities, ['resource_document.v1']);
  const proposedScope = experienceConsentScope(proposed);
  assert.deepEqual(proposedScope.capabilities, ['resource_document.v1']);
  assert.notEqual(experienceConsentDigest(scope), experienceConsentDigest(proposedScope));
  for (const profile of [
    { renderer_version: 'deft.trusted_renderer.v2' },
    { renderer_version: 'deft.trusted_renderer.v1', capabilities: ['resource_document.v1'] },
    { renderer_version: 'deft.trusted_renderer.v2', capabilities: [] },
    { renderer_version: 'deft.trusted_renderer.v2', capabilities: ['resource_refresh.v1'] },
    { renderer_version: 'deft.trusted_renderer.v2', capabilities: ['richtext_field.v1'] },
    { renderer_version: 'deft.trusted_renderer.v2', capabilities: ['file_field.v1'] },
    { renderer_version: 'deft.trusted_renderer.v99', capabilities: ['resource_document.v1'] },
  ]) {
    assert.equal(ExposureSnapshotSchema.safeParse({ ...snapshot, ...profile }).success, false);
    assert.equal(ExperienceConsentScopeSchema.safeParse({ ...scope, ...profile }).success, false);
  }
});
