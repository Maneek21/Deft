import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDeftAppPackage, buildDeftAppRequestedAuthorityReport, canonicalDeftAppRequestedAuthorityReportJson,
  diffDeftAppRequestedAuthority,
  DEFT_EXPERIENCE_BRIDGE_VERSION, DEFT_EXPERIENCE_RENDERER_VERSION,
  isDeftAppProtocolOperationSupported, parseDeftAppManifest, parseResourceAppManifest,
  parseRuntimeAppManifest, prepareDeftExperienceArtifact, verifyDeftAppPackageJson,
} from '../dist/index.js';

const recordSchema = { type: 'object' as const, properties: { subject: { type: 'string' as const, maxLength: 200 } },
  required: ['subject'], additionalProperties: false as const };
const actionSchema = { type: 'object' as const, properties: { message_id: { type: 'string' as const, maxLength: 120 } },
  required: ['message_id'], additionalProperties: false as const };
const base = {
  schema_version: '5' as const, id: 'community.example.email-lite', version: '1.0.0',
  name: 'Email Lite', license: 'AGPL-3.0-only', compatibility: { app_protocol: '5' as const },
  modules: [], navigation: [],
  runtime_requirements: [{ key: 'mail_sync', protocol_version: 'deft.app_runtime_channel.v2' as const }],
  private_capabilities: [], runtime_actions: [],
  sync_descriptors: [{ schema_version: 'deft.app_sync_descriptor.v1' as const, key: 'mail',
    runtime_requirement_key: 'mail_sync', resource_type: 'email_message', requested_visibility: 'user_private' as const,
    record_schema: recordSchema, label_field: 'subject' }],
  experiences: [], public_actions: [],
};
const bundle = { schema_version: 'deft.experience_bundle.v1',
  worker_source: 'self.onmessage = () => postMessage({kind:"view"});', entry_view: 'inbox',
  resource_keys: ['mail'], action_keys: [] };

async function withExperience(manifest: typeof base = base, resourceKeys: string[] = ['mail']) {
  const artifact = await prepareDeftExperienceArtifact('experiences/inbox.json', { ...bundle, resource_keys: resourceKeys });
  const reference = { key: 'inbox', label: 'Inbox', artifact_path: artifact.path, artifact_digest: artifact.digest,
    bridge_version: DEFT_EXPERIENCE_BRIDGE_VERSION, renderer_version: DEFT_EXPERIENCE_RENDERER_VERSION };
  return { manifest: { ...manifest, experiences: [reference] }, artifact };
}

test('v5 sync-only App and Experience package are deterministic and only reviewable by the host', async () => {
  const { manifest, artifact } = await withExperience();
  const built = await buildDeftAppPackage({ manifest, artifacts: [artifact] });
  assert.equal(built.package.package_format, 'deft.app.package.v5');
  assert.deepEqual(await verifyDeftAppPackageJson(built.json), built);
  assert.equal((await buildDeftAppPackage({ manifest, artifacts: [artifact] })).json, built.json);
  assert.equal(parseResourceAppManifest(manifest).sync_descriptors[0]?.key, 'mail');
  assert.throws(() => parseRuntimeAppManifest(manifest));
  assert.equal(isDeftAppProtocolOperationSupported('5', 'authoring'), true);
  for (const operation of ['inspect', 'stage', 'review', 'activate'] as const) {
    assert.equal(isDeftAppProtocolOperationSupported('5', operation), true);
  }
  for (const operation of ['route', 'invoke'] as const) {
    assert.equal(isDeftAppProtocolOperationSupported('5', operation), false);
  }
  const report = buildDeftAppRequestedAuthorityReport(manifest);
  assert.equal(report.schema, 'deft.app.requested_authority.v5');
  assert.equal(report.requested_authority.classification.provider_access, false);
  assert.equal(report.requested_authority.classification.executable, false);
  assert.equal((report.requested_authority.requirements as { sync_descriptors: unknown[] }).sync_descriptors.length, 1);
  assert.equal(canonicalDeftAppRequestedAuthorityReportJson(manifest), canonicalDeftAppRequestedAuthorityReportJson(manifest));
  assert.deepEqual((await diffDeftAppRequestedAuthority({ proposed: manifest })).changed_atoms,
    ['connectors', 'experiences', 'sync_descriptors']);
  const widened = { ...manifest, sync_descriptors: [{ ...manifest.sync_descriptors[0]!, resource_type: 'email_thread' }] };
  assert.deepEqual((await diffDeftAppRequestedAuthority({ prior: manifest, proposed: widened })).changed_atoms,
    ['sync_descriptors']);
});

