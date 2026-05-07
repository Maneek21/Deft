// Timezone-aware date helpers for "due today" / "overdue" / "due within N days"
// comparisons. Postgres stores due_date as a UTC timestamp, but whether a task
// is "due today" is a calendar-day question that depends on the org's timezone.
//
// Two complementary APIs:
//   1. Predicates — isDueToday / isOverdue / isDueWithinDays operate on a
//      single Date + tz and are suitable for filtering an already-narrow set
//      of rows in memory.
//   2. getDayBoundaries returns UTC instants for a day window in the given
//      tz, which can be passed to SQL (`WHERE due_date >= :start AND
//      due_date < :end`) for high-volume worker/service paths.
//
// All helpers default to 'UTC' on invalid tz strings rather than throwing —
// timezone data is user-editable and a bad value should never crash a
// background job.
import { db } from './db.js';
import { orgs } from '@deft/db/schema';
import { eq } from 'drizzle-orm';

const DEFAULT_TZ = 'UTC';

/**
 * Verify a tz string is acceptable to Intl.DateTimeFormat. Returns 'UTC' on
 * any failure so callers can pass through untrusted input.
 */
function safeTz(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TZ;
  try {
    // Throws RangeError on invalid tz.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/**
 * Format a Date into its wall-clock Y/M/D/H/m components in the given tz.
 */
function wallClock(d: Date, tz: string): {
  y: number;
  m: number;
  day: number;
  h: number;
  min: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  let y = 0;
  let m = 0;
  let day = 0;
  let h = 0;
  let min = 0;
  for (const p of parts) {
    if (p.type === 'year') y = Number(p.value);
    else if (p.type === 'month') m = Number(p.value);
    else if (p.type === 'day') day = Number(p.value);
    else if (p.type === 'hour') h = Number(p.value);
    else if (p.type === 'minute') min = Number(p.value);
  }
  return { y, m, day, h, min };
}

function wallClockYMD(d: Date, tz: string): { y: number; m: number; day: number } {
  const wc = wallClock(d, tz);
  return { y: wc.y, m: wc.m, day: wc.day };
}

/**
 * Returns the UTC instant corresponding to local midnight (00:00) on the
 * given Y/M/D in the given tz. Handles DST transitions correctly:
 *   1. Guess UTC = Date.UTC(Y, M-1, D).
 *   2. Probe the tz at that guess; the wall-clock hour/minute at the probe
 *      reveal the tz offset (e.g. in LA in July, UTC midnight reads as
 *      17:00 the previous day, meaning offset = -7h).
 *   3. Subtract the offset to get the true UTC midnight.
 *   4. Iterate once more in case DST changes across the adjustment.
 */
function utcInstantForLocalMidnight(y: number, m: number, day: number, tz: string): Date {
  const targetMs = Date.UTC(y, m - 1, day, 0, 0, 0, 0);
  let utcMs = targetMs;
  for (let i = 0; i < 3; i++) {
    const probe = new Date(utcMs);
    const wc = wallClock(probe, tz);
    // The wall-clock of `probe` in `tz` is (wc.y-wc.m-wc.day wc.h:wc.min).
    // Treat that wall-clock as if it were UTC to compute offset:
    //   offsetMs = wallClockAsUtcMs - utcMs.
    // Then true local-midnight UTC = targetMs - offsetMs.
    const wcAsUtc = Date.UTC(wc.y, wc.m - 1, wc.day, wc.h, wc.min, 0, 0);
    const offsetMs = wcAsUtc - utcMs;
    const next = targetMs - offsetMs;
    if (next === utcMs) return new Date(utcMs);
    utcMs = next;
  }
  return new Date(utcMs);
}

/**
 * Given an org tz and a "now" reference instant, compute the UTC [start, end)
 * boundaries for a calendar day offset by `dayOffset` days in that tz.
 *   dayOffset=0 → today,  1 → tomorrow,  -1 → yesterday.
 */
export function getDayBoundaries(
  tz: string,
  dayOffset = 0,
  now: Date = new Date(),
): { start: Date; end: Date } {
  const zone = safeTz(tz);
  const today = wallClockYMD(now, zone);
  // Shift by dayOffset days via UTC math on the midnight instant, then re-extract
  // the wall-clock Y/M/D so DST-crossing day offsets still land on midnight.
  const todayMidnight = utcInstantForLocalMidnight(today.y, today.m, today.day, zone);
  const shifted = new Date(todayMidnight.getTime() + dayOffset * 24 * 60 * 60 * 1000);
  const shiftedWC = wallClockYMD(shifted, zone);
  const start = utcInstantForLocalMidnight(shiftedWC.y, shiftedWC.m, shiftedWC.day, zone);
  const endWC = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const endWCParts = wallClockYMD(endWC, zone);
  const end = utcInstantForLocalMidnight(endWCParts.y, endWCParts.m, endWCParts.day, zone);
  return { start, end };
}

/**
 * True when `due` falls on today's calendar day in the org's tz.
 */
export function isDueToday(due: Date | null | undefined, tz: string, now: Date = new Date()): boolean {
  if (!due) return false;
  const { start, end } = getDayBoundaries(tz, 0, now);
  return due.getTime() >= start.getTime() && due.getTime() < end.getTime();
}

/**
 * True when `due` is strictly before the start of today in the org's tz.
 * A task due at 23:59 yesterday-local is overdue; a task due later today is not.
 */
export function isOverdue(due: Date | null | undefined, tz: string, now: Date = new Date()): boolean {
  if (!due) return false;
  const { start } = getDayBoundaries(tz, 0, now);
  return due.getTime() < start.getTime();
}

/**
 * True when `due` falls in the next `n` calendar days in the org's tz,
 * inclusive of today. n=0 is equivalent to isDueToday; n=1 means today or
 * tomorrow; etc.
 */
export function isDueWithinDays(
  due: Date | null | undefined,
  tz: string,
  n: number,
  now: Date = new Date(),
): boolean {
  if (!due) return false;
  if (n < 0) return false;
  const { start } = getDayBoundaries(tz, 0, now);
  const { end } = getDayBoundaries(tz, n, now);
  return due.getTime() >= start.getTime() && due.getTime() < end.getTime();
}

/**
 * Fetch an org's timezone. Returns 'UTC' on lookup failure so callers can
 * proceed without crashing on a bad/missing org.
 */
export async function getOrgTimezone(orgId: string): Promise<string> {
  try {
    const [row] = await db
      .select({ tz: orgs.timezone })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);
    return safeTz(row?.tz);
  } catch {
    return DEFAULT_TZ;
  }
}
