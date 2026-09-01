const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/u;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

type LocalParts = Readonly<{
  date: string;
  time: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}>;

export type AppAutomationOccurrence = Readonly<{
  logical_local_date: string;
  local_time: string;
  timezone: string;
  resolution:
    | Readonly<{ kind: 'resolved'; resolved_at_utc: Date }>
    | Readonly<{ kind: 'dst_gap' }>;
}>;

export type AppAutomationOccurrenceDecision =
  | Readonly<{ kind: 'not_eligible' | 'future' }>
  | Readonly<{ kind: 'pending'; occurrence: AppAutomationOccurrence }>
  | Readonly<{ kind: 'skipped'; reason: 'dst_gap' | 'misfire_skipped'; occurrence: AppAutomationOccurrence }>;

function formatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-CA', {
    calendar: 'gregory',
    numberingSystem: 'latn',
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  formatterCache.set(timezone, created);
  return created;
}

function localParts(at: Date, timezone: string): LocalParts {
  const values = new Map(formatter(timezone).formatToParts(at).map((part) => [part.type, part.value]));
  const year = Number(values.get('year'));
  const month = Number(values.get('month'));
  const day = Number(values.get('day'));
  const hour = Number(values.get('hour'));
  const minute = Number(values.get('minute'));
  const second = Number(values.get('second'));
  if (![year, month, day, hour, minute, second].every(Number.isInteger)) {
    throw new Error('APP_AUTOMATION_TIMEZONE_UNAVAILABLE');
  }
  return {
    date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    year,
    month,
    day,
    hour,
    minute,
    second,
  };
}

function parseLocal(date: string, time: string): Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  utc_shape: number;
}> {
  const dateMatch = LOCAL_DATE_PATTERN.exec(date);
  const timeMatch = LOCAL_TIME_PATTERN.exec(time);
  if (!dateMatch || !timeMatch) throw new Error('APP_AUTOMATION_SCHEDULE_INVALID');
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const utcShape = Date.UTC(year, month - 1, day, hour, minute);
  const roundTrip = new Date(utcShape);
  if (
    roundTrip.getUTCFullYear() !== year
    || roundTrip.getUTCMonth() !== month - 1
    || roundTrip.getUTCDate() !== day
  ) throw new Error('APP_AUTOMATION_SCHEDULE_INVALID');
  return { year, month, day, hour, minute, utc_shape: utcShape };
}

function offsetAt(atMs: number, timezone: string): number {
  const parts = localParts(new Date(atMs), timezone);
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ) - atMs;
}

function localWallClockShape(at: Date, timezone: string): number {
  const parts = localParts(at, timezone);
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    at.getUTCMilliseconds(),
  );
}

/** Resolve a wall-clock occurrence. A fold selects the earlier UTC instant;
 * a gap stays explicit so the caller can persist one terminal skipped fire. */
export function resolveAppAutomationOccurrence(input: Readonly<{
  logical_local_date: string;
  local_time: string;
  timezone: string;
}>): AppAutomationOccurrence {
  const parsed = parseLocal(input.logical_local_date, input.local_time);
  // Sampling both sides of the target captures the two offsets around a DST
  // transition without scanning every minute or depending on a tz library.
  const sampleOffsets = new Set([
    offsetAt(parsed.utc_shape - 36 * 60 * 60_000, input.timezone),
    offsetAt(parsed.utc_shape, input.timezone),
    offsetAt(parsed.utc_shape + 36 * 60 * 60_000, input.timezone),
  ]);
  const candidates = [...sampleOffsets]
    .map((offset) => new Date(parsed.utc_shape - offset))
    .filter((candidate) => {
      const parts = localParts(candidate, input.timezone);
      return parts.date === input.logical_local_date && parts.time === input.local_time;
    })
    .sort((left, right) => left.getTime() - right.getTime());
  return {
    logical_local_date: input.logical_local_date,
    local_time: input.local_time,
    timezone: input.timezone,
    resolution: candidates[0]
      ? { kind: 'resolved', resolved_at_utc: candidates[0] }
      : { kind: 'dst_gap' },
  };
}

export function appAutomationLocalDate(at: Date, timezone: string): string {
  return localParts(at, timezone).date;
}

function nextLogicalDate(value: string): string {
  const parsed = parseLocal(value, '00:00');
  const next = new Date(parsed.utc_shape + 24 * 60 * 60_000);
  return `${String(next.getUTCFullYear()).padStart(4, '0')}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

/** Enumerate the bounded local-date window a scanner must reconcile. */
export function listAppAutomationLogicalDates(input: Readonly<{
  eligible_after: Date;
  now: Date;
  timezone: string;
  max_days?: number;
}>): string[] {
  const start = appAutomationLocalDate(input.eligible_after, input.timezone);
  const end = appAutomationLocalDate(input.now, input.timezone);
  const maxDays = Math.max(1, Math.min(31, input.max_days ?? 31));
  const dates: string[] = [];
  for (let cursor = start; cursor <= end && dates.length < maxDays; cursor = nextLogicalDate(cursor)) {
    dates.push(cursor);
  }
  return dates;
}

export function classifyAppAutomationOccurrence(input: Readonly<{
  occurrence: AppAutomationOccurrence;
  now: Date;
  eligible_after: Date;
  eligible_before?: Date;
  catch_up_window_minutes: 15;
}>): AppAutomationOccurrenceDecision {
  const logicalIdentity = `${input.occurrence.logical_local_date}T${input.occurrence.local_time}`;

  if (input.occurrence.resolution.kind === 'dst_gap') {
    const occurrenceShape = parseLocal(
      input.occurrence.logical_local_date,
      input.occurrence.local_time,
    ).utc_shape;
    if (occurrenceShape <= localWallClockShape(
      input.eligible_after,
      input.occurrence.timezone,
    )) return { kind: 'not_eligible' };
    if (input.eligible_before && occurrenceShape >= localWallClockShape(
      input.eligible_before,
      input.occurrence.timezone,
    )) return { kind: 'not_eligible' };
    const currentLocal = localParts(input.now, input.occurrence.timezone);
    return logicalIdentity <= `${currentLocal.date}T${currentLocal.time}`
      ? { kind: 'skipped', reason: 'dst_gap', occurrence: input.occurrence }
      : { kind: 'future' };
  }
  const resolvedAt = input.occurrence.resolution.resolved_at_utc;
  if (resolvedAt <= input.eligible_after
    || (input.eligible_before !== undefined && resolvedAt >= input.eligible_before)) {
    return { kind: 'not_eligible' };
  }
  if (resolvedAt > input.now) return { kind: 'future' };
  const ageMs = input.now.getTime() - resolvedAt.getTime();
  return ageMs <= input.catch_up_window_minutes * 60_000
    ? { kind: 'pending', occurrence: input.occurrence }
    : { kind: 'skipped', reason: 'misfire_skipped', occurrence: input.occurrence };
}
