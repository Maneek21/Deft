import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  base32Decode,
  base32Encode,
  buildOtpauthUrl,
  generateRecoveryCodes,
  generateTwoStepSecret,
  generateTwoStepToken,
  hashTwoStepToken,
  isRecoveryResetToken,
  isTwoStepToken,
  hashRecoveryCode,
  matchTwoStepCode,
  normalizeRecoveryCode,
  twoStepCodeForStep,
  twoStepStepAt,
} from '../src/lib/two-step.js';

// RFC 6238 appendix B, SHA-1 rows. The RFC prints 8 digits; a 6-digit code is
// the last six of the same truncation.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const RFC_VECTORS: Array<[seconds: number, eightDigits: string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

test('time-based codes match the RFC 6238 SHA-1 test vectors', () => {
  for (const [seconds, eightDigits] of RFC_VECTORS) {
    const step = twoStepStepAt(seconds * 1000);
    assert.equal(step, Math.floor(seconds / 30));
    assert.equal(twoStepCodeForStep(RFC_SECRET, step), eightDigits.slice(2), `T=${seconds}`);
  }
});

test('a code is accepted for the current step and one step either side, and no further', () => {
  const secret = generateTwoStepSecret();
  const now = 1_800_000_000_000;
  const step = twoStepStepAt(now);
  for (const drift of [-1, 0, 1]) {
    assert.equal(matchTwoStepCode(secret, twoStepCodeForStep(secret, step + drift), now), step + drift);
  }
  for (const drift of [-3, -2, 2, 3]) {
    const code = twoStepCodeForStep(secret, step + drift);
    // A far step can collide with a near one by chance (1 in 10^6); skip then.
    const near = [-1, 0, 1].map((d) => twoStepCodeForStep(secret, step + d));
    if (!near.includes(code)) assert.equal(matchTwoStepCode(secret, code, now), null, `drift ${drift}`);
  }
});

test('codes are six digits; spaces are tolerated and anything else is refused', () => {
  const secret = generateTwoStepSecret();
  const now = Date.now();
  const code = twoStepCodeForStep(secret, twoStepStepAt(now));
  assert.match(code, /^\d{6}$/);
  assert.equal(matchTwoStepCode(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now), twoStepStepAt(now));
  for (const bad of ['', '12345', '1234567', 'abcdef', `${code}0`, ` ${code.slice(0, 5)}x`]) {
    assert.equal(matchTwoStepCode(secret, bad, now), null, JSON.stringify(bad));
  }
  const other = generateTwoStepSecret();
  if (twoStepCodeForStep(other, twoStepStepAt(now)) !== code) assert.equal(matchTwoStepCode(other, code, now), null);
});

test('secrets are 160 random bits in base32 and round-trip', () => {
  const secret = generateTwoStepSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(base32Decode(secret).length, 20);
  assert.equal(base32Encode(base32Decode(secret)), secret);
  assert.notEqual(generateTwoStepSecret(), secret);
  assert.throws(() => base32Decode('not base32 !'));
});

test('the otpauth address names the issuer, the account and the RFC 6238 parameters', () => {
  const url = new URL(buildOtpauthUrl({ secret: 'JBSWY3DPEHPK3PXP', account: 'ada+test@example.com', issuer: 'Deft' }));
  assert.equal(url.protocol, 'otpauth:');
  assert.equal(url.host, 'totp');
  assert.equal(decodeURIComponent(url.pathname), '/Deft:ada+test@example.com');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    secret: 'JBSWY3DPEHPK3PXP', issuer: 'Deft', algorithm: 'SHA1', digits: '6', period: '30',
  });
});

test('recovery codes are distinct, long, and hash the same however they are typed', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) {
    assert.match(code, /^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/);
    const hash = hashRecoveryCode(code);
    assert.match(hash!, /^[a-f0-9]{64}$/);
    assert.ok(!hash!.includes(normalizeRecoveryCode(code)!.toLowerCase()));
    assert.equal(hashRecoveryCode(code.toLowerCase().replace(/-/g, ' ')), hash);
  }
  assert.equal(hashRecoveryCode('too-short'), null);
  assert.equal(hashRecoveryCode('123456'), null);
});

test('challenge tokens are opaque, not JWTs', () => {
  const token = generateTwoStepToken();
  assert.match(token, /^tsc_[A-Za-z0-9_-]{43}$/);
  assert.equal(token.split('.').length, 1);
  assert.notEqual(generateTwoStepToken(), token);
});

test('a recovery-reset token is its own kind, told apart only by its prefix, which its hash covers', () => {
  const reset = generateTwoStepToken('recovery_reset');
  const challenge = generateTwoStepToken();
  assert.match(reset, /^tsr_[A-Za-z0-9_-]{43}$/);
  assert.equal(isRecoveryResetToken(reset), true);
  assert.equal(isRecoveryResetToken(challenge), false);
  assert.equal(isTwoStepToken(reset) && isTwoStepToken(challenge), true);
  assert.equal(isTwoStepToken('eyJhbGciOiJIUzI1NiJ9.e30.x'), false);
  // Renaming the prefix gives a token whose hash matches no stored challenge.
  assert.notEqual(hashTwoStepToken(`tsc_${reset.slice(4)}`), hashTwoStepToken(reset));
});

// One policy at every place a session is issued: only the two session modules
// may create or rotate a session, and only session-issuance.ts may say a
// second step was verified.
test('no route or library issues a session except through session-issuance.ts', () => {
  const src = resolve(import.meta.dirname, '../src');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(src);
  const allowed = new Set(['web-sessions.ts', 'session-issuance.ts'].map((name) => join(src, 'lib', name)));
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (!allowed.has(file) && /\b(createWebSession|rotateWebSession)\s*\(/.test(text)) offenders.push(file);
    if (!allowed.has(file) && /secondStep:\s*'verified'/.test(text)) offenders.push(file);
    // Session tokens are signed in exactly one module.
    if (file !== join(src, 'lib', 'web-sessions.ts') && /purpose:\s*'web-(access|refresh)'/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
  const issuance = readFileSync(join(src, 'lib', 'session-issuance.ts'), 'utf8');
  for (const via of ['login', 'invite', 'signup', 'refresh', 'challenge', 'enrolment']) assert.ok(issuance.includes(`case '${via}'`), via);
  for (const [route, via] of [['auth.ts', "via: 'signup'"], ['auth.ts', "via: 'login'"], ['auth.ts', "via: 'refresh'"], ['invites.ts', "via: 'invite'"]] as const) {
    assert.ok(readFileSync(join(src, 'routes', route), 'utf8').includes(via), `${route} ${via}`);
  }
});
