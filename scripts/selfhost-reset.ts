import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, URL } from 'node:url';
import { createGzip } from 'node:zlib';

type EnvMap = Record<string, string>;

export type ResetMode = 'platform-only' | 'seed-pilot';

export type ResetOptions = {
  prod: boolean;
  composeFiles: string[];
  mode: ResetMode;
  backup: boolean;
  backupOnly: boolean;
  backupDir: string;
  keepRedis: boolean;
  keepUploads: boolean;
  skipBuild: boolean;
  skipDoctor: boolean;
  skipSmoke: boolean;
  dryRun: boolean;
  force: boolean;
  forceProductionReset: boolean;
};

type CommandStep = {
  label: string;
  command: string;
  args: string[];
};

const DEFAULT_BACKUP_DIR = 'backups';
const ROW_COUNT_SQL = `
SELECT 'orgs=' || count(*) FROM orgs
UNION ALL SELECT 'users=' || count(*) FROM users
UNION ALL SELECT 'org_members=' || count(*) FROM org_members
UNION ALL SELECT 'spaces=' || count(*) FROM spaces
UNION ALL SELECT 'projects=' || count(*) FROM projects
UNION ALL SELECT 'tasks=' || count(*) FROM tasks
UNION ALL SELECT 'messages=' || count(*) FROM messages
UNION ALL SELECT 'skills=' || count(*) FROM skills
UNION ALL SELECT 'employee_templates=' || count(*) FROM agent_employee_templates;
`.trim();

