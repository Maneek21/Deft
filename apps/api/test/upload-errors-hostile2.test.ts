import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { buildDeftAppPackage, digestAppManifest, prepareModuleArtifact } from '@deft/app-kit';
import { inspectAppPackageJson } from '../src/lib/app-service.js';
import { AppError } from '../src/lib/app-errors.js';
import { closeDb } from '../src/lib/db.js';

after(async () => closeDb());

const PATH = 'modules/hiring/deft.module.json';
const moduleManifest = {
  schema_version: '1', id: 'com.example.hiring', slug: 'hiring', version: '1.0.0', name: 'Hiring',
  collections: [{
    key: 'candidates', name: 'Candidates',
    fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
    views: [{ key: 'all', name: 'All', type: 'table', fields: ['name'] }],
  }],
};

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** A well-formed App package whose module file is replaced by `content`, digests kept consistent. */
async function packageWithModule(content: string): Promise<string> {
  const artifact = await prepareModuleArtifact({ path: PATH, manifest: moduleManifest });
  const built = await buildDeftAppPackage({
    manifest: {
      schema_version: '0', id: 'com.example.hiring-app', version: '1.0.0', name: 'Hiring',
      license: 'AGPL-3.0-only', compatibility: { app_protocol: '0' },
      modules: [{ module_id: moduleManifest.id, version: '1.0.0', manifest_path: artifact.path, manifest_digest: artifact.digest }],
      navigation: [],
    },
    artifacts: [artifact],
  });
  const value = JSON.parse(built.json) as any;
  const digest = await sha256(content);
  value.artifacts[0].content = content;
  value.artifacts[0].byte_length = new TextEncoder().encode(content).byteLength;
  value.artifacts[0].digest = digest;
  value.manifest.modules[0].manifest_digest = digest;
  value.manifest_digest = await digestAppManifest(value.manifest);
  return JSON.stringify(value);
}

async function refusal(content: string): Promise<AppError> {
  try { await inspectAppPackageJson(await packageWithModule(content)); } catch (error) {
    assert.ok(error instanceof AppError, `not an AppError: ${String(error)}`);
    return error;
  }
  assert.fail('expected the package to be refused');
}

// Unicode Default_Ignorable_Code_Point and other format (Cf) characters that render as nothing.
const IGNORABLE: Array<[number, number]> = [
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff0, 0xfffb], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0xe0000, 0xe0fff],
];
const ignorableIn = (text: string) => Array.from(text)
  .filter((c) => IGNORABLE.some(([lo, hi]) => c.codePointAt(0)! >= lo && c.codePointAt(0)! <= hi))
  .map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);

/** Everything a person or a client can see: the message, the lines and the issues. */
function visibleText(error: AppError): string[] {
  const details = (error.details ?? {}) as { lines?: string[]; issues?: Array<{ path: unknown[]; message: string }> };
  return [
    error.message,
    ...(details.lines ?? []),
    ...(details.issues ?? []).flatMap((issue) => [issue.message, ...issue.path.map(String)]),
  ];
}

function assertBounded(error: AppError, label: string) {
  assert.equal(error.status, 400, label);
  assert.equal(error.code, 'APP_INVALID_PACKAGE', label);
  const lines = error.message.split('\n');
  assert.ok(lines.length >= 1 && lines.length <= 5, `${label}: ${lines.length} lines`);
  for (const line of lines) assert.ok(line.length <= 240, `${label}: ${line.length} chars`);
}

const INVISIBLES = [
  0xe0100, 0xe01ef, // variation selectors supplement
  0x180b, 0x180c, 0x180d, 0x180f, // Mongolian free variation selectors
  0x115f, 0x1160, 0x3164, 0xffa0, // Hangul fillers
  0x17b4, 0x17b5, // Khmer inherent vowels
  0xfff9, 0xfffa, 0xfffb, // interlinear annotation
  0x1bca0, 0x1bca3, 0x1d173, 0x1d17a, // shorthand and musical format controls
];

test('hostile input: an App file line carries no invisible character from a hostile collection name', async () => {
  const bad = structuredClone(moduleManifest) as any;
  bad.collections[0].name = `Cand${INVISIBLES.map((p) => String.fromCodePoint(p)).join('')}idates`;
  bad.collections[0].fields = Array.from({ length: 65 }, (_, i) => ({ key: `f_${i}`, label: `F ${i}`, type: 'text' }));
  bad.collections[0].views[0].fields = ['f_0'];
  const error = await refusal(JSON.stringify(bad));
  assertBounded(error, 'invisible');
  assert.match(error.message, new RegExp(`App file ${PATH.replace(/[./]/g, '\\$&')} → `), error.message);
  const leaked = visibleText(error).flatMap(ignorableIn);
  assert.deepEqual([...new Set(leaked)], [], `invisible characters reached the person: ${JSON.stringify(error.message)}`);
});

test('hostile input: hostile keys and names inside an App file never put markup or raw JSON in any visible text', async () => {
  const probes: Array<[string, unknown]> = [
    ['unknown root key', { ...moduleManifest, '<img src=x onerror=alert(1)>': 1, '{"a":[{"b":1}]}': 2 }],
    ['unknown field key', { ...moduleManifest, collections: [{ ...moduleManifest.collections[0], fields: [
      { key: 'name', label: 'Name', type: 'text', '<script>x</script>': true }] }] }],
    ['hostile type value', { ...moduleManifest, collections: [{ ...moduleManifest.collections[0], fields: [
      { key: 'name', label: 'Name', type: '<svg onload=alert(1)>' }] }] }],
    ['hostile collection name + bad field', { ...moduleManifest, collections: [{ ...moduleManifest.collections[0],
      name: '</p><b>[{"x":1}]', fields: [{ key: 'name', label: 'Name', type: 'nope' }] }] }],
  ];
  for (const [label, manifest] of probes) {
    const error = await refusal(JSON.stringify(manifest));
    assertBounded(error, label);
    for (const text of visibleText(error)) {
      assert.doesNotMatch(text, /[<>]/, `${label}: markup in ${JSON.stringify(text)}`);
      assert.doesNotMatch(text, /\[\s*\{|\{\s*"/, `${label}: raw JSON in ${JSON.stringify(text)}`);
    }
  }
});

test('hostile input: an App file that is not a module manifest is refused plainly, naming the file, with the code unchanged', async () => {
  const deep = (n: number) => `${'['.repeat(n)}${']'.repeat(n)}`;
  const contents: Array<[string, string]> = [
    ['truncated JSON', '{"schema_version":"1",'],
    ['null', 'null'],
    ['array', '[1,2]'],
    ['string', '"<b>x</b>"'],
    ['deep nesting', `{"schema_version":"1","x":${deep(20000)}}`],
    ['long garbage', `{"schema_version":"1","name":"${'A'.repeat(100_000)}"}`],
    ['bidi key', `{"schema_version":"1","\\u202e<i>":1}`],
  ];
  const failures: string[] = [];
  for (const [label, content] of contents) {
    const error = await refusal(content);
    assertBounded(error, label);
    if (!error.message.includes(`App file ${PATH}`)) failures.push(`${label}: the App file is not named: ${JSON.stringify(error.message)}`);
    for (const text of visibleText(error)) {
      if (/[<>]/.test(text)) failures.push(`${label}: markup in ${JSON.stringify(text)}`);
      if (ignorableIn(text).length) failures.push(`${label}: invisible characters in ${JSON.stringify(text)}`);
      if (text.includes('A'.repeat(300))) failures.push(`${label}: raw content echoed`);
    }
  }
  assert.deepEqual(failures, []);
});
