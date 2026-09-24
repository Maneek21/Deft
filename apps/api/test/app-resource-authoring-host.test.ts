import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  buildDeftAppPackage, isDeftAppProtocolOperationSupported,
  parseRuntimeAppManifest, verifyDeftAppPackageJson,
} from '@deft/app-kit';

test('Protocol 5 authoring remains rejected before host inspection and staging access', async () => {
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
  assert.equal(isDeftAppProtocolOperationSupported('5', 'inspect'), false);
  assert.equal(isDeftAppProtocolOperationSupported('5', 'stage'), false);
  assert.throws(() => parseRuntimeAppManifest(verified.package.manifest),
    'the v1 Runtime manifest parser must not silently accept resource Apps');

  const [{ inspectAppPackageJson, stageAppPackage }, { humanModuleActor }, { closeDb }] =
    await Promise.all([import('../src/lib/app-service.js'),
      import('../src/lib/module-service.js'), import('../src/lib/db.js')]);
  const unsupported = (error: unknown) => {
    assert.equal((error as { code: string }).code, 'APP_PROTOCOL_UNSUPPORTED');
    assert.equal((error as { status: number }).status, 409);
    return true;
  };
  try {
    await assert.rejects(inspectAppPackageJson(artifact.json), unsupported);
    const owner = humanModuleActor({ orgId: randomUUID(), userId: randomUUID(),
      role: 'owner', source: 'ui' });
    await assert.rejects(stageAppPackage(owner, artifact.json), unsupported);
  } finally { await closeDb(); }
});
