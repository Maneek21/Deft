import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, test } from 'node:test';
import { parseSupportedDeftModuleManifest } from '../src/modules.js';
import { validateJsonSchema } from './json-schema-subset.js';

const published = JSON.parse(readFileSync(new URL('../../../docs/schemas/deft.module.v1.schema.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const templates = new URL('../../../apps/web/src/lib/app-templates/', import.meta.url);
const starterFiles = readdirSync(templates).filter((name) => name.endsWith('.json') && !name.endsWith('.samples.json'));

function readJson(url: URL): Record<string, unknown> {
  return JSON.parse(readFileSync(url, 'utf8')) as Record<string, unknown>;
}

describe('the published app file JSON Schema', () => {
  test('accepts every starter app as written (defaulted properties are optional)', () => {
    assert.equal(starterFiles.length, 4);
    for (const name of starterFiles) {
      const value = readJson(new URL(name, templates));
      assert.deepEqual(validateJsonSchema(published, value), [], name);
      parseSupportedDeftModuleManifest(value);
    }
  });

  test('accepts the website guide example, which names the schema in "$schema"', () => {
    const value = readJson(new URL('./fixtures/equipment-loans.app.json', import.meta.url));
    assert.deepEqual(validateJsonSchema(published, value), []);
    parseSupportedDeftModuleManifest(value);
  });

  test('accepts bundled Contacts', () => {
    const value = readJson(new URL('../../../modules/bundled/contacts/deft.module.json', import.meta.url));
    assert.deepEqual(validateJsonSchema(published, value), []);
  });

  test('still refuses a file missing a property that is truly required, or with an unknown key', () => {
    const value = readJson(new URL('hiring-pipeline.json', templates));
    const { id: _id, ...noId } = value;
    assert.ok(validateJsonSchema(published, noId).some((problem) => problem.includes('missing required id')));
    const collections = value.collections as Array<Record<string, unknown>>;
    const fields = collections[0]!.fields as Array<Record<string, unknown>>;
    const { label: _label, ...noLabel } = fields[0]!;
    const broken = { ...value, collections: [{ ...collections[0], fields: [noLabel, ...fields.slice(1)] }, ...collections.slice(1)] };
    assert.notDeepEqual(validateJsonSchema(published, broken), []);
    assert.notDeepEqual(validateJsonSchema(published, { ...value, script: 'x' }), []);
  });

  test('the checker refuses keywords it does not understand, even where no data reaches them', () => {
    assert.throws(() => validateJsonSchema({ $ref: '#/x' }, {}), /Unsupported JSON Schema keyword \$ref/);
    assert.throws(() => validateJsonSchema({ type: 'object', properties: { optional: { $ref: '#/x' } } }, {}), /\$ref/);
    assert.throws(() => validateJsonSchema({ type: 'array', items: { if: {} } }, []), /if/);
  });

  test('the checker treats inherited names as unknown keys and matches patterns in Unicode mode', () => {
    const value = readJson(new URL('hiring-pipeline.json', templates));
    for (const key of ['constructor', '__proto__', 'toString']) {
      const withKey = JSON.parse(JSON.stringify(value).replace(/^\{/, `{"${key}":"x",`)) as Record<string, unknown>;
      assert.ok(validateJsonSchema(published, withKey).some((problem) => problem.includes(`unknown key ${key}`)), key);
    }
    const emoji = String.fromCodePoint(0x1f600);
    assert.deepEqual(validateJsonSchema({ type: 'string', pattern: '^.$' }, emoji), []);
  });
});
