import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDeftAppPackage,
  prepareModuleArtifact,
  type DeftAppManifestV1Input,
} from '@deft/app-kit';
import { inspectAppPackageJson } from '../src/lib/app-service.js';
import { AppError } from '../src/lib/app-errors.js';

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

test('API inspection rejects authoring-only Protocol v1 before persistence is installed', async () => {
  const v0 = await helloPackage();
  const reference = v0.package.manifest.modules[0]!;
  const manifest: DeftAppManifestV1Input = {
    ...v0.package.manifest,
    schema_version: '1',
    compatibility: { app_protocol: '1' },
    dependencies: [{ key: 'contacts_app', app_id: 'community.deft.contacts-app', version: '1.0.0' }],
    resource_requirements: [
      {
        key: 'greeting',
        source: { kind: 'included_module', module_id: reference.module_id, version: reference.version },
        resource_type: 'greetings',
        fields: ['message'],
      },
      {
        key: 'contact',
        source: {
          kind: 'dependency_module', dependency_key: 'contacts_app',
          module_id: 'community.deft.contacts', version: '1.0.0',
        },
        resource_type: 'contacts',
        fields: ['email'],
      },
    ],
    capability_requirements: [{
      key: 'send_email',
      interface: { kind: 'private', namespace: 'app_lineage', key: 'sandbox_email_send', version: '1' },
    }],
    connector_requirements: [{ key: 'mail_provider', provider_kind: 'mcp' }],
    actions: [{
      key: 'send_greeting',
      label: 'Send greeting',
      capability_requirement_key: 'send_email',
      connector_requirement_key: 'mail_provider',
      placement: { kind: 'resource_detail', resource_requirement_key: 'greeting' },
      input_bindings: [
        {
          input_key: 'to',
          source: {
            kind: 'user_input', input_type: 'email', label: 'Recipient', required: true,
          },
        },
        { input_key: 'subject', source: { kind: 'resource_field', resource_requirement_key: 'greeting', field_key: 'message' } },
        { input_key: 'body_text', source: { kind: 'resource_field', resource_requirement_key: 'greeting', field_key: 'message' } },
      ],
    }],
  };
  const built = await buildDeftAppPackage({ manifest, artifacts: v0.package.artifacts });

  await assert.rejects(
    () => inspectAppPackageJson(built.json),
    (error: unknown) => error instanceof AppError
      && error.code === 'APP_PROTOCOL_UNSUPPORTED'
      && error.status === 409,
  );
});
