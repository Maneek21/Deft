import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  checkModule,
  formatModule,
  initModuleProject,
  vendorModule,
  verifyVendoredModules,
} from './modules-cli.js';

async function sandbox(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'deft-modules-cli-'));
}

test('init creates a standalone declarative module project that validates', async (t) => {
  const root = await sandbox();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'LICENSE'), 'test license\n', 'utf8');

  const project = join(root, 'deft-module-equipment-register');
  const checked = await initModuleProject(project, { rootDirectory: root });
  assert.equal(checked.manifest.slug, 'equipment-register');
  assert.equal(checked.manifest.id, 'community.example.equipment-register');
  assert.match(checked.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(await readFile(join(project, 'LICENSE'), 'utf8'), 'test license\n');
  assert.match(await readFile(join(project, 'deft.module.schema.json'), 'utf8'), /Deft declarative module manifest v1/);
  await assert.rejects(() => initModuleProject(project, { rootDirectory: root }), /Refusing to overwrite/);
});

test('check and format produce a stable digest for differently ordered JSON', async (t) => {
  const root = await sandbox();
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'deft-module-content-calendar');
  const initial = await initModuleProject(project, { rootDirectory: root });
  const parsed = JSON.parse(await readFile(join(project, 'deft.module.json'), 'utf8'));
  await writeFile(
    join(project, 'deft.module.json'),
    JSON.stringify({ collections: parsed.collections, name: parsed.name, version: parsed.version, slug: parsed.slug, id: parsed.id, icon: parsed.icon, description: parsed.description, schema_version: parsed.schema_version }),
    'utf8',
  );
  assert.equal((await checkModule(project)).digest, initial.digest);
  assert.equal((await formatModule(project)).digest, initial.digest);
  assert.match(await readFile(join(project, 'deft.module.json'), 'utf8'), /^\{\n  "collections"/);
});

test('vendor pins a canonical offline artifact and exact source provenance', async (t) => {
  const root = await sandbox();
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'deft-module-contacts');
  const checked = await initModuleProject(project, { rootDirectory: root });
  const commit = 'a'.repeat(40);
  const entry = await vendorModule(project, {
    rootDirectory: root,
    sourceRepository: 'https://github.com/deft-modules/deft-module-contacts',
    sourceCommit: commit,
    license: 'AGPL-3.0-only',
  });
  assert.equal(entry.manifest_digest, checked.digest);
  const pinned = await checkModule(join(root, entry.manifest_path));
  assert.equal(pinned.digest, checked.digest);
  const lock = JSON.parse(await readFile(join(root, 'modules', 'modules.lock.json'), 'utf8'));
  assert.deepEqual(lock.modules, [entry]);
  assert.deepEqual(await verifyVendoredModules(root), [entry]);
  const pinnedPath = join(root, entry.manifest_path);
  const tampered = JSON.parse(await readFile(pinnedPath, 'utf8'));
  tampered.description = 'Tampered after the lock was written.';
  await writeFile(pinnedPath, JSON.stringify(tampered), 'utf8');
  await assert.rejects(() => verifyVendoredModules(root), /Locked digest does not match/);
  await assert.rejects(
    () => vendorModule(project, {
      rootDirectory: root,
      sourceRepository: 'https://user:token@github.com/private/repo',
      sourceCommit: commit,
      license: 'AGPL-3.0-only',
    }),
    /without embedded credentials/,
  );
});
