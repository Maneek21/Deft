import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';

type EnvMap = Record<string, string>;

const args = new Set(process.argv.slice(2));
const useProdOverlay = args.has('--prod');
const seedPilotDemo = args.has('--seed-pilot') || args.has('--demo');
const skipBuild = args.has('--skip-build');
const skipSmoke = args.has('--skip-smoke');
const checkOnly = args.has('--check-only') || args.has('--dry-run');
const composeFiles = useProdOverlay ? ['-f', 'docker-compose.yml', '-f', 'compose.prod.yml'] : [];

function parseEnvFile(path: string): EnvMap {
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

function isMissingOrPlaceholder(value: string | undefined) {
  return !value || value.includes('change-me') || value.includes('CHANGE_ME');
}

function isLocalUrl(value: string) {
  try {
    const url = new URL(value);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function validateEnv() {
  const env = parseEnvFile('.env');
  const failures: string[] = [];
  const warnings: string[] = [];

  if (!existsSync('.env')) failures.push('Missing .env. Copy .env.example to .env first.');
  for (const key of ['POSTGRES_PASSWORD', 'JWT_SECRET', 'JWT_REFRESH_SECRET']) {
    if (isMissingOrPlaceholder(env[key])) failures.push(`${key} is missing or still uses a placeholder.`);
  }
  if (!env.ENCRYPTION_KEY || env.ENCRYPTION_KEY.length !== 32) {
    failures.push('ENCRYPTION_KEY must be exactly 32 characters.');
  } else if (env.ENCRYPTION_KEY === 'deft-dev-encryption-key-32ch') {
    warnings.push('ENCRYPTION_KEY is still the dev value. Rotate it before real production data.');
  }

  for (const key of ['NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_WS_URL']) {
    if (!env[key]) warnings.push(`${key} is unset; Compose will use localhost defaults.`);
  }

  if (useProdOverlay) {
    for (const key of ['NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_WS_URL']) {
      const value = env[key];
      if (value && value.startsWith('http://') && !isLocalUrl(value)) {
        failures.push(`${key} is ${value}. Production overlay expects HTTPS for non-local domains.`);
      }
    }
  }

  for (const warning of warnings) console.log(`[WARN] ${warning}`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`[FAIL] ${failure}`);
    process.exit(1);
  }
}

function commandLine(command: string, commandArgs: string[]) {
  return [command, ...commandArgs].map((part) => part.includes(' ') ? `"${part}"` : part).join(' ');
}

async function run(command: string, commandArgs: string[]) {
  console.log('');
  console.log(`[RUN] ${commandLine(command, commandArgs)}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${commandLine(command, commandArgs)} exited with ${code}`));
    });
  });
}

async function main() {
  console.log('Deft self-host bootstrap');
  console.log(`  overlay: ${useProdOverlay ? 'production' : 'default'}`);
  console.log(`  seed: ${seedPilotDemo ? 'pilot demo data' : 'platform only'}`);
  console.log(`  smoke: ${skipSmoke ? 'skipped' : 'enabled'}`);
  console.log(`  mode: ${checkOnly ? 'check only' : 'execute'}`);
  validateEnv();
  if (checkOnly) {
    console.log('');
    console.log('[OK] .env validation passed.');
    return;
  }

  const compose = ['compose', ...composeFiles];
  if (!skipBuild) {
    await run('docker', [...compose, 'build', 'deft', 'init', 'doctor', 'smoke']);
  }
  await run('docker', [...compose, 'up', '-d']);
  if (seedPilotDemo) {
    await run('docker', [...compose, 'run', '--rm', 'init', 'sh', '-c', 'pnpm db:push-full && pnpm db:seed:pilot']);
  } else {
    await run('docker', [...compose, 'run', '--rm', 'init']);
  }
  await run('docker', [...compose, 'run', '--rm', 'doctor']);
  if (!skipSmoke) await run('docker', [...compose, 'run', '--rm', 'smoke']);

  console.log('');
  console.log('[OK] Deft self-host bootstrap completed.');
}

main().catch((err) => {
  console.error('');
  console.error('[FAIL]', err instanceof Error ? err.message : err);
  process.exit(1);
});
