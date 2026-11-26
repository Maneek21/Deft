import assert from 'node:assert/strict';
import test from 'node:test';
import { formatManifestError, formatManifestIssues } from '../src/module-issues';
import { parseDeftModuleManifest, parseSupportedDeftModuleManifest } from '../src/modules';

function appFile(schema: unknown) {
  return {
    schema_version: '1', id: 'org.example.inventory', slug: 'inventory',
    version: '3.8.12', name: 'Inventory', $schema: schema, accidental_key: true,
    collections: [{ key: 'items', name: 'Items', fields: [{ key: 'title', label: 'Title', type: 'text' }] }],
  };
}

function diagnostic(input: unknown, parse: (value: unknown) => unknown) {
  try { parse(input); } catch (error) { return formatManifestError(error, { input }); }
  assert.fail('invalid schema link must be rejected');
}

function assertTextUrl(input: unknown) {
  // Exercise both the v1 server parser and the browser's supported-version parser.
  for (const parse of [parseDeftModuleManifest, parseSupportedDeftModuleManifest]) {
    const report = diagnostic(input, parse);
    assert.match(report.message, /\$schema:.*text URL/i, report.message);
    assert.doesNotMatch(report.message, /unknown keys?[^\n]*\$schema/i, report.message);
    assert.match(report.message, /unknown keys?[^\n]*accidental_key/i, report.message);
  }
}

test('non-text schema links need a text URL while unrelated unknown keys remain visible', () => {
  for (const schema of [null, false, 17, {}, [], ['https://example.test/schema']]) {
    assertTextUrl(appFile(schema));
  }
  // An App Kit package root does not declare this key. Its caller can retain strict unknown-key text.
  const packageReport = formatManifestIssues([
    { code: 'unrecognized_keys', path: [], keys: ['$schema', 'accidental_key'] },
  ], { input: appFile(false), schemaKeyAllowed: false });
  assert.match(packageReport.message, /unknown keys?[^\n]*\$schema/i);
  assert.doesNotMatch(packageReport.message, /text URL/i);
});

test('schema links over 2048 characters need a bounded text URL diagnostic', () => {
  for (const schema of ['https://example.test/' + 'a'.repeat(2049), '😀'.repeat(2049)]) {
    const input = appFile(schema);
    assertTextUrl(input);
    const report = diagnostic(input, parseSupportedDeftModuleManifest);
    assert.match(report.message, /2048/);
    assert.ok(report.message.length < 500, report.message);
    // 2048 Unicode characters remain valid: only the unrelated key should be refused.
    const boundary = diagnostic(appFile('😀'.repeat(2048)), parseSupportedDeftModuleManifest);
    assert.doesNotMatch(boundary.message, /\$schema/);
  }
});
