import assert from 'node:assert/strict';
import test from 'node:test';
import { MODULE_LIMITS } from '@deft/shared/modules';
import {
  MODULE_MANIFEST_REQUEST_MAX_BYTES,
  parseModuleManifestUpload,
} from '../src/lib/module-manifest-upload.js';
import { ModuleError } from '../src/lib/module-errors.js';

const manifest = {
  schema_version: '1',
  id: 'com.example.directory',
  slug: 'example-directory',
  version: '1.0.0',
  name: 'Example directory',
  collections: [{
    key: 'entries',
    name: 'Entries',
    fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
  }],
};

test('parses a strict raw JSON manifest and returns its canonical digest', async () => {
  const parsed = await parseModuleManifestUpload(new Request('http://deft.test/api/modules/sideload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(manifest),
  }));

  assert.equal(parsed.manifest.id, manifest.id);
  assert.equal(parsed.manifest.collections[0]?.fields[0]?.required, true);
  assert.match(parsed.manifest_digest, /^sha256:[a-f0-9]{64}$/);
});

test('requires an optimistic active digest for upgrades', async () => {
  await assert.rejects(
    () => parseModuleManifestUpload(new Request('http://deft.test/api/modules/example-directory/upgrade', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...manifest, version: '1.1.0' }),
    }), { requireExpectedActiveDigest: true }),
    (error: unknown) => error instanceof ModuleError
      && error.code === 'MODULE_MANIFEST_INVALID'
      && error.status === 400,
  );
});

test('accepts a local deft.module.json multipart upload and expected digest', async () => {
  const expected = `sha256:${'a'.repeat(64)}`;
  const form = new FormData();
  form.append('file', new File([JSON.stringify(manifest)], 'deft.module.json', { type: 'application/json' }));
  form.append('expected_active_digest', expected);
  const request = new Request('http://deft.test/api/modules/example-directory/upgrade', {
    method: 'POST',
    body: form,
  });

  const parsed = await parseModuleManifestUpload(request, { requireExpectedActiveDigest: true });
  assert.equal(parsed.expected_active_digest, expected);
  assert.equal(parsed.manifest.slug, manifest.slug);
});

test('rejects oversize bodies before manifest parsing', async () => {
  assert.equal(MODULE_MANIFEST_REQUEST_MAX_BYTES, MODULE_LIMITS.manifest_bytes);
  const request = new Request('http://deft.test/api/modules/sideload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(MODULE_MANIFEST_REQUEST_MAX_BYTES + 1),
  });
  await assert.rejects(
    () => parseModuleManifestUpload(request),
    (error: unknown) => error instanceof ModuleError
      && error.code === 'MODULE_MANIFEST_TOO_LARGE'
      && error.status === 413,
  );
});

test('rejects malformed JSON, unknown manifest keys, and remote media types', async () => {
  await assert.rejects(
    () => parseModuleManifestUpload(new Request('http://deft.test/api/modules/sideload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    })),
    (error: unknown) => error instanceof ModuleError && error.code === 'MODULE_MANIFEST_INVALID',
  );

  await assert.rejects(
    () => parseModuleManifestUpload(new Request('http://deft.test/api/modules/sideload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...manifest, download_url: 'https://example.test/module.js' }),
    })),
    (error: unknown) => error instanceof ModuleError && error.code === 'MODULE_MANIFEST_INVALID',
  );

  await assert.rejects(
    () => parseModuleManifestUpload(new Request('http://deft.test/api/modules/sideload', {
      method: 'POST',
      headers: { 'content-type': 'text/uri-list' },
      body: 'https://example.test/deft.module.json',
    })),
    (error: unknown) => error instanceof ModuleError
      && error.code === 'MODULE_MEDIA_TYPE_UNSUPPORTED'
      && error.status === 415,
  );
});

function hiringManifest(fieldCount: number) {
  return {
    ...manifest,
    id: 'com.example.hiring',
    slug: 'hiring',
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

async function uploadError(body: string, contentType = 'application/json'): Promise<ModuleError> {
  try {
    if (contentType === 'multipart') {
      const form = new FormData();
      form.append('file', new File([body], 'deft.module.json', { type: 'application/json' }));
      await parseModuleManifestUpload(new Request('http://deft.test/api/modules/sideload', { method: 'POST', body: form }));
    } else {
      await parseModuleManifestUpload(new Request('http://deft.test/api/modules/sideload', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body,
      }));
    }
  } catch (error) {
    assert.ok(error instanceof ModuleError, String(error));
    return error;
  }
  assert.fail('expected the upload to be refused');
}

test('a refused manifest names the path in plain words, never raw validator JSON', async () => {
  for (const mode of ['application/json', 'multipart']) {
    const error = await uploadError(JSON.stringify(hiringManifest(500)), mode);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'MODULE_MANIFEST_INVALID');
    assert.equal(error.message, 'Candidates → fields: at most 64 fields (you have 500)');
    assert.deepEqual(error.details?.lines, ['Candidates → fields: at most 64 fields (you have 500)']);
    assert.doesNotMatch(error.message, /\[\{|\{"/);
  }
});

test('a refused manifest keeps to three lines', async () => {
  const error = await uploadError(JSON.stringify({ ...manifest, id: 'X', slug: 'Bad', version: 'v', name: '', script: 1 }));
  const lines = error.details?.lines as string[];
  assert.equal(lines.length, 3);
  assert.equal(error.message, lines.join('\n'));
  assert.ok(Array.isArray(error.details?.issues));
  for (const line of lines) assert.doesNotMatch(line, /\[\{|\{"|\/\^/);
});

test('malformed JSON names the line and column', async () => {
  const error = await uploadError('{\n  "schema_version": "1",\n}');
  assert.equal(error.message, "The file isn't valid JSON near line 3, column 1. Look for a missing or extra comma, quote or bracket.");
});
