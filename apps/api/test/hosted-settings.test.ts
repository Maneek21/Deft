/**
 * Startup guard around the hosted-mode switch (apps/api/src/lib/hosted-settings.ts,
 * called from apps/api/src/lib/env.ts). A mistyped DEFT_HOSTED, or a
 * hosted-only setting present with hosted mode off, must stop the API at
 * startup: otherwise a hosted cell would start as a self-hosted install and
 * its first visitor could claim it without a setup token. No database.
 *
 * Run: pnpm --filter @deft/api test test/hosted-settings.test.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  HOSTED_ONLY_SETTINGS,
  presentHostedOnlySettings,
  validateHostedModeEnvironment,
} from '../src/lib/hosted-settings.js';

const HASH = 'a'.repeat(64);
const EXPIRES_AT = '2026-12-04T10:00:00Z';
// A hosted cell does not start without its four seat settings (seat-settings.test.ts).
const SEATS = {
  DEFT_CELL_ID: 'cell-7f3a9c',
  DEFT_SEAT_PUBLIC_KEYS: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg',
  DEFT_SEAT_STATEMENT_URL: 'https://control.test.invalid/v1/seat-statement',
  DEFT_SEAT_FETCH_TOKEN: 'test-fetch-token',
};
// What isHostedMode() answers for an environment; the guard is handed it.
const hosted = (source: NodeJS.ProcessEnv) => source.DEFT_HOSTED === 'true';
const check = (source: NodeJS.ProcessEnv) => validateHostedModeEnvironment(hosted(source), source);

test('the switch may be unset, "true" or "false", and nothing else', () => {
  assert.doesNotThrow(() => check({}));
  assert.doesNotThrow(() => check({ DEFT_HOSTED: 'false' }));
  assert.doesNotThrow(() => check({ DEFT_HOSTED: 'true' }));
  for (const value of ['1', 'TRUE', 'True', 'true ', ' true', '', ' ', 'yes', 'on', '0', 'FALSE', 'false ', 'hosted']) {
    assert.throws(() => check({ DEFT_HOSTED: value }), /DEFT_HOSTED must be exactly "true" or "false"/, JSON.stringify(value));
    // The same typo beside a complete setup token is still a startup error.
    assert.throws(
      () => check({ DEFT_HOSTED: value, DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: EXPIRES_AT }),
      /DEFT_HOSTED must be exactly "true" or "false"/, JSON.stringify(value));
  }
});

test('a hosted-only setting needs hosted mode, whatever its value', () => {
  assert.deepEqual([...HOSTED_ONLY_SETTINGS], ['DEFT_SETUP_TOKEN_SHA256', 'DEFT_SETUP_TOKEN_EXPIRES_AT', ...Object.keys(SEATS), 'DEFT_HOSTED_SEATS_URL']);
  for (const off of [{}, { DEFT_HOSTED: 'false' }]) {
    for (const name of HOSTED_ONLY_SETTINGS) {
      for (const value of [HASH, EXPIRES_AT, 'anything', '']) {
        assert.throws(() => check({ ...off, [name]: value }), (error: Error) => {
          assert.match(error.message, new RegExp(`${name} is a hosted-only setting, but DEFT_HOSTED is not "true"`));
          if (value) assert.ok(!error.message.includes(value), 'the value of a hosted-only setting is not printed');
          return true;
        }, `${JSON.stringify(off)} ${name}=${JSON.stringify(value)}`);
      }
    }
    assert.throws(
      () => check({ ...off, DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: EXPIRES_AT }),
      /DEFT_SETUP_TOKEN_SHA256 and DEFT_SETUP_TOKEN_EXPIRES_AT are hosted-only settings/);
  }
  // In hosted mode they are allowed, and so is their absence.
  assert.doesNotThrow(() => check({ DEFT_HOSTED: 'true', DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: EXPIRES_AT }));
  assert.doesNotThrow(() => check({ DEFT_HOSTED: 'true' }));
  assert.deepEqual(presentHostedOnlySettings({ DEFT_SETUP_TOKEN_EXPIRES_AT: '', OTHER: 'x' }), ['DEFT_SETUP_TOKEN_EXPIRES_AT']);
  assert.deepEqual(presentHostedOnlySettings({ OTHER: 'x' }), []);
});

const GUARDED = ['DEFT_TEST_FAILURE_SWITCHES', 'DEFT_HOSTED', ...HOSTED_ONLY_SETTINGS];
function start(overrides: Record<string, string>) {
  const source = new URL('../src/lib/env.ts', import.meta.url).href;
  const script = `await import(${JSON.stringify(source)}); console.log('started');`;
  // Unset means unset here: an empty value is itself one of the refused cases.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !GUARDED.includes(name)));
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true,
    env: { ...inherited, NODE_ENV: 'test', DOTENV_CONFIG_QUIET: 'true',
      DATABASE_URL: 'postgres://fixture@127.0.0.1:1/never_connected',
      DEFT_APP_RUNS_ENABLED: 'false', ...overrides },
  });
}

test('env import: a mistyped DEFT_HOSTED stops startup, with or without a setup token beside it', () => {
  for (const value of ['1', 'TRUE', 'true ', '']) {
    for (const beside of [{}, { DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: EXPIRES_AT }]) {
      const label = `DEFT_HOSTED=${JSON.stringify(value)} ${Object.keys(beside).length ? 'with' : 'without'} a setup token`;
      const child = start({ DEFT_HOSTED: value, ...beside });
      assert.equal(child.status, 1, `${label}: env import must fail before startup`);
      assert.match(child.stderr, /DEFT_HOSTED must be exactly "true" or "false"/, label);
      assert.equal(child.stdout, '', `${label}: no successful startup marker`);
      assert.ok(!child.stderr.includes(HASH), `${label}: the hash is not printed`);
    }
  }
});

test('env import: a setup-token setting without hosted mode stops startup', () => {
  for (const [label, overrides] of [
    ['hash and expiry, switch unset', { DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: EXPIRES_AT }],
    ['hash only, switch unset', { DEFT_SETUP_TOKEN_SHA256: HASH }],
    ['expiry only, switch unset', { DEFT_SETUP_TOKEN_EXPIRES_AT: EXPIRES_AT }],
    ['empty hash, switch unset', { DEFT_SETUP_TOKEN_SHA256: '' }],
    ['hash and expiry, DEFT_HOSTED=false', { DEFT_HOSTED: 'false', DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: EXPIRES_AT }],
  ] as const) {
    const child = start(overrides);
    assert.equal(child.status, 1, `${label}: env import must fail before startup`);
    assert.match(child.stderr, /hosted-only setting/, label);
    assert.match(child.stderr, /DEFT_HOSTED is not "true"/, label);
    assert.equal(child.stdout, '', `${label}: no successful startup marker`);
    assert.ok(!child.stderr.includes(HASH), `${label}: the hash is not printed`);
  }
});

test('env import: self-hosted (unset or "false") and hosted ("true") installs start', () => {
  for (const [label, overrides] of [
    ['switch unset', {}],
    ['DEFT_HOSTED=false', { DEFT_HOSTED: 'false' }],
    ['DEFT_HOSTED=true', { DEFT_HOSTED: 'true', ...SEATS }],
    ['DEFT_HOSTED=true with a setup token', { DEFT_HOSTED: 'true', DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: EXPIRES_AT, ...SEATS }],
  ] as const) {
    const child = start(overrides);
    assert.equal(child.status, 0, `${label}: ${child.stderr}`);
    assert.equal(child.stdout.trim(), 'started', label);
  }
});

test('env import: a test failure switch that does not name this install stops startup', () => {
  for (const [label, overrides] of [
    ['self-hosted, "true"', { DEFT_TEST_FAILURE_SWITCHES: 'true' }],
    ['hosted, "on"', { DEFT_HOSTED: 'true', ...SEATS, DEFT_TEST_FAILURE_SWITCHES: 'on' }],
    ['hosted, another cell', { DEFT_HOSTED: 'true', ...SEATS, DEFT_TEST_FAILURE_SWITCHES: 'cell:cell-other' }],
  ] as const) {
    const child = start(overrides);
    assert.equal(child.status, 1, `${label}: env import must fail before startup`);
    assert.match(child.stderr, /DEFT_TEST_FAILURE_SWITCHES/, label);
    assert.equal(child.stdout, '', `${label}: no successful startup marker`);
  }
  const self = start({ DEFT_TEST_FAILURE_SWITCHES: 'on' });
  assert.equal(self.status, 0, self.stderr);
  const cell = start({ DEFT_HOSTED: 'true', ...SEATS, DEFT_TEST_FAILURE_SWITCHES: `cell:${SEATS.DEFT_CELL_ID}` });
  assert.equal(cell.status, 0, cell.stderr);
  assert.match(cell.stderr, /DEFT_TEST_FAILURE_SWITCHES is on/);
});
