import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Two-step verification primitives: time-based codes per RFC 6238 (HMAC-SHA1,
 * 30-second steps, 6 digits) and single-use recovery codes. Pure functions;
 * storage, attempt limits and replay protection live in two-step-service.ts.
 */
export const TWO_STEP_PERIOD_SECONDS = 30;
export const TWO_STEP_DIGITS = 6;
/** One step of clock drift is accepted each way. */
export const TWO_STEP_DRIFT_STEPS = 1;
export const RECOVERY_CODE_COUNT = 10;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new 160-bit secret, base32 encoded as authenticator apps expect. */
export function generateTwoStepSecret(): string {
  return base32Encode(randomBytes(20));
}

export function twoStepStepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TWO_STEP_PERIOD_SECONDS);
}

/** RFC 4226 dynamic truncation over HMAC-SHA1 of the 8-byte step counter. */
export function twoStepCodeForStep(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24)
    | (digest[offset + 1]! << 16)
    | (digest[offset + 2]! << 8)
    | digest[offset + 3]!;
  return String(binary % 10 ** TWO_STEP_DIGITS).padStart(TWO_STEP_DIGITS, '0');
}

export function normalizeTwoStepCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

/**
 * The step a code is valid for at `nowMs`, or null. Every candidate step is
 * compared so the time taken does not depend on which one matched.
 */
export function matchTwoStepCode(secretBase32: string, input: string, nowMs: number): number | null {
  const code = normalizeTwoStepCode(input);
  if (!code) return null;
  const given = Buffer.from(code);
  const current = twoStepStepAt(nowMs);
  let matched: number | null = null;
  for (let drift = -TWO_STEP_DRIFT_STEPS; drift <= TWO_STEP_DRIFT_STEPS; drift += 1) {
    const step = current + drift;
    if (step < 0) continue;
    const expected = Buffer.from(twoStepCodeForStep(secretBase32, step));
    if (timingSafeEqual(given, expected) && matched === null) matched = step;
  }
  return matched;
}

export function buildOtpauthUrl(input: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const query = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TWO_STEP_DIGITS),
    period: String(TWO_STEP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

// No 0/O/1/I/L, so a code read from paper is not mistyped.
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 16 characters from a 31-letter alphabet: about 79 bits each. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    let raw = '';
    for (let index = 0; index < 16; index += 1) raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    codes.add(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12)}`);
  }
  return [...codes];
}

export function normalizeRecoveryCode(input: string): string | null {
  const raw = input.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z0-9]{16}$/.test(raw) ? raw : null;
}

/** Recovery codes are random and long, so a plain SHA-256 is enough. */
export function hashRecoveryCode(input: string): string | null {
  const raw = normalizeRecoveryCode(input);
  return raw ? createHash('sha256').update(`deft-two-step-recovery:${raw}`).digest('hex') : null;
}

export function hashTwoStepToken(token: string): string {
  return createHash('sha256').update(`deft-two-step-token:${token}`).digest('hex');
}

const CHALLENGE_TOKEN_PREFIX = 'tsc_';
const RECOVERY_RESET_TOKEN_PREFIX = 'tsr_';

/**
 * Opaque challenge token. It is not a JWT, so no session check accepts it.
 * `recovery_reset` is the enrol-only token a recovery-code sign-in earns: it
 * may set up a new authenticator without a further code. Its prefix is part
 * of the hashed token, so a holder cannot turn one kind into the other: a
 * changed prefix matches no stored challenge.
 */
export function generateTwoStepToken(purpose: 'challenge' | 'recovery_reset' = 'challenge'): string {
  const prefix = purpose === 'recovery_reset' ? RECOVERY_RESET_TOKEN_PREFIX : CHALLENGE_TOKEN_PREFIX;
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export function isTwoStepToken(token: string): boolean {
  return token.startsWith(CHALLENGE_TOKEN_PREFIX) || token.startsWith(RECOVERY_RESET_TOKEN_PREFIX);
}

/** Only meaningful for a token that matched a stored challenge (see above). */
export function isRecoveryResetToken(token: string): boolean {
  return token.startsWith(RECOVERY_RESET_TOKEN_PREFIX);
}

/** The answer a recovery-reset token gets anywhere but the two enrolment
 * calls (check 15.1). It is refused like any other non-session token; this
 * only says why. */
export const RECOVERY_RESET_REFUSAL = {
  error: 'You signed in with a recovery code. Set up a new authenticator before doing anything else.',
  code: 'TWO_STEP_ENROLMENT_REQUIRED',
} as const;
