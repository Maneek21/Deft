import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { buildContactsCrmApp } from './build-crm-app.mjs';
import { verifyDeftAppPackageJson } from '../packages/app-kit/dist/index.js';

test('CRM package is deterministic and embeds the exact canonical bundled Module', async () => {
  const first = await buildContactsCrmApp();
  assert.equal((await buildContactsCrmApp()).json, first.json);
  await verifyDeftAppPackageJson(first.json);
  const packaged = JSON.parse(first.json);
  const canonical = JSON.parse(await readFile(new URL('../modules/bundled/contacts/deft.module.json', import.meta.url), 'utf8'));
  assert.deepEqual(JSON.parse(packaged.artifacts[0].content), canonical);
  assert.equal(packaged.artifacts.length, 1);
  assert.deepEqual(packaged.manifest.dependencies, []);
  assert.ok(packaged.manifest.resource_requirements.every((item: { source: { module_id: string } }) => item.source.module_id === canonical.id));
});
