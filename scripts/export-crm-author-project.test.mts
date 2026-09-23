import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportCrmAuthorProject } from './export-crm-author-project.mjs';
import { buildContactsCrmApp } from './build-crm-app.mjs';
import { verifyDeftAppPackageJson } from '../packages/app-kit/dist/index.js';

test('CRM author export contains canonical inputs and is deterministic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deft-crm-author-'));
  try {
    const project = await exportCrmAuthorProject(join(root, 'project'));
    const second = await exportCrmAuthorProject(join(root, 'second'));
    const module = JSON.parse(await readFile(join(project, 'modules/contacts/deft.module.json'), 'utf8'));
    const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
    const script = await readFile(join(project, 'build.mjs'), 'utf8');
    const kitPackage = JSON.parse(await readFile(new URL('../packages/app-kit/package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.dependencies['@deft/app-kit'], kitPackage.version);
    assert.match(script, /from '@deft\/app-kit'/);
    const readme = await readFile(join(project, 'README.md'), 'utf8');
    assert.match(readme, /pnpm install/);
    assert.match(readme, /connector-free/);
    assert.match(readme, /Settings -> Apps/);
    assert.match(readme, /Inspect package/);
    assert.match(readme, /contacts-crm\.deftapp\.json/);
    assert.match(readme, /Do not run `deft app install-local`/);
    await assert.rejects(() => readFile(join(project, 'deft.app.json'), 'utf8'), { code: 'ENOENT' });
    assert.doesNotMatch(script, /packages\/app-kit|packages\/shared|apps\/api/);
    const connected = await buildContactsCrmApp();
    await verifyDeftAppPackageJson(connected.json);
    assert.equal(connected.package.manifest.version, '1.9.0');
    assert.equal(connected.package.manifest.connector_requirements.length, 1);
    assert.equal(connected.package.manifest.actions.length, 1);
    assert.equal(module.id, 'com.deft.contacts');
    const wrongRoot = join(root, 'wrong-kit');
    await mkdir(join(wrongRoot, 'package'), { recursive: true });
    await writeFile(join(wrongRoot, 'package/package.json'), JSON.stringify({ name: '@example/wrong-kit', version: '0.0.0' }));
    const wrongArchive = join(root, 'wrong-kit.tgz');
    assert.equal(spawnSync('tar', ['-cf', wrongArchive, 'package/package.json'], { cwd: wrongRoot }).status, 0);
    const rejectedTarget = join(root, 'rejected');
    await assert.rejects(() => exportCrmAuthorProject(rejectedTarget, wrongArchive), /must contain @deft\/app-kit/);
    await assert.rejects(() => readdir(rejectedTarget));
    const files = ['README.md', 'build.mjs', 'package.json', 'modules/contacts/deft.module.json'];
    for (const file of files) assert.equal(await readFile(join(project, file), 'utf8'), await readFile(join(second, file), 'utf8'));
    await assert.rejects(() => exportCrmAuthorProject(project), /must be empty/);
    assert.ok((await readdir(join(project, 'examples'))).length >= 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
