import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { buildDeftAppPackage, prepareModuleArtifact } from '@deft/app-kit';
import { inspectAppPackageJson } from '../src/lib/app-service.js';
import { AppError } from '../src/lib/app-errors.js';
import { closeDb } from '../src/lib/db.js';
import { parseModuleManifestUpload } from '../src/lib/module-manifest-upload.js';
import { ModuleError } from '../src/lib/module-errors.js';

after(async () => closeDb());

const moduleManifest = {
  schema_version: '1',
  id: 'com.example.hiring',
  slug: 'hiring',
  version: '1.0.0',
  name: 'Hiring',
  collections: [{
    key: 'candidates',
    name: 'Candidates',
    fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
    views: [{ key: 'all', name: 'All', type: 'table', fields: ['name'] }],
  }],
};

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** A well-formed package whose module artifact is replaced (digests kept consistent). */
async function packageWithModule(content: string): Promise<string> {
  const artifact = await prepareModuleArtifact({ path: 'modules/hiring/deft.module.json', manifest: moduleManifest });
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
  const { digestAppManifest } = await import('@deft/app-kit');
  value.manifest_digest = await digestAppManifest(value.manifest);
  return JSON.stringify(value);
}

async function inspectionError(json: string): Promise<AppError> {
  try { await inspectAppPackageJson(json); } catch (error) {
    assert.ok(error instanceof AppError, String(error));
    return error;
  }
  assert.fail('expected the package to be refused');
}

test('hostile input: an App module artifact with 500 fields names the module, collection and field count', async () => {
  const bad = structuredClone(moduleManifest) as any;
  bad.collections[0].fields = Array.from({ length: 500 }, (_, i) => ({ key: `f_${i}`, label: `F ${i}`, type: 'text' }));
  bad.collections[0].views[0].fields = ['f_0'];
  const error = await inspectionError(await packageWithModule(JSON.stringify(bad)));
  assert.equal(error.status, 400);
  assert.match(error.message, /Candidates → fields: at most 64 fields/, error.message);
});

test('hostile input: an App module artifact with an unknown key names that key', async () => {
  const error = await inspectionError(await packageWithModule(JSON.stringify({ ...moduleManifest, script: 'x' })));
  assert.match(error.message, /unknown key "script"/, error.message);
});

test('hostile input: a multipart field name never puts markup or bidi text in the refusal', async () => {
  const form = new FormData();
  form.append('file', new Blob([JSON.stringify(moduleManifest)], { type: 'application/json' }), 'deft.module.json');
  form.append(`<img src=x onerror=alert(1)>${String.fromCodePoint(0x202e)}`, 'x');
  const request = new Request('http://localhost/api/modules', { method: 'POST', body: form });
  try {
    await parseModuleManifestUpload(request);
    assert.fail('expected a refusal');
  } catch (error) {
    assert.ok(error instanceof ModuleError, String(error));
    assert.equal(error.status, 400);
    assert.doesNotMatch(error.message, /[<>]/, JSON.stringify(error.message));
    assert.ok(!error.message.includes(String.fromCodePoint(0x202e)), JSON.stringify(error.message));
  }
});
