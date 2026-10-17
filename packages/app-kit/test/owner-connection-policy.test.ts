import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OwnerConnectionPolicyDeclarationSchema, OwnerConnectionPolicyDeclarationsSchema,
  buildDeftAppPackage, verifyDeftAppPackageJson, parseAttachmentAppManifest,
  projectDeftAppRequestedAuthority, diffDeftAppRequestedAuthority,
} from '../dist/index.js';

const scalar = { type: 'object' as const, additionalProperties: false as const,
  properties: { subject: { type: 'string' as const, maxLength: 200 } }, required: ['subject'] };
const policy = { key: 'mailbox', resource_key: 'messages', action_keys: ['send_message'], max_consent_seconds: 86400 };
const manifest = { schema_version: '7' as const, compatibility: { app_protocol: '7' as const },
  id: 'community.example.owner-connection', version: '1.0.0', name: 'Owner connection', license: 'AGPL-3.0-only',
  modules: [], navigation: [], runtime_requirements: [
    { key: 'dispatch', protocol_version: 'deft.app_runtime_channel.v1' as const },
    { key: 'inbox', protocol_version: 'deft.app_runtime_channel.v3' as const }],
  private_capabilities: [{ key: 'send', version: '1' as const, input_schema: scalar, output_schema: scalar }],
  runtime_actions: [{ key: 'send_message', label: 'Send', capability_key: 'send', runtime_requirement_key: 'dispatch' }],
  native_actions: [], sync_descriptors: [{ schema_version: 'deft.app_sync_descriptor.v2' as const,
    key: 'messages', runtime_requirement_key: 'inbox', resource_type: 'message', requested_visibility: 'user_private' as const,
    record_schema: scalar, label_field: 'subject', attachments: { max_attachment_bytes: 1024,
      max_attachments_per_record: 1, max_attachments_per_run: 1, max_attachment_bytes_per_run: 1024,
      retention_days: 1, allowed_media_types: ['application/pdf'] as ['application/pdf'] } }],
  experiences: [], public_actions: [] };

test('owner setup remains absent from legacy packages and is requested-only when declared', async () => {
  const prior = await buildDeftAppPackage({ manifest, artifacts: [] });
  assert.equal(Object.hasOwn(prior.package.manifest, 'owner_connections'), false);
  const proposed = { ...manifest, owner_connections: [policy] };
  const built = await buildDeftAppPackage({ manifest: proposed, artifacts: [] });
  assert.deepEqual(await verifyDeftAppPackageJson(built.json), built);
  const projected = projectDeftAppRequestedAuthority(proposed);
  assert.ok('owner_connections' in projected.requirements);
  assert.deepEqual(projected.requirements.owner_connections, [policy]);
  assert.deepEqual(projected.classification, { authority_state: 'requested_only', executable: false,
    provider_access: false, review_required: true });
  assert.notEqual(built.package.manifest_digest, prior.package.manifest_digest);
  assert.equal((await buildDeftAppPackage({ manifest, artifacts: [] })).json, prior.json);
});

test('adding, narrowing or removing owner setup requires a fresh authority review', async () => {
  const declared = { ...manifest, owner_connections: [policy] };
  for (const pair of [{ prior: manifest, proposed: declared },
    { prior: declared, proposed: { ...declared, owner_connections: [{ ...policy, max_consent_seconds: 60 }] } },
    { prior: declared, proposed: { ...declared, owner_connections: [{ ...policy, action_keys: [] }] } },
    { prior: declared, proposed: manifest }]) {
    const diff = await diffDeftAppRequestedAuthority(pair);
    assert.deepEqual(diff.changed_atoms, ['owner_connections']);
    assert.equal(diff.carry_forward_eligible, false);
    assert.equal(diff.kind, 'widening_or_incompatible');
  }
});

test('policy references exact private resources and Runtime actions; read-only is valid', () => {
  assert.ok(parseAttachmentAppManifest({ ...manifest, owner_connections: [{ ...policy, action_keys: [] }] }));
  assert.throws(() => parseAttachmentAppManifest({ ...manifest,
    owner_connections: [{ ...policy, resource_key: 'other' }] }), /declared user-private resource/);
  assert.throws(() => parseAttachmentAppManifest({ ...manifest,
    owner_connections: [{ ...policy, action_keys: ['other'] }] }), /declared Runtime action/);
});

test('author policy cannot select owner, operator, role eligibility or code', () => {
  for (const extra of [{ owner_user_id: crypto.randomUUID() }, { operator_user_id: crypto.randomUUID() },
    { eligible_roles: ['guest'] }, { module_path: '/tmp/unreviewed.mjs' }, { provider: 'gmail' }]) {
    assert.throws(() => OwnerConnectionPolicyDeclarationSchema.parse({ ...policy, ...extra }));
  }
});

test('owner policy quotas, consent duration and canonical keys are bounded and closed', () => {
  for (const change of [{ max_consent_seconds: 0 }, { max_consent_seconds: 90 * 86400 + 1 },
    { max_consent_seconds: 1.5 }, { key: 'constructor' }, { resource_key: '__proto__' },
    { action_keys: ['send_message', 'send_message'] }, { action_keys: ['z', 'a'] },
    { action_keys: Array.from({ length: 17 }, (_, n) => `action_${String(n).padStart(2, '0')}`) }]) {
    assert.throws(() => OwnerConnectionPolicyDeclarationSchema.parse({ ...policy, ...change }));
  }
  for (const policies of [[], [policy, policy], [{ ...policy, key: 'z' }, { ...policy, key: 'a' }],
    Array.from({ length: 17 }, (_, n) => ({ ...policy, key: `policy_${String(n).padStart(2, '0')}` }))]) {
    assert.throws(() => OwnerConnectionPolicyDeclarationsSchema.parse(policies));
  }
  assert.ok(OwnerConnectionPolicyDeclarationSchema.safeParse({ ...policy, action_keys: [], max_consent_seconds: 90 * 86400 }).success);
});