export function parseResetArgs(argv: string[]): ResetOptions {
  const options: ResetOptions = {
    prod: false,
    composeFiles: [],
    mode: 'platform-only',
    backup: true,
    backupOnly: false,
    backupDir: DEFAULT_BACKUP_DIR,
    keepRedis: false,
    keepUploads: false,
    skipBuild: false,
    skipDoctor: false,
    skipSmoke: false,
    dryRun: false,
    force: false,
    forceProductionReset: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--prod':
        options.prod = true;
        break;
      case '--compose-file':
      case '-f': {
        const value = argv[i + 1];
        if (!value) throw new Error(`${arg} requires a file path.`);
        options.composeFiles.push(value);
        i += 1;
        break;
      }
      case '--seed-pilot':
      case '--demo':
        options.mode = 'seed-pilot';
        break;
      case '--platform-only':
        options.mode = 'platform-only';
        break;
      case '--backup':
        options.backup = true;
        break;
      case '--no-backup':
        options.backup = false;
        break;
      case '--backup-only':
        options.backupOnly = true;
        options.backup = true;
        break;
      case '--backup-dir': {
        const value = argv[i + 1];
        if (!value) throw new Error('--backup-dir requires a directory path.');
        options.backupDir = value;
        i += 1;
        break;
      }
      case '--keep-redis':
        options.keepRedis = true;
        break;
      case '--keep-uploads':
        options.keepUploads = true;
        break;
      case '--skip-build':
        options.skipBuild = true;
        break;
      case '--skip-doctor':
        options.skipDoctor = true;
        break;
      case '--skip-smoke':
        options.skipSmoke = true;
        break;
      case '--dry-run':
      case '--check-only':
        options.dryRun = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--force-production-reset':
        options.forceProductionReset = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

export function parseEnvFile(path = '.env'): EnvMap {
  const env: EnvMap = {};
  if (!existsSync(path)) return env;
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function loadRuntimeEnv(path = '.env'): EnvMap {
  return { ...parseEnvFile(path), ...(process.env as EnvMap) };
}

export function composeArgs(options: ResetOptions): string[] {
  const files = ['docker-compose.yml'];
  if (options.prod) files.push('compose.prod.yml');
  files.push(...options.composeFiles);
  return ['compose', ...files.flatMap((file) => ['-f', file])];
}

export function isPublicUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return !['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function validateResetSafety(options: ResetOptions, env: EnvMap) {
  if (options.backupOnly || options.dryRun) return;
  if (!options.force) {
    throw new Error('Refusing to reset without --force. This drops the public schema and clears runtime data.');
  }

  const looksProduction =
    options.prod ||
    env.NODE_ENV === 'production' ||
    isPublicUrl(env.NEXT_PUBLIC_APP_URL) ||
    isPublicUrl(env.NEXT_PUBLIC_API_URL) ||
    isPublicUrl(env.DEFT_PUBLIC_URL);

  if (looksProduction && !options.forceProductionReset) {
    throw new Error(
      'This looks like a production or public deployment. Add --force-production-reset after taking a backup and confirming the target.'
    );
  }
}

function toolEnvArgs(env: EnvMap): string[] {
  const keys = ['NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_WS_URL', 'DEFT_PUBLIC_URL'];
  return keys.flatMap((key) => (env[key] ? ['-e', `${key}=${env[key]}`] : []));
}

export function buildResetPlan(options: ResetOptions, env: EnvMap = {}): CommandStep[] {
  const compose = composeArgs(options);
  const toolEnv = toolEnvArgs(env);
  const steps: CommandStep[] = [];

  if (options.backupOnly) return steps;

  if (!options.skipBuild) {
    steps.push({
      label: 'Build current app and tool images',
      command: 'docker',
      args: [...compose, 'build', 'deft', 'init', 'doctor', 'smoke'],
    });
  }

  steps.push({
    label: 'Stop app container',
    command: 'docker',
    args: [...compose, 'stop', 'deft'],
  });
  steps.push({
    label: 'Drop and recreate public schema',
    command: 'docker',
    args: [
      ...compose,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'deft',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO postgres; GRANT ALL ON SCHEMA public TO public; CREATE EXTENSION IF NOT EXISTS vector;',
    ],
  });

  if (!options.keepRedis) {
    steps.push({
      label: 'Flush Redis runtime state',
      command: 'docker',
      args: [...compose, 'exec', '-T', 'redis', 'redis-cli', 'FLUSHALL'],
    });
  }

  if (!options.keepUploads) {
    steps.push({
      label: 'Clear local uploads volume',
      command: 'docker',
      args: [
        ...compose,
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        'deft',
        '-lc',
        'rm -rf /app/uploads/* /app/uploads/.[!.]* /app/uploads/..?* 2>/dev/null || true',
      ],
    });
  }

  if (options.mode === 'seed-pilot') {
    steps.push({
      label: 'Initialize schema and seed pilot demo workspace',
      command: 'docker',
      args: [...compose, 'run', '--rm', 'init', 'sh', '-c', 'pnpm db:push-full && pnpm db:seed:pilot'],
    });
  } else {
    steps.push({
      label: 'Initialize schema and platform seed only',
      command: 'docker',
      args: [...compose, 'run', '--rm', 'init'],
    });
  }

  steps.push({
    label: 'Start app container with current environment',
    command: 'docker',
    args: [...compose, 'up', '-d', '--force-recreate', 'deft'],
  });

  if (!options.skipDoctor) {
    steps.push({
      label: 'Run self-host doctor',
      command: 'docker',
      args: [...compose, 'run', '--rm', ...toolEnv, 'doctor'],
    });
  }

  if (!options.skipSmoke) {
    steps.push({
      label: 'Run self-host smoke test',
      command: 'docker',
      args: [...compose, 'run', '--rm', ...toolEnv, 'smoke'],
    });
  }

  steps.push({
    label: 'Print post-reset row counts',
    command: 'docker',
    args: [...compose, 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'deft', '-At', '-c', ROW_COUNT_SQL],
  });

  return steps;
}

function printHelp() {
  console.log(`Deft self-host reset

Usage:
  pnpm selfhost:reset --platform-only --force
  pnpm selfhost:reset --prod --compose-file compose.demo.yml --platform-only --force --force-production-reset
  pnpm selfhost:reset --seed-pilot --force
  pnpm selfhost:backup --prod

Options:
  --platform-only              Fresh empty workspace plus platform bundles (default)
  --seed-pilot, --demo          Fresh Testers Tomatoes/demo workspace
  --prod                       Include compose.prod.yml
  --compose-file, -f <file>     Append an additional Compose overlay
  --backup / --no-backup        Take or skip pg_dump before reset (default: backup)
  --backup-only                 Only write a backup; do not reset
  --backup-dir <dir>            Backup output directory (default: backups)
  --keep-redis                  Do not flush Redis
  --keep-uploads                Do not clear local uploads
  --skip-build                  Do not rebuild app/tool images before reset
  --skip-doctor                 Skip docker compose run --rm doctor
  --skip-smoke                  Skip docker compose run --rm smoke
  --dry-run, --check-only       Print the plan without executing
  --force                      Required for any real reset
  --force-production-reset      Required when target looks public/production
`);
}

function commandLine(command: string, args: string[]) {
  return [command, ...args].map((part) => (part.includes(' ') ? `"${part}"` : part)).join(' ');
}

async function runStep(step: CommandStep, dryRun: boolean) {
  console.log('');
  console.log(`[STEP] ${step.label}`);
  console.log(`[RUN] ${commandLine(step.command, step.args)}`);
  if (dryRun) return;
  await new Promise<void>((resolveStep, reject) => {
    const child = spawn(step.command, step.args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolveStep();
      else reject(new Error(`${commandLine(step.command, step.args)} exited with ${code}`));
    });
  });
}

async function writeBackup(options: ResetOptions) {
  const backupDir = resolve(options.backupDir);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const backupPath = resolve(backupDir, `deft-backup-${stamp}.sql.gz`);
  const args = [...composeArgs(options), 'exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', 'deft'];

  console.log('');
  console.log('[STEP] Backup Postgres');
  console.log(`[OUT] ${backupPath}`);
  console.log(`[RUN] ${commandLine('docker', args)} | gzip > ${backupPath}`);
  if (options.dryRun) return backupPath;

  mkdirSync(backupDir, { recursive: true });
  await new Promise<void>((resolveBackup, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'inherit'] });
    const gzip = createGzip({ level: 9 });
    const out = createWriteStream(backupPath);
    const streamDone = pipeline(child.stdout, gzip, out);
    const processDone = new Promise<void>((resolveProcess, rejectProcess) => {
      child.on('error', rejectProcess);
      child.on('exit', (code) => {
        if (code === 0) resolveProcess();
        else rejectProcess(new Error(`Backup command exited with ${code}`));
      });
    });
    Promise.all([streamDone, processDone]).then(() => resolveBackup(), reject);
  });

  return backupPath;
}

