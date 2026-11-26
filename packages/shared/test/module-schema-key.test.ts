import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  DEFT_MODULE_MANIFEST_SCHEMA_URL,
  digestSupportedModuleManifest,
  getDeftModuleManifestV1JsonSchema,
  parseSupportedDeftModuleManifest,
  parseSupportedDeftModuleManifestJson,
} from '../src/modules.js';
import { formatManifestError } from '../src/module-issues.js';

const manifest = {
  schema_version: '1',
  id: 'com.example.hiring',
  slug: 'hiring',
  version: '1.0.0',
  name: 'Hiring',
  collections: [{ key: 'candidates', name: 'Candidates', fields: [{ key: 'name', label: 'Name', type: 'text' }] }],
};

describe('"$schema" in an app file', () => {
  test('is accepted, dropped from the stored manifest, and left out of the digest', async () => {
    const withSchema = { $schema: DEFT_MODULE_MANIFEST_SCHEMA_URL, ...manifest };
    const parsed = parseSupportedDeftModuleManifest(withSchema);
    assert.equal('$schema' in parsed, false);
    assert.equal(await digestSupportedModuleManifest(withSchema), await digestSupportedModuleManifest(manifest));
    const fromJson = parseSupportedDeftModuleManifestJson(JSON.stringify({ ...manifest, $schema: './deft.module.schema.json' }));
    assert.equal('$schema' in fromJson, false);
  });

  test('must be a link: anything else is refused with a plain line', () => {
    const value = { ...manifest, $schema: 42 };
    let thrown: unknown;
    try { parseSupportedDeftModuleManifest(value); } catch (error) { thrown = error; }
    assert.ok(thrown, 'expected a refusal');
    assert.deepEqual(formatManifestError(thrown, { input: value }).lines, ['$schema: must be a text URL (found a number)']);
  });

  test('a "$schema" that is not a short text URL is never called an unknown key', () => {
    const lines = (value: Record<string, unknown>, options: { schemaKeyAllowed?: boolean } = {}) => {
      let thrown: unknown;
      try { parseSupportedDeftModuleManifest(value); } catch (error) { thrown = error; }
      assert.ok(thrown, 'expected a refusal');
      return formatManifestError(thrown, { input: value, ...options }).lines;
    };
    assert.deepEqual(lines({ ...manifest, $schema: { url: DEFT_MODULE_MANIFEST_SCHEMA_URL } }), ['$schema: must be a text URL (found an object)']);
    assert.deepEqual(lines({ ...manifest, $schema: null }), ['$schema: must be a text URL (found null)']);
    assert.deepEqual(lines({ ...manifest, $schema: 'é'.repeat(3000) }), ['$schema: must be a text URL of at most 2048 characters (you have 3000)']);
    // Other unknown keys are still named as unknown, on their own line.
    assert.deepEqual(lines({ ...manifest, $schema: 42, colour: 'red' }), [
      '$schema: must be a text URL (found a number)',
      'App file: unknown key "colour": remove it',
    ]);
    // Where "$schema" is not allowed at all (an App package), it stays an unknown key.
    assert.deepEqual(lines({ ...manifest, $schema: 42 }, { schemaKeyAllowed: false }), ['App file: unknown key "$schema": remove it']);
  });

  test('the JSON Schema lets editors use "$schema" and names its own address', () => {
    const schema = getDeftModuleManifestV1JsonSchema() as { $id?: string; properties?: Record<string, unknown> };
    assert.equal(schema.$id, DEFT_MODULE_MANIFEST_SCHEMA_URL);
    assert.deepEqual(schema.properties?.$schema, { type: 'string', maxLength: 2048 });
  });

  test('the published schema file matches the validator', () => {
    const published = readFileSync(new URL('../../../docs/schemas/deft.module.v1.schema.json', import.meta.url), 'utf8')
      .split('\r\n').join('\n');
    assert.equal(published, `${JSON.stringify(getDeftModuleManifestV1JsonSchema(), null, 2)}\n`);
  });
});
