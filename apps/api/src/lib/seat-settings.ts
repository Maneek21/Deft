/**
 * The four settings a hosted cell needs to fetch and check its seat
 * statement (hosted design note section 9). All four are hosted-only
 * (lib/hosted-settings.ts refuses them with hosted mode off), and with hosted
 * mode on the API refuses to start unless all four are present and usable,
 * so a misprovisioned cell fails loudly instead of quietly refusing every
 * invitation. Pure: no database, no network.
 */
import { areValidSeatPublicKeys, isValidSeatCellId } from './seat-statement.js';

export const SEAT_SETTING_NAMES = [
  'DEFT_CELL_ID',
  'DEFT_SEAT_PUBLIC_KEYS',
  'DEFT_SEAT_STATEMENT_URL',
  'DEFT_SEAT_FETCH_TOKEN',
] as const;

export type SeatSettings = { cellId: string; publicKeys: string[]; url: string; fetchToken: string };

/** The settings, or what is wrong with them. Problems name settings, never values. */
export function parseSeatSettings(
  source: NodeJS.ProcessEnv = process.env,
): { ok: true; settings: SeatSettings } | { ok: false; problems: string[] } {
  const cellId = (source.DEFT_CELL_ID ?? '').trim();
  const publicKeys = (source.DEFT_SEAT_PUBLIC_KEYS ?? '').split(',').map((key) => key.trim()).filter(Boolean);
  const url = (source.DEFT_SEAT_STATEMENT_URL ?? '').trim();
  const fetchToken = (source.DEFT_SEAT_FETCH_TOKEN ?? '').trim();
  const problems: string[] = [];
  if (!isValidSeatCellId(cellId)) {
    problems.push('DEFT_CELL_ID must be 1 to 128 characters from A-Z a-z 0-9 . _ : -');
  }
  if (!areValidSeatPublicKeys(publicKeys)) {
    problems.push('DEFT_SEAT_PUBLIC_KEYS must be one or more comma-separated Ed25519 public keys (base64url of 32 bytes)');
  }
  let urlOk = false;
  try {
    const parsed = new URL(url);
    // The fetch token is a bearer secret: never send it in clear text.
    urlOk = parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    urlOk = false;
  }
  if (!urlOk) problems.push('DEFT_SEAT_STATEMENT_URL must be an https address without a user name or password');
  if (!fetchToken) problems.push('DEFT_SEAT_FETCH_TOKEN must be set');
  return problems.length > 0 ? { ok: false, problems } : { ok: true, settings: { cellId, publicKeys, url, fetchToken } };
}

/** Startup check, called from env.ts with isHostedMode(). */
export function validateSeatEnvironment(hostedMode: boolean, source: NodeJS.ProcessEnv = process.env): void {
  if (!hostedMode) return;
  const parsed = parseSeatSettings(source);
  if (!parsed.ok) {
    throw new Error(`Hosted mode needs a usable seat statement setup: ${parsed.problems.join('; ')}.`);
  }
}
