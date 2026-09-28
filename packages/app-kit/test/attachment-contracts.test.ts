import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDeftAppPackage, buildDeftAppRequestedAuthorityReport, diffDeftAppRequestedAuthority,
  parseAttachmentAppManifest, verifyDeftAppPackageJson,
  AttachmentStageHeaderSchema, frameResourceSyncAttachment, parseSyncPageV2,
  SyncDescriptorV2Schema, SyncPageV2Schema,
  prepareDeftExperienceArtifact,
} from '../dist/index.js';
import { SyncDescriptorV1Schema, SyncPageV1Schema } from '../src/resource-sync.js';

const policy = { max_attachment_bytes: 2_097_152, max_attachments_per_record: 8,
  max_attachments_per_run: 32, max_attachment_bytes_per_run: 8_388_608,
  retention_days: 7, allowed_media_types: ['text/csv'] as ['text/csv'] };
const descriptor = { schema_version: 'deft.app_sync_descriptor.v2' as const,
  key: 'inbox', runtime_requirement_key: 'mail', resource_type: 'email_message',
  requested_visibility: 'user_private' as const, record_schema: { type: 'object' as const,
    properties: { subject: { type: 'string' as const, maxLength: 200 } },
    required: ['subject'], additionalProperties: false as const }, label_field: 'subject', attachments: policy };
const request = { schema_version: 'deft.app_sync_request.v2' as const, cursor: null, max_items: 10, attachments: policy };
const page = { schema_version: 'deft.app_sync_page.v2' as const,
  upserts: [{ id: 'mail:1', revision: '1', data: { subject: 'Literal <script>☃</script>' },
    attachments: [{ attachment_key: 'part:1', staging_id: crypto.randomUUID() }] }],
  tombstones: [], next_cursor: null, has_more: false };
const manifest = { schema_version: '7' as const, id: 'community.example.email-attachments', version: '1.0.0',
  name: 'Email attachments', license: 'AGPL-3.0-only', compatibility: { app_protocol: '7' as const },
  modules: [], navigation: [], runtime_requirements: [{ key: 'mail', protocol_version: 'deft.app_runtime_channel.v3' as const }],
  private_capabilities: [], runtime_actions: [], native_actions: [], sync_descriptors: [descriptor], experiences: [], public_actions: [] };

test('optional private state packages and widens reviewed authority without changing legacy packages', async () => {
  const old = await buildDeftAppPackage({ manifest, artifacts: [] });
  assert.equal(Object.hasOwn(old.package.manifest, 'private_state'), false);
  const state = { key: 'drafts', label: 'Private drafts', schema: descriptor.record_schema,
    max_record_bytes: 16384, max_records: 32, max_total_bytes: 131072, retention_days: 30 };
  const artifact = await prepareDeftExperienceArtifact('experiences/state.json', {
    schema_version: 'deft.experience_bundle.v3', worker_source: 'self.onmessage=()=>{};',
    entry_view: 'main', resource_keys: [], action_keys: [], state_keys: ['drafts'] });
  const proposed = { ...manifest, private_state: [state], experiences: [{ key: 'main', label: 'Drafts',
    artifact_path: artifact.path, artifact_digest: artifact.digest,
    bridge_version: 'deft.experience_bridge.v1' as const, renderer_version: 'deft.trusted_renderer.v1' as const }] };
  const built = await buildDeftAppPackage({ manifest: proposed, artifacts: [artifact] });
  assert.deepEqual(await verifyDeftAppPackageJson(built.json), built);
  assert.ok((await diffDeftAppRequestedAuthority({ prior: manifest, proposed })).changed_atoms.includes('private_state'));
  await assert.rejects(buildDeftAppPackage({ manifest: { ...proposed, private_state: [{ ...state, key: 'other' }] }, artifacts: [artifact] }), /declared private state/);
  assert.equal((await buildDeftAppPackage({ manifest, artifacts: [] })).json, old.json);
});

