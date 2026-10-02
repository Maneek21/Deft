import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDeftAppPackage, isDeftAppProtocolOperationSupported,
  parseRuntimeAppManifest, verifyDeftAppPackageJson,
} from '@deft/app-kit';

test('Protocol 5 inspection accepts reviewed authoring while action routing remains unavailable', async () => {
  const artifact = await buildDeftAppPackage({ manifest: {
    schema_version: '5', id: 'community.example.private-inbox', version: '1.0.0',
    name: 'Private inbox', license: 'AGPL-3.0-only', compatibility: { app_protocol: '5' },
    modules: [], navigation: [], private_capabilities: [], runtime_actions: [],
    experiences: [], public_actions: [],
    runtime_requirements: [{ key: 'mail', protocol_version: 'deft.app_runtime_channel.v2' }],
    sync_descriptors: [{ schema_version: 'deft.app_sync_descriptor.v1', key: 'inbox',
      runtime_requirement_key: 'mail', resource_type: 'message',
      requested_visibility: 'user_private', label_field: 'subject',
      record_schema: { type: 'object', properties: {
        subject: { type: 'string', maxLength: 120 },
      }, required: ['subject'], additionalProperties: false } }],
  }, artifacts: [] });
  const verified = await verifyDeftAppPackageJson(artifact.json);
  assert.equal(verified.package.manifest.schema_version, '5');
  assert.equal(isDeftAppProtocolOperationSupported('5', 'authoring'), true);
  for (const operation of ['inspect', 'stage', 'review', 'activate'] as const) {
    assert.equal(isDeftAppProtocolOperationSupported('5', operation), true);
  }
  assert.equal(isDeftAppProtocolOperationSupported('5', 'route'), false);
  assert.equal(isDeftAppProtocolOperationSupported('5', 'invoke'), false);
  assert.throws(() => parseRuntimeAppManifest(verified.package.manifest),
    'the v1 Runtime manifest parser must not silently accept resource Apps');

  const [{ inspectAppPackageJson }, { closeDb }] =
    await Promise.all([import('../src/lib/app-service.js'), import('../src/lib/db.js')]);
  try {
    const inspected = await inspectAppPackageJson(artifact.json);
    assert.equal(inspected.manifest.schema_version, '5');
    assert.equal(inspected.package_digest, verified.digest);
    assert.deepEqual(inspected.permissions, []);
  } finally { await closeDb(); }
});
