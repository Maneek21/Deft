/**
 * Hosted mode: the one-time setup token (apps/api/src/lib/setup-token.ts) and
 * its startup check in apps/api/src/lib/env.ts. No database.
 *
 * Run: pnpm --filter @deft/api test test/setup-token.test.ts
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { isHostedMode } from '../src/lib/hosted-mode.js';
import {
  isSetupTokenValid,
  parseIsoTime,
  readSetupTokenSettings,
  validateSetupTokenEnvironment,
} from '../src/lib/setup-token.js';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const TOKEN = 'fixture-setup-token-0123456789abcdef';
const HASH = sha256(TOKEN);
const EXPIRES_AT = '2026-12-04T10:00:00Z';
const BEFORE = Date.parse('2026-12-04T09:59:59Z');
const AT = Date.parse(EXPIRES_AT);

// Every value here other than "true", "false" and unset also stops the API
// at startup; see hosted-settings.test.ts.
test('hosted mode is on only for the exact value "true"', () => {
  const saved = process.env.DEFT_HOSTED;
  try {
    for (const value of [undefined, '', 'false', '1', 'TRUE', 'True', ' true', 'true ', 'yes']) {
      if (value === undefined) delete process.env.DEFT_HOSTED; else process.env.DEFT_HOSTED = value;
      assert.equal(isHostedMode(), false, `DEFT_HOSTED=${JSON.stringify(value)} must be off`);
    }
    process.env.DEFT_HOSTED = 'true';
    assert.equal(isHostedMode(), true);
  } finally {
    if (saved === undefined) delete process.env.DEFT_HOSTED; else process.env.DEFT_HOSTED = saved;
  }
});

test('settings: no hash reads as not configured; a valid pair is parsed', () => {
  assert.equal(readSetupTokenSettings(undefined, undefined), null);
  assert.equal(readSetupTokenSettings('', ''), null);
  assert.equal(readSetupTokenSettings(undefined, EXPIRES_AT), null);
  const settings = readSetupTokenSettings(HASH, EXPIRES_AT);
  assert.equal(settings?.hash.toString('hex'), HASH);
  assert.equal(settings?.expiresAtMs, AT);
  assert.equal(readSetupTokenSettings(HASH, '2026-12-04T15:30:00+05:30')?.expiresAtMs, AT);
});

test('settings: a malformed hash or expiry is an error that never echoes the value', () => {
  const badHashes = [
    HASH.toUpperCase(), HASH.slice(0, 63), `${HASH}0`, `${HASH.slice(0, 63)}g`, ` ${HASH}`, 'not-a-hash',
  ];
  for (const hash of badHashes) {
    assert.throws(() => readSetupTokenSettings(hash, EXPIRES_AT), (error: Error) => {
      assert.match(error.message, /DEFT_SETUP_TOKEN_SHA256/);
      assert.ok(!error.message.includes(hash.trim()), 'the configured hash must not be printed');
      return true;
    });
  }
  const badExpiries = [
    '2026-12-04', '2026-12-04T10:00:00', '2026-12-04 10:00:00Z', '2026-13-40T10:00:00Z',
    'tomorrow', '1796378400', ` ${EXPIRES_AT}`,
  ];
  for (const expiry of badExpiries) {
    assert.throws(() => readSetupTokenSettings(HASH, expiry), /DEFT_SETUP_TOKEN_EXPIRES_AT/, expiry);
    // A malformed expiry is an error even before a hash is set.
    assert.throws(() => readSetupTokenSettings(undefined, expiry), /DEFT_SETUP_TOKEN_EXPIRES_AT/, expiry);
  }
  assert.throws(() => readSetupTokenSettings(HASH, undefined), /DEFT_SETUP_TOKEN_EXPIRES_AT is required/);
  assert.throws(() => readSetupTokenSettings(HASH, ''), /DEFT_SETUP_TOKEN_EXPIRES_AT is required/);
});

test('expiry: an impossible date or time is an error, never rolled forward to a real one', () => {
  const impossible = [
    ['31 November', '2026-11-31T10:00:00Z'],
    ['29 February in a non-leap year', '2027-02-29T10:00:00Z'],
    ['29 February 2100, a century that is not a leap year', '2100-02-29T10:00:00Z'],
    ['30 February', '2028-02-30T10:00:00Z'],
    ['31 April', '2027-04-31T10:00:00Z'],
    ['month 13', '2026-13-01T10:00:00Z'],
    ['month 00', '2026-00-10T10:00:00Z'],
    ['day 00', '2026-12-00T10:00:00Z'],
    ['day 32', '2026-12-32T10:00:00Z'],
    ['hour 24', '2026-12-04T24:00:00Z'],
    ['minute 60', '2026-12-04T10:60:00Z'],
    ['second 60', '2026-12-04T10:00:60Z'],
    ['offset hour 24', '2026-12-04T10:00:00+24:00'],
    ['offset minute 60', '2026-12-04T10:00:00+05:60'],
    ['no zone', '2026-12-04T10:00:00'],
    ['zone without a colon', '2026-12-04T10:00:00+0530'],
    ['lowercase z', '2026-12-04T10:00:00z'],
  ] as const;
  for (const [label, expiry] of impossible) {
    assert.equal(parseIsoTime(expiry), null, label);
    assert.throws(() => readSetupTokenSettings(HASH, expiry), /DEFT_SETUP_TOKEN_EXPIRES_AT must be a real ISO 8601/, label);
    assert.throws(() => validateSetupTokenEnvironment(true, HASH, expiry), /DEFT_SETUP_TOKEN_EXPIRES_AT/, label);
    // The same value can never make a token acceptable at request time.
    assert.equal(isSetupTokenValid(TOKEN, HASH, expiry, 0), false, label);
  }

  const real = [
    ['a leap day', '2028-02-29T10:00:00Z', Date.UTC(2028, 1, 29, 10)],
    ['29 February 2000, a century that is a leap year', '2000-02-29T10:00:00Z', Date.UTC(2000, 1, 29, 10)],
    ['28 February in a non-leap year', '2027-02-28T23:59:59Z', Date.UTC(2027, 1, 28, 23, 59, 59)],
    ['30 November', '2026-11-30T10:00:00Z', Date.UTC(2026, 10, 30, 10)],
    ['the last second of a year', '2026-12-31T23:59:59Z', Date.UTC(2026, 11, 31, 23, 59, 59)],
    ['milliseconds', '2026-12-04T10:00:00.250Z', Date.UTC(2026, 11, 4, 10, 0, 0, 250)],
    ['tenths of a second', '2026-12-04T10:00:00.5Z', Date.UTC(2026, 11, 4, 10, 0, 0, 500)],
    ['an offset ahead of UTC', '2026-12-04T15:30:00+05:30', AT],
    ['an offset behind UTC', '2026-12-04T02:00:00-08:00', AT],
    ['an offset that crosses midnight', '2026-12-05T00:30:00+14:30', AT],
  ] as const;
  for (const [label, expiry, instant] of real) {
    assert.equal(parseIsoTime(expiry), instant, label);
    assert.equal(parseIsoTime(expiry), Date.parse(expiry), `${label}: agrees with Date.parse on a real time`);
    assert.equal(readSetupTokenSettings(HASH, expiry)?.expiresAtMs, instant, label);
  }
});

test('the value check applies in hosted mode', () => {
  assert.throws(() => validateSetupTokenEnvironment(true, 'not-a-hash', EXPIRES_AT), /DEFT_SETUP_TOKEN_SHA256/);
  assert.throws(() => validateSetupTokenEnvironment(true, HASH, 'soon'), /DEFT_SETUP_TOKEN_EXPIRES_AT/);
  assert.doesNotThrow(() => validateSetupTokenEnvironment(true, HASH, EXPIRES_AT));
  // A missing hash is not a startup error: signup refuses instead.
  assert.doesNotThrow(() => validateSetupTokenEnvironment(true, undefined, undefined));
  // With hosted mode off this check stays out of the way: the settings being
  // present at all is refused first, by validateHostedModeEnvironment.
  assert.doesNotThrow(() => validateSetupTokenEnvironment(false, 'not-a-hash', 'soon'));
});

test('token check: only the matching token before the expiry is accepted', () => {
  assert.equal(isSetupTokenValid(TOKEN, HASH, EXPIRES_AT, BEFORE), true);

  assert.equal(isSetupTokenValid(TOKEN, HASH, EXPIRES_AT, AT), false, 'expired at the expiry instant');
  assert.equal(isSetupTokenValid(TOKEN, HASH, EXPIRES_AT, AT + 1), false, 'expired after it');
  assert.equal(isSetupTokenValid(`${TOKEN}x`, HASH, EXPIRES_AT, BEFORE), false, 'wrong token');
  assert.equal(isSetupTokenValid(TOKEN.slice(0, -1), HASH, EXPIRES_AT, BEFORE), false, 'near miss');
  assert.equal(isSetupTokenValid(HASH, HASH, EXPIRES_AT, BEFORE), false, 'the hash is not the token');
  assert.equal(isSetupTokenValid(undefined, HASH, EXPIRES_AT, BEFORE), false, 'missing token');
  assert.equal(isSetupTokenValid('', HASH, EXPIRES_AT, BEFORE), false, 'empty token');
  assert.equal(isSetupTokenValid('', sha256(''), EXPIRES_AT, BEFORE), false, 'empty token never matches');

  assert.equal(isSetupTokenValid(TOKEN, undefined, undefined, BEFORE), false, 'no hash configured');
  assert.equal(isSetupTokenValid(TOKEN, '', EXPIRES_AT, BEFORE), false, 'empty hash');
  assert.equal(isSetupTokenValid(TOKEN, HASH, undefined, BEFORE), false, 'hash without expiry');
  assert.equal(isSetupTokenValid(TOKEN, HASH.toUpperCase(), EXPIRES_AT, BEFORE), false, 'malformed hash');
  assert.equal(isSetupTokenValid(TOKEN, HASH, 'soon', BEFORE), false, 'malformed expiry');
});

const GUARDED = ['DEFT_HOSTED', 'DEFT_SETUP_TOKEN_SHA256', 'DEFT_SETUP_TOKEN_EXPIRES_AT'];
function start(overrides: Record<string, string>) {
  const source = new URL('../src/lib/env.ts', import.meta.url).href;
  const script = `await import(${JSON.stringify(source)}); console.log('started');`;
  // The three settings are left out unless a case sets them: an empty value
  // is not the same as unset (hosted-settings.test.ts).
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !GUARDED.includes(name)));
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true,
    env: { ...inherited, NODE_ENV: 'test', DOTENV_CONFIG_QUIET: 'true',
      DATABASE_URL: 'postgres://fixture@127.0.0.1:1/never_connected',
      DEFT_APP_RUNS_ENABLED: 'false', ...overrides },
  });
}

test('env import: hosted mode refuses to start with a malformed hash or expiry', () => {
  for (const [label, overrides, named] of [
    ['malformed hash', { DEFT_SETUP_TOKEN_SHA256: 'zz-not-a-hash-zz', DEFT_SETUP_TOKEN_EXPIRES_AT: EXPIRES_AT }, /DEFT_SETUP_TOKEN_SHA256/],
    ['malformed expiry', { DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: 'zz-not-a-time-zz' }, /DEFT_SETUP_TOKEN_EXPIRES_AT/],
    ['hash without expiry', { DEFT_SETUP_TOKEN_SHA256: HASH }, /DEFT_SETUP_TOKEN_EXPIRES_AT/],
    ['31 November', { DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: '2026-11-31T10:00:00Z' }, /DEFT_SETUP_TOKEN_EXPIRES_AT/],
  ] as const) {
    const child = start({ DEFT_HOSTED: 'true', ...overrides });
    assert.equal(child.status, 1, `${label}: hosted env import must fail before startup`);
    assert.match(child.stderr, named, label);
    assert.equal(child.stdout, '', `${label}: no successful startup marker`);
    for (const value of ['zz-not-a-hash-zz', 'zz-not-a-time-zz', HASH]) {
      assert.ok(!child.stderr.includes(value), `${label}: validation must not print a configured value`);
    }
  }
});

test('env import: hosted mode starts with valid or absent settings', () => {
  for (const [label, overrides] of [
    ['hosted, valid pair', { DEFT_HOSTED: 'true', DEFT_SETUP_TOKEN_SHA256: HASH, DEFT_SETUP_TOKEN_EXPIRES_AT: EXPIRES_AT }],
    ['hosted, nothing set', { DEFT_HOSTED: 'true' }],
  ] as const) {
    const child = start(overrides);
    assert.equal(child.status, 0, `${label}: ${child.stderr}`);
    assert.equal(child.stdout.trim(), 'started', label);
  }
});