function printTarget(options: ResetOptions) {
  console.log(options.backupOnly ? 'Deft self-host backup' : 'Deft self-host reset');
  console.log(`  compose: ${composeArgs(options).slice(1).join(' ')}`);
  console.log(`  mode: ${options.backupOnly ? 'backup only' : options.mode}`);
  console.log(`  backup: ${options.backup ? options.backupDir : 'disabled'}`);
  if (!options.backupOnly) {
    console.log(`  build: ${options.skipBuild ? 'skipped' : 'current images before reset'}`);
    console.log(`  redis: ${options.keepRedis ? 'kept' : 'flushed'}`);
    console.log(`  uploads: ${options.keepUploads ? 'kept' : 'cleared'}`);
    console.log(`  validation: doctor=${options.skipDoctor ? 'skipped' : 'on'}, smoke=${options.skipSmoke ? 'skipped' : 'on'}`);
  }
  console.log(`  execute: ${options.dryRun ? 'dry run' : 'yes'}`);
  console.log('  public URL values: redacted');
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseResetArgs(argv);
  const env = loadRuntimeEnv('.env');
  printTarget(options);
  validateResetSafety(options, env);

  if (options.backup) {
    const backupPath = await writeBackup(options);
    console.log(`[OK] Backup ${options.dryRun ? 'planned' : 'written'}: ${backupPath}`);
  }

  for (const step of buildResetPlan(options, env)) {
    await runStep(step, options.dryRun);
  }

  if (options.backupOnly) {
    console.log('');
    console.log('[OK] Backup complete.');
    return;
  }

  console.log('');
  console.log('[OK] Reset complete. Open /signup on the configured application URL to create the owner account.');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((err) => {
    console.error('');
    console.error('[FAIL]', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export const __test = {
  ROW_COUNT_SQL,
  commandLine,
  backupBasename: (path: string) => basename(path),
};
