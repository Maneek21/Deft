// Shared timezone-aware time formatting utilities for Deft.
// All functions accept an ISO string and format it in the user's timezone.
// Call setUserTimezone() once on login to configure.

// Module-level timezone — set once on login, defaults to browser's timezone
let userTimezone: string = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function setUserTimezone(tz: string): void {
  userTimezone = tz;
}

export function getUserTimezone(): string {
  return userTimezone;
}

/** Ensure a timestamp string is parseable as UTC. Postgres timestamps without 'Z' get treated as local time by JS. */
function ensureUTC(iso: string): string {
  if (!iso) return iso;
  if (iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso)) return iso;
  return iso.trim() + 'Z';
}

/** Parse a date string safely — ensures bare Postgres timestamps are treated as UTC. */
function parseDate(iso: string): Date {
  return new Date(ensureUTC(iso));
}

function partsFor(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    timeZone: userTimezone,
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value('year'), month: value('month'), day: value('day'),
    hour: value('hour'), minute: value('minute'),
  };
}

/** Calendar-day key for an instant in the signed-in user's timezone. */
export function dateKeyInUserTimezone(value: string | Date): string {
  const date = typeof value === 'string' ? parseDate(value) : value;
  const { year, month, day } = partsFor(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Clock position for an instant in the signed-in user's timezone. */
export function timePartsInUserTimezone(value: string | Date): { hour: number; minute: number } {
  const date = typeof value === 'string' ? parseDate(value) : value;
  const { hour, minute } = partsFor(date);
  return { hour, minute };
}

/** Long label for a date-only calendar key, without timezone rollover. */
export function formatCalendarDateLong(dateKey: string): string {
  const date = new Date(`${dateKey}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(date);
}

// "2:30 PM"
export function formatMessageTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: userTimezone,
  }).format(parseDate(iso));
}

// "Mar 28"
export function formatShortDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: userTimezone,
  }).format(parseDate(iso));
}

// "Mar 28, 2:30 PM"
export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: userTimezone,
  }).format(parseDate(iso));
}

// "Mar 28, 2026"
export function formatFullDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: userTimezone,
  }).format(parseDate(iso));
}

// "5m ago", "2h ago", "3d ago", "Mar 28"
export function formatRelative(iso: string): string {
  const now = Date.now();
  const diff = now - parseDate(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatShortDate(iso);
}

// "5m ago", "2h ago", "3d ago" (compact, no fallback to date — for dashboard)
export function formatRelativeCompact(iso: string): string {
  const diff = Date.now() - parseDate(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

// "TODAY" / "YESTERDAY" / "FRIDAY, MAR 28"
export function formatDayLabel(iso: string): string {
  const date = parseDate(iso);
  const now = new Date();

  // Convert both to the user's timezone for day comparison
  const fmt = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: userTimezone,
  });
  const dateStr = fmt.format(date);
  const nowStr = fmt.format(now);

  if (dateStr === nowStr) return 'Today';

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = fmt.format(yesterday);
  if (dateStr === yesterdayStr) return 'Yesterday';

  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: userTimezone,
  }).format(date).toUpperCase();
}

// "2:30 PM EDT" — with explicit timezone abbreviation
export function formatTimeWithZone(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: userTimezone,
  }).format(parseDate(iso));
}

// For hover tooltip: "2:30 PM EDT · 12:00 AM IST (Rahul's time)"
export function formatTimeWithSenderZone(
  iso: string,
  senderTimezone?: string | null,
  senderName?: string,
): string {
  const viewerTime = formatTimeWithZone(iso);
  if (!senderTimezone || senderTimezone === userTimezone) return viewerTime;

  const senderTime = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: senderTimezone,
  }).format(parseDate(iso));

  return `${viewerTime} · ${senderTime}${senderName ? ` (${senderName}'s time)` : ''}`;
}

// Check if two ISO dates are the same calendar day in the user's timezone
export function isSameDay(iso1: string, iso2: string): boolean {
  const fmt = new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: userTimezone,
  });
  return fmt.format(parseDate(iso1)) === fmt.format(parseDate(iso2));
}

// Format a Date object as "h:mm AM/PM" in user timezone (for calendar events etc.)
export function formatEventTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: userTimezone,
  }).format(parseDate(iso));
}

// "Monday, March 28, 2026" — for dashboard header
export function formatFullDateLong(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: userTimezone,
  }).format(date);
}

// "2:30 PM" — format current time for dashboard
export function formatCurrentTime(): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: userTimezone,
  }).format(new Date());
}
