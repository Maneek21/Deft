import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const cli = resolve(import.meta.dirname, '..', 'dist', 'cli.js');

function run(project: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, 'app', ...args], { cwd: project, encoding: 'utf8' });
}

test('external authoring loop initializes and builds deterministically without credentials', async () => {
  const project = await mkdtemp(resolve(tmpdir(), 'deft-app-kit-'));
  const initialized = run(project, 'init');
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal((await readFile(resolve(project, 'AGENTS.md'), 'utf8')).includes('Do not edit Deft core'), true);

  const checked = run(project, 'check');
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /connected permissions: none/);

  const first = run(project, 'build');
  assert.equal(first.status, 0, first.stderr);
  const firstPackage = await readFile(resolve(project, '.deft', 'app.deftapp.json'), 'utf8');
  const firstLock = await readFile(resolve(project, 'deft.app.lock.json'), 'utf8');
  const second = run(project, 'build');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(resolve(project, '.deft', 'app.deftapp.json'), 'utf8'), firstPackage);
  assert.equal(await readFile(resolve(project, 'deft.app.lock.json'), 'utf8'), firstLock);

  for (const filename of await readdir(project, { recursive: true })) {
    const path = resolve(project, filename);
    if (filename.includes('.deft') && !filename.endsWith('.json')) continue;
    try {
      const contents = await readFile(path, 'utf8');
      assert.equal(contents.includes('deft_app_dev_'), false, filename);
    } catch {
      // Directories are intentionally ignored.
    }
  }
});
