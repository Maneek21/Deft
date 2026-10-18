import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDeftAppPackage, parseDeftAppManifest, verifyDeftAppPackageJson,
  buildDeftAppRequestedAuthorityReport, diffDeftAppRequestedAuthority, parseRuntimeObjectInput } from '../dist/index.js';

const object = { type: 'object' as const, properties: { shipment_id: { type: 'string' as const, maxLength: 120 } },
  required: ['shipment_id'], additionalProperties: false as const };
const manifest = { schema_version: '3' as const, id: 'community.example.shipping', version: '1.0.0',
  name: 'Shipping', license: 'AGPL-3.0-only', compatibility: { app_protocol: '3' as const }, modules: [], navigation: [],
  runtime_requirements: [{ key: 'carrier', protocol_version: 'deft.app_runtime_channel.v1' as const }],
  private_capabilities: [{ key: 'label', version: '1' as const, input_schema: object, output_schema: object }],
  runtime_actions: [{ key: 'create_shipping_label', label: 'Create shipping label', capability_key: 'label', runtime_requirement_key: 'carrier' }],
};

test('Runtime candidate builds deterministically and requests no effective authority', async () => {
  const built = await buildDeftAppPackage({ manifest, artifacts: [] });
  assert.equal(built.package.package_format, 'deft.app.package.v3');
  assert.deepEqual(await verifyDeftAppPackageJson(built.json), built);
  assert.equal((await buildDeftAppPackage({ manifest, artifacts: [] })).json, built.json);
  const report = buildDeftAppRequestedAuthorityReport(manifest);
  assert.equal(report.schema, 'deft.app.requested_authority.v3');
  assert.equal(report.requested_authority.classification.provider_access, false);
  const diff = await diffDeftAppRequestedAuthority({ proposed: manifest });
  assert.deepEqual(diff.changed_atoms.sort(), ['actions', 'capabilities', 'connectors']);
  assert.equal((await diffDeftAppRequestedAuthority({ prior: manifest, proposed: manifest })).kind, 'unchanged');
  const changed = structuredClone(manifest); changed.private_capabilities[0]!.input_schema.properties.shipment_id.maxLength = 121;
  assert.equal((await diffDeftAppRequestedAuthority({ prior: manifest, proposed: changed })).kind, 'widening_or_incompatible');
});

test('Runtime manifest rejects executable config, missing references, widened policy and tampering', async () => {
  for (const patch of [{ command: 'node run.js' }, { credentials: 'secret' }, { experience: {} },
    { runtime_actions: [{ ...manifest.runtime_actions[0], host_policy: { review_requirement: 'never' } }] },
    { runtime_actions: [{ ...manifest.runtime_actions[0], capability_key: 'missing' }] },
    { runtime_actions: [{ ...manifest.runtime_actions[0], key: 'deft_action' }] },
    { runtime_actions: [{ ...manifest.runtime_actions[0], key: 'core_action' }] },
    { runtime_actions: [{ ...manifest.runtime_actions[0], key: 'system_action' }] },
    { runtime_requirements: [...manifest.runtime_requirements, ...manifest.runtime_requirements] }]) {
    assert.throws(() => parseDeftAppManifest({ ...manifest, ...patch }));
  }
  const built = await buildDeftAppPackage({ manifest, artifacts: [] });
  const tampered = JSON.parse(built.json); tampered.manifest.runtime_actions[0].label = 'Changed';
  await assert.rejects(() => verifyDeftAppPackageJson(JSON.stringify(tampered)), /digest mismatch/);
});

test('Runtime schema bounds inputs and rejects undeclared or executable schema features', () => {
  assert.deepEqual(parseRuntimeObjectInput(object, { shipment_id: 'synthetic-1' }), { shipment_id: 'synthetic-1' });
  for (const value of [{}, { shipment_id: 'x', extra: true }, { shipment_id: 1 }, { shipment_id: 'x'.repeat(121) }]) {
    assert.throws(() => parseRuntimeObjectInput(object, value));
  }
  assert.throws(() => parseRuntimeObjectInput({ ...object, $ref: 'https://example.test/schema' } as never, {}));
  const bad = structuredClone(manifest); bad.private_capabilities[0]!.input_schema.required = ['missing'];
  assert.throws(() => parseDeftAppManifest(bad));
});
