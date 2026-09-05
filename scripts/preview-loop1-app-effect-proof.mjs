import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const databaseUrl = process.env.DEFT_TEST_DATABASE_URL;
const capacityMode = process.argv.includes('--capacity');
if (!databaseUrl) throw new Error('DEFT_TEST_DATABASE_URL is required');
if (!/(?:test|ci|acceptance|phase5|loop1_apps)/iu.test(new URL(databaseUrl).pathname)) {
  throw new Error('DEFT_TEST_DATABASE_URL must identify an explicitly disposable database');
}

const key = (purpose, keyId) => createHash('sha256')
  .update(`loop5-lifecycle:${purpose}:${keyId}`)
  .digest('base64');
const keyrings = JSON.stringify({
  schema_version: 'deft.app_run_keyring.v1',
  run_encryption: { current: 'enc-v1', keys: { 'enc-v1': key('run_encryption', 'enc-v1') } },
  receipt_signing: { current: 'sig-v1', keys: { 'sig-v1': key('receipt_signing', 'sig-v1') } },
  fingerprint: { current: 'fp-v1', keys: { 'fp-v1': key('fingerprint', 'fp-v1') } },
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [
  resolve(root, 'node_modules/tsx/dist/cli.mjs'),
  '--test',
  '--test-force-exit',
  '--test-name-pattern=Protocol v2 review and automation lifecycle converge on one governed Run',
  resolve(root, 'apps/api/test/apps-connected-grants-db.test.ts'),
], {
  cwd: root,
  env: {
    ...process.env,
    CI: 'true',
    DATABASE_URL: databaseUrl,
    DEFT_APPS_ENABLED: 'true',
    DEFT_APP_RUNS_ENABLED: 'true',
    DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true',
    DEFT_APP_AUTOMATIONS_ENABLED: 'true',
    DEFT_APP_RUN_KEYRINGS: keyrings,
    ...(capacityMode ? { DEFT_PREVIEW_CAPACITY_PROOF: 'true' } : {}),
  },
  stdio: 'inherit',
});
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
