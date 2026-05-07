// ICS (RFC 5545) parse + generate for the calendar-sync feature.
//
// Parsing uses node-ical (battle-tested against real-world feeds from Google,
// Apple, Outlook). Generation is hand-rolled — the subset Deft emits is a
// minimal VCALENDAR with VEVENT children, no recurrence, no timezones beyond
// UTC. Anything more is over-scope for v1.
//
// What we expose:
//   - parseICS(text)   → array of normalised events
//   - generateICS(...) → text/calendar string for the outbound feed
//   - newPublishToken() / hashPublishToken() helpers used by the routes layer

import { randomBytes } from 'node:crypto';
import nodeIcal from 'node-ical';

export type ParsedEvent = {
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  start: Date;
  end: Date | null;
  all_day: boolean;
  organizer: string | null;
};

/**
 * Parse a raw ICS document into a flat array of events. Tolerates malformed
 * components (skips them) so a single bad VEVENT doesn't poison a whole feed.
 * Recurring events expand into a single base event for now (RRULE expansion
 * is over-scope for v1; Apple/Google/Outlook handle expansion themselves
 * when subscribing to OUR feed, and most user-facing feeds the worker ingests
 * already include EXDATEs and a reasonable horizon).
 */
export function parseICS(text: string): ParsedEvent[] {
  let raw: ReturnType<typeof nodeIcal.sync.parseICS>;
  try {
    raw = nodeIcal.sync.parseICS(text);
  } catch (err) {
    throw new Error(`ICS parse failed: ${(err as Error).message}`);
  }

  const out: ParsedEvent[] = [];
  for (const key of Object.keys(raw)) {
    const item = raw[key] as Record<string, unknown> | undefined;
    if (!item || item.type !== 'VEVENT') continue;

    const uid = typeof item.uid === 'string' && item.uid ? item.uid : key;
    const summary = typeof item.summary === 'string' ? item.summary : '';

    const startRaw = item.start;
    if (!(startRaw instanceof Date)) continue; // skip events with no parseable start
    const endRaw = item.end instanceof Date ? item.end : null;

    // node-ical exposes the all-day flag through a non-standard property
    // on the Date; fall back to "no end and exact midnight" heuristic.
    const dateType = (startRaw as Date & { dateOnly?: boolean }).dateOnly === true;
    const all_day =
      dateType ||
      (endRaw === null && startRaw.getUTCHours() === 0 && startRaw.getUTCMinutes() === 0 && startRaw.getUTCSeconds() === 0);

    out.push({
      uid,
      summary: summary.slice(0, 500),
      description: typeof item.description === 'string' ? item.description.slice(0, 5000) : null,
      location: typeof item.location === 'string' ? item.location.slice(0, 500) : null,
      start: startRaw,
      end: endRaw,
      all_day,
      organizer: extractOrganizer(item.organizer),
    });
  }

  return out;
}

function extractOrganizer(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const v = value as { val?: string; params?: { CN?: string } };
    return v.params?.CN ?? v.val ?? null;
  }
  return null;
}

// ─── Outbound generation ──────────────────────────────────────────────────────

export type OutboundEvent = {
  uid: string;
  summary: string;
  description?: string | null;
  start: Date;
  end?: Date | null;
  all_day?: boolean;
  url?: string | null;
};

/**
 * Generate an RFC 5545 VCALENDAR document. Always emits UTC, never DTSTART;TZID
 * — Apple/Google/Outlook all accept this. Unfolds long lines correctly so
 * subscribers don't reject the feed.
 */
export function generateICS(events: OutboundEvent[], opts: { name: string; description?: string }): string {
  const stamp = formatUTC(new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Deft//Deft Calendar Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(opts.name)}`,
  ];
  if (opts.description) lines.push(`X-WR-CALDESC:${escapeText(opts.description)}`);

  for (const e of events) {
    if (!e.start || !(e.start instanceof Date)) continue;
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${escapeText(e.uid)}`);
    lines.push(`DTSTAMP:${stamp}`);
    if (e.all_day) {
      lines.push(`DTSTART;VALUE=DATE:${formatDate(e.start)}`);
      if (e.end) lines.push(`DTEND;VALUE=DATE:${formatDate(e.end)}`);
    } else {
      lines.push(`DTSTART:${formatUTC(e.start)}`);
      if (e.end) lines.push(`DTEND:${formatUTC(e.end)}`);
    }
    lines.push(`SUMMARY:${escapeText(e.summary)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.url) lines.push(`URL:${escapeText(e.url)}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');

  // RFC 5545 §3.1: lines longer than 75 octets MUST be folded with CRLF + space.
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

function formatUTC(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return d.getUTCFullYear().toString() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
}

function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  let i = 0;
  chunks.push(line.slice(0, 75));
  i = 75;
  while (i < line.length) {
    chunks.push(' ' + line.slice(i, i + 74));
    i += 74;
  }
  return chunks.join('\r\n');
}

// ─── Outbound publish-token helpers ──────────────────────────────────────────

/**
 * Generate a fresh URL-safe token. 32 bytes of entropy = 256 bits, encoded
 * base64url (43 chars). Plenty of unguessability for a public feed URL.
 */
export function newPublishToken(): string {
  return randomBytes(32).toString('base64url');
}
