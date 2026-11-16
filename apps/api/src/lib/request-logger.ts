import { logger } from 'hono/logger';

// Some paths carry a credential: the published calendar feed, and the legacy
// invite preview (`/api/invites/preview/<token>`, still used by invite links
// issued before the token moved into the link fragment). Their request-log
// lines show a fixed placeholder instead of the requested path. Every other
// request is logged unchanged.
const REDACTED_FEED_PATH = '/api/ics/feed/<redacted>';
const FEED_PATH = /^\/api\/ics\/feed(?:\/|$)/;
const REDACTED_INVITE_PREVIEW_PATH = '/api/invites/preview/<redacted>';
// Matches `/api/invites/preview/<anything>` but not the bare POST path.
const INVITE_PREVIEW_TOKEN_PATH = /^\/api\/invites\/preview\/./;

/** Decodes each valid %XX escape and leaves malformed ones in place, so a bad
 * escape anywhere in the target cannot hide a secret-bearing path from the check. */
function tolerantDecode(value: string): string {
  let current = value;
  for (let i = 0; i < 3; i += 1) {
    const next = current.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === current) break;
    current = next;
  }
  return current;
}

function normalizedPath(target: string): string {
  const path = tolerantDecode(target.split(/[?#]/, 1)[0] ?? '');
  return path.toLowerCase().replace(/\/{2,}/g, '/');
}

export function isPublishedFeedTarget(target: string): boolean {
  return FEED_PATH.test(normalizedPath(target));
}

export function isInvitePreviewTokenTarget(target: string): boolean {
  return INVITE_PREVIEW_TOKEN_PATH.test(normalizedPath(target));
}

/** Returns the target to print for a request-log line. */
export function redactLogTarget(target: string): string {
  if (isPublishedFeedTarget(target)) return REDACTED_FEED_PATH;
  if (isInvitePreviewTokenTarget(target)) return REDACTED_INVITE_PREVIEW_PATH;
  return target;
}

/** hono/logger prints `<-- METHOD TARGET` and `--> METHOD TARGET STATUS TIME`. */
export function printRequestLogLine(line: string): void {
  const parts = line.split(' ');
  if (parts.length >= 3) parts[2] = redactLogTarget(parts[2] ?? '');
  console.log(parts.join(' '));
}

export const requestLogger = logger(printRequestLogLine);
