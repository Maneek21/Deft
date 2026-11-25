/**
 * Where telemetry goes, and whether it goes at all (telemetry contract).
 *
 * Hosted cells (DEFT_HOSTED=true) send error events and problem reports to
 * the control plane over the channel they already use for seat statements:
 * the same base address and the same bearer token (lib/seat-settings.ts).
 * With any of those settings missing, nothing is sent.
 *
 * Self-hosted Deft sends no error events and no problem reports anywhere. It
 * sends only the anonymous install ping (install-ping.ts), unless
 * DEFT_TELEMETRY turns it off.
 *
 * DEFT_TELEMETRY is the off switch for everything sent without a person
 * asking: the install ping, and a hosted cell's error events. Problem reports
 * are sent only when a person asks, so the switch does not affect them.
 * Unset, empty, "on", "true", "1" or "yes" leave it on; any other value
 * ("off", "false", "0", "no", a typo) turns it off.
 *
 * Those automatic sends also need a production build (NODE_ENV=production,
 * as the Docker image sets), so a development server or a test run never
 * sends anything.
 *
 * Pure apart from reading the environment.
 */
import { parseSeatSettings } from '../seat-settings.js';

/** Same rule as lib/hosted-mode.ts, read from the given environment. */
function hosted(source: NodeJS.ProcessEnv): boolean {
  return source.DEFT_HOSTED === 'true';
}

export const TELEMETRY_SETTING = 'DEFT_TELEMETRY';

/** True when DEFT_TELEMETRY turns automatic sends off, or this is not a production build. */
export function isTelemetrySwitchedOff(source: NodeJS.ProcessEnv = process.env): boolean {
  const value = (source[TELEMETRY_SETTING] ?? '').trim().toLowerCase();
  return source.NODE_ENV !== 'production' || !['', 'on', 'true', '1', 'yes'].includes(value);
}

export type ControlPlaneTarget = {
  cellId: string;
  /** The control plane's base address, without a trailing slash. */
  baseUrl: string;
  /** The seat-statement fetch token, sent the same way: `Authorization: Bearer`. */
  token: string;
};

/**
 * The base address, from the seat-statement address the provisioner gives
 * each cell (`<base>/v1/cells/<cell id>/seat-statement`): everything before
 * `/v1/cells/`, or the origin when the address has no such part.
 */
export function controlPlaneBaseUrl(seatStatementUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(seatStatementUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  const at = parsed.pathname.indexOf('/v1/cells/');
  const prefix = at >= 0 ? parsed.pathname.slice(0, at) : '';
  return `${parsed.origin}${prefix}`.replace(/\/+$/, '');
}

/** The hosted channel, or null: not hosted, or a setting missing or unusable. */
export function controlPlaneTarget(source: NodeJS.ProcessEnv = process.env): ControlPlaneTarget | null {
  if (!hosted(source)) return null;
  const parsed = parseSeatSettings(source);
  if (!parsed.ok) return null;
  const baseUrl = controlPlaneBaseUrl(parsed.settings.url);
  if (!baseUrl) return null;
  return { cellId: parsed.settings.cellId, baseUrl, token: parsed.settings.fetchToken };
}

/** Error events: hosted, configured, and not switched off. */
export function errorTelemetryTarget(source: NodeJS.ProcessEnv = process.env): ControlPlaneTarget | null {
  if (isTelemetrySwitchedOff(source)) return null;
  return controlPlaneTarget(source);
}

/** Problem reports: hosted and configured. Self-hosted never sends one. */
export function problemReportTarget(source: NodeJS.ProcessEnv = process.env): ControlPlaneTarget | null {
  return controlPlaneTarget(source);
}

/** The install ping: self-hosted only, and not switched off. */
export function isInstallPingEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return !hosted(source) && !isTelemetrySwitchedOff(source);
}

export const SUPPORT_EMAIL_SETTING = 'DEFT_SUPPORT_EMAIL';

/**
 * Self-hosted only: an address people in this workspace can write to for
 * help. When set, "Get help" shows it; when unset, there is no help item.
 */
export function selfHostedSupportEmail(source: NodeJS.ProcessEnv = process.env): string | null {
  if (hosted(source)) return null;
  const value = (source[SUPPORT_EMAIL_SETTING] ?? '').trim();
  if (!value || value.length > 254) return null;
  return /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}$/.test(value) ? value : null;
}
