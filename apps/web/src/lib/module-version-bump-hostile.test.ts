import assert from 'node:assert/strict';
import test from 'node:test';
import { bumpPatchIfUnchanged, checkModuleManifestEdit, nextPatchVersion, saveModuleManifestEdit } from './module-version-bump';

const manifest = { schema_version: '1', id: 'com.example.testerfour', slug: 'testerfour', version: '1.0.0', name: 'Tester Four', collections: [{ key: 'items', name: 'Items', fields: [{ key: 'name', label: 'Name', type: 'text' }] }] };
const source = (version = '1.0.0', extra = {}) => JSON.stringify({ ...manifest, version, ...extra });
const active = { version: '1.0.0', moduleId: manifest.id, slug: manifest.slug };

test('hostile input: a preceding nested version must not reformat CRLF text or change that nested value', () => {
  const text = '{\r\n\t"nested": { "version": "1.0.0" },\r\n\t"version" : "1.0.0"\r\n}\r\n';
  const expected = text.replace('\t"version" : "1.0.0"', '\t"version" : "1.0.1"');
  assert.equal(bumpPatchIfUnchanged(text, '1.0.0'), expected);
});

test('hostile input: escaped top-level key keeps its spelling and formatting', () => {
  const text = source().replace('"version":"1.0.0"', '"\\u0076ersion" : "1.0.0"');
  assert.equal(bumpPatchIfUnchanged(text, '1.0.0'), text.replace(' : "1.0.0"', ' : "1.0.1"'));
});

test('hostile input: a lower major version beyond safe integer precision must never be saved', async () => {
  const text = source('9007199254740992.1.0');
  const activeVersion = '9007199254740993.0.0';
  const result = await checkModuleManifestEdit(text, { ...active, version: activeVersion });
  let calls = 0;
  try {
    await saveModuleManifestEdit({ slug: manifest.slug, moduleId: manifest.id, source: text,
      activeVersion, activeDigest: `sha256:${'b'.repeat(64)}`,
      fetch: async () => { calls++; return new Response('{"module":{}}'); } });
  } catch { /* A refused edit is expected. The fetch count independently proves no write. */ }
  assert.deepEqual({ allowed: result.ok, posts: calls }, { allowed: false, posts: 0 });
});
test('hostile input: next patch must actually be higher for a large allowed patch', () => {
  assert.equal(nextPatchVersion('1.0.9007199254740992'), '1.0.9007199254740993');
});

test('hostile input: invalid edits and non-increasing versions never reach fetch; good edits carry If-Match', async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const fetch = async (path: string, init: RequestInit) => { calls.push({ path, init }); return new Response('{"module":{}}'); };
  for (const text of ['{', source('1.1.0', { id: 'com.example.changed' }), source('1.1.0', { slug: 'changed' }), source('1.0.0+build.2'), source('0.9.9'), source('1.0.0-rc.1'), source('1.1.0-01'), source('1.1.0-a..b'), '\uFEFF' + source(), ' '.repeat(131073) + source()]) {
    await assert.rejects(saveModuleManifestEdit({ slug: manifest.slug, moduleId: manifest.id, source: text, activeVersion: '1.0.0', activeDigest: `sha256:${'b'.repeat(64)}`, fetch }));
  }
  assert.equal(calls.length, 0);
  const text = source('1.1.0-rc.1+build.2', { description: 'The word "version" inside a string.' }).replaceAll(',', ',\r\n');
  const result = await saveModuleManifestEdit({ slug: manifest.slug, moduleId: manifest.id, source: text, activeVersion: '1.0.0', activeDigest: `sha256:${'b'.repeat(64)}`, fetch });
  assert.equal(result.source, text);
  assert.equal(calls[0]!.path, '/api/modules/testerfour/upgrade');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(new Headers(calls[0]!.init.headers).get('If-Match'), `sha256:${'b'.repeat(64)}`);
  assert.equal(calls[0]!.init.body, text);
});

