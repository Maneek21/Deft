/**
 * Hosted mode: the one-time setup token.
 *
 * On the hosted service the provisioner makes a random token when it assigns
 * a cell, sends the buyer to `/signup#setup=<token>`, and gives the cell only
 * the token's SHA-256 hash and an expiry time:
 *
 *   DEFT_SETUP_TOKEN_SHA256      64 lowercase hex characters
 *   DEFT_SETUP_TOKEN_EXPIRES_AT  ISO 8601 time with a zone, e.g. 2026-12-04T10:00:00Z
 *
 * The first signup on a hosted cell must present the token. Anything short of
 * a well-formed, unexpired, matching token is refused. Both settings are
 * hosted-only: the API refuses to start if either is present with hosted mode
 * off (lib/hosted-settings.ts), so a self-hosted install never has them.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

const SHA256_HEX = /^[0-9a-f]{64}$/;
// A full date and time with an explicit zone: Z, +hh:mm or -hh:mm.
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * The instant an ISO 8601 time names, in milliseconds, or null when the text
 * is not a real time. Every part is checked here and the instant is built
 * from the parts, because Date.parse quietly rolls an impossible date
 * forward: it reads 31 November as 1 December.
 */
export function parseIsoTime(value: string): number | null {
  const match = ISO_TIME.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as
    [number, number, number, number, number, number];
  const leapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (daysInMonth === undefined || day < 1 || day > daysInMonth) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const milliseconds = Number((match[7] ?? '').padEnd(3, '0'));
  const offsetHours = Number(match[9] ?? 0);
  const offsetMinutes = Number(match[10] ?? 0);
  if (offsetHours > 23 || offsetMinutes > 59) return null;
  const offsetMs = (match[8] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000;
  // setUTCFullYear keeps years 0000 to 0099 as written; Date.UTC would add 1900.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milliseconds);
  return date.getTime() - offsetMs;
}

export const SETUP_TOKEN_MAX_LENGTH = 512;

/**
 * One public answer for every refusal (no hash configured, no token sent,
 * wrong token, expired token, token already used), so a caller learns nothing about how close a
 * guess was or how the cell is configured.
 */
export const SETUP_TOKEN_ERROR = {
  error:
    'This workspace can only be created from its setup link. ' +
    'The link is missing, incorrect, expired, or already used.',
  code: 'SETUP_TOKEN_INVALID',
} as const;

/**
 * The setup token was right but its use could not be checked or recorded
 * (lib/setup-token-use.ts), so no workspace was created. Only a caller holding
 * the right, unused token can see this.
 */
export const SETUP_UNAVAILABLE_ERROR = {
  error: 'The workspace could not be created right now. Try the setup link again in a few minutes.',
  code: 'SETUP_UNAVAILABLE',
} as const;

export type SetupTokenSettings = { hash: Buffer; expiresAtMs: number };

/**
 * Read the two settings. Returns null when no hash is configured. Throws on a
 * malformed hash, a hash without an expiry, or a malformed expiry. The error
 * text never includes a configured value.
 */
export function readSetupTokenSettings(
  hash: string | undefined,
  expiresAt: string | undefined,
): SetupTokenSettings | null {
  const expiresAtMs = expiresAt ? parseIsoTime(expiresAt) : null;
  if (expiresAt && expiresAtMs === null) {
    throw new Error('DEFT_SETUP_TOKEN_EXPIRES_AT must be a real ISO 8601 date and time with a zone, for example 2026-12-04T10:00:00Z');
  }
  if (!hash) return null;
  if (!SHA256_HEX.test(hash)) {
    throw new Error('DEFT_SETUP_TOKEN_SHA256 must be a SHA-256 hash written as 64 lowercase hex characters');
  }
  if (expiresAtMs === null) {
    throw new Error('DEFT_SETUP_TOKEN_EXPIRES_AT is required when DEFT_SETUP_TOKEN_SHA256 is set');
  }
  return { hash: Buffer.from(hash, 'hex'), expiresAtMs };
}

/**
 * Startup check of the two values, called from env.ts. It applies in hosted
 * mode; with hosted mode off the settings must not be present at all, which
 * validateHostedModeEnvironment (lib/hosted-settings.ts) has already checked.
 */
export function validateSetupTokenEnvironment(
  hostedMode: boolean,
  hash: string | undefined,
  expiresAt: string | undefined,
): void {
  if (hostedMode) readSetupTokenSettings(hash, expiresAt);
}

/**
 * True only when a hash is configured, it has not expired, and the SHA-256 of
 * the presented token equals it. The comparison is constant time over two
 * 32-byte digests. Unreadable settings count as not configured.
 */
export function isSetupTokenValid(
  token: string | undefined,
  hash: string | undefined,
  expiresAt: string | undefined,
  now: number = Date.now(),
): boolean {
  let settings: SetupTokenSettings | null;
  try {
    settings = readSetupTokenSettings(hash, expiresAt);
  } catch {
    return false;
  }
  if (!settings) return false;
  // Always hash and compare, so a missing token costs the same as a wrong one.
  const presented = createHash('sha256').update(token ?? '', 'utf8').digest();
  const matches = timingSafeEqual(presented, settings.hash);
  return matches && typeof token === 'string' && token.length > 0 && now < settings.expiresAtMs;
}
