/**
 * Verifying side of the `deft-seat-v1` seat statement (hosted design note
 * section 9). The control plane signs a statement saying how many seats this
 * cell may fill; the cell fetches it and checks it here. Written from the
 * wire-format specification; it must agree with the published test vectors
 * (apps/api/test/fixtures/seat-statement-v1.json).
 *
 *     deft-seat-v1.<base64url(payload)>.<base64url(ed25519 signature)>
 *
 * The signature covers the ASCII bytes of `deft-seat-v1.<payload segment>`
 * exactly as received. The payload has exactly one valid form, so it is
 * matched with a regular expression, never parsed loosely as JSON.
 *
 * Never throws: every input, however odd, gets an answer.
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export const SEAT_STATEMENT_PREFIX = 'deft-seat-v1';
const MAX_TOKEN_LENGTH = 1024;
const MAX_SEATS = 1_000_000;
const MAX_VERSION = 999_999_999_999_999;
const MAX_TIME = 253_402_300_799;
export const DEFAULT_SEAT_CLOCK_SKEW_SECONDS = 300;

const SPKI_ED25519_HEADER = Buffer.from('302a300506032b6570032100', 'hex');
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const CELL_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PAYLOAD =
  /^\{"cell_id":"([A-Za-z0-9._:-]{1,128})","seats":(0|[1-9][0-9]{0,6}),"version":([1-9][0-9]{0,14}),"issued_at":(0|[1-9][0-9]{0,11}),"expires_at":([1-9][0-9]{0,11})\}$/;

export interface SeatStatement {
  cell_id: string;
  seats: number;
  version: number;
  issued_at: number;
  expires_at: number;
}

export type SeatRefusalReason =
  | 'malformed'
  | 'bad_signature'
  | 'wrong_cell'
  | 'not_yet_valid'
  | 'expired'
  | 'stale_version'
  | 'verifier_misconfigured';

export type SeatVerifyResult =
  | { ok: true; statement: SeatStatement }
  | { ok: false; reason: SeatRefusalReason };

export interface SeatVerifyInput {
  token: unknown;
  publicKeys: readonly string[];
  expectedCellId: string;
  nowSeconds: number;
  /** Highest version already accepted; 0 if none. */
  versionFloor: number;
  maxClockSkewSeconds?: number;
}

/** Strict base64url: URL-safe alphabet, no padding, canonical. */
function decodeBase64Url(text: string): Buffer | null {
  if (!BASE64URL.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.toString('base64url') === text ? bytes : null;
}

function loadPublicKey(encoded: unknown): KeyObject | null {
  if (typeof encoded !== 'string') return null;
  const raw = decodeBase64Url(encoded);
  if (!raw || raw.length !== 32) return null;
  try {
    return createPublicKey({ key: Buffer.concat([SPKI_ED25519_HEADER, raw]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

function wholeInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function parsePayload(text: string): SeatStatement | null {
  const match = PAYLOAD.exec(text);
  if (!match) return null;
  const statement: SeatStatement = {
    cell_id: match[1]!,
    seats: Number(match[2]),
    version: Number(match[3]),
    issued_at: Number(match[4]),
    expires_at: Number(match[5]),
  };
  if (statement.seats > MAX_SEATS || statement.version > MAX_VERSION) return null;
  if (statement.issued_at > MAX_TIME || statement.expires_at > MAX_TIME) return null;
  if (statement.expires_at <= statement.issued_at) return null;
  return statement;
}

/** Whether a configured cell ID could ever match a statement. */
export function isValidSeatCellId(value: unknown): value is string {
  return typeof value === 'string' && CELL_ID.test(value);
}

/** Whether every configured key is a usable Ed25519 public key. */
export function areValidSeatPublicKeys(keys: readonly string[]): boolean {
  return keys.length > 0 && keys.every((key) => loadPublicKey(key) !== null);
}

export function verifySeatStatement(input: SeatVerifyInput): SeatVerifyResult {
  try {
    return verifyInner(input);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

function verifyInner(input: SeatVerifyInput): SeatVerifyResult {
  const refuse = (reason: SeatRefusalReason): SeatVerifyResult => ({ ok: false, reason });
  const skew = input.maxClockSkewSeconds ?? DEFAULT_SEAT_CLOCK_SKEW_SECONDS;
  if (!wholeInRange(input.nowSeconds, 0, MAX_TIME)
    || !wholeInRange(input.versionFloor, 0, MAX_VERSION)
    || !wholeInRange(skew, 0, MAX_TIME)
    || !isValidSeatCellId(input.expectedCellId)
    || !Array.isArray(input.publicKeys) || input.publicKeys.length === 0) {
    return refuse('verifier_misconfigured');
  }
  const keys: KeyObject[] = [];
  for (const encoded of input.publicKeys) {
    const key = loadPublicKey(encoded);
    if (!key) return refuse('verifier_misconfigured');
    keys.push(key);
  }

  // 1. Token shape.
  const token = input.token;
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return refuse('malformed');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== SEAT_STATEMENT_PREFIX) return refuse('malformed');
  const payloadSegment = parts[1]!;
  const payloadBytes = decodeBase64Url(payloadSegment);
  const signature = decodeBase64Url(parts[2]!);
  if (!payloadBytes || !signature || signature.length !== 64) return refuse('malformed');

  // 2. Signature over the bytes as received.
  const signingInput = Buffer.from(`${SEAT_STATEMENT_PREFIX}.${payloadSegment}`, 'ascii');
  if (!keys.some((key) => cryptoVerify(null, signingInput, key, signature))) return refuse('bad_signature');

  // 3. Exact payload form. latin1 keeps every byte as one character, so a
  //    non-ASCII byte fails the pattern instead of being repaired.
  const statement = parsePayload(payloadBytes.toString('latin1'));
  if (!statement) return refuse('malformed');

  // 4 to 7. Meaning.
  if (statement.cell_id !== input.expectedCellId) return refuse('wrong_cell');
  if (statement.issued_at > input.nowSeconds + skew) return refuse('not_yet_valid');
  if (input.nowSeconds >= statement.expires_at) return refuse('expired');
  if (statement.version < input.versionFloor) return refuse('stale_version');
  return { ok: true, statement };
}
