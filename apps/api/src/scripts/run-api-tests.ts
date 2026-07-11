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

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) {
  console.error('[run-api-tests] Run this script through pnpm so npm_execpath is available');
  process.exit(1);
}
const requestedTests = process.argv.slice(2);
const commands = [
  ['exec', 'tsx', 'src/scripts/seed-test-fixtures.ts'],
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
  const result = spawnSync(process.execPath, [pnpmCli, ...args], {
    cwd: resolve(here, '..', '..'),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
