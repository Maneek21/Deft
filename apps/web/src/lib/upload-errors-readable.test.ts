import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ModuleManifestError,
  formatModuleManifestError,
  moduleApiError,
  previewModuleManifestJson,
} from './modules';
import { appApiError } from './apps';

function hiring(fieldCount: number) {
  return {
    schema_version: '1',
    id: 'com.example.hiring',
    slug: 'hiring',
    version: '1.0.0',
    name: 'Hiring',
    collections: [
      { key: 'roles', name: 'Roles', fields: [{ key: 'title', label: 'Title', type: 'text' }] },
      {
        key: 'candidates',
        name: 'Candidates',
        fields: Array.from({ length: fieldCount }, (_, index) => ({ key: `f_${index}`, label: `F ${index}`, type: 'text' })),
      },
    ],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('the browser check explains a refused manifest in plain lines', async () => {
  await assert.rejects(
    () => previewModuleManifestJson(JSON.stringify(hiring(500))),
    (error: unknown) => error instanceof ModuleManifestError
      && error.message === 'Candidates → fields: at most 64 fields (you have 500)'
      && error.lines.length === 1,
  );
});

test('the browser check gives the line of a JSON syntax error', async () => {
  await assert.rejects(
    () => previewModuleManifestJson('{\n  "id": "x",\n}'),
    (error: unknown) => error instanceof ModuleManifestError
      && error.message === "The file isn't valid JSON near line 3, column 1. Look for a missing or extra comma, quote or bracket.",
  );
});

test('formatModuleManifestError turns any thrown parse error into readable text', () => {
  const issues = [{ code: 'too_big', origin: 'array', maximum: 64, path: ['collections', 1, 'fields'], message: 'Too big' }];
  const text = formatModuleManifestError({ issues }, JSON.stringify(hiring(70)));
  assert.equal(text, 'Candidates → fields: at most 64 fields (you have 70)');
  assert.equal(formatModuleManifestError(new Error('[{"code":"invalid_union"}]')), 'App file is not valid');
});

test('moduleApiError shows the server lines, at most three, never raw JSON', async () => {
  const lines = ['version: must be a version like 1.0.0', 'App file: unknown key "script": remove it'];
  assert.equal(
    await moduleApiError(jsonResponse(400, { error: lines.join('\n'), code: 'MODULE_MANIFEST_INVALID', details: { lines } }), 'Failed'),
    lines.join('\n'),
  );
  const many = ['a: x', 'b: y', 'c: z', 'd: w', 'e: v'];
  const shown = (await moduleApiError(jsonResponse(400, { error: 'x', details: { lines: many } }), 'Failed')).split('\n');
  assert.equal(shown.length, 3);
  assert.equal(
    await moduleApiError(jsonResponse(400, { error: '[{"code":"invalid_union","errors":[[{"origin":"array"}]]}]' }), 'Upload failed'),
    'Upload failed',
  );
  assert.equal(
    await moduleApiError(jsonResponse(409, { error: 'This name belongs to an app that ships with Deft. Choose another slug and id.', code: 'MODULE_IDENTITY_RESERVED' }), 'Failed'),
    'This name belongs to an app that ships with Deft. Choose another slug and id.',
  );
});

test('appApiError uses the caller text for a switched-off feature', async () => {
  assert.equal(
    await appApiError(jsonResponse(404, { error: 'Not found', code: 'NOT_FOUND' }), 'Developer pairing is not available here.'),
    'Developer pairing is not available here.',
  );
});

test('appApiError shows the server lines and never raw JSON', async () => {
  const lines = ['App package: unknown key "script": remove it'];
  assert.equal(await appApiError(jsonResponse(400, { error: lines[0], details: { lines } }), 'Failed'), lines[0]);
  assert.equal(
    await appApiError(jsonResponse(400, { error: '[{"code":"invalid_union","errors":[]}]' }), 'Could not inspect'),
    'Could not inspect',
  );
});
