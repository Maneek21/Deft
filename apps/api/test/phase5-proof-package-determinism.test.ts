import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const appKitCli = resolve(repositoryRoot, 'packages', 'app-kit', 'dist', 'cli.js');

const proofApps = [
  {
    name: 'Contacts v0',
    directory: 'resource-participation-contacts-app',
    lock_schema: 'deft.app.lock.v0',
    app_id: 'org.deft.reference.resource-contacts-app',
    version: '1.0.0',
  },
  {
    name: 'Campaigns predecessor v0',
    directory: 'resource-participation-campaigns-app',
    lock_schema: 'deft.app.lock.v0',
    app_id: 'org.deft.reference.resource-campaigns-app',
    version: '2.0.0',
  },
  {
    name: 'connected Campaigns v1',
    directory: 'connected-resource-campaigns-app',
    lock_schema: 'deft.app.lock.v1',
    app_id: 'org.deft.reference.resource-campaigns-app',
    version: '3.0.0',
  },
] as const;

type ProofApp = typeof proofApps[number];
type GeneratedProof = Readonly<{
  package_bytes: Buffer;
  lock_bytes: Buffer;
  package_digest: string;
  package_file_digest: string;
  lock_file_digest: string;
}>;

function sha256(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function buildIsolatedCopy(
  proof: ProofApp,
  copyName: string,
  temporaryRoots: string[],
): Promise<GeneratedProof> {
  const source = resolve(repositoryRoot, 'examples', proof.directory);
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), `deft-phase5-${copyName}-`));
  temporaryRoots.push(temporaryRoot);
  const project = resolve(temporaryRoot, 'app');
  await cp(source, project, {
    recursive: true,
    filter: (sourcePath) => {
      const path = relative(source, sourcePath).replaceAll('\\', '/');
      return path !== 'deft.app.lock.json'
        && path !== '.deft'
        && !path.startsWith('.deft/');
    },
  });

  const built = spawnSync(process.execPath, [appKitCli, 'app', 'build'], {
    cwd: project,
    encoding: 'utf8',
  });
  assert.equal(built.error, undefined, `${proof.name} CLI process failed to start`);
  assert.equal(built.status, 0, `${proof.name} CLI build failed: ${built.stderr}`);

  const packageBytes = await readFile(resolve(project, '.deft', 'app.deftapp.json'));
  const lockBytes = await readFile(resolve(project, 'deft.app.lock.json'));
  assert.equal(packageBytes.at(-1), 0x0a, `${proof.name} package must end in LF`);
  assert.equal(lockBytes.at(-1), 0x0a, `${proof.name} lock must end in LF`);
  assert.equal(lockBytes.includes(Buffer.from('\r\n')), false, `${proof.name} lock must not contain CRLF`);

  const lock = JSON.parse(lockBytes.toString('utf8')) as {
    schema: string;
    app_id: string;
    version: string;
    package_digest: string;
  };
  assert.equal(lock.schema, proof.lock_schema);
  assert.equal(lock.app_id, proof.app_id);
  assert.equal(lock.version, proof.version);
  assert.match(lock.package_digest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(built.stdout.includes(lock.package_digest), `${proof.name} CLI output must report its package digest`);
  assert.equal(
    sha256(packageBytes.subarray(0, -1)),
    lock.package_digest,
    `${proof.name} package bytes must match the generated package digest`,
  );

  return {
    package_bytes: packageBytes,
    lock_bytes: lockBytes,
    package_digest: lock.package_digest,
    package_file_digest: sha256(packageBytes),
    lock_file_digest: sha256(lockBytes),
  };
}

for (const proof of proofApps) {
  test(`${proof.name} has reproducible public CLI package and lock artifacts`, async () => {
    const temporaryRoots: string[] = [];
    try {
      const first = await buildIsolatedCopy(proof, `${proof.directory}-first`, temporaryRoots);
      const second = await buildIsolatedCopy(proof, `${proof.directory}-second`, temporaryRoots);
      assert.deepEqual(second.package_bytes, first.package_bytes, `${proof.name} package bytes changed`);
      assert.deepEqual(second.lock_bytes, first.lock_bytes, `${proof.name} lock bytes changed`);
      assert.equal(second.package_digest, first.package_digest, `${proof.name} package digest changed`);
      assert.equal(second.package_file_digest, first.package_file_digest, `${proof.name} package file hash changed`);
      assert.equal(second.lock_file_digest, first.lock_file_digest, `${proof.name} lock file hash changed`);

      const committedLock = await readFile(resolve(
        repositoryRoot,
        'examples',
        proof.directory,
        'deft.app.lock.json',
      ));
      assert.deepEqual(first.lock_bytes, committedLock, `${proof.name} committed lock is stale`);
    } finally {
      await Promise.all(temporaryRoots.map((path) => rm(path, { recursive: true, force: true })));
    }
  });
}
