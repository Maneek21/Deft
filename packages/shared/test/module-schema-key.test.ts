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
    assert.deepEqual(formatManifestError(thrown, { input: value }).lines, ['App file: unknown key "$schema": remove it']);
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
