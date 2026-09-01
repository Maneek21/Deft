import { spawnSync } from 'node:child_process';
import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '..', '..', '..', '..', '.env'), override: false });

if (!process.env.DATABASE_URL) {
  console.error('[run-api-tests] DATABASE_URL is required');
  process.exit(1);
}

const configuredDatabaseUrl = process.env.DATABASE_URL;
const explicitTestDatabaseUrl = process.env.DEFT_TEST_DATABASE_URL;
const runningInCi = process.env.CI === 'true';

if (explicitTestDatabaseUrl) {
  process.env.DATABASE_URL = explicitTestDatabaseUrl;
} else if (!runningInCi) {
  console.error(
    '[run-api-tests] Refusing to run database-writing tests against DATABASE_URL. ' +
    'Set DEFT_TEST_DATABASE_URL to a disposable test database.',
  );
  process.exit(1);
}

if (!runningInCi && process.env.DATABASE_URL === configuredDatabaseUrl) {
  console.error('[run-api-tests] DEFT_TEST_DATABASE_URL must not point at the active application database');
  process.exit(1);
}

// The API suite is the contract gate for both supported developer install
// flows. Force the otherwise opt-in feature flags in the disposable test
// process so pairing coverage cannot silently turn into skipped tests.
process.env.DEFT_APPS_ENABLED = 'true';
process.env.DEFT_APP_DEVELOPER_PAIRING_ENABLED = 'true';

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) {
  console.error('[run-api-tests] Run this script through pnpm so npm_execpath is available');
  process.exit(1);
}
const requestedTests = process.argv.slice(2);
const commands = [
  ['exec', 'tsx', 'src/scripts/seed-test-fixtures.ts'],
  ['exec', 'tsx', 'src/scripts/seed-platform-bundles.ts'],
  [
    'exec',
    'tsx',
    '--test',
    '--test-concurrency=1',
    '--test-force-exit',
    ...(requestedTests.length > 0 ? requestedTests : ['test/*.test.ts']),
  ],
];

for (const args of commands) {
  console.log(`[run-api-tests] ${args.join(' ')}`);
  const result = spawnSync(process.execPath, [pnpmCli, ...args], {
    cwd: resolve(here, '..', '..'),
    env: process.env,
    stdio: 'inherit',
    timeout: Number(process.env.DEFT_TEST_TIMEOUT_MS ?? 15 * 60 * 1000),
  });
  if (result.error) {
    console.error(`[run-api-tests] command failed: ${result.error.message}`);
    throw result.error;
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
