import assert from 'node:assert/strict';
import test from 'node:test';
import { PrivateStateDeclarationSchema, PrivateStateFilesPolicySchema, parseAttachmentAppManifest,
  projectDeftAppRequestedAuthority, diffDeftAppRequestedAuthority, buildDeftAppPackage,
  verifyDeftAppPackageJson } from '../dist/index.js';

const scalar = { type: 'object' as const, additionalProperties: false as const,
  properties: { body: { type: 'string' as const, maxLength: 4096 } }, required: ['body'] };
const state = { key: 'drafts', label: 'Drafts', schema: scalar,
  max_record_bytes: 16384, max_records: 32, max_total_bytes: 131072, retention_days: 30 };
const files = { max_file_bytes: 2_097_152, max_files_per_record: 1,
  max_total_bytes_per_record: 2_097_152, allowed_media_types: ['application/pdf'] as ['application/pdf'] };
const payload = { action_key: 'send_message', max_payload_bytes: 4_194_304 };
const manifest = { schema_version: '7' as const, compatibility: { app_protocol: '7' as const },
  id: 'community.example.private-files', version: '1.0.0', name: 'Private files', license: 'AGPL-3.0-only',
  modules: [], navigation: [], runtime_requirements: [
    { key: 'dispatch', protocol_version: 'deft.app_runtime_channel.v1' as const },
    { key: 'inbox', protocol_version: 'deft.app_runtime_channel.v3' as const }],
  private_capabilities: [{ key: 'send', version: '1' as const, input_schema: scalar, output_schema: scalar }],
  runtime_actions: [{ key: 'send_message', label: 'Send', capability_key: 'send', runtime_requirement_key: 'dispatch' }],
  native_actions: [], sync_descriptors: [{ schema_version: 'deft.app_sync_descriptor.v2' as const,
    key: 'messages', runtime_requirement_key: 'inbox', resource_type: 'message', requested_visibility: 'user_private' as const,
    record_schema: { ...scalar, properties: { body: { type: 'string' as const, maxLength: 200 } } },
    label_field: 'body', attachments: { max_attachment_bytes: 2_097_152,
      max_attachments_per_record: 1, max_attachments_per_run: 1, max_attachment_bytes_per_run: 2_097_152,
      retention_days: 1, allowed_media_types: ['application/pdf'] as ['application/pdf'] } }],
  experiences: [], public_actions: [], private_state: [state] };

test('optional file and payload declarations preserve scalar schema and absent legacy fields', () => {
  assert.deepEqual(PrivateStateDeclarationSchema.parse(state), state);
  const parsed = parseAttachmentAppManifest(manifest);
  assert.equal(Object.hasOwn(parsed.private_state![0]!, 'files'), false);
  assert.equal(Object.hasOwn(parsed.private_state![0]!, 'action_payloads'), false);
  assert.deepEqual(PrivateStateDeclarationSchema.parse({ ...state, files, action_payloads: [payload] }).schema, scalar);
  assert.throws(() => PrivateStateDeclarationSchema.parse({ ...state, schema: { ...scalar,
    properties: { files: { type: 'array', items: { type: 'string' } } } } }));
});

test('reviewed file policies are closed, bounded and use the established media classifier', () => {
  assert.deepEqual(PrivateStateFilesPolicySchema.parse(files), files);
  for (const changed of [{ ...files, max_file_bytes: 2_097_153 }, { ...files, max_files_per_record: 9 },
    { ...files, max_total_bytes_per_record: 8_388_609 }, { ...files, max_file_bytes: 0 },
    { ...files, max_total_bytes_per_record: 1 }, { ...files, allowed_media_types: [] },
    { ...files, allowed_media_types: ['application/pdf', 'application/pdf'] },
    { ...files, allowed_media_types: ['text/html'] }, { ...files, storage_url: 'https://example.test' }]) {
    assert.throws(() => PrivateStateFilesPolicySchema.parse(changed));
  }
  assert.ok(PrivateStateFilesPolicySchema.safeParse({ ...files, allowed_media_types: ['text/plain'] }).success);
});

test('payload action policy is bounded, nonempty, sorted, unique and closed', () => {
  for (const action_payloads of [[], [{ ...payload, max_payload_bytes: 8_388_609 }],
    [{ ...payload, max_payload_bytes: 0 }], [payload, payload],
    [payload, { action_key: 'another', max_payload_bytes: 1 }],
    [{ ...payload, action_key: 'core_send' }], [{ ...payload, provider_url: 'https://example.test' }]]) {
    assert.throws(() => PrivateStateDeclarationSchema.parse({ ...state, action_payloads }));
  }
});

test('each payload action references a Runtime declaration and exactly one private state', () => {
  const declared = { ...manifest, private_state: [{ ...state, files, action_payloads: [payload] }] };
  assert.ok(parseAttachmentAppManifest(declared));
  assert.throws(() => parseAttachmentAppManifest({ ...declared,
    private_state: [{ ...state, action_payloads: [{ ...payload, action_key: 'undeclared' }] }] }), /declared Runtime action/);
  assert.throws(() => parseAttachmentAppManifest({ ...declared, private_state: [
    { ...state, action_payloads: [payload] }, { ...state, key: 'other', action_payloads: [payload] }] }), /only one payload state/);
});

test('canonical packages and requested authority retain policies exactly; changes require private-state review', async () => {
  const before = await buildDeftAppPackage({ manifest, artifacts: [] });
  const proposed = { ...manifest, private_state: [{ ...state, files, action_payloads: [payload] }] };
  const built = await buildDeftAppPackage({ manifest: proposed, artifacts: [] });
  assert.deepEqual(await verifyDeftAppPackageJson(built.json), built);
  const projection = projectDeftAppRequestedAuthority(proposed);
  assert.ok('private_state' in projection.requirements);
  assert.deepEqual(projection.requirements.private_state, proposed.private_state);
  assert.notEqual(built.package.manifest_digest, before.package.manifest_digest);
  assert.deepEqual((await diffDeftAppRequestedAuthority({ prior: manifest, proposed })).changed_atoms, ['private_state']);
  const narrowed = { ...proposed, private_state: [{ ...state, files: { ...files, max_file_bytes: 1024 }, action_payloads: [payload] }] };
  assert.deepEqual((await diffDeftAppRequestedAuthority({ prior: proposed, proposed: narrowed })).changed_atoms, ['private_state']);
  assert.equal((await buildDeftAppPackage({ manifest, artifacts: [] })).json, before.json);
});
