import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  formatManifestError,
  formatManifestIssues,
  READABLE_ISSUE_LINE_LIMIT,
} from '../src/module-issues.js';
import {
  DeftModuleManifestSchema,
  parseSupportedDeftModuleManifestJson,
} from '../src/modules.js';

const RLO = String.fromCodePoint(0x202e);

function hiring(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: '1',
    id: 'com.example.hiring',
    slug: 'hiring',
    version: '1.0.0',
    name: 'Hiring',
    collections: [
      { key: 'roles', name: 'Roles', fields: [{ key: 'title', label: 'Title', type: 'text' }] },
      { key: 'candidates', name: 'Candidates', fields: [{ key: 'name', label: 'Name', type: 'text' }] },
    ],
    ...overrides,
  };
}

function readable(value: unknown, source?: string) {
  const parsed = DeftModuleManifestSchema.safeParse(value);
  assert.equal(parsed.success, false, 'the probe must be invalid');
  return formatManifestError(parsed.error, { input: value, source });
}

function assertPlain(lines: string[]) {
  assert.ok(lines.length >= 1 && lines.length <= READABLE_ISSUE_LINE_LIMIT, `1-3 lines, got ${lines.length}`);
  for (const line of lines) {
    assert.doesNotMatch(line, /\[\s*\{|\{\s*"/, `no raw JSON in ${line}`);
    assert.doesNotMatch(line, /[<>]/, `no markup in ${line}`);
    assert.ok(!Array.from(line).some((char) => { const point = char.codePointAt(0)!; return point < 0x20 || (point >= 0x202a && point <= 0x202e) || (point >= 0x2066 && point <= 0x2069); }), `no control or bidi characters in ${line}`);
    assert.ok(line.length <= 240, `bounded line: ${line.length}`);
  }
}

describe('readable manifest issues', () => {
  test('names the collection for too many fields, from the v1 branch of the union', () => {
    const manifest = hiring();
    manifest.collections[1]!.fields = Array.from({ length: 500 }, (_, index) => ({
      key: `field_${index}`, label: `Field ${index}`, type: 'text',
    }));
    const result = readable(manifest);
    assert.deepEqual(result.lines, ['Candidates → fields: at most 64 fields (you have 500)']);
    assert.doesNotMatch(result.message, /schema_version/);
  });

  test('a bad version and an unknown key read as plain sentences', () => {
    const result = readable(hiring({ version: 'one', script: 'alert(1)' }));
    assert.deepEqual(result.lines, [
      'version: must be a version like 1.0.0',
      'App file: unknown key "script": remove it',
    ]);
  });

  test('a top-level array names the whole file', () => {
    const result = readable([1, 2]);
    assert.deepEqual(result.lines, ['App file: must be an object (found a list)']);
  });

  test('a v2 manifest is explained from the v2 branch', () => {
    const result = readable(hiring({ schema_version: '2', version: 'x' }));
    assert.deepEqual(result.lines, ['version: must be a version like 1.0.0']);
  });

  test('names a field by its label and an unnamed element by its position', () => {
    const manifest = hiring();
    manifest.collections[1]!.fields.push({ key: 'stage', label: 'Stage', type: 'colour' } as never);
    manifest.collections.push({ fields: [] } as never);
    const result = readable(manifest);
    assert.ok(result.lines.some((line) => line.startsWith('Candidates → Stage → type: must be one of')), result.message);
    assert.ok(result.lines.some((line) => line.startsWith('record type 3 → key: is required')), result.message);
  });

  test('keeps to three lines and counts the rest', () => {
    const result = readable(hiring({ id: 'X', slug: 'Bad Slug', version: 'x', name: '' }));
    assert.equal(result.lines.length, 3);
    assert.match(result.lines[2]!, /^…and \d+ more problems\. Fix these, then check again\.$/);
    assert.ok(result.issues.length >= 4);
    assertPlain(result.lines);
  });

  test('hostile names, keys and labels never reach a line as markup or hidden text', () => {
    const manifest = hiring({ ['<script>x</script>' + RLO]: 1 });
    manifest.collections[1]!.name = '"><svg onload=alert(1)>' + RLO + 'Candidates';
    manifest.collections[1]!.fields = Array.from({ length: 65 }, (_, index) => ({
      key: `f_${index}`, label: `<img src=x onerror=alert(${index})>`, type: 'text',
    }));
    const result = readable(manifest);
    assertPlain(result.lines);
    assert.ok(result.lines.some((line) => /fields: at most 64 fields \(you have 65\)/.test(line)), result.message);
  });

  test('very long names are cut short', () => {
    const manifest = hiring();
    manifest.collections[1]!.name = 'C'.repeat(5000);
    manifest.collections[1]!.fields = Array.from({ length: 65 }, (_, index) => ({
      key: `f_${index}`, label: `F ${index}`, type: 'text',
    }));
    const result = readable(manifest);
    assertPlain(result.lines);
  });

  test('deep nesting and huge issue lists stay fast and bounded', () => {
    let deep: unknown = 'x';
    for (let index = 0; index < 20_000; index += 1) deep = [deep];
    const started = performance.now();
    const result = readable(hiring({ collections: deep }));
    assertPlain(result.lines);

    const issues = Array.from({ length: 50_000 }, (_, index) => ({ code: 'custom', path: ['x', index], message: 'bad' }));
    const many = formatManifestIssues(issues, { input: {} });
    assertPlain(many.lines);
    assert.ok(many.issues.length <= 20);
    assert.ok(performance.now() - started < 2000, 'bounded time');
  });

  test('a JSON syntax error gives the line and column, not the parser text', () => {
    const source = '{\n  "schema_version": "1",\n  "id": "com.example.x",\n}';
    let thrown: unknown;
    try { parseSupportedDeftModuleManifestJson(source); } catch (error) { thrown = error; }
    const result = formatManifestError(thrown, { source });
    assert.equal(result.lines.length, 1);
    assert.match(result.lines[0]!, /^The file isn't valid JSON near line 4, column 1\. Look for a missing or extra comma, quote or bracket\.$/);
  });

  test('an unknown error whose text is raw JSON is replaced', () => {
    const result = formatManifestError(new Error('[{"code":"invalid_union","errors":[]}]'), { subject: 'App package' });
    assert.deepEqual(result.lines, ['App package is not valid']);
  });

  test('custom validator messages drop their subject and keep their meaning', () => {
    const manifest = hiring({ navigation: { default_collection: 'nope' } });
    const result = readable(manifest);
    assertPlain(result.lines);
    assert.ok(result.lines.every((line) => !/^Invalid|Too big/.test(line.split(': ')[1] ?? '')), result.message);
  });

  test('an unknown error with markup or regex text never reaches a line', () => {
    assert.deepEqual(formatManifestError(new Error('Field must match /^[a-z]+$/')).lines, ['App file is not valid']);
    assert.deepEqual(formatManifestError(new Error('Bad <img src=x onerror=alert(1)> value')).lines, ['Bad img src=x onerror=alert(1) value']);
  });

  test('a label with quotes or brackets cannot make a line look like JSON', () => {
    const manifest = hiring();
    manifest.collections[1]!.name = 'a": {"x';
    manifest.collections[1]!.fields = Array.from({ length: 65 }, (_, index) => ({ key: `f_${index}`, label: `F ${index}`, type: 'text' }));
    const result = readable(manifest);
    assert.deepEqual(result.lines, ['a: x → fields: at most 64 fields (you have 65)']);
  });

  test('counts characters the way the validator does and keeps words ending in -us', () => {
    const issues = [
      { code: 'too_big', origin: 'string', maximum: 3, path: ['name'], message: 'Too big' },
      { code: 'too_big', origin: 'array', maximum: 1, path: ['status'], message: 'Too big' },
    ];
    const result = formatManifestIssues(issues, { input: { name: '😀😀', status: [1, 2] } });
    assert.deepEqual(result.lines, ['name: at most 3 characters (you have 4)', 'status: at most 1 status (you have 2)']);
  });

  test('a prefix names the module inside an App package', () => {
    const result = formatManifestIssues(
      [{ code: 'too_big', origin: 'array', maximum: 64, path: ['collections', 0, 'fields'], message: 'Too big' }],
      { input: { collections: [{ name: 'Leads', fields: new Array(70).fill({}) }] }, prefix: 'Module modules/crm.json' },
    );
    assert.deepEqual(result.lines, ['Module modules/crm.json → Leads → fields: at most 64 fields (you have 70)']);
  });
});