test('protocol7 attachment-only candidate packs exact descriptor2 policy without old-parser admission', async () => {
  const built = await buildDeftAppPackage({ manifest, artifacts: [] });
  assert.equal(built.package.package_format, 'deft.app.package.v7');
  assert.deepEqual(await verifyDeftAppPackageJson(built.json), built);
  assert.equal(parseAttachmentAppManifest(manifest).native_actions.length, 0);
  const report = buildDeftAppRequestedAuthorityReport(manifest);
  assert.equal(report.schema, 'deft.app.requested_authority.v7');
  assert.equal(report.requested_authority.classification.provider_access, false);
  const changed = { ...manifest, sync_descriptors: [{ ...descriptor, attachments: { ...policy, retention_days: 8 } }] };
  assert.deepEqual((await diffDeftAppRequestedAuthority({ prior: manifest, proposed: changed })).changed_atoms, ['sync_descriptors']);
  assert.throws(() => SyncDescriptorV1Schema.parse(descriptor));
  assert.throws(() => SyncPageV1Schema.parse(page));
  assert.throws(() => parseAttachmentAppManifest({ ...manifest,
    runtime_requirements: [{ key: 'mail', protocol_version: 'deft.app_runtime_channel.v2' }] }));
});

test('page2 requires complete bounded unique catalog and exact host-narrowed scalar policy', () => {
  assert.deepEqual(parseSyncPageV2(descriptor, request, page), page);
  assert.deepEqual(parseSyncPageV2(descriptor, request, { ...page, upserts: [{ ...page.upserts[0]!, attachments: [] }] })
    .upserts[0]?.attachments, []);
  assert.throws(() => SyncPageV2Schema.parse({ ...page, upserts: [{ ...page.upserts[0], attachments: undefined }] }));
  assert.throws(() => parseSyncPageV2(descriptor, request, { ...page,
    upserts: [{ ...page.upserts[0]!, attachments: [page.upserts[0]!.attachments[0]!, page.upserts[0]!.attachments[0]!] }] }));
  assert.throws(() => parseSyncPageV2(descriptor, { ...request, attachments: { ...policy, retention_days: 8 } }, page));
  assert.throws(() => parseSyncPageV2(descriptor, { ...request, attachments: { ...policy, allowed_media_types: ['image/png'] } }, page));
  assert.throws(() => parseSyncPageV2(descriptor, request, { ...page, upserts: [{ ...page.upserts[0], data: { subject: 'x', body: 'undeclared' } }] }));
  assert.throws(() => SyncDescriptorV2Schema.parse({ ...descriptor, attachments: { ...policy, allowed_media_types: ['text/html'] } }));
});

test('stage framing preserves literal bounded Unicode and binary bytes without token or provider authority', () => {
  const bytes = new Uint8Array([0, 255, 1, 2]);
  const header = { schema_version: 'deft.app_sync_attachment_stage.v1', channel_version: 'deft.app_runtime_channel.v3',
    audience: 'app_resource_sync', session_id: crypto.randomUUID(), run_id: crypto.randomUUID(), attempt_id: crypto.randomUUID(),
    claim_token: crypto.randomUUID(), sequence: 1, parent_resource_id: 'mail:1', parent_revision: '1', attachment_key: 'part:1',
    filename: 'Literal <script>☃.csv', declared_media_type: 'text/csv', declared_size_bytes: 4 };
  const frame = frameResourceSyncAttachment(header, bytes);
  const length = new DataView(frame.buffer).getUint32(0, false);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + length))), header);
  assert.deepEqual(frame.subarray(4 + length), bytes);
  assert.throws(() => frameResourceSyncAttachment({ ...header, declared_size_bytes: 3 }, bytes));
  for (const filename of ['path/x', 'path\\x', 'x\r\ny', '☃'.repeat(201), '\ud800']) {
    assert.throws(() => AttachmentStageHeaderSchema.parse({ ...header, filename }));
  }
  for (const extra of [{ session_token: 'secret' }, { provider_url: 'https://private' }, { owner_user_id: crypto.randomUUID() }]) {
    assert.throws(() => AttachmentStageHeaderSchema.parse({ ...header, ...extra }));
  }
  assert.throws(() => AttachmentStageHeaderSchema.parse({ ...header, channel_version: 'deft.app_runtime_channel.v2' }));
});
