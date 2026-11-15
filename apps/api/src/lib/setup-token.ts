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
 * a well-formed, unexpired, matching token is refused. Self-hosted installs
 * never read these settings.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

const SHA256_HEX = /^[0-9a-f]{64}$/;
// A full date and time with an explicit zone, so Date.parse never guesses.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export const SETUP_TOKEN_MAX_LENGTH = 512;

/**
 * One public answer for every refusal (no hash configured, no token sent,
 * wrong token, expired token), so a caller learns nothing about how close a
 * guess was or how the cell is configured.
 */
export const SETUP_TOKEN_ERROR = {
  error:
    'This workspace can only be created from its setup link. ' +
    'The link is missing, incorrect, or has expired.',
  code: 'SETUP_TOKEN_INVALID',
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
  if (expiresAt && (!ISO_TIME.test(expiresAt) || Number.isNaN(Date.parse(expiresAt)))) {
    throw new Error('DEFT_SETUP_TOKEN_EXPIRES_AT must be an ISO 8601 time with a zone, for example 2026-12-04T10:00:00Z');
  }
  if (!hash) return null;
  if (!SHA256_HEX.test(hash)) {
    throw new Error('DEFT_SETUP_TOKEN_SHA256 must be a SHA-256 hash written as 64 lowercase hex characters');
  }
  if (!expiresAt) {
    throw new Error('DEFT_SETUP_TOKEN_EXPIRES_AT is required when DEFT_SETUP_TOKEN_SHA256 is set');
  }
  return { hash: Buffer.from(hash, 'hex'), expiresAtMs: Date.parse(expiresAt) };
}

/** Startup check, called from env.ts. Self-hosted installs skip it entirely. */
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
