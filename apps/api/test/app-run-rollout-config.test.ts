import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateAppRunRolloutConfiguration } from '../src/lib/env.js';

const apiRoot = fileURLToPath(new URL('../', import.meta.url));

test('App Run rollout accepts the three safe engine and legacy MCP intake states', () => {
  assert.doesNotThrow(() => validateAppRunRolloutConfiguration(false, false));
  assert.doesNotThrow(() => validateAppRunRolloutConfiguration(true, false));
  assert.doesNotThrow(() => validateAppRunRolloutConfiguration(true, true));
});

test('legacy MCP intake values other than exact lowercase true fail closed', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--eval',
      "import('./src/lib/env.ts').then((env) => { if (env.APP_RUN_LEGACY_MCP_CUTOVER_ENABLED) process.exit(2); })",
    ],
    {
      cwd: apiRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        DEFT_APP_RUNS_ENABLED: 'false',
        DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED: 'TRUE',
        DEFT_APP_RUN_KEYRINGS: '',
      },
    },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('API startup rejects legacy MCP intake while the App Run engine is disabled', () => {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--eval', "import('./src/lib/env.ts')"],
    {
      cwd: apiRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        DEFT_APP_RUNS_ENABLED: 'false',
        DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED: 'true',
        DEFT_APP_RUN_KEYRINGS: '',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED=true requires DEFT_APP_RUNS_ENABLED=true/,
  );
});
