import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

type Options = { prod: boolean; composeFiles: string[]; backupDir: string; appStopped: boolean; dryRun: boolean };

export function parseBackupArgs(argv: string[]): Options {
  const options: Options = { prod: false, composeFiles: [], backupDir: 'backups', appStopped: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--prod') options.prod = true;
    else if (arg === '--compose-file' || arg === '-f') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a file path.`);
      options.composeFiles.push(value);
    } else if (arg === '--backup-dir') {
      const value = argv[++index];
      if (!value) throw new Error('--backup-dir requires a directory path.');
      options.backupDir = value;
    } else if (arg === '--app-stopped') options.appStopped = true;
    else if (arg === '--dry-run' || arg === '--check-only') options.dryRun = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function composeArgs(options: Options) {
  const files = ['docker-compose.yml'];
  if (options.prod) files.push('compose.prod.yml');
  files.push(...options.composeFiles);
  return ['compose', ...files.flatMap((file) => ['-f', file])];
}

function run(command: string, args: string[], capture = false): string {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  return capture ? result.stdout.trim() : '';
}

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

async function streamToFile(command: string, args: string[], path: string, gzip: boolean) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const processDone = new Promise<void>((resolveProcess, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolveProcess() : reject(new Error(`${command} exited with ${code}`)));
  });
  const streams = gzip
    ? pipeline(child.stdout, createGzip({ level: 9 }), createWriteStream(path))
    : pipeline(child.stdout, createWriteStream(path));
  await Promise.all([streams, processDone]);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseBackupArgs(argv);
  const compose = composeArgs(options);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const artifact = resolve(options.backupDir, `deft-recovery-${stamp}`);
  console.log(`Deft recovery backup\n  artifact: ${artifact}\n  secrets: .env/keyrings are included; protect this directory`);
  if (options.dryRun) return;
  mkdirSync(artifact, { recursive: true });

  let restart = false;
  if (!options.appStopped) {
    run('docker', [...compose, 'stop', 'deft']);
    restart = true;
  }
  try {
    await streamToFile('docker', [...compose, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', '--clean', '--if-exists', '--no-owner', '--no-privileges', 'deft'], resolve(artifact, 'database.sql.gz'), true);
    await streamToFile('docker', [...compose, 'run', '--rm', '--no-deps', '--entrypoint', 'tar', 'deft', '-C', '/app/uploads', '-czf', '-', '.'], resolve(artifact, 'uploads.tar.gz'), false);

    const containerId = run('docker', [...compose, 'ps', '-aq', 'deft'], true);
    if (containerId) {
      const legacyPath = resolve(artifact, 'legacy-container-uploads');
      mkdirSync(legacyPath, { recursive: true });
      const legacyCopy = spawnSync('docker', ['cp', `${containerId}:/app/apps/api/uploads/.`, legacyPath], { encoding: 'utf8' });
      if (legacyCopy.status !== 0 && !/could not find|no such file/i.test(legacyCopy.stderr)) {
        throw new Error(`Could not capture legacy container uploads: ${legacyCopy.stderr.trim()}`);
      }
      if (options.appStopped && filesBelow(legacyPath).length > 0) {
        run('docker', [
          ...compose,
          'run', '--rm', '--no-deps',
          '--volume', `${legacyPath}:/legacy:ro`,
          '--entrypoint', 'sh', 'deft',
          '-c', 'cp -a /legacy/. /app/uploads/',
        ]);
      }
      const imageId = run('docker', ['inspect', containerId, '--format', '{{.Image}}'], true);
      writeFileSync(resolve(artifact, 'running-image-id.txt'), `${imageId}\n`);
      writeFileSync(resolve(artifact, 'running-image-repo-digests.json'), `${run('docker', ['image', 'inspect', imageId, '--format', '{{json .RepoDigests}}'], true)}\n`);
    }
    for (const file of ['.env', 'docker-compose.yml', 'compose.prod.yml', 'compose.release.yml', 'release-manifest.json', 'SHA256SUMS']) {
      if (existsSync(file)) copyFileSync(file, resolve(artifact, basename(file)));
    }
    writeFileSync(resolve(artifact, 'README.txt'), 'Restore database.sql.gz with psql -v ON_ERROR_STOP=1 into a clean database. Extract uploads.tar.gz, then overlay legacy-container-uploads into the uploads volume. Upgrade backups also overlay captured legacy files into the corrected volume before migration. Use the recorded running image digest and preserved .env/keyrings.\n');
    const sums = filesBelow(artifact)
      .filter((path) => basename(path) !== 'SHA256SUMS')
      .sort()
      .map((path) => `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${relative(artifact, path).replaceAll('\\', '/')}`)
      .join('\n');
    writeFileSync(resolve(artifact, 'SHA256SUMS'), `${sums}\n`);
  } finally {
    if (restart) run('docker', [...compose, 'start', 'deft']);
  }
  console.log(`[OK] Complete recovery artifact written: ${artifact}`);
}

if (process.argv[1]?.endsWith('selfhost-backup.ts')) {
  main().catch((error) => {
    console.error('[FAIL]', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
