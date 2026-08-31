import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  AppArtifactPathSchema,
  DEFT_MODULE_ARTIFACT_MEDIA_TYPE,
  DeftAppManifestV0Schema,
  buildDeftAppPackage,
  digestAppManifest,
  getDeftAppManifestV0JsonSchema,
  parseDeftAppManifest,
  prepareModuleArtifact,
  verifyDeftAppPackageJson,
  type DeftAppManifestV0Input,
} from '../src/index.js';

const moduleManifest = {
  schema_version: '1',
  id: 'community.deft.contacts',
  slug: 'contacts',
  version: '1.0.0',
  name: 'Contacts',
  collections: [],
};

async function fixture() {
  const artifact = await prepareModuleArtifact({
    path: 'modules/contacts/deft.module.json',
    manifest: moduleManifest,
  });
  const manifest: DeftAppManifestV0Input = {
    schema_version: '0',
    id: 'community.deft.contacts-app',
    version: '1.0.0',
    name: 'Contacts App',
    license: 'AGPL-3.0-only',
    compatibility: { app_protocol: '0' },
    modules: [
      {
        module_id: moduleManifest.id,
        version: moduleManifest.version,
        manifest_path: artifact.path,
        manifest_digest: artifact.digest,
      },
    ],
    navigation: [
      { key: 'contacts', label: 'Contacts', module_id: moduleManifest.id, collection_key: 'contacts' },
    ],
  };
  return { artifact, manifest };
}

describe('App Protocol v0 contract', () => {
  test('builds and verifies byte-identical deterministic packages', async () => {
    const { artifact, manifest } = await fixture();
    const first = await buildDeftAppPackage({ manifest, artifacts: [artifact] });
    const reordered = {
      navigation: manifest.navigation,
      modules: manifest.modules,
      compatibility: manifest.compatibility,
      license: manifest.license,
      name: manifest.name,
      version: manifest.version,
      id: manifest.id,
      schema_version: manifest.schema_version,
    } satisfies DeftAppManifestV0Input;
    const second = await buildDeftAppPackage({ manifest: reordered, artifacts: [artifact] });

    assert.equal(first.json, second.json);
    assert.equal(first.digest, second.digest);
    assert.deepEqual(await verifyDeftAppPackageJson(first.json), first);
  });

  test('exports a machine-readable strict authoring schema', () => {
    const schema = getDeftAppManifestV0JsonSchema();
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal((schema as { additionalProperties?: boolean }).additionalProperties, false);
  });

  test('rejects capability planes reserved for later protocol versions', async () => {
    const { manifest } = await fixture();
    for (const forbidden of [
      'capabilities',
      'connectors',
      'secrets',
      'experience',
      'runtime',
      'sync',
      'automation',
      'public',
      'grants',
      'entitlement',
      'billing',
    ]) {
      assert.equal(DeftAppManifestV0Schema.safeParse({ ...manifest, [forbidden]: {} }).success, false, forbidden);
    }
  });

  test('rejects unsafe, ambiguous, and reserved artifact paths', () => {
    for (const path of [
      '../deft.module.json',
      '/modules/deft.module.json',
      'c:/modules/deft.module.json',
      'modules\\deft.module.json',
      'modules//deft.module.json',
      'Modules/deft.module.json',
      'módules/deft.module.json',
      '.git/config',
      'node_modules/x.json',
      'deft.app.json',
      'package.json',
    ]) {
      assert.equal(AppArtifactPathSchema.safeParse(path).success, false, path);
    }
  });

  test('rejects duplicate module identities, paths, and navigation keys', async () => {
    const { artifact, manifest } = await fixture();
    const moduleReference = manifest.modules[0]!;
    assert.equal(
      DeftAppManifestV0Schema.safeParse({ ...manifest, modules: [moduleReference, moduleReference] }).success,
      false,
    );
    assert.equal(
      DeftAppManifestV0Schema.safeParse({
        ...manifest,
        navigation: [manifest.navigation![0]!, manifest.navigation![0]!],
      }).success,
      false,
    );
    await assert.rejects(
      buildDeftAppPackage({ manifest, artifacts: [artifact, artifact] }),
      /Duplicate package artifact path|exactly the artifacts/,
    );
  });

  test('rejects unsupported protocols, media types, malformed JSON, and integrity drift', async () => {
    const { artifact, manifest } = await fixture();
    assert.equal(
      DeftAppManifestV0Schema.safeParse({ ...manifest, compatibility: { app_protocol: '1' } }).success,
      false,
    );
    await assert.rejects(verifyDeftAppPackageJson('{'), /not valid JSON/);
    assert.equal(
      await digestAppManifest(manifest),
      await digestAppManifest(JSON.parse(JSON.stringify(manifest)) as unknown),
    );

    await assert.rejects(
      buildDeftAppPackage({
        manifest,
        artifacts: [{ ...artifact, media_type: 'text/plain' as typeof DEFT_MODULE_ARTIFACT_MEDIA_TYPE }],
      }),
    );
    await assert.rejects(
      buildDeftAppPackage({ manifest, artifacts: [{ ...artifact, digest: `sha256:${'0'.repeat(64)}` }] }),
      /digest mismatch/,
    );
    await assert.rejects(
      buildDeftAppPackage({ manifest, artifacts: [{ ...artifact, byte_length: artifact.byte_length + 1 }] }),
      /byte length mismatch/,
    );
  });

  test('preserves direct v0 rejection issues instead of wrapping them in a v1 union error', async () => {
    const invalid = {
      schema_version: '0',
      id: 'community.deft.bad',
      version: '1.0.0',
      name: 'Bad',
      license: 'AGPL-3.0-only',
      compatibility: { app_protocol: '0' },
      modules: [],
      runtime: {},
    };
    assert.throws(
      () => parseDeftAppManifest(invalid),
      (error: any) => {
        assert.deepEqual(error.issues, [
          {
            origin: 'array',
            code: 'too_small',
            minimum: 1,
            inclusive: true,
            path: ['modules'],
            message: 'Too small: expected array to have >=1 items',
          },
          {
            code: 'unrecognized_keys',
            keys: ['runtime'],
            path: [],
            message: 'Unrecognized key: "runtime"',
          },
        ]);
        return true;
      },
    );

    const { artifact, manifest } = await fixture();
    const built = await buildDeftAppPackage({ manifest, artifacts: [artifact] });
    const invalidPackage = JSON.parse(built.json) as any;
    invalidPackage.manifest.modules = [];
    invalidPackage.manifest.runtime = {};
    await assert.rejects(
      verifyDeftAppPackageJson(JSON.stringify(invalidPackage)),
      (error: any) => {
        assert.deepEqual(error.issues.map((issue: any) => ({ code: issue.code, path: issue.path })), [
          { code: 'too_small', path: ['manifest', 'modules'] },
          { code: 'unrecognized_keys', path: ['manifest'] },
        ]);
        return true;
      },
    );
  });

  test('rejects module identity drift and orphan artifacts', async () => {
    const { artifact, manifest } = await fixture();
    const other = await prepareModuleArtifact({
      path: 'modules/other/deft.module.json',
      manifest: { ...moduleManifest, id: 'community.deft.other' },
    });
    await assert.rejects(buildDeftAppPackage({ manifest, artifacts: [other] }), /Missing module artifact/);
    await assert.rejects(buildDeftAppPackage({ manifest, artifacts: [artifact, other] }), /exactly the artifacts/);
  });
});
