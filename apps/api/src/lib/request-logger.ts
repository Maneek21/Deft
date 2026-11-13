import { logger } from 'hono/logger';

// The published calendar feed carries its credential in the path, so its
// request-log lines show a fixed placeholder instead of the requested path.
// Every other request is logged unchanged.
const REDACTED_FEED_PATH = '/api/ics/feed/<redacted>';
const FEED_PATH = /\/ics\/feed(?:\/|$)/;

/** Decodes each valid %XX escape and leaves malformed ones in place, so a bad
 * escape anywhere in the target cannot hide the feed path from the check. */
function tolerantDecode(value: string): string {
  let current = value;
  for (let i = 0; i < 3; i += 1) {
    const next = current.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === current) break;
    current = next;
  }
  return current;
}

export function isPublishedFeedTarget(target: string): boolean {
  const path = tolerantDecode(target.split(/[?#]/, 1)[0] ?? '');
  return FEED_PATH.test(path.toLowerCase().replace(/\/{2,}/g, '/'));
}

/** hono/logger prints `<-- METHOD TARGET` and `--> METHOD TARGET STATUS TIME`. */
export function printRequestLogLine(line: string): void {
  const parts = line.split(' ');
  if (parts.length >= 3 && isPublishedFeedTarget(parts[2] ?? '')) parts[2] = REDACTED_FEED_PATH;
  console.log(parts.join(' '));
}

export const requestLogger = logger(printRequestLogLine);
