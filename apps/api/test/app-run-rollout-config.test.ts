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
  assert.doesNotThrow(() => validateAppRunRolloutConfiguration(true, false, true, true));
  assert.doesNotThrow(() => validateAppRunRolloutConfiguration(true, false, true, true, true));
  assert.throws(
    () => validateAppRunRolloutConfiguration(true, false, true, false),
    /requires DEFT_APP_RUNS_ENABLED=true and DEFT_APPS_ENABLED=true/,
  );
});

test('App automation intake defaults off and requires the complete connected Run stack', () => {
  const defaulted = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--eval',
      "import('./src/lib/env.ts').then((env) => { if (env.APP_AUTOMATIONS_ENABLED) process.exit(2); })",
    ],
    {
      cwd: apiRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        DEFT_APPS_ENABLED: 'false',
        DEFT_APP_RUNS_ENABLED: 'false',
        DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'false',
        DEFT_APP_AUTOMATIONS_ENABLED: 'TRUE',
        DEFT_APP_RUN_KEYRINGS: '',
      },
    },
  );
  assert.equal(defaulted.status, 0, `${defaulted.stdout}\n${defaulted.stderr}`);

  assert.throws(
    () => validateAppRunRolloutConfiguration(true, false, false, false, true),
    /requires DEFT_APPS_ENABLED=true, DEFT_APP_RUNS_ENABLED=true, and DEFT_APP_RUN_APP_ORIGIN_ENABLED=true/,
  );
  assert.throws(
    () => validateAppRunRolloutConfiguration(true, false, false, true, true),
    /requires DEFT_APPS_ENABLED=true, DEFT_APP_RUNS_ENABLED=true, and DEFT_APP_RUN_APP_ORIGIN_ENABLED=true/,
  );
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

test('App-origin intake defaults off and cannot start without Apps and Runs', () => {
  const defaulted = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--eval',
      "import('./src/lib/env.ts').then((env) => { if (env.APP_RUN_APP_ORIGIN_ENABLED) process.exit(2); })",
    ],
    {
      cwd: apiRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        DEFT_APPS_ENABLED: 'false',
        DEFT_APP_RUNS_ENABLED: 'false',
        DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'TRUE',
        DEFT_APP_RUN_KEYRINGS: '',
      },
    },
  );
  assert.equal(defaulted.status, 0, `${defaulted.stdout}\n${defaulted.stderr}`);

  const invalid = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--eval', "import('./src/lib/env.ts')"],
    {
      cwd: apiRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        DEFT_APPS_ENABLED: 'false',
        DEFT_APP_RUNS_ENABLED: 'true',
        DEFT_APP_RUN_APP_ORIGIN_ENABLED: 'true',
        DEFT_APP_RUN_KEYRINGS: '',
      },
    },
  );
  assert.notEqual(invalid.status, 0);
  assert.match(
    `${invalid.stdout}\n${invalid.stderr}`,
    /DEFT_APP_RUN_APP_ORIGIN_ENABLED=true requires DEFT_APP_RUNS_ENABLED=true and DEFT_APPS_ENABLED=true/,
  );
});
