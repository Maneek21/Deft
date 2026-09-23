import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  DEFT_APP_DEVELOPER_COMPATIBILITY,
  DeftAppDeveloperCompatibilitySchema,
  parseDeftAppManifest,
  validateDeftModuleManifest,
} from '../dist/index.js';
import { parseSupportedDeftModuleManifest } from '../../shared/src/modules.js';
import { validEquipmentModule } from './fixtures/module-semantic-negative-corpus.js';

const root = resolve(import.meta.dirname, '../../..');

for (const example of [
  'hello-workspace-app',
  'connected-resource-campaigns-app',
  'scheduled-connected-resource-campaigns-app',
]) {
  for (const path of [[], ['modules', 0], ['navigation', 0]]) {
    test(`${example}: unknown keys preserve rejection issues at ${path.join('.') || 'root'}`, () => {
      const manifest = JSON.parse(readFileSync(resolve(root, 'examples', example, 'deft.app.json'), 'utf8'));
      assert.doesNotThrow(() => parseDeftAppManifest(manifest));
      manifest.modules.push(structuredClone(manifest.modules[0]));
      assert.throws(() => parseDeftAppManifest(manifest), (error: unknown) => {
        assert.ok(error && typeof error === 'object' && 'issues' in error);
        assert.ok((error.issues as { code: string }[]).some(issue => issue.code === 'custom'));
        return true;
      });
      let object = manifest;
      for (const key of path) object = object[key];
      object.runtime = {};
      assert.throws(() => parseDeftAppManifest(manifest), (error: unknown) => {
        assert.ok(error && typeof error === 'object' && 'issues' in error);
        assert.deepEqual(error.issues, [{
          code: 'unrecognized_keys', keys: ['runtime'], path,
          message: 'Unrecognized key: "runtime"',
        }]);
        return true;
      });
    });
  }
}

for (const schemaVersion of ['1', '2']) {
  for (const path of [[], ['collections', 0], ['collections', 0, 'fields', 0]]) {
    test(`Module ${schemaVersion}: unknown keys retain host/Kit parity at ${path.join('.') || 'root'}`, () => {
      const manifest: Record<string, any> = structuredClone(validEquipmentModule);
      manifest.schema_version = schemaVersion;
      assert.doesNotThrow(() => parseSupportedDeftModuleManifest(manifest));
      manifest.collections.push(structuredClone(manifest.collections[0]));
      assert.throws(() => parseSupportedDeftModuleManifest(manifest));
      let object = manifest;
      for (const key of path) object = object[key];
      object.runtime = {};
      assert.throws(() => parseSupportedDeftModuleManifest(manifest), (error: unknown) => {
        assert.ok(error && typeof error === 'object' && 'issues' in error);
        // Both branches aborted on unknown keys before Zod 4.6; the public
        // union diagnostic and branch ordering are part of that contract.
        assert.deepEqual(error.issues, [{
          code: 'invalid_union', path: [], message: 'Invalid input',
          errors: ['1', '2'].map(version => [
            ...(version === schemaVersion ? [] : [{
              code: 'invalid_value', values: [version], path: ['schema_version'],
              message: `Invalid input: expected "${version}"`,
            }]),
            { code: 'unrecognized_keys', keys: ['runtime'], path,
              message: 'Unrecognized key: "runtime"' },
          ]),
        }]);
        return true;
      });
      const result = validateDeftModuleManifest(manifest);
      assert.equal(result.success, false);
      assert.equal(result.issues.length, 1);
      assert.equal(result.issues[0]?.reason, 'Invalid input');
    });
  }
}

test('developer compatibility keeps unknown-key diagnostics without accepting duplicate versions', () => {
  const value = structuredClone(DEFT_APP_DEVELOPER_COMPATIBILITY);
  const invalid = { ...value, app_kit: { ...value.app_kit, versions: [...value.app_kit.versions, value.app_kit.versions[0]] } };
  assert.equal(DeftAppDeveloperCompatibilitySchema.safeParse(invalid).success, false);
  const result = DeftAppDeveloperCompatibilitySchema.safeParse({ ...invalid, runtime: {} });
  assert.equal(result.success, false);
  if (!result.success) assert.deepEqual(result.error.issues, [{
    code: 'unrecognized_keys', keys: ['runtime'], path: [],
    message: 'Unrecognized key: "runtime"',
  }]);
});
