import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type UpgradeOptions = {
  prod: boolean;
  release: boolean;
  composeFiles: string[];
  backup: boolean;
  backupDir: string;
  skipBuild: boolean;
  skipDoctor: boolean;
  skipSmoke: boolean;
  dryRun: boolean;
};

export type CommandStep = {
  label: string;
  command: string;
  args: string[];
};

export function parseUpgradeArgs(argv: string[]): UpgradeOptions {
  const options: UpgradeOptions = {
    prod: false,
    release: false,
    composeFiles: [],
    backup: true,
    backupDir: 'backups',
    skipBuild: false,
    skipDoctor: false,
    skipSmoke: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--prod') options.prod = true;
    else if (arg === '--release') options.release = true;
    else if (arg === '--compose-file' || arg === '-f') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a file path.`);
      options.composeFiles.push(value);
      index += 1;
    } else if (arg === '--no-backup') options.backup = false;
    else if (arg === '--backup') options.backup = true;
    else if (arg === '--backup-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--backup-dir requires a directory path.');
      options.backupDir = value;
      index += 1;
    } else if (arg === '--skip-build' || arg === '--skip-pull') options.skipBuild = true;
    else if (arg === '--skip-doctor') options.skipDoctor = true;
    else if (arg === '--skip-smoke') options.skipSmoke = true;
    else if (arg === '--dry-run' || arg === '--check-only') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Deft self-host upgrade

Usage:
  pnpm selfhost:upgrade
  pnpm selfhost:upgrade --prod --release
  DEFT_IMAGE=ghcr.io/maneek21/deft:<version> pnpm selfhost:upgrade --prod --release

Options:
  --prod                       Include compose.prod.yml
  --release                    Include compose.release.yml and pull release images
  --compose-file, -f <file>    Append a site-specific Compose overlay
  --backup / --no-backup       Take or skip a pre-upgrade backup (default: backup)
  --backup-dir <dir>           Backup directory (default: backups)
  --skip-build, --skip-pull    Reuse existing images
  --skip-doctor                Skip post-upgrade doctor
  --skip-smoke                 Skip post-upgrade smoke test
  --dry-run, --check-only      Print the plan without changing anything
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

export function composeArgs(options: UpgradeOptions): string[] {
  const files = ['docker-compose.yml'];
  if (options.prod) files.push('compose.prod.yml');
  if (options.release) files.push('compose.release.yml');
  files.push(...options.composeFiles);
  return ['compose', ...files.flatMap((file) => ['-f', file])];
}

function backupArgs(options: UpgradeOptions): string[] {
  const args = ['selfhost:backup', '--app-stopped'];
  if (options.prod) args.push('--prod');
  for (const file of options.composeFiles) args.push('--compose-file', file);
  args.push('--backup-dir', options.backupDir);
  return args;
}

export function buildUpgradePlan(options: UpgradeOptions): CommandStep[] {
  const compose = composeArgs(options);
  const steps: CommandStep[] = [];
  steps.push({ label: 'Stop app writes', command: 'docker', args: [...compose, 'stop', 'deft'] });
  if (options.backup) {
    steps.push({ label: 'Back up the stopped recovery set', command: 'pnpm', args: backupArgs(options) });
  }
  if (!options.skipBuild) {
    steps.push(options.release
      ? {
          label: 'Pull target release images',
          command: 'docker',
          args: [...compose, 'pull', 'deft', 'upgrade', 'doctor', 'smoke'],
        }
      : {
          label: 'Build target app and upgrade tool images',
          command: 'docker',
          args: [...compose, 'build', 'deft', 'upgrade', 'doctor', 'smoke'],
        });
  }
  steps.push({
    label: 'Apply versioned database upgrade',
    command: 'docker',
    args: [...compose, 'run', '--rm', 'upgrade'],
  });
  steps.push({
    label: 'Recreate app on target version',
    command: 'docker',
    args: [...compose, 'up', '-d', '--force-recreate', 'deft'],
  });
  if (!options.skipDoctor) {
    steps.push({ label: 'Run self-host doctor', command: 'docker', args: [...compose, 'run', '--rm', 'doctor'] });
  }
  if (!options.skipSmoke) {
    steps.push({ label: 'Run connector smoke test', command: 'docker', args: [...compose, 'run', '--rm', 'smoke'] });
  }
  return steps;
}

function commandLine(step: CommandStep): string {
  return [step.command, ...step.args].map((part) => part.includes(' ') ? `"${part}"` : part).join(' ');
}

export async function runStep(step: CommandStep, dryRun: boolean) {
  console.log('');
  console.log(`[STEP] ${step.label}`);
  console.log(`[RUN] ${commandLine(step)}`);
  if (dryRun) return;
  await new Promise<void>((resolveStep, reject) => {
    const child = spawn(step.command, step.args, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0
      ? resolveStep()
      : reject(new Error(`${commandLine(step)} exited with ${code}`)));
  });
}

type StepRunner = (step: CommandStep, dryRun: boolean) => Promise<void>;

export async function executeUpgradePlan(
  options: UpgradeOptions,
  runner: StepRunner = runStep,
) {
  const compose = composeArgs(options);
  const plan = buildUpgradePlan(options);
  let appStopped = false;
  let schemaMayHaveChanged = false;

  try {
    for (const step of plan) {
      if (step.label === 'Apply versioned database upgrade' && !options.dryRun) {
        // The upgrader commits migrations individually. From the moment it starts,
        // failure cannot prove that the previous image can read the resulting schema.
        schemaMayHaveChanged = true;
      }
      await runner(step, options.dryRun);
      if (step.label === 'Stop app writes' && !options.dryRun) appStopped = true;
    }
  } catch (error) {
    if (appStopped && !schemaMayHaveChanged) {
      console.error('[WARN] Upgrade failed before schema migration started. Restarting the previous app container.');
      await runner({ label: 'Restart previous app container', command: 'docker', args: [...compose, 'start', 'deft'] }, false)
        .catch((restartError) => console.error('[WARN] Automatic restart failed:', restartError));
    } else if (appStopped) {
      await runner({ label: 'Stop app after failed upgrade', command: 'docker', args: [...compose, 'stop', 'deft'] }, false)
        .catch((stopError) => console.error('[WARN] Could not confirm the app is stopped:', stopError));
      console.error('[RECOVERY REQUIRED] The schema may have changed. The app remains stopped; do not start the previous image against this database.');
      console.error('[RECOVERY REQUIRED] Restore the pre-upgrade database, uploads, configuration/keyrings, and previous image digest as documented in docs/self-hosting.md.');
    }
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseUpgradeArgs(argv);
  const compose = composeArgs(options);
  console.log('Deft self-host upgrade');
  console.log(`  mode: ${options.release ? 'published release image' : 'source build'}`);
  console.log(`  compose: ${compose.slice(1).join(' ')}`);
  console.log(`  backup: ${options.backup ? options.backupDir : 'disabled'}`);
  console.log(`  execute: ${options.dryRun ? 'dry run' : 'yes'}`);

  await executeUpgradePlan(options);

  console.log('');
  console.log(options.dryRun
    ? '[OK] Upgrade plan is valid. No changes were made.'
    : '[OK] Upgrade complete. Backup, schema upgrade, doctor, and smoke gates passed.');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    console.error('');
    console.error('[FAIL]', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
