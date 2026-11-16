import { isHostedMode } from './hosted-mode.js';

const LOCAL_WEB_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'] as const;

/**
 * The configured web address as an origin, for hosted mode. Fails closed:
 * a missing or unusable NEXT_PUBLIC_APP_URL allows no browser origin at all.
 */
function hostedWebOrigins(): string[] {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!configured) return [];
  try {
    const url = new URL(configured);
    return url.protocol === 'https:' || url.protocol === 'http:' ? [url.origin] : [];
  } catch {
    return [];
  }
}

/** The two local development web addresses; none in hosted mode. */
export function localDevelopmentWebOrigins(): string[] {
  return isHostedMode() ? [] : [...LOCAL_WEB_ORIGINS];
}

/**
 * Browser origins the API's CORS policy accepts. Self-hosted: the configured
 * web address plus the two local development addresses, exactly as before.
 * Hosted: only the configured web address.
 */
export function corsAllowedWebOrigins(): string[] {
  if (isHostedMode()) return hostedWebOrigins();
  return [process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000', ...LOCAL_WEB_ORIGINS];
}

/**
 * Origin setting for the live-connection server's CORS. Self-hosted: the
 * configured web address, or the local default, exactly as before. Hosted:
 * only the configured web address (no local fallback).
 */
export function socketAllowedWebOrigins(): string | string[] {
  if (isHostedMode()) return hostedWebOrigins();
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

/** WebSocket upgrades need an origin check too; CORS covers only polling. */
export function socketOriginAllowed(origin: string | undefined): boolean {
  // Non-browser clients omit Origin and still authenticate with their token.
  return !isHostedMode() || origin === undefined || hostedWebOrigins().includes(origin);
}
