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
