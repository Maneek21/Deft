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

test('packed App Kit builds Contacts, connected Campaigns, and scheduled Campaigns externally', async () => {
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
    assert.equal(installedPackage.version, '0.1.0-alpha.2');
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

    const scheduled = resolve(temporaryRoot, 'scheduled-campaigns');
    await mkdir(scheduled, { recursive: true });
    run(process.execPath, [cli, 'app', 'init', '--template', 'connected-automation'], scheduled);
    const scheduledProof = await buildTwice(cli, scheduled);
    const scheduledLock = JSON.parse(scheduledProof.lock) as any;
    assert.equal(scheduledLock.schema, 'deft.app.lock.v2');
    assert.equal(scheduledLock.permission_diff.kind, 'initial');
    assert.equal(scheduledLock.requested_authority_digest,
      scheduledLock.permission_diff.proposed_requested_authority_digest);
    assert.deepEqual(scheduledLock.permissions, []);
    assert.equal((JSON.parse(scheduledProof.report) as any).requested_authority.classification.executable, false);

    await writeFile(resolve(scheduled, 'simulation.json'), JSON.stringify({
      request_key: 'daily_campaign_send',
      occurrence: {
        logical_local_date: '2026-02-10', local_time: '09:00', timezone: 'UTC',
        now: '2026-02-10T09:05:00.000Z', eligible_after: '2026-02-09T00:00:00.000Z',
      },
      pins: {
        placement: {
          approved: { revision: '1', content_digest: `sha256:${'a'.repeat(64)}` },
          current: { revision: '1', content_digest: `sha256:${'a'.repeat(64)}` },
        },
        selected: {
          approved: { revision: '1', content_digest: `sha256:${'b'.repeat(64)}` },
          current: { revision: '1', content_digest: `sha256:${'b'.repeat(64)}` },
        },
      },
      provider_input: {
        to: 'ada@example.test', subject: 'Analytical Engines', body_text: 'Hello Ada',
        idempotency_key: 'campaign:one/contact:ada',
      },
    }), 'utf8');
    const simulation = run(process.execPath, [
      cli, 'app', 'simulate-automation', '--fixture', 'simulation.json',
    ], scheduled);
    assert.deepEqual(JSON.parse(simulation.stdout), {
      schema: 'deft.app.automation_simulation.v1',
      request: {
        key: 'daily_campaign_send', action_key: 'send_campaign_email',
        trigger: { kind: 'daily_local_time' },
      },
      schedule: {
        decision: 'pending', resolution: 'resolved', resolved_at_utc: '2026-02-10T09:00:00.000Z',
      },
      pinned_inputs: { status: 'ready', changed: [] },
      provider_input: { status: 'valid', issues: [] },
      executable: false,
      provider_access: false,
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