test('v5 mixed Runtime actions reference only v1; sync descriptors reference only v2', async () => {
  const mixed = { ...base,
    runtime_requirements: [...base.runtime_requirements, { key: 'mail_write', protocol_version: 'deft.app_runtime_channel.v1' as const }],
    private_capabilities: [{ key: 'archive', version: '1' as const, input_schema: actionSchema, output_schema: actionSchema }],
    runtime_actions: [{ key: 'archive_mail', label: 'Archive mail', capability_key: 'archive', runtime_requirement_key: 'mail_write' }],
  };
  assert.equal(parseDeftAppManifest(mixed).schema_version, '5');
  assert.equal((await buildDeftAppPackage({ manifest: mixed, artifacts: [] })).package.package_format, 'deft.app.package.v5');
  assert.throws(() => parseDeftAppManifest({ ...mixed, runtime_actions: [{ ...mixed.runtime_actions[0], runtime_requirement_key: 'mail_sync' }] }));
  assert.throws(() => parseDeftAppManifest({ ...mixed, sync_descriptors: [{ ...mixed.sync_descriptors[0], runtime_requirement_key: 'mail_write' }] }));
  assert.throws(() => parseDeftAppManifest({ ...mixed, runtime_actions: [{ ...mixed.runtime_actions[0], key: 'mail' }] }));
});

test('v5 rejects undeclared/oversized Experience resources and tampered package bytes', async () => {
  const { manifest, artifact } = await withExperience();
  await assert.rejects(() => buildDeftAppPackage({ manifest: { ...manifest, sync_descriptors: [] }, artifacts: [artifact] }));
  await assert.rejects(() => buildDeftAppPackage({ manifest: { ...manifest,
    runtime_requirements: [...manifest.runtime_requirements, ...manifest.runtime_requirements] }, artifacts: [artifact] }));
  await assert.rejects(() => buildDeftAppPackage({ manifest, artifacts: [] }), /exactly the artifacts/);
  const undeclared = await withExperience(base, ['other']);
  await assert.rejects(() => buildDeftAppPackage({ manifest: undeclared.manifest, artifacts: [undeclared.artifact] }), /declared sync resource/);
  const built = await buildDeftAppPackage({ manifest, artifacts: [artifact] });
  const changedManifest = JSON.parse(built.json); changedManifest.manifest.name = 'Changed';
  await assert.rejects(() => verifyDeftAppPackageJson(JSON.stringify(changedManifest)), /digest mismatch/);
  const changedArtifact = JSON.parse(built.json); changedArtifact.artifacts[0].content += ' ';
  await assert.rejects(() => verifyDeftAppPackageJson(JSON.stringify(changedArtifact)), /byte length mismatch/);
  assert.throws(() => parseDeftAppManifest({ ...base, provider_url: 'https://provider.example' }));
  assert.throws(() => parseDeftAppManifest({ ...base, sync_descriptors: [{ ...base.sync_descriptors[0], source_url: 'https://provider.example' }] }));
  for (const older of ['3', '4']) {
    assert.throws(() => parseDeftAppManifest({ ...base, schema_version: older,
      compatibility: { app_protocol: older } }));
  }
});
