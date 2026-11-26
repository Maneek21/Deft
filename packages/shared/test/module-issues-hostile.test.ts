import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatManifestError, READABLE_ISSUE_LINE_LIMIT } from '../src/module-issues.js';
import { DeftModuleManifestSchema, parseSupportedDeftModuleManifestJson } from '../src/modules.js';

function hiring(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: '1',
    id: 'com.example.hiring',
    slug: 'hiring',
    version: '1.0.0',
    name: 'Hiring',
    collections: [
      { key: 'candidates', name: 'Candidates', fields: [{ key: 'name', label: 'Name', type: 'text' }] },
    ],
    ...overrides,
  } as Record<string, unknown> & { collections: Array<Record<string, unknown>> };
}

function readable(value: unknown) {
  const parsed = DeftModuleManifestSchema.safeParse(value);
  assert.equal(parsed.success, false, 'the probe must be invalid');
  return formatManifestError(parsed.error, { input: value });
}

function readableJson(source: string) {
  try {
    parseSupportedDeftModuleManifestJson(source);
  } catch (error) {
    let input: unknown;
    try { input = JSON.parse(source); } catch { input = undefined; }
    return formatManifestError(error, { input, source });
  }
  assert.fail('expected a refusal');
}

const RAW_JSON = /\[\s*\{|\{\s*"/;
// Invisible format characters (Unicode Cf) that render as nothing.
const INVISIBLE_RANGES: Array<[number, number]> = [[0xad, 0xad], [0x34f, 0x34f], [0x180e, 0x180e], [0x2060, 0x2064], [0xfe00, 0xfe0f], [0xe0000, 0xe007f]];
const hasInvisible = (line: string) => Array.from(line).some((char) => INVISIBLE_RANGES.some(([low, high]) => char.codePointAt(0)! >= low && char.codePointAt(0)! <= high));

function assertPlain(lines: string[]) {
  assert.ok(lines.length >= 1 && lines.length <= READABLE_ISSUE_LINE_LIMIT);
  for (const line of lines) {
    assert.doesNotMatch(line, RAW_JSON, `no raw JSON in ${line}`);
    assert.doesNotMatch(line, /[<>]/, `no markup in ${line}`);
    assert.ok(!hasInvisible(line), `no invisible characters in ${JSON.stringify(line)}`);
  }
}

describe('hostile input: readable manifest issues', () => {
  test('a collection named like raw JSON never puts raw JSON in a line', () => {
    const manifest = hiring();
    manifest.collections[0]!.name = '[{"a":1}]';
    manifest.collections[0]!.fields = Array.from({ length: 65 }, (_, index) => ({
      key: `field_${index}`, label: `Field ${index}`, type: 'text',
    }));
    assertPlain(readable(manifest).lines);
  });

  test('a truncated JSON file names its line and column', () => {
    const result = readableJson('{\n  "schema_version": "1",\n  "id": "com.example.hiring"');
    assert.match(result.message, /line \d+, column \d+/, result.message);
  });

  test('invisible tag characters and soft hyphens in a name never reach a line', () => {
    const manifest = hiring();
    manifest.collections[0]!.name = `Cand${String.fromCodePoint(0xad)}i${String.fromCodePoint(0xe0041, 0xe0042)}dates`;
    manifest.collections[0]!.fields = Array.from({ length: 65 }, (_, index) => ({
      key: `field_${index}`, label: `Field ${index}`, type: 'text',
    }));
    assertPlain(readable(manifest).lines);
  });
});
