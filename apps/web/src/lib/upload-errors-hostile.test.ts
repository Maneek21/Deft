import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleApiError, previewModuleManifestJson, formatModuleManifestError } from './modules';
import { appApiError } from './apps';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('hostile input: a server refusal carrying markup is shown without markup', async () => {
  const body = { error: 'Unexpected multipart field: <img src=x onerror=alert(1)>', code: 'MODULE_MANIFEST_INVALID' };
  assert.doesNotMatch(await moduleApiError(json(400, body), 'Upload failed'), /[<>]/);
  assert.doesNotMatch(await appApiError(json(400, body), 'Upload failed'), /[<>]/);
});

test('hostile input: the browser check never shows raw JSON from a collection name', async () => {
  const manifest = {
    schema_version: '1', id: 'com.example.hiring', slug: 'hiring', version: '1.0.0', name: 'Hiring',
    collections: [{ key: 'candidates', name: '{"a":1}', fields: Array.from({ length: 500 }, (_, i) => ({ key: `f_${i}`, label: `F ${i}`, type: 'text' })) }],
  };
  const source = JSON.stringify(manifest);
  let message = '';
  try { await previewModuleManifestJson(source); } catch (error) { message = formatModuleManifestError(error, source); }
  assert.ok(message, 'expected a refusal');
  assert.doesNotMatch(message, /\[\s*\{|\{\s*"/, message);
});
