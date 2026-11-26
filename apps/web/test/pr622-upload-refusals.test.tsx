import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModuleUploadReview } from '../src/components/apps/home/module-upload-review';
import {
  moduleApiError, normalizeModuleManifest, previewModuleManifestJson, resolveModuleManifestUpload,
  type ModuleInstallation,
} from '../src/lib/modules';

function file(version: string) {
  return {
    schema_version: '1', id: 'org.example.inventory', slug: 'inventory', version, name: 'Inventory',
    collections: [{ key: 'items', name: 'Items', fields: [{ key: 'title', label: 'Title', type: 'text' }] }],
  };
}

async function review(installedVersion: string, uploadedVersion: string) {
  const preview = await previewModuleManifestJson(JSON.stringify(file(uploadedVersion)));
  const installation: ModuleInstallation = {
    id: 'installed-inventory', slug: preview.slug, moduleId: preview.moduleId, source: 'sideloaded',
    enabled: true, agentAccess: 'none', activeVersionId: null, manifestDigest: preview.digest,
    owningAppInstallationId: null, manifest: normalizeModuleManifest(file(installedVersion)),
  };
  return renderToStaticMarkup(createElement(ModuleUploadReview, {
    preview, decision: resolveModuleManifestUpload(preview, [installation], installation.id),
    busy: false, onCancel() {}, onConfirm() {},
  }));
}

for (const [name, installed, uploaded] of [
  ['older upload', '3.8.12', '2.99.99'],
  ['equal upload', '3.8.12', '3.8.12'],
  ['equal precedence with different build metadata', '3.8.12+installed', '3.8.12+uploaded'],
] as const) {
  test(`${name}: check step explains refusal and offers no Update button`, async () => {
    const html = await review(installed, uploaded);
    const text = html.replace(/<[^>]*>/g, ' ');
    assert.match(text, /not higher than the installed one/i, text);
    assert.ok(text.includes(installed) && text.includes(uploaded), text);
    const buttons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)]
      .map((match) => match[1]!.replace(/<[^>]*>/g, ' '));
    assert.ok(buttons.every((label) => !/update/i.test(label)), buttons.join('\n'));
    assert.ok(buttons.some((label) => /cancel/i.test(label)));
    // A higher patch still offers the normal update action.
    assert.match(await review(installed, '3.8.13'), /Update to v3\.8\.13/);
  });
}

test('version refusal preserves server advice without refresh instructions', async () => {
  const advice = 'The installed app is 3.8.12 and this file is 2.99.99. Give the file a higher version, such as 3.8.13.';
  const response = (code: string, error: string) => new Response(JSON.stringify({ code, error }), { status: 409 });
  const message = await moduleApiError(response('MODULE_UPDATE_NOT_AVAILABLE', advice), 'Cannot update');
  assert.equal(message, advice);
  assert.doesNotMatch(message, /refresh/i);
  const stale = await moduleApiError(response('MODULE_MANIFEST_STALE', 'The app changed.'), 'Cannot update');
  assert.match(stale, /Refresh and try again\./);
});

test('browser upload rejects invalid schema links with text URL advice', async () => {
  for (const schema of [false, 'x'.repeat(2049)]) {
    await assert.rejects(previewModuleManifestJson(JSON.stringify({ ...file('3.8.12'), $schema: schema })), (error: Error) => {
      assert.match(error.message, /\$schema:.*text URL/i, error.message);
      assert.doesNotMatch(error.message, /unknown key/i);
      return true;
    });
  }
});
