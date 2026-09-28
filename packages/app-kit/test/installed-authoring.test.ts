import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDeftAppPackage, verifyDeftAppPackageJson, prepareModuleArtifact, prepareDeftExperienceArtifact,
  parseDeftAppManifest, diffDeftAppRequestedAuthority, buildDeftAppRequestedAuthorityReport } from '../dist/index.js';

async function fixture() {
  const module = await prepareModuleArtifact({ path: 'modules/parcels/deft.module.json', manifest: {
    schema_version: '1', id: 'community.example.parcels', slug: 'parcels', version: '1.0.0', name: 'Parcels',
    collections: [{ key: 'parcels', name: 'Parcels', singular_name: 'Parcel',
      fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
      views: [{ key: 'all', name: 'All', type: 'table', fields: ['name'] }],
      search: { title_field: 'name', subtitle_fields: [], fields: ['name'] } }],
    navigation: { default_collection: 'parcels', default_view: 'all' },
  } });
  const experience = await prepareDeftExperienceArtifact('experiences/main.json', {
    schema_version: 'deft.experience_bundle.v1', worker_source: 'self.onmessage=()=>{};',
    entry_view: 'main', resource_keys: [], action_keys: ['create_label'],
  });
  const object = { type: 'object' as const, properties: { shipment_id: { type: 'string' as const, maxLength: 120 } },
    required: ['shipment_id'], additionalProperties: false as const };
  const manifest = { schema_version: '4' as const, id: 'community.example.shipping', version: '1.0.0', name: 'Shipping',
    license: 'AGPL-3.0-only', compatibility: { app_protocol: '4' as const },
    modules: [{ module_id: 'community.example.parcels', version: '1.0.0', manifest_path: module.path, manifest_digest: module.digest }],
    navigation: [], runtime_requirements: [{ key: 'carrier', protocol_version: 'deft.app_runtime_channel.v1' as const }],
    private_capabilities: [{ key: 'label', version: '1' as const, input_schema: object, output_schema: object }],
    runtime_actions: [{ key: 'create_label', label: 'Create label', capability_key: 'label', runtime_requirement_key: 'carrier' }],
    experiences: [{ key: 'main', label: 'Shipping', artifact_path: experience.path, artifact_digest: experience.digest,
      bridge_version: 'deft.experience_bridge.v1' as const, renderer_version: 'deft.trusted_renderer.v1' as const }],
    public_actions: [{ key: 'claim_label', action_key: 'create_label', module_id: 'community.example.parcels', collection_key: 'parcels',
      input_mapping: { shipment_id: 'claim.resource_id' as const } }],
  };
  return { manifest, artifacts: [module, experience] };
}

test('installed v4 combines exact Module, Experience and public mapping without granting authority', async () => {
  const input = await fixture();
  const built = await buildDeftAppPackage(input);
  assert.equal(built.package.package_format, 'deft.app.package.v4');
  assert.deepEqual(await verifyDeftAppPackageJson(built.json), built);
  assert.equal((await buildDeftAppPackage({ ...input, artifacts: [...input.artifacts].reverse() })).json, built.json);
  const report = buildDeftAppRequestedAuthorityReport(input.manifest);
  assert.equal(report.schema, 'deft.app.requested_authority.v4');
  assert.equal(report.requested_authority.classification.executable, false);
  const changed = structuredClone(input.manifest); changed.experiences[0]!.label = 'Changed';
  assert.deepEqual((await diffDeftAppRequestedAuthority({ prior: input.manifest, proposed: changed })).changed_atoms, ['experiences']);
  assert.throws(() => parseDeftAppManifest({ ...input.manifest, schema_version: '3', compatibility: { app_protocol: '3' } }));
});

test('installed v4 rejects orphan artifacts, undeclared actions and invalid canonical claim mappings', async () => {
  const input = await fixture();
  await assert.rejects(() => buildDeftAppPackage({ ...input, artifacts: input.artifacts.slice(0, 1) }), /exactly/);
  for (const patch of [{ input_mapping: { shipment_id: 'request.body' } }, { input_mapping: {} },
    { action_key: 'missing' }, { module_id: 'missing' }, { input_mapping: { extra: 'claim.claim_id' } }]) {
    assert.throws(() => parseDeftAppManifest({ ...input.manifest, public_actions: [{ ...input.manifest.public_actions[0], ...patch }] }));
  }
  const invalid = structuredClone(input.manifest); invalid.public_actions[0]!.collection_key = 'missing';
  await assert.rejects(() => buildDeftAppPackage({ ...input, manifest: invalid }), /included Module collection/);
  const tampered = await prepareDeftExperienceArtifact('experiences/main.json', {
    schema_version: 'deft.experience_bundle.v1', worker_source: 'self.onmessage=()=>{};', entry_view: 'main',
    resource_keys: [], action_keys: ['undeclared'] });
  const manifest = structuredClone(input.manifest); manifest.experiences[0]!.artifact_digest = tampered.digest;
  await assert.rejects(() => buildDeftAppPackage({ manifest, artifacts: [input.artifacts[0]!, tampered] }), /declared actions/);
});
