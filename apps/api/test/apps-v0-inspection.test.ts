import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import {
  buildDeftAppPackage,
  prepareModuleArtifact,
} from '@deft/app-kit';
import { inspectAppPackageJson } from '../src/lib/app-service.js';
import { AppError } from '../src/lib/app-errors.js';
import { closeDb } from '../src/lib/db.js';
import {
  buildPhase5ConnectedAppPackage,
  buildTrackAAutomatedConnectedAppPackage,
} from './fixtures/phase5-connected-app-package.js';

after(async () => closeDb());

async function helloPackage(options: { includeOmittedDefault?: boolean } = {}) {
  const fields = [
    { key: 'message', label: 'Message', type: 'text' as const, required: true },
    ...(options.includeOmittedDefault
      ? [{ key: 'occasion', label: 'Occasion', type: 'text' as const }]
      : []),
  ];
  const moduleManifest = {
    schema_version: '1',
    id: 'community.deft.hello-workspace',
    slug: 'hello-workspace',
    version: '1.0.0',
    name: 'Hello Workspace',
    collections: [{
      key: 'greetings',
      name: 'Greetings',
      fields,
      views: [{ key: 'all', name: 'All greetings', type: 'table', fields: ['message'] }],
    }],
  };
  const artifact = await prepareModuleArtifact({
    path: 'modules/hello-workspace/deft.module.json',
    manifest: moduleManifest,
  });
  return buildDeftAppPackage({
    manifest: {
      schema_version: '0',
      id: 'community.deft.hello-workspace-app',
      version: '1.0.0',
      name: 'Hello Workspace',
      license: 'AGPL-3.0-only',
      compatibility: { app_protocol: '0' },
      modules: [{
        module_id: moduleManifest.id,
        version: moduleManifest.version,
        manifest_path: artifact.path,
        manifest_digest: artifact.digest,
      }],
      navigation: [{
        key: 'greetings',
        label: 'Greetings',
        module_id: moduleManifest.id,
        collection_key: 'greetings',
        view_key: 'all',
      }],
    },
    artifacts: [artifact],
  });
}

test('API inspection uses the public package contract and grants zero permissions', async () => {
  const built = await helloPackage();
  const inspected = await inspectAppPackageJson(built.json);
  assert.equal(inspected.package_digest, built.digest);
  assert.deepEqual(inspected.permissions, []);
  assert.equal(inspected.manifest.navigation[0]?.collection_key, 'greetings');
});

test('API inspection accepts public App Kit artifacts with omitted Module defaults', async () => {
  const built = await helloPackage({ includeOmittedDefault: true });
  const inspected = await inspectAppPackageJson(built.json);
  assert.equal(inspected.package_digest, built.digest);
});

test('API inspection rejects navigation that is not backed by an included Module collection', async () => {
  const built = await helloPackage();
  const value = JSON.parse(built.json) as any;
  value.manifest.navigation[0].collection_key = 'missing';
  await assert.rejects(
    () => inspectAppPackageJson(JSON.stringify(value)),
    (error: unknown) => error instanceof AppError && error.code === 'APP_INVALID_PACKAGE',
  );
});

test('API inspection accepts Protocol v1 without granting authority', async () => {
  const built = await buildPhase5ConnectedAppPackage();
  const inspected = await inspectAppPackageJson(built.json);

  assert.equal(inspected.package_digest, built.digest);
  assert.equal(inspected.manifest.compatibility.app_protocol, '1');
  assert.deepEqual(inspected.permissions, []);
});

test('API inspection accepts Protocol v2 automation requests without granting authority', async () => {
  const built = await buildTrackAAutomatedConnectedAppPackage();
  const inspected = await inspectAppPackageJson(built.json);

  assert.equal(inspected.package_digest, built.digest);
  assert.equal(inspected.manifest.compatibility.app_protocol, '2');
  assert.deepEqual(inspected.permissions, []);
  assert.deepEqual(
    inspected.manifest.schema_version === '2' ? inspected.manifest.automation_requests : [],
    [{
      key: 'daily_campaign_send',
      label: 'Send campaign daily',
      trigger: { kind: 'daily_local_time' },
      action_key: 'send_campaign_email',
    }],
  );
});
