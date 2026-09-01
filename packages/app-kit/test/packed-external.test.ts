import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const packageRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(packageRoot, '..', '..');

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n'));
  return result;
}

function runPnpm(args: string[], cwd: string) {
  assert.ok(process.env.npm_execpath, 'Run App Kit tests through pnpm');
  return run(process.execPath, [process.env.npm_execpath, ...args], cwd);
}

async function buildTwice(cli: string, project: string) {
  const check = run(process.execPath, [cli, 'app', 'check'], project);
  assert.match(check.stdout, /Valid App Protocol/);
  run(process.execPath, [cli, 'app', 'build'], project);
  const first = {
    package: await readFile(resolve(project, '.deft', 'app.deftapp.json'), 'utf8'),
    lock: await readFile(resolve(project, 'deft.app.lock.json'), 'utf8'),
    report: await readFile(resolve(project, '.deft', 'requested-authority.json'), 'utf8'),
  };
  run(process.execPath, [cli, 'app', 'build'], project);
  assert.equal(await readFile(resolve(project, '.deft', 'app.deftapp.json'), 'utf8'), first.package);
  assert.equal(await readFile(resolve(project, 'deft.app.lock.json'), 'utf8'), first.lock);
  assert.equal(await readFile(resolve(project, '.deft', 'requested-authority.json'), 'utf8'), first.report);
  return first;
}

test('packed App Kit builds Contacts and connected Campaigns from a clean external install', async () => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'deft-packed-app-kit-'));
  try {
    const artifacts = resolve(temporaryRoot, 'artifacts');
    const consumer = resolve(temporaryRoot, 'consumer');
    await mkdir(artifacts, { recursive: true });
    await mkdir(consumer, { recursive: true });
    runPnpm(['--dir', packageRoot, 'pack', '--pack-destination', artifacts, '--json'], repositoryRoot);
    const archives = (await readdir(artifacts)).filter((entry) => entry.endsWith('.tgz'));
    assert.equal(archives.length, 1);
    const archive = resolve(artifacts, archives[0]!);
    await writeFile(resolve(consumer, 'package.json'), `${JSON.stringify({
      name: 'deft-external-app-author',
      version: '1.0.0',
      private: true,
      dependencies: { '@deft/app-kit': `file:${archive.replace(/\\/g, '/')}` },
    }, null, 2)}\n`, 'utf8');
    runPnpm(['--dir', consumer, 'install', '--ignore-workspace', '--offline'], repositoryRoot);

    const installedRoot = await realpath(resolve(consumer, 'node_modules', '@deft', 'app-kit'));
    assert.equal(installedRoot.startsWith(await realpath(consumer)), true);
    const installedPackage = JSON.parse(await readFile(resolve(installedRoot, 'package.json'), 'utf8')) as any;
    assert.equal(installedPackage.version, '0.1.0-alpha.1');
    assert.equal(installedPackage.bin.deft, './dist/cli.js');
    const installedFiles = await readdir(installedRoot, { recursive: true });
    assert.equal(installedFiles.some((entry) => /^src(?:[\\/]|$)/.test(entry)), false);
    assert.equal(installedFiles.some((entry) => /^test(?:[\\/]|$)/.test(entry)), false);
    const installedText = (await Promise.all(installedFiles
      .filter((entry) => /\.(?:js|d\.ts|md|json)$/.test(entry))
      .map(async (entry) => {
        try { return await readFile(resolve(installedRoot, entry), 'utf8'); }
        catch { return ''; }
      }))).join('\n');
    assert.equal(installedText.includes(repositoryRoot), false);
    assert.doesNotMatch(installedText, /from\s+['"]@deft\/(?:db|shared|mcp|api|web)/);

    const cli = resolve(installedRoot, 'dist', 'cli.js');
    const contacts = resolve(temporaryRoot, 'contacts');
    await cp(resolve(repositoryRoot, 'examples', 'resource-participation-contacts-app'), contacts, {
      recursive: true,
    });
    const contactsProof = await buildTwice(cli, contacts);
    assert.equal((JSON.parse(contactsProof.lock) as any).package_digest,
      'sha256:1471f0b94da9f6851bd978c315bc22a2dd0343b61a87477e4293b144c54248d8');

    const campaigns = resolve(temporaryRoot, 'campaigns');
    await mkdir(campaigns, { recursive: true });
    run(process.execPath, [cli, 'app', 'init', '--template', 'connected'], campaigns);
    const campaignsProof = await buildTwice(cli, campaigns);
    assert.equal((JSON.parse(campaignsProof.lock) as any).schema, 'deft.app.lock.v1');
    assert.deepEqual((JSON.parse(campaignsProof.lock) as any).permissions, []);
    assert.equal((JSON.parse(campaignsProof.report) as any).requested_authority.classification.executable, false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
