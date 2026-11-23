/**
 * The seat settings and the startup guard (apps/api/src/lib/seat-settings.ts,
 * called from apps/api/src/lib/env.ts; registered as hosted-only in
 * lib/hosted-settings.ts). A self-hosted install must not carry them, and a
 * hosted cell must not start without all four. No database.
 *
 * Run: pnpm --filter @deft/api test test/seat-settings.test.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { HOSTED_ONLY_SETTINGS } from '../src/lib/hosted-settings.js';
import { parseSeatSettings, parseSeatsPurchaseUrl, SEAT_SETTING_NAMES, SEATS_PURCHASE_URL_SETTING, validateSeatEnvironment } from '../src/lib/seat-settings.js';

const SEATS = {
  DEFT_CELL_ID: 'cell-7f3a9c',
  DEFT_SEAT_PUBLIC_KEYS: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg',
  DEFT_SEAT_STATEMENT_URL: 'https://control.test.invalid/v1/seat-statement',
  DEFT_SEAT_FETCH_TOKEN: 'zz-secret-fetch-token-zz',
};
type Case = [label: string, change: Record<string, string>, named: RegExp];
const BROKEN: Case[] = [
  ['cell ID missing', { DEFT_CELL_ID: '' }, /DEFT_CELL_ID/],
  ['cell ID with a space', { DEFT_CELL_ID: 'cell 7f' }, /DEFT_CELL_ID/],
  ['no public key', { DEFT_SEAT_PUBLIC_KEYS: '' }, /DEFT_SEAT_PUBLIC_KEYS/],
  ['a public key that is not 32 bytes', { DEFT_SEAT_PUBLIC_KEYS: 'zz-not-a-key-zz' }, /DEFT_SEAT_PUBLIC_KEYS/],
  ['plain http address', { DEFT_SEAT_STATEMENT_URL: 'http://control.test.invalid/v1/seat-statement' }, /DEFT_SEAT_STATEMENT_URL/],
  ['address with a password', { DEFT_SEAT_STATEMENT_URL: 'https://u:zz-pw-zz@control.test.invalid/' }, /DEFT_SEAT_STATEMENT_URL/],
  ['no fetch token', { DEFT_SEAT_FETCH_TOKEN: ' ' }, /DEFT_SEAT_FETCH_TOKEN/],
];
const SECRETS = ['zz-secret-fetch-token-zz', 'zz-not-a-key-zz', 'zz-pw-zz'];
const SEATS_PAGE = 'https://control.test.invalid/seats';

test('all four seat settings are hosted-only', () => {
  for (const name of SEAT_SETTING_NAMES) assert.ok(HOSTED_ONLY_SETTINGS.includes(name), name);
  assert.deepEqual([...SEAT_SETTING_NAMES].sort(), Object.keys(SEATS).sort());
});

test('parse: usable settings, and each way they are not', () => {
  const parsed = parseSeatSettings(SEATS);
  assert.ok(parsed.ok);
  assert.equal(parsed.settings.cellId, 'cell-7f3a9c');
  assert.equal(parseSeatSettings({}).ok, false);
  for (const [label, change, named] of BROKEN) {
    const result = parseSeatSettings({ ...SEATS, ...change });
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.match(result.problems.join('\n'), named, label);
  }
  // Self-hosted: nothing is checked.
  assert.doesNotThrow(() => validateSeatEnvironment(false, {}));
  assert.throws(() => validateSeatEnvironment(true, {}),
    /DEFT_CELL_ID.*DEFT_SEAT_PUBLIC_KEYS.*DEFT_SEAT_STATEMENT_URL.*DEFT_SEAT_FETCH_TOKEN/);
  assert.doesNotThrow(() => validateSeatEnvironment(true, SEATS));
});

test('the "Buy more seats" page: optional, hosted-only, https without credentials', () => {
  assert.equal(SEATS_PURCHASE_URL_SETTING, 'DEFT_HOSTED_SEATS_URL');
  assert.ok(HOSTED_ONLY_SETTINGS.includes(SEATS_PURCHASE_URL_SETTING));
  assert.deepEqual(parseSeatsPurchaseUrl({}), { ok: true, url: null });
  assert.deepEqual(parseSeatsPurchaseUrl({ DEFT_HOSTED_SEATS_URL: ' ' }), { ok: true, url: null });
  assert.deepEqual(parseSeatsPurchaseUrl({ DEFT_HOSTED_SEATS_URL: SEATS_PAGE }), { ok: true, url: SEATS_PAGE });
  for (const bad of ['http://control.test.invalid/seats', 'https://u:zz-pw-zz@control.test.invalid/seats', 'javascript:alert(1)', 'not a url']) {
    const parsed = parseSeatsPurchaseUrl({ DEFT_HOSTED_SEATS_URL: bad });
    assert.equal(parsed.ok, false, bad);
    assert.throws(() => validateSeatEnvironment(true, { ...SEATS, DEFT_HOSTED_SEATS_URL: bad }), (error: Error) => {
      assert.match(error.message, /DEFT_HOSTED_SEATS_URL must be an https address/);
      assert.ok(!error.message.includes('zz-pw-zz'), 'no setting value printed');
      return true;
    }, bad);
  }
  assert.doesNotThrow(() => validateSeatEnvironment(true, { ...SEATS, DEFT_HOSTED_SEATS_URL: SEATS_PAGE }));
});

const GUARDED = ['DEFT_HOSTED', ...HOSTED_ONLY_SETTINGS];
function start(overrides: Record<string, string>) {
  const source = new URL('../src/lib/env.ts', import.meta.url).href;
  const script = `await import(${JSON.stringify(source)}); console.log('started');`;
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !GUARDED.includes(name)));
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true,
    env: { ...inherited, NODE_ENV: 'test', DOTENV_CONFIG_QUIET: 'true',
      DATABASE_URL: 'postgres://fixture@127.0.0.1:1/never_connected',
      DEFT_APP_RUNS_ENABLED: 'false', ...overrides },
  });
}

test('env import: a seat setting without hosted mode stops startup', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['all four, switch unset', SEATS],
    ['fetch token only, switch unset', { DEFT_SEAT_FETCH_TOKEN: SEATS.DEFT_SEAT_FETCH_TOKEN }],
    ['empty cell ID, switch unset', { DEFT_CELL_ID: '' }],
    ['all four, DEFT_HOSTED=false', { DEFT_HOSTED: 'false', ...SEATS }],
    ['the seats page only, switch unset', { DEFT_HOSTED_SEATS_URL: SEATS_PAGE }],
  ];
  for (const [label, overrides] of cases) {
    const child = start(overrides);
    assert.equal(child.status, 1, `${label}: env import must fail before startup`);
    assert.match(child.stderr, /hosted-only setting/, label);
    assert.equal(child.stdout, '', label);
    for (const value of SECRETS) assert.ok(!child.stderr.includes(value), `${label}: no setting value printed`);
  }
});

test('env import: hosted mode without usable seat settings stops startup', () => {
  const cases: Case[] = [
    ['no seat settings', {}, /DEFT_CELL_ID/],
    ...BROKEN.map(([label, change, named]): Case => [label, { ...SEATS, ...change }, named]),
  ];
  for (const [label, seats, named] of cases) {
    const child = start({ DEFT_HOSTED: 'true', ...seats });
    assert.equal(child.status, 1, `${label}: env import must fail before startup`);
    assert.match(child.stderr, /Hosted mode needs a usable seat statement setup/, label);
    assert.match(child.stderr, named, label);
    assert.equal(child.stdout, '', label);
    for (const value of SECRETS) assert.ok(!child.stderr.includes(value), `${label}: no setting value printed`);
  }
});

test('env import: hosted mode with all four seat settings starts, with or without the seats page', () => {
  for (const extra of [{}, { DEFT_HOSTED_SEATS_URL: SEATS_PAGE }]) {
    const child = start({ DEFT_HOSTED: 'true', ...SEATS, ...extra });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), 'started');
  }
});
